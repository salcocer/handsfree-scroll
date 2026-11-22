/*
 * Sound matcher: MFCC features + DTW template matching + a streaming
 * onset segmenter. No dependencies. Works in the browser (window.HFDSP)
 * and in Node (module.exports) so it can be unit tested.
 */
(function (root) {
  'use strict';

  const NUM_MEL = 26;
  const NUM_CEPS = 13; // we keep c1..c12 (c0 = loudness, dropped so volume doesn't matter)
  const FMIN = 100;
  const FMAX = 8000;

  // ---------- FFT (radix-2, in place) ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // ---------- MFCC extractor (cached per sample rate) ----------
  const cache = new Map();

  function setup(sampleRate) {
    if (cache.has(sampleRate)) return cache.get(sampleRate);
    const frameLen = Math.round(0.025 * sampleRate);
    const hop = Math.round(0.010 * sampleRate);
    let nfft = 1;
    while (nfft < frameLen) nfft <<= 1;

    const window = new Float32Array(frameLen);
    for (let i = 0; i < frameLen; i++) window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frameLen - 1));

    const mel = (f) => 2595 * Math.log10(1 + f / 700);
    const imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const fmax = Math.min(FMAX, sampleRate / 2);
    const mMin = mel(FMIN), mMax = mel(fmax);
    const bins = [];
    for (let i = 0; i < NUM_MEL + 2; i++) {
      const f = imel(mMin + ((mMax - mMin) * i) / (NUM_MEL + 1));
      bins.push(Math.floor(((nfft + 1) * f) / sampleRate));
    }
    const filters = [];
    for (let m = 1; m <= NUM_MEL; m++) {
      const f = new Float32Array(nfft / 2 + 1);
      for (let k = bins[m - 1]; k < bins[m]; k++) f[k] = (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]);
      for (let k = bins[m]; k < bins[m + 1]; k++) f[k] = (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]);
      filters.push(f);
    }
    const dct = [];
    for (let c = 0; c < NUM_CEPS; c++) {
      const row = new Float32Array(NUM_MEL);
      for (let m = 0; m < NUM_MEL; m++) row[m] = Math.cos((Math.PI * c * (m + 0.5)) / NUM_MEL);
      dct.push(row);
    }
    const s = { frameLen, hop, nfft, window, filters, dct };
    cache.set(sampleRate, s);
    return s;
  }

  /** Returns an array of frames, each an array of 12 cepstral coefficients. */
  function mfcc(samples, sampleRate) {
    const s = setup(sampleRate);
    const frames = [];
    const re = new Float64Array(s.nfft);
    const im = new Float64Array(s.nfft);
    const power = new Float64Array(s.nfft / 2 + 1);
    const logMel = new Float64Array(NUM_MEL);
    for (let start = 0; start + s.frameLen <= samples.length; start += s.hop) {
      re.fill(0); im.fill(0);
      let prev = start > 0 ? samples[start - 1] : 0;
      for (let i = 0; i < s.frameLen; i++) {
        const x = samples[start + i];
        re[i] = (x - 0.97 * prev) * s.window[i]; // pre-emphasis + window
        prev = x;
      }
      fft(re, im);
      for (let k = 0; k <= s.nfft / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      for (let m = 0; m < NUM_MEL; m++) {
        let e = 0;
        const f = s.filters[m];
        for (let k = 0; k < f.length; k++) if (f[k]) e += f[k] * power[k];
        logMel[m] = Math.log(e + 1e-10);
      }
      const ceps = [];
      for (let c = 1; c < NUM_CEPS; c++) {
        let v = 0;
        const row = s.dct[c];
        for (let m = 0; m < NUM_MEL; m++) v += row[m] * logMel[m];
        ceps.push(v);
      }
      frames.push(ceps);
    }
    return frames;
  }

  // ---------- DTW ----------
  function frameDist(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      const t = a[i] - b[i];
      d += t * t;
    }
    return Math.sqrt(d);
  }

  /** Length-normalised DTW distance between two MFCC sequences. */
  function dtw(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return Infinity;
    const ratio = Math.max(n, m) / Math.min(n, m);
    if (ratio > 3) return Infinity; // wildly different durations: not the same sound
    let prev = new Float64Array(m + 1).fill(Infinity);
    let cur = new Float64Array(m + 1).fill(Infinity);
    prev[0] = 0;
    for (let i = 1; i <= n; i++) {
      cur[0] = Infinity;
      for (let j = 1; j <= m; j++) {
        const c = frameDist(a[i - 1], b[j - 1]);
        cur[j] = c + Math.min(prev[j], cur[j - 1], prev[j - 1]);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[m] / (n + m);
  }

  // ---------- Segmentation ----------
  function rms(buf, start, len) {
    let s = 0;
    for (let i = 0; i < len; i++) { const x = buf[start + i] || 0; s += x * x; }
    return Math.sqrt(s / len);
  }

  /**
   * Find the loudest sound event in a recording (used when recording a
   * trigger sample). Returns a Float32Array slice or null if nothing stands
   * out from the background.
   */
  function extractEvent(samples, sampleRate) {
    const hop = Math.round(0.010 * sampleRate);
    const n = Math.floor(samples.length / hop);
    if (n < 5) return null;
    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) e[i] = rms(samples, i * hop, hop);
    const sorted = Array.from(e).sort((x, y) => x - y);
    const floor = Math.max(sorted[Math.floor(n * 0.2)], 1e-4);
    let peak = 0;
    for (let i = 1; i < n; i++) if (e[i] > e[peak]) peak = i;
    if (e[peak] < floor * 4 || e[peak] < 0.005) return null;
    const thr = Math.max(floor * 2.5, e[peak] * 0.08);
    let a = peak, b = peak;
    // allow short gaps (e.g. a double click) of up to 80 ms inside the event
    let gap = 0;
    while (a > 0) { if (e[a - 1] > thr) { gap = 0; } else if (++gap > 8) break; a--; }
    a += gap; gap = 0;
    while (b < n - 1) { if (e[b + 1] > thr) { gap = 0; } else if (++gap > 8) break; b++; }
    b -= gap;
    const pad = 3;
    a = Math.max(0, a - pad);
    b = Math.min(n - 1, b + pad);
    return samples.slice(a * hop, (b + 1) * hop);
  }

  /**
   * Streaming segmenter: feed it audio chunks, it calls onEvent(samples)
   * whenever a sound pops out of the background and then ends.
   */
  class Segmenter {
    constructor(sampleRate, onEvent, opts = {}) {
      this.sr = sampleRate;
      this.hop = Math.round(0.010 * sampleRate);
      this.onEvent = onEvent;
      this.maxFrames = opts.maxFrames || 200; // 2 s
      this.onRatio = opts.onRatio || 4;      // ~12 dB above background
      this.minLevel = opts.minLevel || 0.004;
      this.floor = 0.002;
      this.pending = new Float32Array(0);
      this.pre = [];      // pre-roll frames
      this.event = null;  // frames of current event
      this.quiet = 0;
      this.level = 0;     // last frame level, for UI meters
    }
    push(chunk) {
      const buf = new Float32Array(this.pending.length + chunk.length);
      buf.set(this.pending); buf.set(chunk, this.pending.length);
      let off = 0;
      while (off + this.hop <= buf.length) {
        this._frame(buf.subarray(off, off + this.hop));
        off += this.hop;
      }
      this.pending = buf.slice(off);
    }
    _frame(f) {
      const frame = Float32Array.from(f);
      const r = rms(frame, 0, frame.length);
      this.level = r;
      const on = Math.max(this.floor * this.onRatio, this.minLevel);
      if (!this.event) {
        if (r > on) {
          this.event = this.pre.concat([frame]);
          this.peak = r;
          this.quiet = 0;
        } else {
          // track background slowly (rises slowly, falls fast)
          this.floor = r < this.floor ? this.floor * 0.9 + r * 0.1 : this.floor * 0.98 + r * 0.02;
          this.floor = Math.max(this.floor, 1e-4);
          this.pre.push(frame);
          if (this.pre.length > 3) this.pre.shift();
        }
        return;
      }
      this.event.push(frame);
      this.peak = Math.max(this.peak, r);
      const off = Math.max(this.floor * 2, this.peak * 0.08);
      this.quiet = r < off ? this.quiet + 1 : 0;
      if (this.quiet >= 12 || this.event.length >= this.maxFrames) {
        const frames = this.event.slice(0, this.event.length - Math.max(0, this.quiet - 3));
        this.event = null;
        this.pre = [];
        this.quiet = 0;
        const out = new Float32Array(frames.length * this.hop);
        frames.forEach((fr, i) => out.set(fr, i * this.hop));
        this.onEvent(out);
      }
    }
  }

  // ---------- Matcher ----------
  /**
   * templates: array of MFCC sequences. sensitivity: 0..1 (higher = triggers
   * more easily). Returns { threshold }. Threshold is calibrated from how
   * different your own samples are from each other.
   */
  function calibrate(templates, sensitivity) {
    let spread = 0, pairs = 0;
    for (let i = 0; i < templates.length; i++)
      for (let j = i + 1; j < templates.length; j++) {
        const d = dtw(templates[i], templates[j]);
        if (isFinite(d)) { spread = Math.max(spread, d); pairs++; }
      }
    if (!pairs) spread = 6; // single sample: generic fallback
    const s = Math.min(1, Math.max(0, sensitivity));
    return spread * (1.1 + s * 1.4);
  }

  /** Returns { distance, score } where score < 1 means "it's your sound". */
  function match(templates, threshold, feats) {
    let best = Infinity;
    for (const t of templates) best = Math.min(best, dtw(t, feats));
    return { distance: best, score: best / threshold };
  }

  const api = { mfcc, dtw, extractEvent, Segmenter, calibrate, match };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HFDSP = api;
})(typeof self !== 'undefined' ? self : this);
