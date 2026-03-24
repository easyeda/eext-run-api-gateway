# Run API Gateway

嘉立创EDA 专业版扩展 — 为 AI 编程工具（Claude Code、OpenCode、QwenCode 等）提供 WebSocket API 网关桥接服务。

## 功能

- 🔌 **自动连接** — 启动时自动扫描端口范围 49620-49629，发现并连接 Bridge Server
- 🤝 **握手验证** — 通过 HTTP `/health` 和 WebSocket handshake 验证服务身份 (`easyeda-bridge`)
- 🔄 **自动重连** — 心跳检测 + 断线自动重新扫描端口
- 🤖 **代码执行** — 接收来自 AI 的代码请求，在 EDA 环境中执行并返回结果

## 架构

```
┌──────────────┐  HTTP/WS   ┌─────────────────┐  WebSocket   ┌──────────┐
│  AI Agent    │ ◄────────► │  Bridge Server  │ ◄──────────► │ 本扩展    │
│ (Skill Tool) │ Port Range │  (Node.js)      │  Port Range  │ (EasyEDA)│
└──────────────┘ 49620-629  └─────────────────┘  49620-629   └──────────┘
```

## 配合使用

本扩展需要配合 EasyEDA skill 一起使用：

- 安装命令：`npx clawhub@latest install easyeda-api`
- 用途：该 skill 提供 Bridge Server、EasyEDA API 参考文档以及 AI 调用网关所需的工作流

### 使用教程

1. 先在 AI 工具环境中安装 skill：`npx clawhub@latest install easyeda-api`
2. 在嘉立创EDA中安装本扩展
3. 确保扩展已成功加载，顶部菜单栏出现 **API Gateway**
4. 在 AI 工具中输入：`嘉立创EDA，启动！`
5. AI 工具会根据 EasyEDA skill 的工作流启动 Bridge Server，并开始连接本扩展
6. 连接成功后，AI 工具即可通过 Bridge Server 向嘉立创EDA发送代码执行请求

如果需要重新建立连接，可在嘉立创EDA顶部菜单中点击 **重新连接**；如需停止当前连接，可点击 **停止连接**。

## 菜单操作

| 菜单项 | 说明 |
|--------|------|
| **Reconnect** | 手动重新扫描端口并连接 Bridge Server |
| **Stop Connection** | 断开当前连接 |
| **Toggle Auto-Connect Status** | 切换自动连接状态 |
| **About...** | 显示版本和连接状态 |

## 开发

```bash
# 安装依赖
npm install

# 编译扩展包
npm run build
```

编译后在 `./build/dist/` 下生成 `.eext` 扩展包文件，可在嘉立创EDA专业版中安装。

## 开源许可

本扩展使用 [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/) 开源许可协议。
