// "Hey Halo": an always-on, on-device wake word. A simple voice-activity
// detector cuts the microphone into short utterances; each one is transcribed
// by a tiny Whisper model on this computer, and only an utterance that starts
// with the wake phrase does anything. Nothing leaves the computer.

const RATE = 16000;
const FRAME = 2048; // ~128 ms
const PRE_ROLL = 3; // frames kept from just before speech starts
const END_SILENCE = 6; // ~0.77 s of quiet ends an utterance
const MAX_FRAMES = Math.round((9 * RATE) / FRAME); // 9 s
const MIN_SECONDS = 0.45;
const HEAD_SECONDS = 2.5;
const ECHO_MEMORY_MS = 20_000; // how long Halo remembers what it said, to ignore its own voice

const words = (t) => String(t).toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? [];

/**
 * True when the mic heard Halo's own words: an echo repeats them in order, so
 * look for a run of 4+ words (or the whole utterance, if shorter) from what
 * Halo said. A reply that merely reuses a few words ("Yes, check my Jira
 * tickets") is not an echo.
 */
export function isEcho(heard, said) {
  const a = words(heard);
  const b = words(said);
  if (a.length < 2 || !b.length) return false;
  let best = 0;
  const run = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = run[j];
      run[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      diag = up;
      if (run[j] > best) best = run[j];
    }
  }
  return best >= Math.min(4, a.length);
}

// Whisper often hears "Halo" as one of these. "Hello" only counts after
// "hey" or "ok" ("Hey, hello."), so a plain "Hello" never wakes Halo.
const HALO = "(?:halo|hallo|haylo|hailo|halow)";
const HALO_AFTER_PREFIX = "(?:hello|hullo|hollow|hay\\s?lo|jalo|jallo|jello|yellow)";
const NAMES = {
  nova: "(?:nova|noa)",
  sunny: "(?:sunny|sonny|sunni)",
  luna: "(?:luna|lunar|loona)",
  orbit: "(?:orbit|orbits)",
  mimi: "(?:mimi|mimmy|mee\\s?mee|me\\s?me)",
};

// "Hey Halo" / "OK Nova" said explicitly (a bare name doesn't count while Halo is talking).
const PREFIXED = /^\W*(?:hey|hay|hi|ok|okay|o\.k\.|yo|jay)\W/i;

// Words that hush Halo instead of asking it something ("Hey Halo, stop").
export const HUSH = /^\W*(?:stop|stop it|stop talking|quiet|be quiet|shush|hush|cancel|never ?mind|that'?s (?:all|it|enough)|thanks?|thank you|ok(?:ay)? thanks?)\W*$/i;

// "Hey Halo, stop listening": the wake word goes off and stays off until you
// turn it back on in the app. Only the whole phrase counts, so "stop listening
// to that podcast and summarize it" is still a request.
export const MIC_OFF = /^\W*(?:please\W+)?(?:(?:stop|quit) (?:hearing|listening)(?: (?:to|for) (?:me|us)| me)?|(?:don[’']?t|do not) listen(?: to (?:me|us))?|(?:turn|switch|shut) off (?:the |your )?(?:wake ?word|mic(?:rophone)?|listening|ears)|mute(?: yourself| (?:the |your )?mic(?:rophone)?)?|go deaf)(?:\W+(?:anymore|any more|for now|now|please|for a while|thanks?|thank you))*\W*$/i;

// What Whisper tends to "hear" in silence or noise. Never a real request.
export const NOISE = /^\W*(?:thank you\.?|thanks for watching!?|you|bye\.?|okay\.?|so\.?|uh+|um+|hmm+|\.+|(?:\[|\().*(?:\]|\)))\W*$/i;

export function wakePattern(character) {
  const names = [HALO, NAMES[character]].filter(Boolean).join("|");
  const prefix = "(?:hey|hay|hi|ok|okay|o\\.k\\.|yo|jay)";
  // "Hey Halo…", "OK Nova…", "Hey, hello…", or the name alone opening the sentence ("Halo, …").
  return new RegExp(`^\\W*(?:${prefix}\\W+(?:${names}|${HALO_AFTER_PREFIX})|(?:${names}))\\b[\\s,.!?:;-]*(.*)$`, "i");
}

export class WakeWord {
  /**
   * @param {{ transcribe: (pcm: Float32Array) => Promise<string>, onWake: () => void, onCommand: (text: string) => void, onHush?: () => void, onMicOff?: () => void, onState?: (s: string) => void, character: () => string, said?: () => ({ text: string, from: number, until: number } | null), onHeard?: (text: string, seconds: number) => void }} opts
   *   said: what Halo is saying or last said out loud, and when (until = Infinity while still talking)
   */
  constructor(opts) {
    this.opts = opts;
    this.running = false;
    this.paused = false;
    this.busy = false;
    this.floor = 0.006;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.pre = [];
    this.speaking = false;
    this.quiet = 0;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext({ sampleRate: RATE });
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is old but available everywhere Electron runs, and enough for 16 kHz mono.
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1);
    this.node.onaudioprocess = (e) => this.frame(e.inputBuffer.getChannelData(0));
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this.running = true;
    this.opts.onState?.("listening");
  }

  async stop() {
    this.running = false;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.reset();
    this.opts.onState?.("off");
  }

  /** Pause while the microphone is busy with a meeting recording or dictation. */
  pause(p) {
    this.paused = p;
    this.reset();
  }

  frame(input) {
    if (!this.running || this.paused) return;
    const buf = new Float32Array(input);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const threshold = Math.max(0.012, this.floor * 3.2);

    if (!this.speaking) {
      // Track background noise only while nobody is talking.
      this.floor = this.floor * 0.97 + rms * 0.03;
      this.pre.push(buf);
      if (this.pre.length > PRE_ROLL) this.pre.shift();
      if (rms > threshold) {
        this.speaking = true;
        this.frames = [...this.pre];
        this.quiet = 0;
        this.startedAt = Date.now() - (this.pre.length * FRAME * 1000) / RATE;
      }
      return;
    }
    this.frames.push(buf);
    this.quiet = rms > threshold * 0.8 ? 0 : this.quiet + 1;
    if (this.quiet >= END_SILENCE || this.frames.length >= MAX_FRAMES) {
      const frames = this.frames;
      const startedAt = this.startedAt;
      this.reset();
      this.utterance(frames, startedAt);
    }
  }

  async utterance(frames, startedAt = Date.now()) {
    const seconds = (frames.length * FRAME) / RATE;
    if (seconds < MIN_SECONDS || this.busy) return;
    const pcm = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => pcm.set(f, i * FRAME));
    this.busy = true;
    try {
      // Long stretches of other speech (a video, a call): look at the first
      // seconds only, and transcribe the rest just when they start with the wake phrase.
      if (seconds > HEAD_SECONDS + 1) {
        const head = (await this.opts.transcribe(pcm.subarray(0, HEAD_SECONDS * RATE))).trim();
        if (!wakePattern(this.opts.character()).test(head)) {
          this.opts.onHeard?.(`${head} …`, HEAD_SECONDS);
          return;
        }
      }
      const text = (await this.opts.transcribe(pcm)).trim();
      if (!text || NOISE.test(text)) return this.opts.onHeard?.(text, seconds);
      // Halo's own voice comes back through the mic. Anything that started
      // while Halo was talking, or repeats what it just said, is not you.
      const said = this.opts.said?.();
      const overHalo = !!said && startedAt < said.until && startedAt + seconds * 1000 > said.from;
      if (said && Date.now() - said.until < ECHO_MEMORY_MS && isEcho(text, said.text)) return this.opts.onHeard?.(`${text} (Halo's own voice, ignored)`, seconds);
      const m = wakePattern(this.opts.character()).exec(text);
      // Over Halo's voice only an explicit "Hey Halo…" / "OK Nova…" counts.
      if (overHalo && !(m && PREFIXED.test(text))) return this.opts.onHeard?.(`${text} (while Halo was talking, ignored)`, seconds);
      this.opts.onHeard?.(text, seconds);
      if (!m) return;
      // "Hey Halo… Hey Halo, what's next?": drop repeated wake phrases from the request.
      let rest = m[1].trim();
      for (let again = wakePattern(this.opts.character()).exec(rest); again && rest; again = wakePattern(this.opts.character()).exec(rest)) rest = again[1].trim();
      if (MIC_OFF.test(rest)) this.opts.onMicOff?.();
      else if (HUSH.test(rest)) this.opts.onHush?.();
      else if (rest.replace(/\W/g, "").length >= 3) this.opts.onCommand(rest);
      else this.opts.onWake(); // just "Hey Halo": the panel listens for the question
    } catch {
      // A failed transcription just means this utterance is ignored.
    } finally {
      this.busy = false;
    }
  }
}
