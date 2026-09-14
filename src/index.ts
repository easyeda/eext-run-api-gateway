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
const ROUTING_WARNING_AFTER_MS = 30_000;

// ─── 状态 ───────────────────────────────────────────────────────────
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
let activeRoutingId: string | null = null;
let lastRoutingStatus = 'No routing task';
let routingStartedAt = 0;

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
	eda.sys_MessageBus.rpcService('api-gateway-routing-status', () => activeRoutingId ? `${lastRoutingStatus}\nElapsed: ${Date.now() - routingStartedAt} ms` : lastRoutingStatus);
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

function performReconnect(): void {
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
	catch {}

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
	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	autoConnectEnabled = storedValue !== false;

	if (autoConnectEnabled) {
		void scanAndConnect();
	}
}

/**
 * 扩展停用时清理资源
 */
export function deactivate(): void {
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
 */
export function stopConnection(): void {
	void dispatchControlCommand('stop');
}

export async function routingStatus(): Promise<void> {
	const status = await eda.sys_MessageBus.rpcCall('api-gateway-routing-status', undefined, 500);
	eda.sys_Dialog.showInformationMessage(String(status), 'Routing Task');
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
							if (msg.service === SERVICE_ID) {
								handshakeVerified = true;
								// 生成窗口ID并注册到bridge
								windowId = crypto.randomUUID();
								eda.sys_WebSocket.send(WS_ID, JSON.stringify({
									type: 'register',
									windowId,
									capabilities: ['execution-tasks-v1', 'routing-v1'],
									timestamp: Date.now(),
								}));
								eda.sys_Message.showToastMessage(
									`${eda.sys_I18n.text('Bridge connected (port ', undefined, undefined, String(port))})`,
								);
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
					console.warn('[API-Gateway] Heartbeat timeout, reconnecting...');
					cancelConnectionFlow();
					void scanAndConnect();
				}
			}, HEARTBEAT_TIMEOUT_MS);
		}
		catch {
			// send 失败说明已断开
			cancelConnectionFlow();
			void scanAndConnect();
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
	type: 'execute' | 'routing' | 'ping' | 'pong' | 'handshake' | 'result' | 'error';
	id?: string;
	code?: string;
	service?: string;
	result?: unknown;
	error?: string;
	timestamp?: number;
	routing?: RoutingRequest;
}

interface RoutingRequest {
	operation: 'autoRouting' | 'clearRouting';
	documentUuid: string;
	props?: IPCB_AutoRoutingProps;
	clearType?: 'all' | 'net' | 'connection';
}

interface ErrorDetails {
	name: string;
	message: string;
	stack?: string;
	code?: unknown;
	details?: unknown;
	cause?: ErrorDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function diagnosticValue(value: unknown): unknown {
	const seen = new WeakSet<object>();
	try {
		return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
			if (typeof item === 'bigint')
				return String(item);
			if (isRecord(item)) {
				if (seen.has(item))
					return '[Circular]';
				seen.add(item);
				if (item instanceof Error || Object.prototype.toString.call(item) === '[object Error]')
					return { name: item.name, message: item.message, stack: item.stack, cause: item.cause };
			}
			return item;
		}) ?? 'null');
	}
	catch {
		return String(value);
	}
}

function describeError(error: unknown, depth = 0): ErrorDetails {
	const item = isRecord(error) ? error : {};
	return {
		name: typeof item.name === 'string' ? item.name : 'Error',
		message: typeof item.message === 'string' ? item.message : String(error),
		stack: typeof item.stack === 'string' ? item.stack : undefined,
		code: diagnosticValue(item.code),
		details: diagnosticValue(item.details),
		cause: item.cause !== undefined && depth < 3 ? describeError(item.cause, depth + 1) : undefined,
	};
}

function routingError(code: string, message: string, details?: unknown): Error {
	return Object.assign(new Error(message), { code, details });
}

function validateRoutingProps(props: unknown): asserts props is IPCB_AutoRoutingProps | undefined {
	if (props === undefined)
		return;
	if (!isRecord(props) || Array.isArray(props))
		throw routingError('INVALID_ROUTING_PROPS', 'props must be an object');
	const supported = ['RoutingNets', 'ignoreNets', 'layers', 'cornerStyle', 'optimization', 'existingPrimitiveMode'];
	const unknown = Object.keys(props).filter(key => !supported.includes(key));
	if (unknown.length)
		throw routingError('INVALID_ROUTING_PROPS', `Unknown routing properties: ${unknown.join(', ')}. Use RoutingNets for network names.`);
	const names = (value: unknown): boolean => Array.isArray(value) && value.every(name => typeof name === 'string' && name.trim().length > 0);
	if (props.RoutingNets !== undefined && props.RoutingNets !== 'selected' && props.RoutingNets !== 'selectedComponents' && !names(props.RoutingNets))
		throw routingError('INVALID_ROUTING_PROPS', 'RoutingNets must be an array of network names, selected, or selectedComponents');
	if (props.ignoreNets !== undefined && !names(props.ignoreNets))
		throw routingError('INVALID_ROUTING_PROPS', 'ignoreNets must be an array of network names');
	if (props.layers !== undefined && (!Array.isArray(props.layers) || !props.layers.length || !props.layers.every(layer => layer === EPCB_LayerId.TOP || layer === EPCB_LayerId.BOTTOM || (Number.isInteger(layer) && layer >= EPCB_LayerId.INNER_1 && layer <= EPCB_LayerId.INNER_30))))
		throw routingError('INVALID_ROUTING_PROPS', 'layers must contain copper layer IDs');
	if (props.cornerStyle !== undefined && props.cornerStyle !== EPCB_AutoRoutingCornerStyle.DEGREE_45 && props.cornerStyle !== EPCB_AutoRoutingCornerStyle.DEGREE_90)
		throw routingError('INVALID_ROUTING_PROPS', 'Invalid cornerStyle');
	if (props.optimization !== undefined && props.optimization !== EPCB_AutoRoutingOptimization.COMPLETION && props.optimization !== EPCB_AutoRoutingOptimization.FASTER)
		throw routingError('INVALID_ROUTING_PROPS', 'Invalid optimization');
	if (props.existingPrimitiveMode !== undefined && props.existingPrimitiveMode !== EPCB_AutoRoutingExistingPrimitiveMode.KEEP && props.existingPrimitiveMode !== EPCB_AutoRoutingExistingPrimitiveMode.REMOVE)
		throw routingError('INVALID_ROUTING_PROPS', 'Invalid existingPrimitiveMode');
}

async function runRouting(request: RoutingRequest, report: (phase: string) => void): Promise<unknown> {
	if (!request || !['autoRouting', 'clearRouting'].includes(request.operation) || typeof request.documentUuid !== 'string' || !request.documentUuid.trim())
		throw routingError('INVALID_ROUTING_REQUEST', 'A routing operation and documentUuid are required');
	validateRoutingProps(request.props);
	report('preflight');
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (document?.documentType !== EDMT_EditorDocumentType.PCB || document.uuid !== request.documentUuid)
		throw routingError('WRONG_DOCUMENT', 'The requested PCB must have input focus', { expected: request.documentUuid, actual: document });
	if (typeof eda.pcb_Document[request.operation] !== 'function')
		throw routingError('API_UNAVAILABLE', `${request.operation} is unavailable in this EDA version`, { version: eda.sys_Environment.getEditorCurrentVersion() });
	const needsSelection = request.operation === 'clearRouting'
		? request.clearType === 'net' || request.clearType === 'connection'
		: request.props?.RoutingNets === 'selected' || request.props?.RoutingNets === 'selectedComponents';
	if (needsSelection && !(await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()).length)
		throw routingError('EMPTY_SELECTION', 'This routing operation requires selected PCB primitives');
	if (request.operation === 'clearRouting') {
		if (!request.clearType || !['all', 'net', 'connection'].includes(request.clearType))
			throw routingError('INVALID_ROUTING_PROPS', 'clearType must explicitly be all, net, or connection');
		const current = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (current?.uuid !== request.documentUuid || current.documentType !== EDMT_EditorDocumentType.PCB)
			throw routingError('WRONG_DOCUMENT', 'PCB focus changed during routing preflight');
		report('clearing');
		const cleared = await eda.pcb_Document.clearRouting(request.clearType);
		if (cleared !== true)
			throw routingError('CLEAR_ROUTING_FAILED', 'EDA did not confirm clearing the routing', { result: cleared });
		return { outcome: 'complete', cleared };
	}
	if (Array.isArray(request.props?.RoutingNets) && request.props.RoutingNets.length) {
		const nets = await eda.pcb_Net.getAllNetsName();
		const missing = request.props.RoutingNets.filter(net => !nets.includes(net));
		if (missing.length)
			throw routingError('UNKNOWN_NETS', 'Requested networks are absent from the PCB', { missing });
	}
	// Preflight awaits must not leave the operation targeting a newly focused document.
	const current = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (current?.uuid !== request.documentUuid || current.documentType !== EDMT_EditorDocumentType.PCB)
		throw routingError('WRONG_DOCUMENT', 'PCB focus changed during routing preflight');
	report('routing');
	const result = await eda.pcb_Document.autoRouting(request.props);
	if (!result || typeof result.success !== 'boolean')
		throw routingError('INVALID_ROUTING_RESULT', 'EDA returned an unrecognized routing result', { result });
	if (!result.success)
		throw routingError('ROUTING_NOT_STARTED', 'EDA reported that automatic routing did not start successfully', { result });
	if (!Number.isInteger(result.totalNetsCount) || result.totalNetsCount < 0 || !Number.isInteger(result.successNetsCount) || result.successNetsCount < 0 || result.successNetsCount > result.totalNetsCount || !Array.isArray(result.failedNets) || !result.failedNets.every(net => typeof net === 'string') || !Number.isFinite(result.duration) || result.duration < 0)
		throw routingError('INVALID_ROUTING_RESULT', 'EDA returned invalid routing statistics', { result });
	const outcome = result.failedNets.length || result.successNetsCount < result.totalNetsCount ? 'partial' : 'complete';
	report(outcome);
	return { ...result, outcome };
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

	if (msg.type === 'execute' || msg.type === 'routing') {
		const sessionId = connectionSessionId;
		const taskWindowId = windowId;
		const startedAt = Date.now();
		let phase = 'starting';
		let ownsRouting = false;
		let warningTimer: ReturnType<typeof setTimeout> | undefined;
		const send = (message: Record<string, unknown>): void => {
			if (!isConnectionSessionActive(sessionId) || windowId !== taskWindowId)
				return;
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ ...message, id: msg.id, timestamp: Date.now() }));
		};
		const report = (nextPhase: string): void => {
			phase = nextPhase;
			if (ownsRouting)
				lastRoutingStatus = `${msg.id}\n${phase}\n${msg.routing?.documentUuid}`;
			send({ type: 'progress', phase, progress: null, elapsedMs: Date.now() - startedAt });
		};
		try {
			let result: unknown;
			if (msg.type === 'routing') {
				if (!msg.id || !msg.routing)
					throw routingError('INVALID_ROUTING_REQUEST', 'Missing task ID or routing request');
				if (activeRoutingId)
					throw routingError('ROUTING_BUSY', 'Another routing operation is still running in this window', { taskId: activeRoutingId });
				activeRoutingId = msg.id;
				routingStartedAt = startedAt;
				ownsRouting = true;
				warningTimer = setTimeout(() => {
					const warning = 'Native routing call has not returned after 30 seconds. It was not cancelled; do not resubmit it.';
					lastRoutingStatus += `\n${warning}`;
					try {
						send({ type: 'progress', phase, progress: null, warning, elapsedMs: Date.now() - startedAt });
					}
					catch (error: unknown) {
						console.warn('[API-Gateway] Could not publish routing warning:', error);
					}
				}, ROUTING_WARNING_AFTER_MS);
				result = await runRouting(msg.routing, report);
			}
			else {
				if (typeof msg.code !== 'string' || !msg.code.trim())
					throw routingError('INVALID_CODE', 'Missing executable code');
				report('executing');
				const taskConsole = { ...console };
				for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
					taskConsole[level] = (...args: unknown[]): void => {
						send({ type: 'log', level, args: diagnosticValue(args) });
					};
				}
				const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
				const fn = new AsyncFunction('eda', 'console', 'execution', 'EDMT_EditorDocumentType', 'EPCB_LayerId', 'EPCB_AutoRoutingCornerStyle', 'EPCB_AutoRoutingOptimization', 'EPCB_AutoRoutingExistingPrimitiveMode', msg.code);
				result = await fn(
					eda,
					taskConsole,
					{ reportProgress: report },
					typeof EDMT_EditorDocumentType === 'undefined' ? undefined : EDMT_EditorDocumentType,
					typeof EPCB_LayerId === 'undefined' ? undefined : EPCB_LayerId,
					typeof EPCB_AutoRoutingCornerStyle === 'undefined' ? undefined : EPCB_AutoRoutingCornerStyle,
					typeof EPCB_AutoRoutingOptimization === 'undefined' ? undefined : EPCB_AutoRoutingOptimization,
					typeof EPCB_AutoRoutingExistingPrimitiveMode === 'undefined' ? undefined : EPCB_AutoRoutingExistingPrimitiveMode,
				);
			}
			phase = 'serializing';
			send({ type: 'result', result: result !== undefined ? result : null });
			if (ownsRouting)
				lastRoutingStatus = `${msg.id}\nCompleted in ${Date.now() - startedAt} ms\n${JSON.stringify(result)}`;
		}
		catch (err: unknown) {
			const errorDetails = { ...describeError(err), phase };
			if (ownsRouting)
				lastRoutingStatus = `${msg.id}\nFailed after ${Date.now() - startedAt} ms\n${JSON.stringify(errorDetails)}`;
			send({ type: 'error', error: errorDetails.message, errorDetails });
		}
		finally {
			clearTimeout(warningTimer);
			if (ownsRouting)
				activeRoutingId = null;
		}
	}
}
