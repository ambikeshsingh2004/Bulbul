const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, dialog } = require('electron');
const path = require('path');
const { Readable } = require('stream');
const DeltaMerger = require('./deltaMerger');

require('dotenv').config();

const { SarvamAIClient } = require('sarvamai');
const sarvam = new SarvamAIClient({
  apiSubscriptionKey: process.env.SARVAM_API_KEY
});


// RobotJS - keyboard injection
let robot;
try {
  robot = require('robotjs');
  console.log('[Main] robotjs loaded OK');
} catch (e) {
  console.warn('[Main] robotjs not available - text will be logged only.');
  console.warn('[Main] Fix: npx electron-rebuild -f -w robotjs');
}

// Win32 APIs via koffi
// GetForegroundWindow : captures the locked target when recording starts
// IsWindow            : checks if the locked target is still alive
// SendMessageW        : sends WM_CHAR directly to window (no focus needed)
// PostMessageW        : async variant for non-blocking char delivery
let GetForegroundWindow = null;
let SetForegroundWindow = null;
let IsWindow = null;
let SendMessageW = null;
let PostMessageW = null;
let GetClassNameW = null;
let AttachThreadInput = null;
let GetWindowThreadProcessId = null;
let GetCurrentThreadId = null;
let SetFocus = null;
let keybdEvent = null;

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
  SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr']);
  IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', ['intptr']);
  SendMessageW = user32.func('__stdcall', 'SendMessageW', 'intptr', ['intptr', 'uint32', 'intptr', 'intptr']);
  PostMessageW = user32.func('__stdcall', 'PostMessageW', 'bool', ['intptr', 'uint32', 'intptr', 'intptr']);
  GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int32', ['intptr', 'void *', 'int32']);
  AttachThreadInput = user32.func('__stdcall', 'AttachThreadInput', 'bool', ['uint32', 'uint32', 'bool']);
  GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', 'void *']);
  SetFocus = user32.func('__stdcall', 'SetFocus', 'intptr', ['intptr']);
  keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'intptr']);
  GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);

  console.log('[Main] Win32 window APIs ready (koffi)');
} catch (e) {
  console.warn('[Main] koffi not available - run: npm install koffi');
}



// ── State ──────────────────────────────────────────────────────────────
let tray = null;
let hiddenWindow = null;
let welcomeWindow = null;   // onboarding screen shown on launch
let indicatorWindow = null; // small always-on-top recording indicator
let notificationWindow = null; // custom popup for focus warning
let isRecording = false;
let lockedHWND = null;   // the ONE window we are allowed to type into
const deltaMerger = new DeltaMerger();
const processedChunks = new Set();

// Serial chunk queue — ensures chunks are transcribed ONE AT A TIME in order.
// Without this, concurrent API calls return out of order and delta merger
// produces garbled interleaved text.
let chunkQueue = Promise.resolve();
let blinkInterval = null;  // for tray icon blinking
let blinkState = false; // toggles between mic and red dot

// Polling interval to check if the locked target window still exists
let targetWatchInterval = null;
// Focus enforcer: keeps locked window in foreground while recording
let focusEnforcerInterval = null;

// ── Icon helpers ──────────────────────────────────────────────────────────
// Creates a solid 16x16 colored icon from raw RGBA pixels (no file needed)
function createColorIcon(r, g, b, a = 255) {
  const size = 16;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const px = i * 4;
    // Draw a circle (pixels within radius 7 from center get the color)
    const x = i % size - 7.5;
    const y = Math.floor(i / size) - 7.5;
    const inside = (x * x + y * y) <= 49; // radius 7
    data[px] = inside ? r : 0;
    data[px + 1] = inside ? g : 0;
    data[px + 2] = inside ? b : 0;
    data[px + 3] = inside ? a : 0;
  }
  return nativeImage.createFromBuffer(data, { width: size, height: size });
}

let iconNormal = null; // set after app ready
const iconRed = createColorIcon(220, 30, 30);   // vivid red circle (recording)
const iconBlank = createColorIcon(0, 0, 0, 0);    // transparent (blink-off state)

// ── Tray helpers ────────────────────────────────────────────────────────
function startBlink() {
  stopBlink();
  blinkState = false;
  blinkInterval = setInterval(() => {
    if (!tray) return;
    // Toggle between vivid red circle and transparent — very visible
    tray.setImage(blinkState ? iconRed : iconBlank);
    blinkState = !blinkState;
  }, 500); // blink every 500ms
}

function stopBlink() {
  if (blinkInterval) {
    clearInterval(blinkInterval);
    blinkInterval = null;
  }
  // Restore normal icon
  if (tray && iconNormal) tray.setImage(iconNormal);
}

function updateTray() {
  if (!tray) return;
  const tooltip = isRecording
    ? '🔴 Dictating → ' + (lockedHWND ? `HWND:${lockedHWND}` : 'Unknown target')
    : '🎙️ VoiceCursor — Ready';
  tray.setToolTip(tooltip);

  const menu = Menu.buildFromTemplate([
    {
      label: isRecording ? '⏹  Stop Dictation' : '▶  Start Dictation',
      click: toggleRecording
    },
    { type: 'separator' },
    { label: 'Quit VoiceCursor', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

// ── Check that the locked target window is still alive ──────────────────
function startTargetWatcher() {
  stopTargetWatcher();
  if (!IsWindow || !lockedHWND) return;

  targetWatchInterval = setInterval(() => {
    if (!isRecording) return stopTargetWatcher();

    const alive = IsWindow(lockedHWND);
    if (!alive) {
      console.warn('[Main] Locked target window was closed! Stopping dictation.');
      stopDictation();
      tray && tray.displayBalloon({
        title: 'VoiceCursor — Target Closed',
        content: 'The target window was closed. Dictation stopped.',
        iconType: 'warning'
      });
    }
  }, 1000); // poll every 1 second
}

function stopTargetWatcher() {
  if (targetWatchInterval) {
    clearInterval(targetWatchInterval);
    targetWatchInterval = null;
  }
}

// ── Focus enforcer ──────────────────────────────────────────────────────────
// While recording, polls every 200ms and pushes the locked target back to
// foreground if anything else has stolen focus.
// This guarantees plain Ctrl+V always lands in the right place.
function startFocusEnforcer() {
  // Disabled: Users want to be able to switch windows while speaking.
  // The injection logic will temporarily focus the target window when text
  // is actually ready to be inserted.
}

function stopFocusEnforcer() {
  // Disabled
}

// ── Start / Stop dictation ───────────────────────────────────────────────
function startDictation() {
  if (isRecording) return;

  // Capture the currently focused window as the locked target
  if (GetForegroundWindow) {
    lockedHWND = GetForegroundWindow();
    console.log(`[Main] Locked target window: HWND=${lockedHWND}`);
  } else {
    lockedHWND = null;
    console.warn('[Main] koffi unavailable — no window locking');
  }

  isRecording = true;
  deltaMerger.reset();
  processedChunks.clear();
  updateTray();
  startBlink();
  showIndicator();
  startTargetWatcher();
  startFocusEnforcer(); // keep locked window in foreground while recording

  if (hiddenWindow) hiddenWindow.webContents.send('toggle-recording', true);
  console.log('[Main] Dictation STARTED — focus locked to HWND', lockedHWND);
}

function stopDictation() {
  if (!isRecording) return;
  isRecording = false;
  lockedHWND = null;
  deltaMerger.reset();
  processedChunks.clear();
  chunkQueue = Promise.resolve();
  // Clear any pending paste operations so they don't fire after stop
  pasteQueue = [];
  pasteActive = false;
  stopFocusEnforcer(); // allow user to freely switch windows again
  stopBlink();
  hideIndicator();
  stopTargetWatcher();
  updateTray();

  if (hiddenWindow) hiddenWindow.webContents.send('toggle-recording', false);
  console.log('[Main] Dictation STOPPED — focus released');
}

// ── Recording indicator overlay ──────────────────────────────────────────
// A small always-on-top window in the top-right corner that pulses
// red while recording — much more visible than the tray icon.
function showIndicator() {
  if (indicatorWindow && !indicatorWindow.isDestroyed()) {
    indicatorWindow.show();
    return;
  }

  const { width } = require('electron').screen.getPrimaryDisplay().workAreaSize;

  indicatorWindow = new BrowserWindow({
    width: 64,
    height: 64,
    x: width - 80,  // 16px from right edge
    y: 16,          // 16px from top
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,       // never steals focus
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  indicatorWindow.loadFile('indicator.html');
  indicatorWindow.setIgnoreMouseEvents(true); // click-through
}

function hideIndicator() {
  if (indicatorWindow && !indicatorWindow.isDestroyed()) {
    indicatorWindow.hide();
  }
}

// ── Custom Notification Popup ─────────────────────────────────────────────
// Safely shows an HTML-based notification that ignores Windows Focus Assist.
function showCustomNotification() {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    // If already showing, just extend the timer and shake it
    notificationWindow.showInactive();
    return;
  }

  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const w = 320;
  const h = 80;

  notificationWindow = new BrowserWindow({
    width: w,
    height: h,
    x: width / 2 - w / 2,     // center horizontal
    y: height / 2 - h / 2,    // center vertical
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,       // never steal focus
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  notificationWindow.loadFile('notification.html');
  notificationWindow.setIgnoreMouseEvents(true); // click-through

  // Show without stealing focus
  notificationWindow.showInactive();

  // Auto close after 3 seconds
  setTimeout(() => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.close();
      notificationWindow = null;
    }
  }, 3000);
}


function toggleRecording() {

  if (isRecording) stopDictation();
  else startDictation();
}

// ── WAV Buffer ───────────────────────────────────────────────────────────
function buildWavBuffer(pcmBytes, sampleRate = 16000, numChannels = 1, bitDepth = 16) {
  const dataLen = pcmBytes.length;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);

  header.write('RIFF', 0); header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36); header.writeUInt32LE(dataLen, 40);

  return Buffer.concat([header, Buffer.from(pcmBytes)]);
}

// ── Clipboard-based text injection ───────────────────────────────────────
// Pastes entire text at once via Ctrl+V (no autocomplete triggered).
// Briefly focuses target window for the paste, then restores focus.
// A serialized queue ensures multiple chunks never overlap.

let pasteQueue = [];       // Array<string> — text segments waiting to be pasted
let pasteActive = false;   // true while the drain loop is running

function drainPasteQueue() {
  if (!pasteActive || pasteQueue.length === 0) {
    pasteActive = false;
    return;
  }

  // Abort if target window is gone
  if (IsWindow && lockedHWND && !IsWindow(lockedHWND)) {
    pasteQueue = [];
    pasteActive = false;
    console.warn('[Main] Target window gone — cleared paste queue.');
    return;
  }

  const text = pasteQueue.shift();
  if (!text || !text.trim()) {
    setTimeout(drainPasteQueue, 50);
    return;
  }

  if (!robot) {
    console.log(`[Main] [MOCK] Would inject: "${text}"`);
    setTimeout(drainPasteQueue, 50);
    return;
  }

  const { clipboard } = require('electron');
  const previousClipboard = clipboard.readText();

  // Remember what user is looking at
  const userHWND = GetForegroundWindow ? GetForegroundWindow() : null;

  // Briefly switch to target, paste, switch back
  if (SetForegroundWindow && lockedHWND) {
    SetForegroundWindow(lockedHWND);
  }

  // Small delay to let OS actually switch focus
  setTimeout(() => {
    clipboard.writeText(text);
    robot.keyTap('v', ['control']);

    // Restore user's focus and clipboard after paste
    setTimeout(() => {
      clipboard.writeText(previousClipboard);
      // Restore focus to where user was working (if it's a different window)
      if (SetForegroundWindow && userHWND && userHWND !== lockedHWND) {
        SetForegroundWindow(userHWND);
      }
      // Process next word in queue after a very short gap for smooth flow
      setTimeout(drainPasteQueue, 40);
    }, 60);
  }, 40);
}

function injectTextIntoTarget(text) {
  if (!text || !text.trim()) return;

  if (IsWindow && lockedHWND && !IsWindow(lockedHWND)) {
    console.warn('[Main] Target window no longer valid. Dropping text.');
    return;
  }

  console.log(`[Main] Queuing words for paste: "${text}"`);

  // Split transcript into words but preserve spaces
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const hasLeadingSpace = text.startsWith(' ');

  words.forEach((word, index) => {
    // Add leading space to all words except the first one (unless the whole text had a leading space)
    const needsSpace = index > 0 || hasLeadingSpace;
    const chunkToPaste = needsSpace ? ' ' + word : word;
    pasteQueue.push(chunkToPaste);
  });

  if (!pasteActive) {
    pasteActive = true;
    setTimeout(drainPasteQueue, 0);
  }
}







// ── Transcribe chunk → delta → inject ───────────────────────────────────
async function transcribeChunk(chunkId, pcmData, sampleRate) {
  if (processedChunks.has(chunkId)) return;
  processedChunks.add(chunkId);

  console.log(`[Main] Transcribing chunk ${chunkId}...`);

  try {
    const wavBuffer = buildWavBuffer(pcmData, sampleRate);
    const readable = new Readable();
    readable.push(wavBuffer);
    readable.push(null);
    readable.path = 'chunk.wav';

    const response = await sarvam.speechToText.transcribe({
      file: readable,
      model: 'saaras:v3',
      mode: 'translate',     // auto-detects any Indian language + English, always outputs English
      language_code: 'unknown' // let Sarvam detect: Hindi, Tamil, Telugu, Hinglish, English, etc.
    });


    const transcript = response.transcript || response.text || '';
    console.log(`[Main] Chunk ${chunkId} transcript: "${transcript}"`);

    if (!transcript.trim()) return;

    // Compute delta (no duplicate words from 1s overlapping chunks)
    const deltaText = deltaMerger.getDelta(transcript);
    console.log(`[Main] Delta to inject: "${deltaText}"`);

    if (!deltaText || !deltaText.trim()) return;

    // LOCKED TARGET MODE: always inject into the locked window, nowhere else
    injectTextIntoTarget(deltaText);

  } catch (err) {
    console.error(`[Main] Sarvam API error for chunk ${chunkId}:`, err.message || err);
  }
}

// ── Create hidden renderer window (mic capture) ──────────────────────────
function createHiddenWindow() {
  hiddenWindow = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  hiddenWindow.loadFile('index.html');
}

// ── Welcome screen ────────────────────────────────────────────────────
function showWelcomeScreen() {
  welcomeWindow = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    frame: true,
    title: 'Welcome to Bulbul',
    center: true,
    skipTaskbar: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  welcomeWindow.loadFile('welcome.html');
  welcomeWindow.setMenuBarVisibility(false);
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

// ── App lifecycle ────────────────────────────────────────────────────────
app.setAppUserModelId('com.voicecursor.app');

app.whenReady().then(() => {
  // Never quit when last window closes (tray app)
  app.on('window-all-closed', (e) => e.preventDefault());

  showWelcomeScreen();  // show instructions on every startup
  createHiddenWindow();

  // System tray — load custom icon with fallback to programmatic icon
  try {
    const iconPath = path.join(__dirname, 'Icon_3.jpg');
    const loaded = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    iconNormal = loaded.isEmpty() ? createColorIcon(30, 180, 140) : loaded;
  } catch (e) {
    console.warn('[Main] Could not load icon file, using fallback:', e.message);
    iconNormal = createColorIcon(30, 180, 140); // teal-green circle fallback
  }
  tray = new Tray(iconNormal);
  tray.on('click', toggleRecording);
  updateTray();


  // Global shortcut: Ctrl+Shift+V
  globalShortcut.register('CommandOrControl+Shift+V', toggleRecording);
  console.log('[Main] VoiceCursor running in system tray (Ctrl+Shift+V to dictate)');
});

app.on('will-quit', () => {
  stopTargetWatcher();
  globalShortcut.unregisterAll();
});

// ── IPC ──────────────────────────────────────────────────────────────────
ipcMain.on('audio-chunk', (_event, { chunkId, pcmData, sampleRate }) => {
  console.log(`[Main] Queuing chunk ${chunkId} (${pcmData.length} bytes)`);
  // Chain onto queue: each chunk waits for the previous to fully complete
  // before starting — guarantees FIFO serial processing and correct delta order
  chunkQueue = chunkQueue.then(() => transcribeChunk(chunkId, pcmData, sampleRate));
});

ipcMain.on('renderer-log', (_event, msg) => console.log(msg));

