# Run API Gateway

[简体中文](./README.md) · [FAQ 简体中文](./FAQ.md) · [FAQ English](./FAQ.en.md)

EasyEDA Pro extension — provides a WebSocket API gateway bridge for AI coding tools (OpenCode, Claude Code, Cursor, Cline, Continue, Windsurf, WorkBuddy, QwenCode, KimiCode, Trae, etc.).

## Features

- 🔌 **Auto-Connect** — On startup, automatically scans port range 49620-49629 to discover and connect to the Bridge Server.
- 🤝 **Handshake Verification** — Verifies the service identity through a WebSocket handshake (`easyeda-bridge`).
- 🔄 **Auto-Reconnect** — Heartbeat detection + automatic port re-scan on disconnect.
- 🤖 **Code Execution** — Receives code requests from AI, executes them inside the EDA environment, and returns results.

## Architecture

```
┌──────────────┐  HTTP/WS    ┌─────────────────┐  WebSocket   ┌──────────┐
│  AI Agent    │ ◄─────────► │  Bridge Server  │ ◄──────────► │ Extension│
│ (Skill Tool) │ Port Range  │  (Node.js)      │  Port Range  │ (EasyEDA)│
└──────────────┘ 49620-49629 └─────────────────┘  49620-49629 └──────────┘
```

## Companion Skill

This extension must be used together with the **easyeda-api** Skill. That Skill is responsible for starting the Bridge Server, providing EasyEDA API documentation and calling conventions, and orchestrating the full workflow between AI and EDA.

## Quick Start

If you are already familiar with the terminal, Node.js, and the EasyEDA extension system, follow the shortest path:

1. Install **Node.js 22 LTS** or higher: <https://nodejs.org/en/download>
2. Install your AI coding tool (pick one):
  - **OpenCode**: `npm install -g opencode-ai`
  - **Claude Code / QwenCode / KimiCode / WorkBuddy**: see each tool's official install guide
  - **Cursor / Windsurf / Trae**: download the installer from the official site
  - **Cline / Continue**: install from the VS Code extension marketplace
3. Install **easyeda-api** to your AI tool's global Skill directory:

  **Let your AI Agent install it with one sentence** (recommended): copy the version matching your tool:

  - **OpenCode**:
    > Please install the easyeda-api skill from <https://github.com/easyeda/easyeda-api-skill> into OpenCode's global Skill directory.

  - **Claude Code**:
    > Please install the easyeda-api skill from <https://github.com/easyeda/easyeda-api-skill> into Claude Code's global Skill directory.

  - **Cursor / Cline / Continue / Windsurf / WorkBuddy / QwenCode / KimiCode / Trae**:
    > Please download and install the easyeda-api skill from <https://github.com/easyeda/easyeda-api-skill>.

  **Manual download and unzip**: if you don't have an AI Agent at hand, download the zip and unzip it into the global Skill directory:
  - Download: <https://image.lceda.cn/files/easyeda-api-skill.zip>
  - Unzip target: `~/.config/opencode/skills/easyeda-api/` (OpenCode path; for other tools, see your tool's docs for its global skills directory)
  - For full steps, see [FAQ.en.md § 5.2](./FAQ.en.md#52-manual-install-if-the-command-fails)

  Advanced users can also use the `npx clawhub@latest install ...` command-line method — see [FAQ.en.md § 5.1](./FAQ.en.md#51-one-line-install-via-clawhub).
4. Start your AI tool:
  - **OpenCode / Claude Code / QwenCode / KimiCode**: in the terminal, run `opencode` / `claude` / `qwencode` / `kimi` (or the matching command)
  - **Cursor / Windsurf / Trae / WorkBuddy**: double-click the desktop icon
  - **Cline / Continue**: open VS Code
5. On first use, follow the in-tool prompts to log in or pick a model. In OpenCode you can run `/connect` to choose a free model.
6. Install the **Run API Gateway** extension in EasyEDA Pro, and make sure both **Allow External Interaction** and **Show in Top Menu** are enabled in the Extension Manager.
7. Open EasyEDA and confirm the **API Gateway** menu appears at the top.
8. Return to your AI tool and trigger it with `/easyeda-api skill ...`, for example:
  - `Use /easyeda-api skill to inspect my current schematic.`
  - `Use /easyeda-api skill to draw a NE555 minimal circuit.`

If this is your first time with these tools, please read the "From-Scratch Tutorial" section in [FAQ.md](./FAQ.md) for a full step-by-step walkthrough.

## Menu Operations

| Menu Item | Description |
|-----------|-------------|
| **Reconnect** | Manually re-scan ports and connect to the Bridge Server. |
| **Stop Connection** | Disconnect the current session. |
| **Toggle Auto-Connect Status** | Toggle the auto-connect switch. |
| **About...** | Show the extension version and current connection status. |

## Advanced Topics

For connection failures, prompt examples, component responsibilities, and developer-mode debugging, see:

- [FAQ 简体中文](./FAQ.md) — Detailed environment prep, installation steps, troubleshooting and examples
- [FAQ English](./FAQ.en.md) — Detailed setup, troubleshooting and examples

You can also read them directly on GitHub:

- <https://github.com/easyeda/eext-run-api-gateway/blob/main/FAQ.md>
- <https://github.com/easyeda/eext-run-api-gateway/blob/main/FAQ.en.md>

## License

This extension is licensed under the [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/).
