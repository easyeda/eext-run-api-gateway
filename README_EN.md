> **[English](README_EN.md)** | **[中文](README.md)**

# Run API Gateway

EasyEDA Pro Extension — Provides a WebSocket API gateway bridge service for AI coding tools (OpenCode, QwenCode, KimiCode, etc.).

## Features

- 🔌 **Auto-Connect** — Automatically scans port range 49620-49629 on startup to discover and connect to the Bridge Server
- 🤝 **Handshake Verification** — Validates service identity (`easyeda-bridge`) via HTTP `/health` and WebSocket handshake
- 🔄 **Auto-Reconnect** — Heartbeat detection + automatic port re-scanning on disconnection
- 🤖 **Code Execution** — Receives code requests from AI, executes them in the EDA environment, and returns results

## Architecture

```
┌──────────────┐  HTTP/WS    ┌─────────────────┐  WebSocket   ┌──────────┐
│  AI Agent    │ ◄─────────► │  Bridge Server  │ ◄──────────► │ Extension│
│ (Skill Tool) │ Port Range  │  (Node.js)      │  Port Range  │ (EasyEDA)│
└──────────────┘ 49620-49629 └─────────────────┘  49620-49629 └──────────┘
```

## Usage with Skill

This extension is designed to be used together with the **easyeda-api** Skill:

- Recommended install command (installs to OpenCode's global Skill directory):
  - Windows PowerShell: `npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills`
  - Windows cmd: `npx clawhub@latest install easyeda-api --workdir "%USERPROFILE%\.config\opencode" --dir skills`
  - macOS / Linux: `npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills`
- Purpose: The Skill provides the Bridge Server, EasyEDA API documentation, calling conventions, and the complete workflow between AI and EDA

## Quick Path for Power Users

If you're already familiar with the terminal, Node.js, OpenCode, and the EasyEDA extension system, you can follow the shortest path:

1. Install **Node.js 22 LTS** or higher: <https://nodejs.org/en/download>
2. Install OpenCode: `npm install -g opencode-ai`
3. Install **easyeda-api** to OpenCode's global Skill directory:
   - PowerShell: `npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills`
   - cmd: `npx clawhub@latest install easyeda-api --workdir "%USERPROFILE%\.config\opencode" --dir skills`
   - macOS / Linux: `npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills`
4. Launch OpenCode: `opencode`
5. On first use, run `/connect` to configure your API Key, or select a free model provided by OpenCode
6. Install the **Run API Gateway** extension in EasyEDA Pro, and in the extension manager check **Allow External Interaction** and **Show in Top Menu**
7. Open EasyEDA — you should see the **API Gateway** menu at the top
8. Go back to OpenCode and type: `EasyEDA, start!`

If this is your first time using these tools, please continue reading the full beginner tutorial below.

## Beginner Tutorial from Scratch

This section is written from the perspective of a "brand new computer first-time setup." Simply follow the steps in order to let OpenCode call EasyEDA Pro APIs through this extension.

### 0. What You'll End Up With

After completing this guide, you'll have:

1. **Node.js** properly installed and verified on your computer
2. **OpenCode** installed and launched
3. The **easyeda-api** Skill installed in OpenCode
4. The **Run API Gateway** extension installed and enabled in EasyEDA Pro
5. AI successfully connected to your running EDA window
6. AI able to directly call EDA APIs, such as reading current project info, getting window state, etc.

### 1. Prerequisites

Before you begin, please ensure the following:

- This tutorial assumes you're using **Windows 10** or **Windows 11**; if your system is older than **Windows 10**, please upgrade first
- If you're unsure about your Windows version, press the **Win** key, type **winver**, and press Enter
- You're familiar with using EasyEDA Pro
- Your computer has internet access for installing dependencies and downloading tools
- You can prepare your own AI model provider account or API Key; if not, you can start with the free model provided by OpenCode
- **Node.js 22 LTS** or higher is recommended for better compatibility with OpenCode and related tools
- Most advanced features in this tutorial depend on model capabilities; for more complex understanding, planning, code generation, and API call chains, choose a well-rated large model

### 2. Install Node.js

Both **OpenCode** and the Skill install commands depend on Node.js, so this is the first step.

> TIP
>
> Windows users who don't know how to open a terminal can press the **Win** key, type **PowerShell**, and click to open **Windows PowerShell** or **PowerShell**. It usually opens in your user directory by default, which is perfect for running the commands in this guide.

#### 2.1 Download and Install

Go to the official Node.js website to install **22 LTS** or higher: <https://nodejs.org/en/download>

> TIP
>
> If you're familiar with package managers, you can use your system package manager; but for most first-time users, the official installer is the easiest option.

#### 2.2 Verify Installation

After installation, open a terminal and run:

```bash
node -v
npm -v
```

If the terminal outputs version numbers like `v22.x.x` or `24.x.x`, Node.js has been successfully installed.

![Terminal showing successful `node -v` / `npm -v` output](./images/readme/init_2.png)

#### 2.3 Common Issues

- If you see `command not found`, you usually need to reopen the terminal after installation
- If you have multiple Node versions installed, make sure the current terminal is using the newer version
- Windows users are advised to reopen the terminal or restart the system before verifying

### 3. Install OpenCode

Using **npm** is recommended. Run in the terminal:

```bash
npm install -g opencode-ai
```

After installation, verify with:

```bash
opencode --version
```

If it outputs a version number, OpenCode has been successfully installed.

![Terminal showing successful OpenCode installation](./images/readme/init_3.png)

> TIP
>
> If you're using macOS / Linux, you can also use the official install script:
>
> ```bash
> curl -fsSL https://opencode.ai/install | bash
> ```

### 4. First Launch of OpenCode and Model Connection

For beginners, it's recommended to open a terminal directly in your "user directory" and run **OpenCode** — don't worry about "working directory" yet.

- Windows users: After opening **PowerShell**, you're usually already in your user directory
- macOS / Linux users: After opening the terminal, you're usually also in your user directory

In most cases, just open the terminal and run:

```bash
opencode
```

![OpenCode first launch interface](./images/readme/init_4_1.png)

On first use, complete these initialization steps:

1. If you have a model provider subscription, run `/connect` in OpenCode; otherwise skip to step 5
2. Select your model provider
   ![`/connect` model provider configuration](./images/readme/init_4_2.png)
3. Follow the prompts to sign in or enter your API Key
4. After seeing the connection success message, return to the main interface
5. Run `/models` in OpenCode to switch models (you can choose a free model or a paid model from your connected provider)
   ![`/models` model selection interface](./images/readme/init_4_3.png)

If this step is not completed, even with the Skill and extension installed, OpenCode won't be able to call EDA.

> TIP
>
> Free models can provide a basic experience, but many capabilities in this tutorial — especially complex instruction understanding, multi-step planning, long-chain calls, and result summarization — are significantly affected by model capabilities. For more stable full-flow testing, choose a well-rated large model.

### 5. Install the EasyEDA API Skill

This extension itself only handles "connecting EDA to the bridge network." The actual Bridge Server startup, API documentation, and AI calling guidance are provided by the **easyeda-api** Skill.

To make it available for all projects, install the Skill to OpenCode's global Skill scan directory.

OpenCode's common global Skill scan paths include:

- `~/.agents/skills/`
- `~/.config/opencode/skills/`

`~/.config/opencode/skills/` is the recommended installation target.

#### 5.1 Install via ClawHub One-Liner

For most users, simply open a terminal and run the command matching your system and terminal type:

If you're following this guide from scratch on **Windows** and have been using **PowerShell**, run the **Windows PowerShell** command below — you don't need the **Windows cmd** one.

**Windows PowerShell**

```powershell
npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills
```

**Windows cmd**

```bat
npx clawhub@latest install easyeda-api --workdir "%USERPROFILE%\.config\opencode" --dir skills
```

**macOS / Linux**

```bash
npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills
```

What this command does:

- `--workdir ...`: Fixes the installation location to OpenCode's global config directory
- `--dir skills`: Places the Skill in the `skills/` folder that OpenCode auto-scans

After execution, the target directory should be:

- Windows PowerShell: `$HOME/.config/opencode/skills/easyeda-api`
- Windows cmd: `%USERPROFILE%\.config\opencode\skills\easyeda-api`
- macOS / Linux: `~/.config/opencode/skills/easyeda-api`

![Installing Skill](./images/readme/init_5_1.png)

#### 5.2 Manual Download and Installation if Command Fails

If you encounter network restrictions, `npx` is unavailable, `clawhub` can't run properly, or you simply prefer manual installation, you can download the archive directly and place it in the local Skill directory.

Manual download URL:

- <https://image.lceda.cn/files/easyeda-api.zip>

Manual installation steps:

1. Download `easyeda-api.zip` from the link above
2. Find or create a `skills` folder in OpenCode's global Skill directory
3. Create an `easyeda-api` folder inside `skills`
4. Extract `easyeda-api.zip` into the `easyeda-api` folder
5. After extraction, verify the directory structure is correct

Recommended target paths:

- Windows: `%USERPROFILE%\.config\opencode\skills\easyeda-api`
- macOS / Linux: `~/.config/opencode/skills/easyeda-api`

After extraction, the `easyeda-api` folder should contain:

- `SKILL.md`
- `package.json`
- `guide/`
- `references/`
- `user-guide/`

Important: Do not create nested directories.

- Correct: `~/.config/opencode/skills/easyeda-api/SKILL.md`
- Wrong: `~/.config/opencode/skills/easyeda-api/easyeda-api/SKILL.md`

#### 5.3 After Installation

After installation, it's recommended to restart OpenCode or have it re-read the current environment.

If you later use OpenCode in a specific project directory (e.g., pro-api-sdk), you can also run:

```text
/init
```

This lets OpenCode initialize the project context for better understanding of your codebase; however, this is not a prerequisite for connecting to EDA.

Use `/skills` to confirm the Skill is installed:

![OpenCode interface after recognizing the Skill](./images/readme/init_5_2.png)

### 6. Install the Extension in EasyEDA Pro

Next, install the **Run API Gateway** extension on the EDA side.

Extension URL:

- https://ext.lceda.cn/item/oshwhub/run-api-gateway

After installation, go to EasyEDA's extension manager, find **Run API Gateway**, and ensure these options are checked:

- **Allow External Interaction**
- **Show in Top Menu**

![Extension manager with Allow External Interaction and Show in Top Menu checked](./images/readme/init_6.png)

After checking these, confirm that the **API Gateway** menu appears in the top menu or related area.

If you can see the following menu items, the extension has loaded successfully:

- **Reconnect**
- **Stop Connection**
- **Toggle Auto-Connect Status**
- **About...**

### 7. Open EDA and Wait for Extension Connection

As long as EasyEDA Pro is running and the extension is loaded, the connection can be established.

This extension automatically scans port range `49620-49629` after loading to find the Bridge Server launched by the Skill. Once the Bridge Server is up, the extension will attempt to connect automatically.

You don't need to manually enter an IP or port — the default workflow automates this process.

> TIP
>
> If you've already opened EDA but don't see any connection activity, or if the connection has failed after 5 retries, manually click:
>
> - **API Gateway** → **Reconnect**

![Retry prompt when not connected](./images/readme/init_7.png)

### 8. Issue the Start Command in OpenCode

Now go back to OpenCode and type:

```text
EasyEDA, start!
```

Or be more explicit:

```text
Please use the easyeda-api Skill to connect to my currently open EasyEDA Pro window and check the connection status.
```

OpenCode will then:

1. Read the **easyeda-api** Skill's workflow instructions
2. Start or verify the Bridge Server
3. Check service status via `/health`
4. Complete handshake with the **Run API Gateway** extension on the EDA side
5. Prepare to execute subsequent API calls after successful connection

If everything works, you'll see results like:

- Bridge Server started
- EDA client found
- Bridge connected
- Ready to execute API calls
- Connected
- Ready to work

![OpenCode interface after typing "EasyEDA, start!"](./images/readme/init_8_1.png)

![Connection success prompt](./images/readme/init_8_2.png)

### 9. Verify That EDA Can Actually Be Called

After connection succeeds, don't rush into complex operations — run a simple verification command first.

You can type something like this in OpenCode:

```text
Please check if the current EasyEDA window has connected successfully, and return the current window state, editor type, and whether a project is currently open.
```

Or:

```text
Do a read-only verification: if no project is currently open, also tell me whether the current EDA environment can normally receive API calls.
```

If the call succeeds, OpenCode will return actual execution results from EDA, not just theoretical explanations.

This confirms the following chain is fully connected:

**OpenCode** → **easyeda-api Skill** → **Bridge Server** → **Run API Gateway** → **EasyEDA Pro**

### 10. Recommended Complete Operation Order for Beginners

If you want to follow along step by step, execute in this order:

If you're following this guide from scratch on **Windows**, use the command marked **Windows PowerShell** below; only use the **Windows cmd** version if you're certain you're using cmd.

```bash
# 1) Install and verify Node.js
node -v
npm -v

# 2) Install OpenCode
npm install -g opencode-ai
opencode --version

# 3) Install easyeda-api Skill to OpenCode's global Skill directory
# Windows PowerShell
npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills

# Windows cmd
npx clawhub@latest install easyeda-api --workdir "%USERPROFILE%\.config\opencode" --dir skills

# macOS / Linux
npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills

# 4) Launch OpenCode
opencode
```

After entering OpenCode, complete these steps in order:

1. Run `/connect` to configure your model provider, or select a free model
2. Run `/init` if needed
3. Open EasyEDA Pro and ensure **Run API Gateway** is installed
4. In the extension manager, confirm **Allow External Interaction** and **Show in Top Menu** are checked
5. In OpenCode, type: `EasyEDA, start!`
6. After successful connection, have AI execute a simple read-only API query to verify

### 11. Troubleshooting Connection Failures

If you've followed the steps but still can't connect, try these troubleshooting steps in order:

#### 11.1 Check if OpenCode is Available

```bash
opencode --version
```

If this fails, go back to step 3 and reinstall OpenCode.

#### 11.2 Check if the Skill is Installed

Go back to OpenCode and type:

```text
/skills
```

Check if **easyeda-api** appears in the skill list.

- If you see **easyeda-api**, the Skill is installed successfully
- If not, run the install command again for your terminal type:

If you're following this guide from scratch on **Windows** and have been using **PowerShell**, use the **Windows PowerShell** command below.

```powershell
# Windows PowerShell
npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills

# Windows cmd
npx clawhub@latest install easyeda-api --workdir "%USERPROFILE%\.config\opencode" --dir skills

# macOS / Linux
npx clawhub@latest install easyeda-api --workdir "$HOME/.config/opencode" --dir skills
```

If the command still fails, refer to [5.2 Manual Download and Installation if Command Fails](#52-manual-download-and-installation-if-command-fails) for manual installation steps.

Errors during installation are usually related to Node.js, network, or npm permissions.

#### 11.3 Check if the EDA Extension is Actually Loaded

Confirm whether you can see the **API Gateway** menu in EasyEDA, and verify that **Allow External Interaction** and **Show in Top Menu** are checked in the extension manager. If the menu doesn't appear, the extension isn't running.

#### 11.4 Check if EDA is Running

This extension doesn't require you to open a project first. As long as EasyEDA is running and the extension is loaded, connection is possible.

#### 11.5 Manually Trigger Reconnection

In the EDA top menu, click:

- **API Gateway** → **Reconnect**

Then go back to OpenCode and try again:

```text
Please reconnect to EasyEDA and check the current bridge status.
```

#### 11.6 Complete Restart

If nothing works, the most effective approach is to restart everything in this order:

1. Close OpenCode
2. Close EasyEDA Pro
3. Reopen EasyEDA and confirm the extension is loaded
4. Return to your user directory or usual working directory, and relaunch `opencode`
5. Run the connection command again

### 12. Example Prompts to Copy-Paste into OpenCode

These prompts are suitable for first verification after installation:

```text
Please use the easyeda-api Skill to connect to the currently open EasyEDA Pro window and tell me if the connection succeeded.
```

```text
If connected successfully, please return the current EDA window state, editor type, and whether a project is currently open.
```

```text
Please do not modify the project — just do a read-only check to confirm that my current EDA environment can normally call APIs.
```

```text
Please list the EasyEDA-related capabilities you can currently call, and tell me what I can do next.
```

### 13. What Each Component Does in This Setup

To avoid confusion, here's a summary of each component's responsibility:

- **Node.js**: Provides the runtime environment for OpenCode and related commands
- **OpenCode**: Your interface for interacting with AI
- **easyeda-api** Skill: Tells the AI how to connect to and call EDA, and manages the Bridge Server workflow
- **Run API Gateway** Extension: Runs inside EasyEDA, responsible for receiving bridge requests and executing code
- **EasyEDA Pro**: The actual target application being operated on

Understanding this makes troubleshooting much faster:

- OpenCode not installed → AI can't start at all
- Skill not installed → AI doesn't know how to connect to EDA
- Extension not installed → EDA can't receive requests
- EDA not open → Even with the bridge set up, there's no window to operate on

### 14. Additional Notes: Developer Local Debug Mode

If you're not a regular user but are debugging the `easyeda-api-skill` repository locally, you can manually start the Bridge Server:

```bash
cd /path/to/easyeda-api-skill
npm install
npm run server
```

The server will automatically find an available port between `49620-49629`. Then open EasyEDA with this extension loaded to enter local debug mode.

However, for most users, the recommended approach is the standard flow above — using OpenCode + **easyeda-api** Skill for automatic connection.

## Menu Operations

| Menu Item | Description |
|-----------|-------------|
| **Reconnect** | Manually re-scan ports and connect to Bridge Server |
| **Stop Connection** | Disconnect the current connection |
| **Toggle Auto-Connect Status** | Toggle automatic connection on/off |
| **About...** | Show version and connection status |

## Development

```bash
# Install dependencies
npm install

# Build extension package
npm run build
```

The build generates `.eext` extension package files in `./build/dist/`, which can be installed in EasyEDA Pro.

## License

This extension is licensed under the [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/).
