/* ==========================================================================
   sound.js — optional, very soft sound: paper rustle per page, one bell note.

   ON by default (after the visitor's first tap; never on page load). One small speaker button
   in the header turns it off; the choice is remembered on this device. No audio files: every sound is synthesised with
   the Web Audio API, so nothing is downloaded and nothing can fail to load.

   REAL RECORDING (optional): put a short page-turn sound at assets/sounds/flip.mp3 and it replaces
   the synthesised rustle automatically; no code change needed.

   Contract (main.js exposes it as app.sound)
     flip()    a soft, low paper rustle           ← book.js, each time a page lifts
     chime()   one soft bell note             ← result.js, as the Message appears
     bowl()    a faint low singing-bowl note  ← home.js, when the user chooses a topic or begins again
     enabled   true / false

   Browsers only allow audio after a tap: the audio engine is created on the
   first call made while sound is on (always inside a tap or press).
   ========================================================================== */

const KEY = 'wonderbook.sound';

export function initSound(app) {
  const button = document.querySelector('#sound-toggle');
  let enabled = true; // on from the first visit; the speaker button turns it off and the choice is remembered
  try { enabled = localStorage.getItem(KEY) !== '0'; } catch { /* storage unavailable: stays on */ }

  let ctx = null, master = null, noise = null, sample = null, lastFlip = -1;

  /** Optional: drop a real recording at assets/sounds/flip.mp3 and it is used instead of the synthesised rustle. */
  async function loadSample(c) {
    try {
      const res = await fetch('assets/sounds/flip.mp3');
      if (res.ok) sample = await c.decodeAudioData(await res.arrayBuffer());
    } catch { /* no recording: the synthesised sound is used */ }
  }

  function engine() {
    if (!enabled) return null;
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = 0.9;
      const limiter = ctx.createDynamicsCompressor(); // keeps a fast riffle from piling up into loudness
      limiter.threshold.value = -20;
      limiter.ratio.value = 4;
      master.connect(limiter).connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // white noise, the raw material of every rustle
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      loadSample(ctx);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function flip() {
    const c = engine();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastFlip < 0.09) return; // a fast riffle stays a soft crackle, never a machine gun
    lastFlip = now;

    if (sample) { // a real recording, if one was provided
      const src = c.createBufferSource();
      src.buffer = sample;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const level = c.createGain();
      level.gain.value = 0.7;
      src.connect(level).connect(master);
      src.start(now);
      return;
    }

    // Paper rubbing on paper: a handful of tiny, irregular scratches in quick succession (stick-slip
    // friction), each one brief broadband noise at a slightly different pitch. Not one smooth gust.
    const span = 0.17 + Math.random() * 0.1;
    const bursts = 4 + Math.floor(Math.random() * 4);
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const gate = c.createGain();
    gate.gain.setValueAtTime(0, now);
    const scratch = c.createBiquadFilter(); // the "xột xoạt": scratchy mid-high edge
    scratch.type = 'bandpass';
    scratch.Q.value = 0.5;
    const scratchGain = c.createGain();
    scratchGain.gain.value = 1;
    const body = c.createBiquadFilter(); // the weight underneath
    body.type = 'lowpass';
    body.frequency.value = 700;
    const bodyGain = c.createGain();
    bodyGain.gain.value = 0.7;
    src.connect(gate);
    gate.connect(scratch).connect(scratchGain).connect(master);
    gate.connect(body).connect(bodyGain).connect(master);

    for (let k = 0; k < bursts; k++) {
      const t = now + (span * k) / bursts + Math.random() * 0.005; // irregular spacing, every burst ends before the next
      const len = 0.01 + Math.random() * 0.006;
      scratch.frequency.setValueAtTime(1600 + Math.random() * 3200 + k * 150, t);
      gate.gain.setValueAtTime(0.0001, t);
      gate.gain.linearRampToValueAtTime(0.1 + Math.random() * 0.12, t + 0.003);
      gate.gain.exponentialRampToValueAtTime(0.0005, t + len);
    }
    src.start(now, Math.random() * 0.7);
    src.stop(now + span + 0.08);
  }

  /** A faint, low singing-bowl note: marks the moments the user chooses to begin (never on its own). */
  function bowl(level = 0.06) {
    const c = engine();
    if (!c) return;
    const now = c.currentTime;
    [[1, 1], [2.71, 0.38], [5.1, 0.14]].forEach(([ratio, amp], i) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 220 * ratio;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level * amp, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.6 - i * 0.8);
      osc.connect(gain).connect(master);
      osc.start(now);
      osc.stop(now + 3.8);
    });
  }

  function chime(level = 0.16) {
    const c = engine();
    if (!c) return;
    const now = c.currentTime;
    [[1, 1], [2.0, 0.42], [2.76, 0.22], [4.1, 0.1]].forEach(([ratio, amp], i) => { // bell-like overtones
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880 * ratio;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level * amp, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.8 - i * 0.4);
      osc.connect(gain).connect(master);
      osc.start(now);
      osc.stop(now + 3);
    });
  }

  function paint() {
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', app.t(enabled ? 'sound.turnOff' : 'sound.turnOn'));
  }

  button.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
    paint();
    if (enabled) chime(0.07); // a soft note confirms that sound works
  });
  app.on('lang', paint);
  paint();

  // Browsers only allow audio after a touch, click or key press: prepare the engine on the very first one,
  // so the first page flip of a first-time visitor already has its sound. Nothing ever plays on page load.
  const unlock = () => { engine(); };
  document.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('keydown', unlock, { once: true, capture: true });

  return { flip, chime, bowl, get enabled() { return enabled; } };
}
