// Counts your time with your agents off the main process: reading a week of
// transcripts takes seconds.

import { agentStats } from "./agent-recap.js";

process.parentPort.on("message", (e) => {
  try {
    process.parentPort.postMessage({ ok: true, stats: agentStats(e.data) });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: err.message });
  }
});
