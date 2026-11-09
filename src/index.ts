/**
 * EasyEDA API Gateway 扩展
 *
 * 为 AI 编程工具（Claude Code、OpenCode、QwenCode 等）提供 WebSocket 桥接服务。
 * 扩展启动后自动扫描端口范围 49620-49629，发现 Bridge Server 并建立连接。
 *
 * 功能：
 * 1. 自动扫描端口范围发现 Bridge Server（握手验证 service: "easyeda-bridge"）
 * 2. 接收并执行来自 AI 的代码请求
 * 3. 将执行结果/错误返回给 Bridge Server
 * 4. 心跳检测 + 断线自动重连
 *
 * 架构：
 *   ┌─────────────┐  HTTP/WS    ┌────────────────┐  WebSocket   ┌──────────┐
 *   │  AI Agent    │ ◄────────► │  Bridge Server  │ ◄──────────► │ 本扩展    │
 *   │ (Skill Tool) │ Port Range │  (Node.js)      │  Port Range  │ (EasyEDA)│
 *   └─────────────┘ 49620-629  └────────────────┘  49620-629   └──────────┘
 */
import * as extensionConfig from '../extension.json';

// ─── 配置 ───────────────────────────────────────────────────────────
const WS_ID_PREFIX = 'ai-bridge';
const PORT_START = 49620;
const PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';
const RETRY_DELAY_MS = 3000;
const RETRY_DELAY_MAX_MS = 30000;
// 退避到上限后提醒用户去检查桥接服务本身，只提醒一次。
const RETRY_HINT_AT = 5;
const HEARTBEAT_INTERVAL_MS = 15000;
// 心跳 tick 迟到超过这个时长，说明定时器被浏览器节流、或者主线程正被一段长任务
// 占着。这两种情况下的「沉默」都不代表连接坏了，本轮不做掉线判定。
const HEARTBEAT_TICK_LATE_MS = 22500;
// 连续这么久没收到任何消息才判定掉线。
//
// 必须大于 HEARTBEAT_TICK_LATE_MS：否则一次迟到的 tick 会同时不满足「算节流」
// 又超过沉默上限，把一条好连接误杀掉。真正的断连一般由 send 抛异常立刻发现，
// 不必依赖这个上限，所以它可以取得宽松些。
const HEARTBEAT_SILENCE_LIMIT_MS = 45000;
const CONNECTION_TIMEOUT_MS = 2500; // 每个端口的连接+握手超时
const WATCHDOG_INTERVAL_MS = 30000;
// 断连期间最多暂存多少条待补发消息，以及超过多久就不值得补发了
const OUTBOX_MAX = 16;
const OUTBOX_TTL_MS = 60000;
const STORAGE_KEY_AUTO_CONNECT = 'autoConnectEnabled';
const STORAGE_KEY_LAST_PORT = 'lastBridgePort';
const SESSION_KEY_WINDOW_ID = 'runApiGateway.windowId';
const MBUS_TOPIC_STATUS = 'api-gateway-status';
const MBUS_TOPIC_CONTROL = 'api-gateway-control';

// ─── 状态 ───────────────────────────────────────────────────────────
let currentPort: number | null = null;
let handshakeVerified = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let autoConnectEnabled = true;
let retryCount = 0;
let windowId: string | null = null; // 窗口唯一标识符
let isConnecting = false;
let connectionSessionId = 0;
let messageBusRegistered = false;
let visibilityBound = false;

// 用户点过「停止连接」之后，看门狗和可见性自愈都不再插手，直到用户手动重连。
let manuallyStopped = false;

// 每次连接尝试都要换一个没用过的 WebSocket ID，原因见 tryConnectToPort。
let wsIdSeq = 0;
let activeWsId: string | null = null;

// 上次连上的端口。桥接服务通常固定在同一个端口，记住它能让重连少扫几轮。
let rememberedPort: number | null = null;

// 断连时没能送出去的消息，等重连后补发。
interface OutboxEntry {
	payload: object;
	at: number;
}
let outbox: Array<OutboxEntry> = [];

// 最近一次收到桥接消息的时刻，用来判断连接是否还活着。
let lastInboundAt = 0;
// 上一次心跳 tick 的时刻，用来识别定时器是否被浏览器节流。
let lastHeartbeatTickAt = 0;

type SendOutcome = 'sent' | 'queued' | 'failed';

interface GatewayControlRequest {
	command: 'reconnect' | 'stop';
}

interface GatewayControlResponse {
	handled: boolean;
	connected: boolean;
	windowId: string | null;
}

/**
 * 获取当前连接状态（供 messageBus RPC 调用）
 */
function getConnectionStatus(): {
	connected: boolean;
	connecting: boolean;
	port: number | null;
	windowId: string | null;
	retryCount: number;
	stopped: boolean;
} {
	return {
		connected: handshakeVerified,
		connecting: isConnecting,
		port: currentPort,
		windowId,
		retryCount,
		stopped: manuallyStopped,
	};
}

function ensureMessageBusServices(): void {
	if (messageBusRegistered)
		return;

	eda.sys_MessageBus.rpcService(MBUS_TOPIC_STATUS, () => getConnectionStatus());
	eda.sys_MessageBus.rpcService(MBUS_TOPIC_CONTROL, (request?: GatewayControlRequest): GatewayControlResponse => {
		if (request?.command === 'reconnect') {
			performReconnect();
		}
		else if (request?.command === 'stop') {
			performStopConnection(false);
		}

		return {
			handled: true,
			connected: handshakeVerified,
			windowId,
		};
	});

	messageBusRegistered = true;
}

function nextConnectionSessionId(): number {
	connectionSessionId += 1;
	return connectionSessionId;
}

function isConnectionSessionActive(sessionId: number): boolean {
	return sessionId === connectionSessionId;
}

// ─── WebSocket 句柄 ─────────────────────────────────────────────────

/**
 * 生成一个全新的 WebSocket ID。
 *
 * 官方 sys_WebSocket.register 有一条硬约束：对同一个 ID、如果已存在处于活跃
 * 状态的连接，新传入的地址和回调都不会生效。扫描端口时若复用一个固定 ID，
 * 上一个端口的连接只要还没关干净，后面所有 register 就都成了空操作——扩展
 * 会一直报「未找到 Bridge 服务」，连手动重连也救不回来。所以每次尝试换一个
 * 新 ID，从根上绕开这个状态。
 */
function nextWsId(): string {
	wsIdSeq += 1;
	return `${WS_ID_PREFIX}-${wsIdSeq}`;
}

function closeWebSocketById(id: string | null): void {
	if (!id)
		return;
	try {
		eda.sys_WebSocket.close(id);
	}
	catch { /* 连接可能早就不在了，关闭失败无需处理 */ }
}

function closeActiveWebSocket(): void {
	closeWebSocketById(activeWsId);
	activeWsId = null;
}

/**
 * 向桥接服务发送一条消息。
 *
 * @param payload - 消息内容
 * @param queueOnFailure - 连接不可用时是否留到重连后补发
 * @returns `sent` 已送出；`queued` 已进补发队列；`failed` 内容无法序列化，重试也没用
 */
function sendToBridge(payload: object, queueOnFailure = false): SendOutcome {
	let text: string;
	try {
		text = JSON.stringify(payload);
	}
	catch (err: unknown) {
		// 内容本身序列化不了，补发多少次都一样，不进队列
		console.warn('[API-Gateway] Failed to serialize message:', err instanceof Error ? err.message : String(err));
		return 'failed';
	}

	if (activeWsId) {
		try {
			eda.sys_WebSocket.send(activeWsId, text);
			return 'sent';
		}
		catch (err: unknown) {
			console.warn('[API-Gateway] Failed to send:', err instanceof Error ? err.message : String(err));
		}
	}

	if (queueOnFailure) {
		enqueueOutbox(payload);
		return 'queued';
	}
	return 'failed';
}

/**
 * 暂存一条发不出去的消息，等重连后补发。
 *
 * 执行结果只有一次发送机会：连接在执行期间断掉，这条结果就永久丢了，可 EDA
 * 里的改动是真实发生过的。请求方只看到「窗口已断开」，重试一遍就做了第二次——
 * 实测因此出现过位号与坐标完全相同的重复器件，在图上根本看不出来。
 * 留着重连后补发，配合稳定的 windowId，请求方至少还有机会认领这个结果。
 */
function enqueueOutbox(payload: object): void {
	outbox.push({ payload, at: Date.now() });
	if (outbox.length > OUTBOX_MAX) {
		outbox.splice(0, outbox.length - OUTBOX_MAX);
	}
}

function flushOutbox(): void {
	if (outbox.length === 0)
		return;

	const now = Date.now();
	// 太旧的结果请求方早已按超时处理，补发只会造成困惑
	const queued = outbox.filter(entry => now - entry.at <= OUTBOX_TTL_MS);
	outbox = [];

	for (let i = 0; i < queued.length; i++) {
		if (sendToBridge(queued[i].payload) !== 'sent') {
			outbox = queued.slice(i);
			return;
		}
	}
}

// ─── 连接流程控制 ────────────────────────────────────────────────────

function cancelConnectionFlow(resetRetryCount = true): void {
	nextConnectionSessionId();
	isConnecting = false;
	clearRetryTimer();
	stopHeartbeat();
	handshakeVerified = false;
	currentPort = null;
	windowId = null;
	if (resetRetryCount) {
		retryCount = 0;
	}
	closeActiveWebSocket();
}

function performReconnect(): void {
	eda.sys_Message.showToastMessage(eda.sys_I18n.text('Reconnecting...'));
	manuallyStopped = false;
	cancelConnectionFlow();
	void scanAndConnect();
}

function performStopConnection(showToast = true): void {
	manuallyStopped = true;
	cancelConnectionFlow();
	if (showToast) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
	}
}

/**
 * 掉线后立即重连。
 */
function reconnectAfterDrop(): void {
	cancelConnectionFlow();
	if (!autoConnectEnabled || manuallyStopped)
		return;
	void scanAndConnect();
}

async function dispatchControlCommand(command: GatewayControlRequest['command']): Promise<void> {
	try {
		const response = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_CONTROL, { command }, 500) as GatewayControlResponse;
		if (response?.handled) {
			if (command === 'stop') {
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
			}
			return;
		}
	}
	catch { /* messageBus 不可用时退回本窗口直接执行 */ }

	ensureMessageBusServices();
	if (command === 'reconnect') {
		performReconnect();
	}
	else {
		performStopConnection();
	}
}

// ─── 生命周期 ────────────────────────────────────────────────────────

/**
 * 扩展激活入口（支持 onStartupFinished 自动启动）
 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	ensureMessageBusServices();
	bindVisibilityRecovery();

	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	autoConnectEnabled = storedValue !== false;
	rememberedPort = readRememberedPort();

	startWatchdog();

	if (autoConnectEnabled) {
		void scanAndConnect();
	}
}

/**
 * 扩展停用时清理资源
 */
export function deactivate(): void {
	stopWatchdog();
	cancelConnectionFlow(false);
}

// ─── 菜单操作 ────────────────────────────────────────────────────────

/**
 * 手动重新连接（菜单项）
 */
export function reconnect(): void {
	void dispatchControlCommand('reconnect');
}

/**
 * 关于对话框（菜单项）
 */
export async function about(): Promise<void> {
	let status: string;

	// 通过 messageBus 获取 WebSocket 连接状态
	let statusInfo = { connected: false, connecting: false, port: 0, windowId: null, retryCount: 0, stopped: false };
	try {
		statusInfo = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_STATUS, undefined, 300);
	}
	// eslint-disable-next-line unused-imports/no-unused-vars
	catch (e) {}

	if (statusInfo?.connected) {
		const portInfo = `Connected (port ${statusInfo.port})`;
		const windowInfo = statusInfo.windowId ? `\nWindow ID: ${statusInfo.windowId}` : '\nWindow ID: (not registered)';
		status = `${portInfo}${windowInfo}`;
	}
	else if (statusInfo?.connecting) {
		status = 'Connecting...';
	}
	else if (statusInfo?.stopped) {
		status = 'Disconnected (stopped manually)';
	}
	else if (statusInfo?.retryCount) {
		status = `Disconnected (retry #${statusInfo.retryCount})`;
	}
	else {
		status = 'Disconnected';
	}

	eda.sys_Dialog.showInformationMessage(
		`API Gateway v${extensionConfig.version}\n${status}`,
		'About',
	);
}

/**
 * 切换自动连接开关（菜单项）
 */
export async function toggleAutoConnect(): Promise<void> {
	const enabled = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT) !== false;
	const nextEnabled = !enabled;
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT, nextEnabled);

	// 只改存储不改内存的话，开关要等下次启动 EDA 才生效。
	autoConnectEnabled = nextEnabled;

	eda.sys_Message.showToastMessage(
		eda.sys_I18n.text(nextEnabled ? 'Auto-Connect enabled' : 'Auto-Connect disabled'),
	);

	if (nextEnabled) {
		manuallyStopped = false;
		if (!handshakeVerified && !isConnecting) {
			retryCount = 0;
			void scanAndConnect();
		}
	}
	else {
		performStopConnection(false);
	}
}

/**
 * 停止连接并取消重试（菜单项）
 */
export function stopConnection(): void {
	void dispatchControlCommand('stop');
}

// ─── 端口扫描与连接 ──────────────────────────────────────────────────

function readRememberedPort(): number | null {
	const stored = Number(eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_LAST_PORT));
	if (Number.isInteger(stored) && stored >= PORT_START && stored <= PORT_END) {
		return stored;
	}
	return null;
}

/**
 * 取本窗口的标识，同一个标签页内保持不变。
 *
 * 原先每次连接都新生成一个 UUID，桥接端因此把「同一个标签页重连」看成
 * 「旧窗口消失、新窗口出现」。心跳抖动一次，AI 之前指定过的窗口就不存在了，
 * 多窗口场景下后续操作可能落到另一个工程上。
 *
 * sessionStorage 的生命周期正好对应「一个标签页」：刷新后保留、关闭即失效，
 * 而且不同标签页之间天然隔离，不会撞 ID。
 */
function resolveWindowId(): string {
	try {
		const cached = sessionStorage.getItem(SESSION_KEY_WINDOW_ID);
		if (cached) {
			return cached;
		}

		const created = crypto.randomUUID();
		sessionStorage.setItem(SESSION_KEY_WINDOW_ID, created);
		return created;
	}
	catch { /* sessionStorage 不可用时退回一次性 ID，行为与旧版一致 */ }

	return crypto.randomUUID();
}

function rememberPort(port: number): void {
	if (rememberedPort === port)
		return;

	rememberedPort = port;
	void eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_LAST_PORT, port);
}

/**
 * 端口尝试顺序：上次连上的端口排在最前。
 */
function portCandidates(): Array<number> {
	const ports: Array<number> = [];
	for (let port = PORT_START; port <= PORT_END; port++) {
		ports.push(port);
	}

	if (rememberedPort === null) {
		return ports;
	}
	return [rememberedPort, ...ports.filter(port => port !== rememberedPort)];
}

/**
 * 计算下一次重试的等待时间。
 *
 * 这里不再设重试上限。桥接服务完全可能比 EDA 晚启动、或者中途重启一次，
 * 一旦扩展彻底放弃，用户就只剩手动点菜单一条路，而且往往察觉不到自己已经
 * 掉线了。改成指数退避后既不会一直空转，也总能自己恢复。
 */
function nextRetryDelayMs(): number {
	const exponent = Math.min(Math.max(retryCount - 1, 0), 10);
	return Math.min(RETRY_DELAY_MS * 2 ** exponent, RETRY_DELAY_MAX_MS);
}

/**
 * 扫描端口范围，通过 WebSocket 连接 + 握手验证找到 Bridge Server。
 *
 * 不使用 HTTP fetch（EasyEDA 网页端为 HTTPS，fetch http://127.0.0.1 会被
 * 浏览器的 Mixed Content 策略拦截），改为直接用 eda.sys_WebSocket.register()
 * 逐端口尝试，等待服务端发送 handshake 消息来确认身份。
 */
async function scanAndConnect(): Promise<void> {
	if (isConnecting) {
		return;
	}

	const sessionId = nextConnectionSessionId();
	isConnecting = true;
	clearRetryTimer();

	try {
		for (const port of portCandidates()) {
			if (!isConnectionSessionActive(sessionId)) {
				return;
			}

			const found = await tryConnectToPort(port, sessionId);
			if (!isConnectionSessionActive(sessionId)) {
				return;
			}

			if (found) {
				currentPort = port;
				retryCount = 0;
				rememberPort(port);
				startHeartbeat(sessionId);
				return;
			}
		}

		retryCount++;
		const delayMs = nextRetryDelayMs();
		console.warn(`[API-Gateway] No bridge server found on ports ${PORT_START}-${PORT_END}, retrying in ${delayMs}ms...`);

		if (retryCount === RETRY_HINT_AT) {
			eda.sys_Message.showToastMessage(
				eda.sys_I18n.text('Bridge still not found'),
				ESYS_ToastMessageType.WARNING,
			);
		}
		else {
			eda.sys_Message.showToastMessage(
				`${eda.sys_I18n.text('Bridge not found, retrying in ', undefined, undefined, String(Math.round(delayMs / 1000)))} (${retryCount})`,
			);
		}

		scheduleRetry(sessionId, delayMs);
	}
	finally {
		if (isConnectionSessionActive(sessionId)) {
			isConnecting = false;
		}
	}
}

/**
 * 尝试通过 WebSocket 连接到指定端口，等待握手验证。
 *
 * 流程：
 * 1. 用一个全新的 WS ID register 连接（不复用，见 nextWsId 的说明）
 * 2. 等待服务端主动发送 handshake 消息
 * 3. 如果 handshake.service === SERVICE_ID → 注册窗口并成功（resolve true）
 * 4. 超时 CONNECTION_TIMEOUT_MS 仍未成功 → 关闭并返回 false
 *
 * @returns true = 握手成功且连接保持；false = 超时或验证失败
 */
function tryConnectToPort(port: number, sessionId: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;

		const wsId = nextWsId();

		const settle = (success: boolean) => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);

			if (success) {
				activeWsId = wsId;
			}
			else {
				if (activeWsId === wsId) {
					activeWsId = null;
				}
				closeWebSocketById(wsId);
			}

			resolve(success);
		};

		if (!isConnectionSessionActive(sessionId)) {
			resolve(false);
			return;
		}

		timer = setTimeout(() => settle(false), CONNECTION_TIMEOUT_MS);

		handshakeVerified = false;

		try {
			eda.sys_WebSocket.register(
				wsId,
				`ws://127.0.0.1:${port}/eda`,
				// 收到消息的回调（在扫描阶段处理握手，后续处理业务消息）
				async (event: MessageEvent) => {
					// 会话已被取代（用户手动重连或停止），这条连接不再属于当前流程
					if (!isConnectionSessionActive(sessionId)) {
						closeWebSocketById(wsId);
						return;
					}

					lastInboundAt = Date.now();

					try {
						const msg = JSON.parse(event.data) as BridgeMessage;

						// 握手验证
						if (msg.type === 'handshake') {
							if (msg.service !== SERVICE_ID) {
								console.warn(`[API-Gateway] Handshake failed: unexpected service "${msg.service}"`);
								settle(false);
								return;
							}

							// 先认领这条连接，sendToBridge 需要知道用哪个句柄
							activeWsId = wsId;

							const id = resolveWindowId();
							// 注册消息发不出去，说明连接没真正可用，别把它当成功
							if (sendToBridge({
								type: 'register',
								windowId: id,
								timestamp: Date.now(),
							}) !== 'sent') {
								settle(false);
								return;
							}

							windowId = id;
							handshakeVerified = true;
							eda.sys_Message.showToastMessage(
								`${eda.sys_I18n.text('Bridge connected (port ', undefined, undefined, String(port))})`,
							);
							settle(true);
							// 断连期间攒下的执行结果，现在有机会送出去了
							flushOutbox();
							return;
						}

						// 非握手消息：扫描阶段忽略，已连接后正常处理
						if (!handshakeVerified)
							return;

						await handleMessage(msg);
					}
					catch (err: unknown) {
						console.error('[API-Gateway] Failed to handle message:', err);
					}
				},
				// 连接建立回调（此时等待服务端主动发送 handshake）
				() => {},
			);
		}
		catch (e: unknown) {
			// register 本身抛异常（如权限未开启）
			console.error('[API-Gateway] Failed to register WebSocket:', e);
			settle(false);
		}
	});
}

// ─── 心跳检测 ────────────────────────────────────────────────────────

function startHeartbeat(sessionId: number): void {
	stopHeartbeat();

	const now = Date.now();
	lastInboundAt = now;
	lastHeartbeatTickAt = now;

	heartbeatTimer = setInterval(() => {
		if (!isConnectionSessionActive(sessionId)) {
			stopHeartbeat();
			return;
		}

		if (!handshakeVerified)
			return;

		const tickAt = Date.now();
		const sinceLastTick = tickAt - lastHeartbeatTickAt;
		lastHeartbeatTickAt = tickAt;

		// tick 明显迟到有两种成因：后台标签页的定时器被浏览器节流甚至冻结，或者
		// 执行中的代码长时间占着主线程（执行的代码与心跳共用同一个事件循环）。
		// 两种情况下心跳都没能按时发出，对端的沉默不代表连接坏了。原先在这里直接
		// 判超时并重连，等于在一段长任务执行到一半时掐掉自己的连接、让这次调用
		// 白白失败。放过这一轮，先补一次心跳，下一轮再按正常标准判断。
		if (sinceLastTick > HEARTBEAT_TICK_LATE_MS) {
			lastInboundAt = tickAt;
			sendHeartbeat();
			return;
		}

		if (tickAt - lastInboundAt > HEARTBEAT_SILENCE_LIMIT_MS) {
			console.warn('[API-Gateway] Heartbeat timeout, reconnecting...');
			reconnectAfterDrop();
			return;
		}

		sendHeartbeat();
	}, HEARTBEAT_INTERVAL_MS);
}

function sendHeartbeat(): void {
	// 心跳过期就没有意义了，不进补发队列
	if (sendToBridge({
		type: 'ping',
		id: `hb-${Date.now()}`,
		timestamp: Date.now(),
	}) !== 'sent') {
		// send 失败说明已断开
		reconnectAfterDrop();
	}
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

// ─── 重试 ────────────────────────────────────────────────────────────

function scheduleRetry(sessionId: number, delayMs: number): void {
	clearRetryTimer();
	retryTimer = setTimeout(() => {
		retryTimer = null;
		if (!isConnectionSessionActive(sessionId)) {
			return;
		}
		void scanAndConnect();
	}, delayMs);
}

function clearRetryTimer(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

// ─── 掉线自愈 ────────────────────────────────────────────────────────

/**
 * 标签页回到前台时立刻重连。
 *
 * 后台标签页的定时器会被浏览器冻结，心跳因此停摆，桥接服务那边探活失败就把
 * 这个窗口摘掉了。页面被冻结期间扩展无能为力，但重新可见是最可靠的自愈时机：
 * 此时清掉退避直接重连，用户切回来就能用，不用手动点菜单。
 */
function bindVisibilityRecovery(): void {
	if (visibilityBound)
		return;
	if (typeof document === 'undefined' || typeof document.addEventListener !== 'function')
		return;

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState !== 'visible')
			return;
		if (!autoConnectEnabled || manuallyStopped)
			return;
		if (handshakeVerified || isConnecting)
			return;

		retryCount = 0;
		clearRetryTimer();
		void scanAndConnect();
	});

	visibilityBound = true;
}

/**
 * 兜底看门狗：连接既没建立、也没有在连、也没排重试，就把流程重新拉起来。
 */
function startWatchdog(): void {
	if (watchdogTimer)
		return;

	watchdogTimer = setInterval(() => {
		if (!autoConnectEnabled || manuallyStopped)
			return;
		if (handshakeVerified || isConnecting || retryTimer)
			return;

		void scanAndConnect();
	}, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}
}

// ─── 消息处理 ────────────────────────────────────────────────────────

interface BridgeMessage {
	type: 'execute' | 'ping' | 'pong' | 'handshake' | 'result' | 'error';
	id?: string;
	code?: string;
	service?: string;
	result?: unknown;
	error?: string;
	timestamp?: number;
}

async function handleMessage(msg: BridgeMessage): Promise<void> {
	if (msg.type === 'ping') {
		sendToBridge({
			type: 'pong',
			id: msg.id,
			timestamp: Date.now(),
		});
		return;
	}

	// pong 无需额外处理：收到消息时已经刷新过活跃时间
	if (msg.type === 'pong') {
		return;
	}

	if (msg.type === 'execute' && msg.code) {
		try {
			// 使用 AsyncFunction 执行代码，允许 await

			const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
			const fn = new AsyncFunction('eda', msg.code);
			const result = await fn(eda);

			const outcome = sendToBridge({
				type: 'result',
				id: msg.id,
				result: result !== undefined ? result : null,
				timestamp: Date.now(),
			}, true);

			// 结果含循环引用之类序列化不了的内容时回一条错误，免得请求方干等到超时
			if (outcome === 'failed') {
				sendToBridge({
					type: 'error',
					id: msg.id,
					error: 'Failed to serialize result',
					timestamp: Date.now(),
				}, true);
			}
		}
		catch (err: unknown) {
			sendToBridge({
				type: 'error',
				id: msg.id,
				error: err instanceof Error ? err.message : String(err),
				timestamp: Date.now(),
			});
		}
	}
}
