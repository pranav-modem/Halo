// Runs in an Electron utility process so transcription never blocks the app.
// Whisper via transformers.js on onnxruntime-node: everything stays on this
// computer. The English model ships with Halo (models/); others download once
// into the app's data folder. Each model transcribes one thing at a time.

import { env, pipeline } from "@huggingface/transformers";

const loaded = new Map(); // model → Promise<pipeline>
const queues = new Map(); // model → the last job waiting for it
const post = (m) => process.parentPort.postMessage(m);

function load(model) {
  if (!loaded.has(model)) {
    const p = pipeline("automatic-speech-recognition", model, {
      dtype: "q8",
      device: "cpu",
      progress_callback: (ev) => {
        if (ev.status === "progress" || ev.status === "done" || ev.status === "ready") {
          post({ type: "progress", model, status: ev.status, file: ev.file ?? "", progress: ev.progress ?? 100, loaded: ev.loaded ?? 0, total: ev.total ?? 0 });
        }
      },
    });
    p.catch(() => loaded.delete(model));
    loaded.set(model, p);
  }
  return loaded.get(model);
}

function queue(model, job) {
  const run = (queues.get(model) ?? Promise.resolve()).then(job, job);
  queues.set(model, run.catch(() => {}));
  return run;
}

async function transcribe(msg) {
  const run = await load(msg.model);
  const audio = msg.pcm instanceof Float32Array ? msg.pcm : new Float32Array(msg.pcm);
  // English-only models (*.en) refuse a task or language setting.
  const opts = /\.en$/i.test(msg.model) ? {} : { task: "transcribe" };
  // Timestamps (per phrase, in seconds from the start of this audio) let the
  // notetaker put both sides of a call in order.
  opts.return_timestamps = !!msg.timestamps;
  if (audio.length > 16000 * 30) Object.assign(opts, { chunk_length_s: 30, stride_length_s: 5 });
  const out = await run(audio, opts);
  const chunks = msg.timestamps
    ? (out.chunks ?? []).map((c) => ({ start: c.timestamp?.[0] ?? 0, end: c.timestamp?.[1] ?? null, text: String(c.text ?? "").trim() }))
    : undefined;
  return { text: String(out.text ?? "").trim(), chunks };
}

process.parentPort.on("message", async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    env.localModelPath = msg.localModels; // the models that ship with Halo
    env.allowLocalModels = true;
    env.cacheDir = msg.cacheDir; // anything else, downloaded once
    return;
  }
  if (msg.type === "warmup") {
    try {
      await load(msg.model);
      post({ type: "ready", model: msg.model });
    } catch (err) {
      post({ type: "error", id: null, message: err.message });
    }
    return;
  }
  if (msg.type === "transcribe") {
    try {
      const { text, chunks } = await queue(msg.model, () => transcribe(msg));
      post({ type: "result", id: msg.id, text, chunks });
    } catch (err) {
      post({ type: "error", id: msg.id, message: err.message });
    }
  }
});
