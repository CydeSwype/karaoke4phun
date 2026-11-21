// Generative chill background music for the gaps between songs. Pure Web Audio, no samples:
// a soft electric-piano chord loop, a sub bass, a lazy swung beat and the odd plucked melody note.
// Every run picks a different key and progression and the melody is random, so it never loops exactly.

const MUSIC = (() => {
  const BPM = 78;
  const SWING = 0.1; // how late the off-beat eighths land, as a fraction of a beat

  // Chords as MIDI notes (C major / A minor family), with the bass root. All sit in a warm mid register.
  const CHORDS = {
    Am9: { root: 45, notes: [57, 60, 64, 67, 71] },
    Fmaj9: { root: 41, notes: [53, 57, 60, 64, 67] },
    Cmaj9: { root: 36, notes: [52, 55, 59, 62, 64] },
    G69: { root: 43, notes: [55, 59, 62, 64, 69] },
    Em9: { root: 40, notes: [52, 55, 59, 62, 66] },
    Dm9: { root: 38, notes: [50, 53, 57, 60, 64] },
  };
  const PROGRESSIONS = [
    ['Am9', 'Fmaj9', 'Cmaj9', 'G69'],
    ['Fmaj9', 'Em9', 'Dm9', 'Cmaj9'],
    ['Dm9', 'G69', 'Cmaj9', 'Am9'],
    ['Am9', 'Dm9', 'Em9', 'Fmaj9'],
  ];
  const MELODY_POOL = [69, 72, 74, 76, 79, 81, 84]; // A minor pentatonic, so nothing clashes

  const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const chance = (p) => Math.random() < p;

  /** Builds the synth graph on `ctx` and returns controls. `dest` is where the music goes. */
  function createEngine(ctx, dest = ctx.destination) {
    const beat = 60 / BPM;
    const stepLen = beat / 4; // 16th notes
    const transpose = pick([-3, -2, 0, 0, 2, 3]);

    // ---- signal chain: voices -> bus -> warm lowpass -> glue compressor -> master -> dest
    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.25;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 5200;
    const bus = ctx.createGain();
    bus.connect(tone).connect(comp).connect(master).connect(dest);

    // Shared reverb (generated decaying-noise impulse) and a dotted-eighth echo for the melody.
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 2.6);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.3;
    reverbSend.connect(reverb).connect(bus);

    const echo = ctx.createDelay(1);
    echo.delayTime.value = beat * 0.75;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 2200;
    const echoFb = ctx.createGain();
    echoFb.gain.value = 0.38;
    const echoSend = ctx.createGain();
    echoSend.gain.value = 0.5;
    echoSend.connect(echo);
    echo.connect(echoTone).connect(echoFb).connect(echo);
    echoTone.connect(bus);
    echoTone.connect(reverbSend);

    const noise = makeNoise(ctx);

    // ---- voices
    function envGain(t, peak, attack, decay) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      return g;
    }

    /** Soft electric piano: a sine carrier with a short FM "tine" at the start, through a mellow filter. */
    function keys(t, midi, vel, decay = 2.4) {
      const f = midiToHz(midi);
      const carrier = ctx.createOscillator();
      carrier.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.frequency.value = f; // 1:1 ratio gives that bell-like Rhodes attack
      const modAmt = ctx.createGain();
      modAmt.gain.setValueAtTime(f * 1.1, t);
      modAmt.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.5);
      mod.connect(modAmt).connect(carrier.frequency);
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1700 + vel * 900;
      const env = envGain(t, 0.075 * vel, 0.012, decay);
      carrier.connect(filt).connect(env);
      env.connect(bus);
      env.connect(reverbSend);
      for (const o of [carrier, mod]) {
        o.start(t);
        o.stop(t + decay + 0.1);
      }
    }

    function bass(t, midi, vel, len) {
      const o = ctx.createOscillator();
      o.frequency.value = midiToHz(midi);
      const o2 = ctx.createOscillator(); // a touch of triangle so it still reads on small TV speakers
      o2.type = 'triangle';
      o2.frequency.value = midiToHz(midi);
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.2 * vel, t + 0.02);
      env.gain.setTargetAtTime(0.0001, t + len * 0.6, len * 0.18);
      o.connect(env);
      o2.connect(g2).connect(env);
      env.connect(bus);
      for (const x of [o, o2]) {
        x.start(t);
        x.stop(t + len * 1.4);
      }
    }

    function pluck(t, midi, vel) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiToHz(midi);
      const env = envGain(t, 0.05 * vel, 0.006, 0.7);
      o.connect(env);
      env.connect(bus);
      env.connect(echoSend);
      env.connect(reverbSend);
      o.start(t);
      o.stop(t + 0.8);
    }

    function kick(t, vel) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      const env = envGain(t, 0.55 * vel, 0.003, 0.32);
      o.connect(env).connect(bus);
      o.start(t);
      o.stop(t + 0.4);
    }

    function noiseHit(t, { type, freq, q = 0.7, peak, decay }) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = freq;
      filt.Q.value = q;
      const env = envGain(t, peak, 0.002, decay);
      src.connect(filt).connect(env);
      env.connect(bus);
      src.start(t, Math.random() * 0.5);
      src.stop(t + decay + 0.05);
      return env;
    }
    const snare = (t, vel) => {
      noiseHit(t, { type: 'bandpass', freq: 1900, q: 0.9, peak: 0.2 * vel, decay: 0.16 }).connect(reverbSend);
    };
    const hat = (t, vel) => noiseHit(t, { type: 'highpass', freq: 7500, peak: 0.06 * vel, decay: 0.045 });

    // ---- sequencer: schedules 16th-note steps ahead of the audio clock
    let step = 0; // 0..15 within the bar
    let barIndex = 0;
    let nextTime = 0;
    let progression = pick(PROGRESSIONS);
    let lastMelody = pick(MELODY_POOL);

    function playStep(t, s, chordName) {
      const chord = CHORDS[chordName];
      const swung = s % 4 === 2 ? t + SWING * beat : t; // lazy off-beat eighths
      const lastBar = barIndex % 4 === 3;

      // Chords: a full strum on the one, and a softer re-hit later in the bar.
      if (s === 0 || (s === 10 && chance(0.65))) {
        const full = s === 0;
        chord.notes.forEach((n, i) => keys(swung + i * 0.014 + Math.random() * 0.01, n + transpose, (full ? 0.85 : 0.5) * (0.85 + Math.random() * 0.15), full ? 3.2 : 1.6));
      }

      // Bass
      if (s === 0) bass(t, chord.root + transpose, 1, beat * 1.6);
      if (s === 10 && chance(0.7)) bass(swung, chord.root + transpose, 0.7, beat * 0.9);
      if (s === 14 && chance(0.3)) bass(t, chord.root + transpose + 7, 0.6, beat * 0.5);

      // Drums: lazy kick, soft backbeat, relaxed hats
      if (s === 0) kick(t, 1);
      if (s === 10 && chance(0.8)) kick(swung, 0.8);
      if (s === 7 && chance(0.3)) kick(t, 0.6);
      if (s === 4 || s === 12) snare(t, s === 4 ? 0.85 : 1);
      if (s === 15 && lastBar && chance(0.5)) snare(t, 0.4);
      if (s % 2 === 0) hat(swung, 0.55 + Math.random() * 0.45);
      else if (chance(0.18)) hat(t, 0.3);

      // Sparse melody: wander gently around the last note
      if ([2, 6, 8, 12, 14].includes(s) && chance(0.24)) {
        const i = MELODY_POOL.indexOf(lastMelody);
        const next = MELODY_POOL[Math.max(0, Math.min(MELODY_POOL.length - 1, i + pick([-2, -1, -1, 1, 1, 2])))];
        lastMelody = next;
        pluck(swung, next + transpose, 0.7 + Math.random() * 0.3);
      }
    }

    function scheduleUntil(until) {
      while (nextTime < until) {
        playStep(nextTime, step, progression[barIndex % 4]);
        nextTime += stepLen;
        step += 1;
        if (step === 16) {
          step = 0;
          barIndex += 1;
          if (barIndex % 4 === 0 && chance(0.4)) progression = pick(PROGRESSIONS);
        }
      }
    }

    /** Restarts on a clean bar line, `delay` seconds from now. */
    function restart(from = ctx.currentTime, delay = 0.15) {
      step = 0;
      nextTime = from + delay;
    }

    function fadeTo(level, seconds) {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.setTargetAtTime(level, now, Math.max(0.01, seconds / 3));
    }

    return { scheduleUntil, restart, fadeTo, master };
  }

  function makeNoise(ctx) {
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function makeImpulse(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    return buf;
  }

  // ---- live player: fades in and out, and only runs its scheduler while audible ----------------

  const LEVEL = 0.8;
  let ctx = null;
  let engine = null;
  let timer = null;
  let stopTimer = null;

  return {
    createEngine,

    /** Call from a click handler: browsers only allow audio after a user gesture. */
    unlock() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      engine = createEngine(ctx);
    },

    play() {
      if (!ctx) return;
      clearTimeout(stopTimer);
      ctx.resume();
      if (!timer) {
        engine.restart();
        engine.scheduleUntil(ctx.currentTime + 0.5);
        timer = setInterval(() => engine.scheduleUntil(ctx.currentTime + 0.5), 120);
      }
      engine.fadeTo(LEVEL, 2.2);
    },

    stop() {
      if (!ctx || !timer) return;
      engine.fadeTo(0, 0.9);
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        clearInterval(timer);
        timer = null;
      }, 1500);
    },
  };
})();
