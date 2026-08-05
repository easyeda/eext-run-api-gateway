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
const WS_ID = 'ai-bridge';
const PORT_START = 49620;
const PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';
const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 5;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const CONNECTION_TIMEOUT_MS = 1500; // 每个端口的连接+握手超时
const STORAGE_KEY_AUTO_CONNECT = 'autoConnectEnabled';
const MBUS_TOPIC_STATUS = 'api-gateway-status';
const MBUS_TOPIC_CONTROL = 'api-gateway-control';
// 「已连接」Toast 最小间隔：防止断线重连循环时反复弹窗
const CONNECTED_TOAST_MIN_INTERVAL_MS = 10_000;
// 连接建立后的重连冷却期：期间心跳超时/send 失败不立即重连，避免多窗口实例互相抢占连接导致乒乓
const RECONNECT_COOLDOWN_MS = 3_000;
// 自动重连熔断：60 秒窗口内最多重连次数，超限停止自动重连（可手动菜单重连）
const RECONNECT_WINDOW_MS = 60_000;
const MAX_RECONNECT_PER_WINDOW = 5;
// 多实例选举：连接持有者查询超时（毫秒）
const LEADER_QUERY_TIMEOUT_MS = 300;
// standby 实例轮询接管间隔（毫秒）：持有者窗口关闭后，备用实例在 ≤1 个周期内接管
const STANDBY_CHECK_INTERVAL_MS = 30_000;

// ─── 状态 ───────────────────────────────────────────────────────────
// 实例唯一标识：同扩展 UUID 的多个窗口/标签页实例共享 WS 连接与 messageBus，
// 用该标识区分日志来源，避免多实例互相抢占连接
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);
let isStandby = false; // 本实例处于备用模式（不持有连接，不碰 sys_WebSocket）
let standbyTimer: ReturnType<typeof setInterval> | null = null; // standby 轮询定时器
let currentPort: number | null = null;
let handshakeVerified = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPending = false;
let autoConnectEnabled = true;
let retryCount = 0;
let windowId: string | null = null; // 窗口唯一标识符
let isConnecting = false;
let connectionSessionId = 0;
let messageBusRegistered = false;
let lastReconnectAt = 0; // 上次执行重连的时间戳（防重入，毫秒）
let lastConnectedToastAt = 0; // 上次弹「已连接」Toast 的时间戳
let connectedAt = 0; // 当前连接建立的时间戳
let reconnectWindowStart = 0; // 自动重连熔断窗口起点
let reconnectCount = 0; // 熔断窗口内自动重连次数

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
} {
	return {
		connected: handshakeVerified,
		connecting: isConnecting,
		port: currentPort,
		windowId,
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

function closeWebSocket(): void {
	try {
		eda.sys_WebSocket.close(WS_ID);
	}
	catch { /* ignore */ }
}

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
	closeWebSocket();
}

/**
 * 自动重连熔断：60 秒窗口内最多自动重连 MAX_RECONNECT_PER_WINDOW 次。
 * 连接反复断开（如多窗口实例抢占同一 Bridge Server 连接）时，防止无限重连循环。
 *
 * @returns true = 允许执行自动重连；false = 已超限，停止自动重连
 */
function allowAutoReconnect(): boolean {
	const now = Date.now();
	if (now - reconnectWindowStart > RECONNECT_WINDOW_MS) {
		reconnectWindowStart = now;
		reconnectCount = 0;
	}
	if (reconnectCount >= MAX_RECONNECT_PER_WINDOW) {
		console.warn(`[API-Gateway] Too many reconnects in ${RECONNECT_WINDOW_MS / 1000}s window, auto-reconnect paused.`);
		return false;
	}
	reconnectCount += 1;
	return true;
}

// ─── 多实例选举 ─────────────────────────────────────────────────────
// 背景：同扩展 UUID 的多个窗口/标签页实例共享同一条 sys_WebSocket 连接与
// messageBus。若每个实例都执行 scanAndConnect，其 tryConnectToPort 会先
// closeWebSocket() 关闭共享连接再重建，导致多实例互相抢占、反复握手弹窗。
// 方案：同一时刻只允许一个实例持有连接（leader），其余 standby；leader 消失
// （窗口关闭/扩展停用）后由 standby 轮询接管。

/**
 * 查询 messageBus 上是否有任意实例已持有连接。
 * rpcCall 可能返回单个响应或数组（多实例时），宽容处理两种情况。
 */
async function queryAnyLeaderConnected(): Promise<boolean> {
	try {
		const resp = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_STATUS, undefined, LEADER_QUERY_TIMEOUT_MS);
		if (Array.isArray(resp)) {
			return resp.some(r => r?.connected === true);
		}
		return resp?.connected === true;
	}
	catch {
		// 无任何实例响应（本实例可能是第一个激活的）
		return false;
	}
}

/**
 * 进入 standby 模式：不持有连接、不碰 sys_WebSocket，周期轮询等待接管。
 */
function becomeStandby(): void {
	if (isStandby) {
		return;
	}
	console.warn(`[API-Gateway][${INSTANCE_ID}] standby: another instance holds the connection.`);
	isStandby = true;
	nextConnectionSessionId();
	isConnecting = false;
	clearRetryTimer();
	stopHeartbeat();
	handshakeVerified = false;
	currentPort = null;
	windowId = null;
	// 注意：不调用 closeWebSocket()，避免关闭 leader 实例的共享连接

	stopStandbyMonitor();
	standbyTimer = setInterval(() => {
		void checkAndTakeOver();
	}, STANDBY_CHECK_INTERVAL_MS);
}

function stopStandbyMonitor(): void {
	if (standbyTimer) {
		clearInterval(standbyTimer);
		standbyTimer = null;
	}
}

/**
 * standby 轮询：发现无实例持有连接时，本实例接管成为 leader。
 */
async function checkAndTakeOver(): Promise<void> {
	if (!isStandby) {
		stopStandbyMonitor();
		return;
	}
	const anyConnected = await queryAnyLeaderConnected();
	if (anyConnected) {
		return; // leader 仍在线
	}
	console.warn(`[API-Gateway][${INSTANCE_ID}] no leader found, taking over connection.`);
	isStandby = false;
	stopStandbyMonitor();
	void scanAndConnect();
}

/**
 * 激活入口的选举逻辑：已有 leader 则 standby，否则本实例连接。
 */
async function tryConnectWithElection(): Promise<void> {
	const anyConnected = await queryAnyLeaderConnected();
	if (anyConnected) {
		becomeStandby();
		return;
	}
	console.warn(`[API-Gateway][${INSTANCE_ID}] no leader, this instance takes the connection.`);
	void scanAndConnect();
}

/**
 * 断线后的自动重连入口：先查询是否有其他实例已持有连接。
 * 若有（连接可能已被对方接管管理）→ 本实例转 standby 不抢；
 * 若无 → 在熔断限制内重连。
 */
async function reconnectAfterQuerying(): Promise<void> {
	if (isStandby) {
		return;
	}
	const anyConnected = await queryAnyLeaderConnected();
	if (anyConnected) {
		becomeStandby();
		return;
	}
	if (allowAutoReconnect()) {
		void scanAndConnect();
	}
}

/**
 * 执行重连：取消当前连接并重新扫描端口。
 *
 * 防重入说明：菜单点击会先触发 messageBus 广播，若广播响应超时还会走本地
 * fallback，导致同一请求被执行两次、Toast 重复弹出。因此这里用时间戳做
 * 1 秒内的去重，第二次重复调用直接忽略。
 */
function performReconnect(): void {
	const now = Date.now();
	// 1 秒内的重复重连请求直接忽略（messageBus 广播 + 本地 fallback 双路径防重）
	if (now - lastReconnectAt < 1000) {
		return;
	}
	lastReconnectAt = now;

	eda.sys_Message.showToastMessage(eda.sys_I18n.text('Reconnecting...'));
	cancelConnectionFlow();
	void scanAndConnect();
}

function performStopConnection(showToast = true): void {
	cancelConnectionFlow();
	if (showToast) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
	}
}

// ─── 生命周期 ────────────────────────────────────────────────────────

/**
 * 扩展激活入口（支持 onStartupFinished 自动启动）
 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	ensureMessageBusServices();
	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	autoConnectEnabled = storedValue !== false;

	if (autoConnectEnabled) {
		console.warn(`[API-Gateway][${INSTANCE_ID}] activate, auto-connect enabled.`);
		// 多实例选举：已有实例持有连接则 standby，否则本实例连接
		void tryConnectWithElection();
	}
	else {
		console.warn(`[API-Gateway][${INSTANCE_ID}] activate, auto-connect disabled.`);
	}
}

/**
 * 扩展停用时清理资源
 */
export function deactivate(): void {
	stopStandbyMonitor();
	cancelConnectionFlow(false);
}

// ─── 菜单操作 ────────────────────────────────────────────────────────

/**
 * 手动重新连接（菜单项）
 *
 * 直接在本窗口执行，不再走 messageBus 广播：每个 EDA 窗口的扩展实例
 * 是相互独立的（各自持有 WebSocket 连接与连接状态），广播会让所有窗口
 * 一起重连并各自弹出 Toast，造成"正在重新连接.../Bridge 已连接"重复出现。
 */
export function reconnect(): void {
	ensureMessageBusServices();
	performReconnect();
}

/**
 * 关于对话框（菜单项）
 */
export async function about(): Promise<void> {
	let status: string;

	// 通过 messageBus 获取 WebSocket 连接状态
	let statusInfo = { connected: false, connecting: false, port: 0, windowId: null };
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
	const current = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	const newValue = current !== false;
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT, !newValue);

	const msgKey = !newValue
		? 'Auto-Connect enabled'
		: 'Auto-Connect disabled';
	eda.sys_Message.showToastMessage(eda.sys_I18n.text(msgKey));
}

/**
 * 停止连接并取消重试（菜单项）
 *
 * 同 reconnect：直接在本窗口执行，不走 messageBus 广播，避免多窗口重复操作。
 */
export function stopConnection(): void {
	performStopConnection();
}

// ─── 端口扫描与连接 ──────────────────────────────────────────────────

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
	console.warn(`[API-Gateway][${INSTANCE_ID}] scanning ports ${PORT_START}-${PORT_END}...`);

	try {
		if (retryCount >= MAX_RETRIES) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('Max retries reached'), ESYS_ToastMessageType.ERROR);
			return;
		}

		for (let port = PORT_START; port <= PORT_END; port++) {
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
				console.warn(`[API-Gateway][${INSTANCE_ID}] connection established on port ${port}.`);
				startHeartbeat(sessionId);
				return;
			}
		}

		retryCount++;
		console.warn(`[API-Gateway] No bridge server found on ports ${PORT_START}-${PORT_END}, retrying in ${RETRY_DELAY_MS}ms...`);
		eda.sys_Message.showToastMessage(
			`${eda.sys_I18n.text('Bridge not found, retrying in ', undefined, undefined, String(RETRY_DELAY_MS / 1000))} (${retryCount}/${MAX_RETRIES})`,
		);
		scheduleRetry(sessionId);
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
 * 1. 关闭已有 WS → register 新连接
 * 2. 如果 connectedCallFn 被调用 → 等待 handshake 消息
 * 3. 如果 handshake.service === SERVICE_ID → 成功（resolve true）
 * 4. 超时 CONNECTION_TIMEOUT_MS 仍未成功 → 关闭并返回 false
 *
 * @returns true = 握手成功且连接保持；false = 超时或验证失败
 */
function tryConnectToPort(port: number, sessionId: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;

		let timer: ReturnType<typeof setTimeout>;

		const settle = (success: boolean, _reason: string) => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			if (!success && isConnectionSessionActive(sessionId)) {
				closeWebSocket();
			}
			resolve(success);
		};

		if (!isConnectionSessionActive(sessionId)) {
			resolve(false);
			return;
		}

		// 先关闭旧连接（register 对同 ID 活跃连接不会更新参数）
		closeWebSocket();

		timer = setTimeout(() => settle(false, 'timeout'), CONNECTION_TIMEOUT_MS);

		handshakeVerified = false;

		try {
			eda.sys_WebSocket.register(
				WS_ID,
				`ws://127.0.0.1:${port}/eda`,
				// 收到消息的回调（在扫描阶段处理握手，后续处理业务消息）
				async (event: MessageEvent) => {
					if (!isConnectionSessionActive(sessionId)) {
						settle(false, 'session cancelled');
						return;
					}

					try {
						const msg = JSON.parse(event.data);

						// 握手验证
						if (msg.type === 'handshake') {
							// 同一连接上重复/残留的 handshake 忽略，防止重复注册与重复弹窗
							if (settled) {
								return;
							}

							if (msg.service === SERVICE_ID) {
								handshakeVerified = true;
								connectedAt = Date.now();
								// 生成窗口ID并注册到bridge
								windowId = crypto.randomUUID();
								eda.sys_WebSocket.send(WS_ID, JSON.stringify({
									type: 'register',
									windowId,
									timestamp: Date.now(),
								}));
								console.warn(`[API-Gateway][${INSTANCE_ID}] handshake OK on port ${port}.`);
								// 节流：断线重连循环时避免反复弹「已连接」Toast
								const now = Date.now();
								if (now - lastConnectedToastAt >= CONNECTED_TOAST_MIN_INTERVAL_MS) {
									lastConnectedToastAt = now;
									eda.sys_Message.showToastMessage(
										`${eda.sys_I18n.text('Bridge connected (port ', undefined, undefined, String(port))})`,
									);
								}
								else {
									console.warn(`[API-Gateway][${INSTANCE_ID}] handshake OK again, toast throttled.`);
								}
								settle(true, 'handshake OK');
							}
							else {
								console.warn(`[API-Gateway] Handshake failed: unexpected service "${msg.service}"`);
								settle(false, `wrong service: ${msg.service}`);
							}
							return;
						}

						// 非握手消息：扫描阶段忽略，已连接后正常处理
						if (!handshakeVerified)
							return;

						await handleMessage(msg);
					}
					catch (err) {
						console.error('[API-Gateway] Failed to handle message:', err);
					}
				},
				// 连接建立回调（此时等待服务端主动发送 handshake）
				() => {},
			);
		}
		catch (e) {
			// register 本身抛异常（如权限未开启）
			console.error('[API-Gateway] Failed to register WebSocket:', e);
			settle(false, `register threw: ${e}`);
		}
	});
}

// ─── 心跳检测 ────────────────────────────────────────────────────────

function startHeartbeat(sessionId: number): void {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
		if (!isConnectionSessionActive(sessionId)) {
			stopHeartbeat();
			return;
		}

		if (!handshakeVerified)
			return;
		try {
			heartbeatPending = true;
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({
				type: 'ping',
				id: `hb-${Date.now()}`,
				timestamp: Date.now(),
			}));
			// 如果超时内没收到 pong，重新扫描
			setTimeout(() => {
				if (!isConnectionSessionActive(sessionId)) {
					return;
				}

				if (heartbeatPending) {
					// 冷却期：连接刚建立不重连，避免多窗口实例抢占连接导致乒乓循环
					if (Date.now() - connectedAt < RECONNECT_COOLDOWN_MS) {
						heartbeatPending = false;
						return;
					}
					console.warn(`[API-Gateway][${INSTANCE_ID}] Heartbeat timeout, reconnecting...`);
					cancelConnectionFlow(false);
					// 先查询其他实例是否已持有连接，避免抢占
					void reconnectAfterQuerying();
				}
			}, HEARTBEAT_TIMEOUT_MS);
		}
		catch {
			// send 失败说明已断开
			if (Date.now() - connectedAt >= RECONNECT_COOLDOWN_MS) {
				console.warn(`[API-Gateway][${INSTANCE_ID}] send failed, reconnecting...`);
				cancelConnectionFlow(false);
				void reconnectAfterQuerying();
			}
		}
	}, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	heartbeatPending = false;
}

// ─── 重试 ────────────────────────────────────────────────────────────

function scheduleRetry(sessionId: number): void {
	clearRetryTimer();
	retryTimer = setTimeout(() => {
		if (!isConnectionSessionActive(sessionId) || isConnecting) {
			return;
		}
		void scanAndConnect();
	}, RETRY_DELAY_MS);
}

function clearRetryTimer(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
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
		eda.sys_WebSocket.send(WS_ID, JSON.stringify({
			type: 'pong',
			id: msg.id,
			timestamp: Date.now(),
		}));
		return;
	}

	if (msg.type === 'pong') {
		heartbeatPending = false;
		return;
	}

	if (msg.type === 'execute' && msg.code) {
		try {
			// 使用 AsyncFunction 执行代码，允许 await

			const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
			const fn = new AsyncFunction('eda', msg.code);
			const result = await fn(eda);

			eda.sys_WebSocket.send(WS_ID, JSON.stringify({
				type: 'result',
				id: msg.id,
				result: result !== undefined ? result : null,
				timestamp: Date.now(),
			}));
		}
		catch (err: unknown) {
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({
				type: 'error',
				id: msg.id,
				error: err instanceof Error ? err.message : String(err),
				timestamp: Date.now(),
			}));
		}
	}
}
