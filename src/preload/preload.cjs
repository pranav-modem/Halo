// The only bridge between the pages and the main process. Channels are
// limited to the app's own prefixes.

const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED = /^(app|companion|panel|chat|today|notes|settings|snip|capture|approval|island|room|memory|skills|history|pieces|calls|recap|wake|sessions):/;

function check(channel) {
  if (!ALLOWED.test(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
}

contextBridge.exposeInMainWorld("halo", {
  platform: process.platform,
  send(channel, data) {
    check(channel);
    ipcRenderer.send(channel, data);
  },
  invoke(channel, data) {
    check(channel);
    return ipcRenderer.invoke(channel, data);
  },
  on(channel, fn) {
    check(channel);
    const handler = (_event, data) => fn(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
