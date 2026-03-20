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

// ─── 状态 ───────────────────────────────────────────────────────────
let currentPort: number | null = null;
let handshakeVerified = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPending = false;
let autoConnectEnabled = true;
let retryCount = 0;
let windowId: string | null = null; // 窗口唯一标识符

/**
 * 获取当前连接状态（供 messageBus RPC 调用）
 */
function getConnectionStatus(): {
	connected: boolean;
	port: number | null;
	windowId: string | null;
} {
	return {
		connected: handshakeVerified,
		port: currentPort,
		windowId,
	};
}

// ─── 生命周期 ────────────────────────────────────────────────────────

/**
 * 扩展激活入口（支持 onStartupFinished 自动启动）
 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	autoConnectEnabled = storedValue !== false;

	if (autoConnectEnabled) {
		scanAndConnect();
	}
}

/**
 * 扩展停用时清理资源
 */
export function deactivate(): void {
	clearRetryTimer();
	stopHeartbeat();
	try {
		eda.sys_WebSocket.close(WS_ID);
	}
	catch { /* ignore */ }
}

// ─── 菜单操作 ────────────────────────────────────────────────────────

/**
 * 手动重新连接（菜单项）
 */
export function reconnect(): void {
	eda.sys_Message.showToastMessage(eda.sys_I18n.text('Reconnecting...'));
	clearRetryTimer();
	stopHeartbeat();
	handshakeVerified = false;
	retryCount = 0;
	try {
		eda.sys_WebSocket.close(WS_ID);
	}
	catch { /* ignore */ }
	scanAndConnect();
}

/**
 * 关于对话框（菜单项）
 */
export async function about(): Promise<void> {
	let status: string;

	// 通过 messageBus 获取 WebSocket 连接状态
	let statusInfo = { connected: false, port: 0, windowId: null };
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
	clearRetryTimer();
	stopHeartbeat();
	handshakeVerified = false;
	currentPort = null;
	retryCount = 0;
	try {
		eda.sys_WebSocket.close(WS_ID);
	}
	catch { /* ignore */ }
	eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
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
	clearRetryTimer();

	if (retryCount >= MAX_RETRIES) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Max retries reached'), ESYS_ToastMessageType.ERROR);
		return;
	}

	for (let port = PORT_START; port <= PORT_END; port++) {
		const found = await tryConnectToPort(port);
		if (found) {
			currentPort = port;
			retryCount = 0;
			startHeartbeat();
			return;
		}
	}

	retryCount++;
	console.warn(`[API-Gateway] No bridge server found on ports ${PORT_START}-${PORT_END}, retrying in ${RETRY_DELAY_MS}ms...`);
	eda.sys_Message.showToastMessage(
		`${eda.sys_I18n.text('Bridge not found, retrying in ', undefined, undefined, String(RETRY_DELAY_MS / 1000))} (${retryCount}/${MAX_RETRIES})`,
	);
	scheduleRetry();
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
function tryConnectToPort(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;

		let timer: ReturnType<typeof setTimeout>;

		const settle = (success: boolean, _reason: string) => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			if (!success) {
				try {
					eda.sys_WebSocket.close(WS_ID);
				}
				catch { /* ignore */ }
			}
			resolve(success);
		};

		// 先关闭旧连接（register 对同 ID 活跃连接不会更新参数）
		try {
			eda.sys_WebSocket.close(WS_ID);
		}
		catch {
			// ignore
		}

		timer = setTimeout(() => settle(false, 'timeout'), CONNECTION_TIMEOUT_MS);

		handshakeVerified = false;

		try {
			eda.sys_WebSocket.register(
				WS_ID,
				`ws://127.0.0.1:${port}/eda`,
				// 收到消息的回调（在扫描阶段处理握手，后续处理业务消息）
				async (event: MessageEvent) => {
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
									timestamp: Date.now(),
								}));
								eda.sys_Message.showToastMessage(
									`${eda.sys_I18n.text('Bridge connected (port ', undefined, undefined, String(port))})`,
								);
								// 注册 RPC 服务，供其他扩展实例（如 About 窗口）查询状态
								eda.sys_MessageBus.rpcService(MBUS_TOPIC_STATUS, () => getConnectionStatus());
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

function startHeartbeat(): void {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
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
				if (heartbeatPending) {
					console.warn('[API-Gateway] Heartbeat timeout, reconnecting...');
					stopHeartbeat();
					try {
						eda.sys_WebSocket.close(WS_ID);
					}
					catch { /* ignore */ }
					scanAndConnect();
				}
			}, HEARTBEAT_TIMEOUT_MS);
		}
		catch {
			// send 失败说明已断开
			stopHeartbeat();
			scanAndConnect();
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

function scheduleRetry(): void {
	clearRetryTimer();
	retryTimer = setTimeout(() => scanAndConnect(), RETRY_DELAY_MS);
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
