VoiceCursor

# VoiceCursor 🎙️

A Windows desktop app built with **Electron** that provides near real-time speech-to-text dictation into **any active application** — VS Code, Chrome, Notepad, anywhere.

## How It Works

```
Mic → Web Audio API (PCM 16kHz) → 5s Chunks (1s overlap)
    → WebSocket → Sarvam STT
    → Delta Merger (no duplicates)
    → RobotJS keyboard injection → Active app cursor
```

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electron |
| Audio capture | Web Audio API |
| Speech-to-Text | Sarvam STT (WebSocket) |
| Keyboard injection | RobotJS |
| IPC | Electron IPC + contextBridge |

## Setup

### Prerequisites
- Node.js 18+
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (required for RobotJS native build)
- Python 3.x (required for RobotJS native build)
- A [Sarvam AI](https://dashboard.sarvam.ai) API key

### Install

```bash
npm install
```

> If RobotJS fails to build, run:
> ```bash
> npm install --global --production windows-build-tools
> npm install robotjs
> ```

### Configure API Key

Open `renderer.js` and replace the placeholder:
```js
const SARVAM_API_KEY = 'YOUR_SARVAM_API_KEY_HERE';
```

### Run

```bash
npm start
```

## Usage

- Press **Ctrl+Shift+V** to start dictating
- Press **Ctrl+Shift+V** again to stop
- Text appears at your cursor in any app

## Project Structure

```
BUlbul/
├── main.js          # Electron main process, IPC, keyboard injection
├── preload.js       # Secure IPC bridge (contextBridge)
├── renderer.js      # Audio capture, WebSocket, STT client
├── deltaMerger.js   # Delta-based transcript deduplication
├── index.html       # Minimal status UI
└── package.json
```

What I am trying to say is it's very tough to build what. To build what are you fucking doing? Yes, it's. Yes, it's going very good now. We should continue this way. We'll achieve success. We will achieve sushould I continue? Should I s wrong last ti last time. What went wred. Library Change Ho Gaya To


You know that working the way I expected you to,s is the same thing.