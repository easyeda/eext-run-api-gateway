# Run API Gateway

[English](./README.en.md) · [FAQ 简体中文](./FAQ.md) · [FAQ English](./FAQ.en.md)

嘉立创EDA 专业版扩展 — 为 AI 编程工具（OpenCode、Claude Code、Cursor、Cline、Continue、Windsurf、WorkBuddy、QwenCode、KimiCode、Trae 等）提供 WebSocket API 网关桥接服务。

## 功能

- 🔌 **自动连接** — 启动时自动扫描端口范围 49620-49629，发现并连接 Bridge Server
- 🤝 **握手验证** — 通过 WebSocket handshake 验证服务身份 (`easyeda-bridge`)
- 🔄 **自动重连** — 心跳检测 + 断线自动重新扫描端口
- 🤖 **代码执行** — 接收来自 AI 的代码请求，在 EDA 环境中执行并返回结果

## 架构

```
┌──────────────┐  HTTP/WS    ┌─────────────────┐  WebSocket   ┌──────────┐
│  AI Agent    │ ◄─────────► │  Bridge Server  │ ◄──────────► │ 本扩展    │
│ (Skill Tool) │ Port Range  │  (Node.js)      │  Port Range  │ (EasyEDA)│
└──────────────┘ 49620-49629 └─────────────────┘  49620-49629 └──────────┘
```

## 配合使用

本扩展需要配合 **easyeda-api** Skill 一起使用。该 Skill 负责启动 Bridge Server、提供 EasyEDA API 文档与调用约定，并负责 AI 与 EDA 之间的完整工作流。

## 快速开始

如果你已经熟悉终端、Node.js 和嘉立创EDA 扩展系统，可以直接走最短路径：

1. 安装 **Node.js 22 LTS** 或更高版本：<https://nodejs.org/zh-cn/download>
2. 安装你的 AI 编程工具（任选其一）：
  - **OpenCode**：`npm install -g opencode-ai`
  - **Claude Code / QwenCode / KimiCode / WorkBuddy**：参考各自官网的安装说明
  - **Cursor / Windsurf / Trae**：从官网下载安装包双击安装
  - **Cline / Continue**：在 VS Code 扩展商店搜索安装
3. 把 **easyeda-api** 安装到 AI 工具的全局 Skill 目录：

  **让 AI Agent 一句话代为安装**（推荐）：根据你使用的工具复制对应版本发给它：

  - **OpenCode**：
    > 请帮我从 <https://github.com/easyeda/easyeda-api-skill> 安装 easyeda-api skill 到 OpenCode 的全局 Skill 目录

  - **Claude Code**：
    > 请帮我从 <https://github.com/easyeda/easyeda-api-skill> 安装 easyeda-api skill 到 Claude Code 的全局 Skill 目录

  - **Cursor / Cline / Continue / Windsurf / WorkBuddy / QwenCode / KimiCode / Trae**：
    > 请帮我从 <https://github.com/easyeda/easyeda-api-skill> 下载并安装 easyeda-api skill

  **手动下载并解压**：如果手边没有 AI Agent，可以下载 zip 后解压到全局 Skill 目录：
  - 下载地址：<https://image.lceda.cn/files/easyeda-api-skill.zip>
  - 解压目标：`~/.config/opencode/skills/easyeda-api/`（OpenCode 路径；其他工具请参考各自文档的全局 skills 目录）
  - 详细步骤见 [FAQ.md § 5.2](./FAQ.md#52-如果命令安装失败如何手动下载并安装-skill)

  进阶用户也可以使用 `npx clawhub@latest install ...` 的命令行方式，详见 [FAQ.md § 5.1](./FAQ.md#51-从-clawhub-单行命令安装)。
4. 启动 AI 工具：
  - **OpenCode / Claude Code / QwenCode / KimiCode**：在终端运行 `opencode` / `claude` / `qwencode` / `kimi`（或对应命令）
  - **Cursor / Windsurf / Trae / WorkBuddy**：双击桌面图标启动
  - **Cline / Continue**：打开 VS Code
5. 首次使用时按工具提示登录或选择模型，OpenCode 中可执行 `/connect` 选择免费模型
6. 在嘉立创EDA 专业版安装 **Run API Gateway** 扩展，并在扩展管理器中勾选 **允许外部交互** 与 **显示在顶部菜单**
7. 打开嘉立创EDA，看到顶部 **API Gateway** 菜单即可
8. 回到 AI 工具，使用 `/easyeda-api skill` 让它帮你做事，例如：
  - `使用 /easyeda-api skill 帮我检查当前原理图`
  - `使用 /easyeda-api skill 帮我画一个 NE555 最小系统`

如果你是首次接触这些工具，请阅读 [FAQ.md](./FAQ.md) 中的「从零开始使用教程」章节，里面有完整的逐步说明。

## 菜单操作

| 菜单项 | 说明 |
|--------|------|
| **Reconnect** | 手动重新扫描端口并连接 Bridge Server |
| **Stop Connection** | 断开当前连接 |
| **Toggle Auto-Connect Status** | 切换自动连接状态 |
| **About...** | 显示版本和连接状态 |

## 进阶内容

连接失败、命令提示词、各组件职责、开发者本地调试模式等内容请查阅：

- [FAQ 简体中文](./FAQ.md) — 详细的环境准备、安装步骤、故障排查与示例
- [FAQ English](./FAQ.en.md) — Detailed setup, troubleshooting and examples

也可直接访问 GitHub 在线版本：

- <https://github.com/easyeda/eext-run-api-gateway/blob/main/FAQ.md>
- <https://github.com/easyeda/eext-run-api-gateway/blob/main/FAQ.en.md>

## 开源许可

本扩展使用 [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/) 开源许可协议。
