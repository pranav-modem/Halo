// Meeting recorder. Your microphone ("You") and the system audio ("Them",
// everyone else on the call) are kept apart as two 16 kHz mono tracks, and
// each track is cut into segments for Whisper: at a pause once a segment is
// long enough, or, when nobody pauses, with 2 s of overlap so a word on the
// cut is heard whole in the next segment. Every segment carries its start and
// end on the meeting's clock, so the two sides can be merged in time order.
// Stretches with no speech are never sent.

const RATE = 16000;
const BLOCK = 4096; // ScriptProcessor buffer, ~256 ms
const FRAME = 320; // 20 ms: the unit for telling speech from quiet
const MIN_SEG = 12 * RATE; // past this, a short pause is enough to cut
const MAX_SEG = 28 * RATE; // Whisper hears 30 s at a time
const OVERLAP = 2 * RATE;
const SHORT_PAUSE = 25; // frames (0.5 s)
const LONG_PAUSE = 100; // frames (2 s): the speaker stopped, so cut even a short segment
const LOOKBACK = (8 * RATE) / FRAME; // frames searched for a pause before a forced cut
const MIN_GAP = 10; // frames (0.2 s): the shortest pause worth cutting in
const MIN_SPEECH = 15; // frames (0.3 s) of speech before a segment is worth sending
const PRE_ROLL = 15 * FRAME; // quiet kept before speech starts

const ms = (samples) => Math.round((samples * 1000) / RATE);

/** Decodes recorded audio to 16 kHz mono PCM for on-device Whisper. */
export async function toPcm16k(blob) {
  const buf = await blob.arrayBuffer();
  const decoder = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await decoder.decodeAudioData(buf);
    let pcm = audio.getChannelData(0);
    if (audio.numberOfChannels > 1) {
      const r = audio.getChannelData(1);
      const mix = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) mix[i] = (pcm[i] + r[i]) / 2;
      pcm = mix;
    }
    return pcm;
  } finally {
    decoder.close();
  }
}

/** One side of the call, cut into segments. */
class Track {
  constructor(side, emit) {
    this.side = side;
    this.emit = emit;
    this.buf = new Float32Array(MAX_SEG + BLOCK + 2 * FRAME);
    this.flags = new Uint8Array(Math.ceil(this.buf.length / FRAME)); // 1 = speech, per frame
    this.len = 0; // samples in the current segment
    this.done = 0; // samples already looked at (whole frames)
    this.speech = 0; // speech frames among them
    this.quiet = 0; // quiet frames in a row
    this.start = 0; // where the segment starts on the meeting's clock (samples)
    this.lead = 0; // samples at the start shared with the previous segment
    this.floor = 0.01; // the room's noise level
    this.index = 0;
  }

  push(data) {
    this.buf.set(data, this.len);
    this.len += data.length;
    while (this.len - this.done >= FRAME) {
      this.listen(this.done);
      this.done += FRAME;
      this.decide();
    }
  }

  listen(pos) {
    let sum = 0;
    for (let i = pos; i < pos + FRAME; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / FRAME);
    const speech = rms > Math.max(0.004, this.floor * 2.5);
    // The noise level follows quiet quickly and loudness slowly.
    this.floor += (rms - this.floor) * (rms < this.floor ? 0.05 : 0.0008);
    this.flags[pos / FRAME] = speech ? 1 : 0;
    this.speech += speech ? 1 : 0;
    this.quiet = speech ? 0 : this.quiet + 1;
  }

  decide() {
    if (!this.speech) {
      // Nothing said yet: keep only a moment of quiet before the next sound.
      if (this.done > PRE_ROLL + RATE) this.cut(this.done - PRE_ROLL, 0, false);
      return;
    }
    const pause = this.done >= MIN_SEG ? SHORT_PAUSE : LONG_PAUSE;
    if (this.quiet >= pause) {
      this.cut(this.done - (this.quiet - SHORT_PAUSE) * FRAME, 0, true);
      return;
    }
    if (this.done >= MAX_SEG) {
      // Nobody paused for long: cut in the longest gap of the last few
      // seconds, or keep an overlap so the word on the cut isn't lost.
      const end = this.done / FRAME;
      let best = { at: 0, len: 0 };
      for (let f = Math.max(0, end - LOOKBACK), run = 0; f < end; f++) {
        run = this.flags[f] ? 0 : run + 1;
        if (run > best.len) best = { at: f - run + 1, len: run };
      }
      if (best.len >= MIN_GAP) this.cut((best.at + Math.floor(best.len / 2)) * FRAME, 0, true);
      else this.cut(this.done, OVERLAP, true);
    }
  }

  /** Ends the segment at `at` (sending it if it has speech) and starts the next `keep` samples earlier. */
  cut(at, keep, send) {
    const frames = Math.floor(at / FRAME);
    let speech = 0;
    for (let f = 0; f < frames; f++) speech += this.flags[f];
    if (send && speech >= MIN_SPEECH) {
      this.emit({
        side: this.side,
        index: this.index++,
        startMs: ms(this.start),
        endMs: ms(this.start + at),
        overlapMs: ms(this.lead),
        pcm: this.buf.slice(0, at),
      });
    }
    const from = at - keep;
    this.buf.copyWithin(0, from, this.len);
    this.flags.copyWithin(0, from / FRAME, this.done / FRAME);
    this.len -= from;
    this.done -= from;
    this.start += from;
    this.lead = keep;
    this.speech = 0;
    for (let f = 0; f < this.done / FRAME; f++) this.speech += this.flags[f];
    if (!this.speech) this.quiet = this.done / FRAME;
  }

  flush() {
    if (this.len) this.cut(this.len - (this.len % FRAME), 0, true);
  }
}

export class Recorder {
  /** @param {{ onSegment: (seg: {side: "you"|"them", index: number, startMs: number, endMs: number, overlapMs: number, pcm: Float32Array}) => void, onLevel?: (you: number, them: number) => void }} opts */
  constructor({ onSegment, onLevel }) {
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.active = false;
    this.systemAudio = false;
  }

  async start({ systemAudio }) {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (systemAudio) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        display.getVideoTracks().forEach((t) => t.stop());
        const tracks = display.getAudioTracks();
        if (tracks.length) {
          this.sys = new MediaStream(tracks);
          this.systemAudio = true;
        }
      } catch {
        this.systemAudio = false;
      }
    }

    // One processor with two channels keeps both sides on the same clock.
    this.ctx = new AudioContext({ sampleRate: RATE });
    await this.ctx.resume();
    const merger = this.ctx.createChannelMerger(2);
    const micSrc = this.ctx.createMediaStreamSource(this.mic);
    micSrc.connect(merger, 0, 0);
    const sysSrc = this.sys ? this.ctx.createMediaStreamSource(this.sys) : null;
    sysSrc?.connect(merger, 0, 1);

    const emit = (seg) => this.onSegment(seg);
    this.tracks = { you: new Track("you", emit), them: new Track("them", emit) };
    // ScriptProcessor is old but available everywhere Electron runs, and enough for 16 kHz.
    this.node = this.ctx.createScriptProcessor(BLOCK, 2, 1);
    this.node.onaudioprocess = (e) => {
      if (!this.active) return;
      this.tracks.you.push(e.inputBuffer.getChannelData(0));
      if (this.systemAudio) this.tracks.them.push(e.inputBuffer.getChannelData(1));
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    merger.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.ctx.destination);

    // Level meters for the UI, one per side.
    const meter = (src) => {
      if (!src) return () => 0;
      const a = this.ctx.createAnalyser();
      a.fftSize = 512;
      src.connect(a);
      const data = new Uint8Array(a.fftSize);
      return () => {
        a.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / data.length) * 4);
      };
    };
    const you = meter(micSrc);
    const them = meter(sysSrc);
    this.levelTimer = setInterval(() => this.onLevel?.(you(), them()), 80);

    this.active = true;
    return { systemAudio: this.systemAudio };
  }

  async stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.levelTimer);
    this.node.onaudioprocess = null;
    this.node.disconnect();
    this.tracks.you.flush();
    this.tracks.them.flush();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.sys?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.onLevel?.(0, 0);
  }
}
