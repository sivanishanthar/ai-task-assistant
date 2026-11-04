// Offline worker fixture: acknowledge startup, then leave IPC open indefinitely.
process.on("message", () => process.send({ ready: true }));
