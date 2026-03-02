const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Receive from Main
  onToggleRecording: (callback) =>
    ipcRenderer.on('toggle-recording', (_event, isRecording) => callback(isRecording)),

  // Send audio chunk (PCM bytes) to Main for Sarvam SDK transcription
  sendAudioChunk: (chunkData) => ipcRenderer.send('audio-chunk', chunkData),

  // Pipe renderer debug logs to main terminal
  sendLog: (msg) => ipcRenderer.send('renderer-log', msg)
});
