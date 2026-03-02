// ─────────────────────────────────────────────
// VoiceCursor · renderer.js
// Mic capture → PCM 16kHz → Rolling buffer →
// IPC → Main process (Sarvam SDK) → keyboard
// ─────────────────────────────────────────────

// ── Configuration ─────────────────────────────
const TARGET_SAMPLE_RATE = 16000;  // 16kHz required by Sarvam
const CHUNK_DURATION_S = 3;      // 3 seconds per chunk (good balance of speed vs accuracy)
const OVERLAP_DURATION_S = 0;      // NO overlap — clean cuts, no merging complexity

// ── State ─────────────────────────────────────
let audioContext = null;
let mediaStream = null;
let scriptNode = null;
let isRecording = false;
let chunkIdCounter = 0;

// PCM rolling buffer at 16kHz
let rollingBuffer = new Float32Array(0);

// UI
const statusEl = document.getElementById('status');
function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

// ── Debug Logger (pipes to terminal via IPC) ──
function log(...args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  console.log(msg);
  window.electronAPI.sendLog('[Renderer] ' + msg);
}

// ── Downsampling ───────────────────────────────
function downsampleBuffer(buffer, originalRate, targetRate) {
  if (originalRate === targetRate) return buffer;
  const ratio = originalRate / targetRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffset = Math.round((offsetResult + 1) * ratio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
      accum += buffer[i]; count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffset;
  }
  return result;
}

// ── Float32 → PCM Int16 ArrayBuffer ──────────
function float32ToPCM16(float32Array) {
  const buf = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

// ── Append to rolling buffer ──────────────────
function appendToRollingBuffer(newSamples) {
  const combined = new Float32Array(rollingBuffer.length + newSamples.length);
  combined.set(rollingBuffer);
  combined.set(newSamples, rollingBuffer.length);
  rollingBuffer = combined;
}

// ── Send chunk to main process for transcription ─
function sendChunkToMain(samples, chunkId) {
  const pcm16Buffer = float32ToPCM16(samples);
  // Transfer the raw PCM bytes to main via IPC
  // We send the ArrayBuffer (it will be transferable)
  const uint8 = new Uint8Array(pcm16Buffer);
  const arr = Array.from(uint8); // serialize for IPC
  log(`Sending chunk ${chunkId} to main · ${samples.length} samples · ${CHUNK_DURATION_S}s`);
  window.electronAPI.sendAudioChunk({ chunkId, pcmData: arr, sampleRate: TARGET_SAMPLE_RATE });
}

// ── Silence detection ──────────────────────────
// Calculate RMS energy of audio samples — if below threshold, the chunk is silence/noise.
const SILENCE_THRESHOLD = 0.01; // RMS below this = silence (adjust if needed)

function isSilent(samples) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms < SILENCE_THRESHOLD;
}

// ── Process rolling buffer ─────────────────────
function processBuffer() {
  const chunkSamples = TARGET_SAMPLE_RATE * CHUNK_DURATION_S;   // 80,000
  const overlapSamples = TARGET_SAMPLE_RATE * OVERLAP_DURATION_S;  // 16,000

  if (rollingBuffer.length >= chunkSamples) {
    const chunk = rollingBuffer.slice(0, chunkSamples);

    // Skip silent chunks — prevents hallucinated text from ambient noise
    if (isSilent(chunk)) {
      log('Skipping silent chunk');
      rollingBuffer = rollingBuffer.slice(chunkSamples - overlapSamples);
      return;
    }

    const chunkId = ++chunkIdCounter;
    sendChunkToMain(chunk, chunkId);
    // Retain last 1s for overlap
    rollingBuffer = rollingBuffer.slice(chunkSamples - overlapSamples);
  }
}

// ── Start Recording ────────────────────────────
async function startRecording() {
  if (isRecording) return;
  isRecording = true;
  rollingBuffer = new Float32Array(0);
  chunkIdCounter = 0;
  setStatus('🔴 Recording... (Ctrl+Shift+V to stop)', 'recording');
  log('Starting microphone...');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

    log(`AudioContext sample rate: ${audioContext.sampleRate}Hz → downsampling to ${TARGET_SAMPLE_RATE}Hz`);

    scriptNode.onaudioprocess = (event) => {
      if (!isRecording) return;
      const inputData = event.inputBuffer.getChannelData(0);
      const native = new Float32Array(inputData);
      const downsampled = downsampleBuffer(native, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      appendToRollingBuffer(downsampled);
      processBuffer();
    };

    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
    log('Microphone active. Speak now!');

  } catch (err) {
    log('Mic access error:', err.message);
    setStatus('❌ Mic permission denied', 'stopped');
    isRecording = false;
  }
}

// ── Stop Recording ─────────────────────────────
function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  setStatus('Ready (Press Ctrl+Shift+V)', 'stopped');
  log('Stopping recording...');

  // Flush remaining buffer as a final chunk
  if (rollingBuffer.length > 1600) { // at least 0.1s of audio
    sendChunkToMain(rollingBuffer, ++chunkIdCounter);
    rollingBuffer = new Float32Array(0);
  }

  if (scriptNode) { scriptNode.disconnect(); scriptNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// ── IPC: Toggle from main ─────────────────────
window.electronAPI.onToggleRecording((recording) => {
  if (recording) startRecording();
  else stopRecording();
});
