interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  ttlMs: number;
  lifeMs: number;
  color: string;
}

export type PowerModeBurstKind = "insert" | "delete";

interface BurstOptions {
  kind?: PowerModeBurstKind;
}

export class PowerModeEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private particles: Particle[] = [];
  private rafId: number | null = null;
  private lastFrameTimeMs: number | null = null;

  private shakeEl: HTMLElement | null = null;
  private shakeTimeoutId: number | null = null;
  private shakePrevTranslate: string | null = null;
  private shakePrevRotate: string | null = null;
  private lastShakeTimeMs = 0;

  private audioCtx: AudioContext | null = null;
  private audioMasterGain: GainNode | null = null;
  private audioNoiseBuffer: AudioBuffer | null = null;
  private audioInitFailed = false;

  private lastSoundTimeMs = 0;

  private resizeListenerActive = false;

  // Particle cap (reference: 500 max) and spawn throttle (reference: 25ms).
  private static readonly MAX_PARTICLES = 500;
  private lastBurstTimeMs = 0;

  // Golden-ratio hue walk for well-distributed bright colors (reference "bright random" mode).
  private colorSeed = Math.random();

  setCanvas(canvas: HTMLCanvasElement | null): void {
    if (this.canvas === canvas) return;

    this.canvas = canvas;
    this.ctx = canvas?.getContext("2d") ?? null;

    this.setResizeListenerActive(Boolean(canvas && this.ctx));

    if (!canvas || !this.ctx) {
      this.stop();
      return;
    }

    this.resizeCanvasToWindow();
  }

  setShakeElement(el: HTMLElement | null): void {
    if (this.shakeEl === el) return;

    this.clearShake();
    this.shakeEl = el;
  }

  burst(x: number, y: number, intensity = 1, options?: BurstOptions): void {
    const normalizedIntensity = Math.max(1, Math.min(12, Math.floor(intensity)));
    const kind = options?.kind ?? "insert";

    this.maybeShake(normalizedIntensity);
    this.maybePlaySounds(normalizedIntensity, kind);

    if (!this.ctx || !this.canvas) {
      return;
    }

    // Spawn throttle: max ~40 bursts/second per the reference (25ms cooldown).
    const now = performance.now();
    if (now - this.lastBurstTimeMs < 25) return;
    this.lastBurstTimeMs = now;

    // Reference spawns 5–15 particles per keystroke.
    const count = 5 + Math.floor(Math.random() * 11);

    // Enforce particle cap (reference: 500 max). Evict oldest in one bulk
    // splice instead of per-particle shift() which is O(n) each.
    const overflow = this.particles.length + count - PowerModeEngine.MAX_PARTICLES;
    if (overflow > 0) {
      this.particles.splice(0, overflow);
    }

    for (let i = 0; i < count; i++) {
      // Reference: horizontal spread [-1, +1] mapped to px/s, mostly upward vertical.
      const vx = (-1 + Math.random() * 2) * 60;
      const vy =
        kind === "delete"
          ? 150 + Math.random() * 100 // downward for deletes
          : -(150 + Math.random() * 100); // upward for inserts (reference default)

      // Golden-ratio hue walk for well-distributed bright colors.
      this.colorSeed = (this.colorSeed + 0.618033988749895) % 1;
      const hue =
        kind === "delete"
          ? Math.floor(10 + Math.random() * 40) // orange/red for deletes
          : Math.floor(this.colorSeed * 360);
      const lightness = kind === "delete" ? 60 : 65;

      const ttlMs = 240 + Math.random() * 260;
      this.particles.push({
        x,
        y,
        vx,
        vy,
        // Reference: size 2–4 px (square).
        size: 2 + Math.random() * 2,
        ttlMs,
        lifeMs: ttlMs,
        color: `hsl(${hue}, 100%, ${lightness}%)`,
      });
    }

    this.startAnimationIfNeeded();
  }

  stop(): void {
    this.particles = [];
    this.stopAnimation();
    this.clearShake();
    this.stopAudio();
  }

  private startAnimationIfNeeded(): void {
    if (this.rafId !== null) return;

    this.lastFrameTimeMs = null;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private stopAnimation(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.lastFrameTimeMs = null;

    const ctx = this.ctx;
    if (ctx) {
      // Clear any remaining pixels.
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  private readonly frame = (nowMs: number) => {
    // Clear the scheduled ID immediately so stop() can safely cancel only pending frames.
    this.rafId = null;

    const ctx = this.ctx;
    if (!ctx || this.particles.length === 0) {
      this.stopAnimation();
      return;
    }

    const lastFrameTimeMs = (this.lastFrameTimeMs ??= nowMs);

    const dtMs = Math.min(34, Math.max(0, nowMs - lastFrameTimeMs));
    this.lastFrameTimeMs = nowMs;

    this.step(dtMs);
    this.render();

    if (this.particles.length > 0) {
      this.rafId = requestAnimationFrame(this.frame);
    }
  };

  private step(dtMs: number): void {
    const dt = dtMs / 1000;
    const gravity = 300;

    // Update particles in-place, compacting the array.
    let write = 0;
    for (const p of this.particles) {
      p.vy += gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;

      p.lifeMs -= dtMs;
      if (p.lifeMs > 0) {
        this.particles[write] = p;
        write++;
      }
    }
    this.particles.length = write;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of this.particles) {
      const alpha = Math.max(0, Math.min(1, p.lifeMs / p.ttlMs));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }

    ctx.restore();
  }

  private maybeShake(intensity: number): void {
    const el = this.shakeEl;
    if (!el) return;

    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ) {
      return;
    }

    const now = performance.now();
    if (now - this.lastShakeTimeMs < 100) {
      return;
    }

    // Shake doesn't need to happen every keystroke.
    const chance = Math.min(0.35, 0.06 * intensity);
    if (Math.random() > chance) {
      return;
    }

    this.lastShakeTimeMs = now;

    const magnitude = 1 + intensity * 0.7;
    const dx = (Math.random() * 2 - 1) * magnitude;
    const dy = (Math.random() * 2 - 1) * magnitude;
    const rot = (Math.random() * 2 - 1) * (magnitude * 0.15);

    if (this.shakeTimeoutId !== null) {
      window.clearTimeout(this.shakeTimeoutId);
      this.shakeTimeoutId = null;
    }

    // Use individual transform properties so we don't clobber any existing `transform`.
    this.shakePrevTranslate ??= el.style.getPropertyValue("translate");
    this.shakePrevRotate ??= el.style.getPropertyValue("rotate");

    el.style.setProperty("translate", `${dx}px ${dy}px`);
    el.style.setProperty("rotate", `${rot}deg`);

    this.shakeTimeoutId = window.setTimeout(() => {
      this.clearShake();
    }, 75);
  }

  private clearShake(): void {
    const el = this.shakeEl;
    if (!el) {
      this.shakePrevTranslate = null;
      this.shakePrevRotate = null;
      return;
    }

    if (this.shakeTimeoutId !== null) {
      window.clearTimeout(this.shakeTimeoutId);
      this.shakeTimeoutId = null;
    }

    if (this.shakePrevTranslate === null && this.shakePrevRotate === null) {
      return;
    }

    if (this.shakePrevTranslate !== null) {
      if (this.shakePrevTranslate) {
        el.style.setProperty("translate", this.shakePrevTranslate);
      } else {
        el.style.removeProperty("translate");
      }
    }

    if (this.shakePrevRotate !== null) {
      if (this.shakePrevRotate) {
        el.style.setProperty("rotate", this.shakePrevRotate);
      } else {
        el.style.removeProperty("rotate");
      }
    }

    this.shakePrevTranslate = null;
    this.shakePrevRotate = null;
  }

  private maybePlaySounds(intensity: number, kind: PowerModeBurstKind): void {
    // Audio should feel subtle; fail silently if AudioContext is unavailable or blocked.
    // Throttle aggressively so we don't create Web Audio node graphs at key-repeat rates.
    const nowMs = performance.now();
    if (nowMs - this.lastSoundTimeMs < 30) {
      return;
    }

    let played = false;

    const base = kind === "delete" ? 0.35 : 0.55;
    const typeChance = Math.min(0.95, base + intensity * 0.06);
    if (Math.random() <= typeChance) {
      this.playTypewriter(intensity, kind);
      played = true;
    }

    const cap = kind === "delete" ? 0.2 : 0.12;
    const gunChance = Math.min(cap, (kind === "delete" ? 0.03 : 0.015) * intensity);
    if (Math.random() <= gunChance) {
      this.playGun(intensity, kind);
      played = true;
    }

    if (played) {
      this.lastSoundTimeMs = nowMs;
    }
  }

  private stopAudio(): void {
    const ctx = this.audioCtx;
    if (!ctx) return;

    this.audioCtx = null;
    this.audioMasterGain = null;
    this.audioNoiseBuffer = null;

    ctx.close().catch(() => {
      // Ignored.
    });
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.audioInitFailed) {
      return null;
    }

    const existing = this.audioCtx;
    if (existing && existing.state !== "closed") {
      return existing;
    }

    if (typeof window === "undefined") {
      return null;
    }

    const AudioContextConstructor =
      window.AudioContext ??
      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextConstructor) {
      this.audioInitFailed = true;
      return null;
    }

    try {
      const ctx = new AudioContextConstructor();
      const masterGain = ctx.createGain();
      // Keep this subtle; per-sound envelopes are tuned against this base.
      masterGain.gain.value = 0.12;
      masterGain.connect(ctx.destination);

      this.audioCtx = ctx;
      this.audioMasterGain = masterGain;
      this.audioNoiseBuffer = null;

      return ctx;
    } catch {
      this.audioInitFailed = true;
      return null;
    }
  }

  private ensureNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.audioNoiseBuffer) {
      return this.audioNoiseBuffer;
    }

    try {
      const durationS = 0.18;
      const frames = Math.max(1, Math.floor(ctx.sampleRate * durationS));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);

      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      this.audioNoiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  private tryResumeAudioContext(ctx: AudioContext): void {
    if (ctx.state !== "suspended") {
      return;
    }

    ctx.resume().catch(() => {
      // Ignored: browsers may block audio until a gesture; typing usually counts.
    });
  }

  private safeDisconnect(...nodes: AudioNode[]): void {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Ignored.
      }
    }
  }

  private playTypewriter(intensity: number, kind: PowerModeBurstKind): void {
    const ctx = this.ensureAudioContext();
    const masterGain = this.audioMasterGain;
    if (!ctx || !masterGain) {
      return;
    }

    const noiseBuffer = this.ensureNoiseBuffer(ctx);
    if (!noiseBuffer) {
      return;
    }

    this.tryResumeAudioContext(ctx);

    const t0 = ctx.currentTime;
    const intensityT = (Math.max(1, Math.min(12, intensity)) - 1) / 11;

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.playbackRate.value = kind === "delete" ? 1.15 : 1.0;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.setValueAtTime(kind === "delete" ? 900 : 1200, t0);
    noiseFilter.Q.setValueAtTime(0.7, t0);

    const noiseGain = ctx.createGain();
    const clickPeak = (kind === "delete" ? 0.55 : 0.65) + intensityT * 0.15;
    noiseGain.gain.setValueAtTime(0.0001, t0);
    noiseGain.gain.linearRampToValueAtTime(clickPeak, t0 + 0.002);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);

    const thudOsc = ctx.createOscillator();
    thudOsc.type = "triangle";
    const baseFreq = kind === "delete" ? 150 : 180;
    thudOsc.frequency.setValueAtTime(baseFreq + intensityT * 30, t0);

    const thudGain = ctx.createGain();
    const thudPeak = (kind === "delete" ? 0.18 : 0.15) + intensityT * 0.05;
    thudGain.gain.setValueAtTime(0.0001, t0);
    thudGain.gain.linearRampToValueAtTime(thudPeak, t0 + 0.001);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterGain);

    thudOsc.connect(thudGain);
    thudGain.connect(masterGain);

    const stopTime = t0 + 0.06;
    noiseSource.start(t0);
    noiseSource.stop(stopTime);
    thudOsc.start(t0);
    thudOsc.stop(stopTime);

    noiseSource.onended = () => {
      this.safeDisconnect(noiseSource, noiseFilter, noiseGain, thudOsc, thudGain);
    };
  }

  private playGun(intensity: number, kind: PowerModeBurstKind): void {
    const ctx = this.ensureAudioContext();
    const masterGain = this.audioMasterGain;
    if (!ctx || !masterGain) {
      return;
    }

    const noiseBuffer = this.ensureNoiseBuffer(ctx);
    if (!noiseBuffer) {
      return;
    }

    this.tryResumeAudioContext(ctx);

    const t0 = ctx.currentTime;
    const intensityT = (Math.max(1, Math.min(12, intensity)) - 1) / 11;

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.playbackRate.value = kind === "delete" ? 0.75 : 0.85;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(kind === "delete" ? 900 : 700, t0);
    noiseFilter.Q.setValueAtTime(0.9, t0);

    const gain = ctx.createGain();
    const peak = (kind === "delete" ? 0.38 : 0.33) + intensityT * 0.08;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);

    const osc = ctx.createOscillator();
    osc.type = "square";
    const startFreq = (kind === "delete" ? 220 : 200) + intensityT * 50;
    const endFreq = kind === "delete" ? 70 : 90;
    osc.frequency.setValueAtTime(startFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + 0.09);

    const oscGain = ctx.createGain();
    const oscPeak = (kind === "delete" ? 0.18 : 0.14) + intensityT * 0.04;
    oscGain.gain.setValueAtTime(0.0001, t0);
    oscGain.gain.linearRampToValueAtTime(oscPeak, t0 + 0.003);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(gain);
    gain.connect(masterGain);

    osc.connect(oscGain);
    oscGain.connect(masterGain);

    const stopTime = t0 + 0.14;
    noiseSource.start(t0);
    noiseSource.stop(stopTime);
    osc.start(t0);
    osc.stop(stopTime);

    noiseSource.onended = () => {
      this.safeDisconnect(noiseSource, noiseFilter, gain, osc, oscGain);
    };
  }

  private setResizeListenerActive(active: boolean): void {
    if (this.resizeListenerActive === active) return;
    this.resizeListenerActive = active;

    if (active) {
      window.addEventListener("resize", this.handleResize, { passive: true });
      return;
    }

    window.removeEventListener("resize", this.handleResize);
  }

  private readonly handleResize = () => {
    this.resizeCanvasToWindow();
  };

  private resizeCanvasToWindow(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(window.innerWidth * dpr));
    const height = Math.max(1, Math.floor(window.innerHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    canvas.style.width = "100%";
    canvas.style.height = "100%";

    // Draw in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
