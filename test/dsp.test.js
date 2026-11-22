// Run: node test/dsp.test.js
// Synthetic check: record 3 samples of a "trigger" sound, then make sure the
// matcher fires on new takes of that sound and ignores different noises,
// including when everything is buried in a stream of background noise.
const assert = require('assert');
const D = require('../src/dsp.js');

const SR = 48000;
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (n, amp) => Float32Array.from({ length: n }, () => (rand() * 2 - 1) * amp);

function mix(a, b) { const o = Float32Array.from(a); for (let i = 0; i < b.length && i < o.length; i++) o[i] += b[i]; return o; }
function pad(sig, before, after, amp) {
  const o = noise(before + sig.length + after, amp);
  for (let i = 0; i < sig.length; i++) o[before + i] += sig[i];
  return o;
}

// Sounds (each call = a slightly different "take")
const v = (x, pct) => x * (1 + (rand() * 2 - 1) * pct);
function whistle() { // rising whistle ~1.4k -> 2.2k
  const dur = v(0.35, 0.15), n = Math.floor(dur * SR), f0 = v(1400, 0.05), f1 = v(2200, 0.05), g = v(0.3, 0.5);
  let ph = 0; return Float32Array.from({ length: n }, (_, i) => { const t = i / n; ph += (2 * Math.PI * (f0 + (f1 - f0) * t)) / SR; return g * Math.sin(ph) * Math.sin(Math.PI * t); });
}
function tongueClick() { // short resonant click ~ 900 Hz
  const n = Math.floor(v(0.06, 0.2) * SR), f = v(900, 0.08), g = v(0.5, 0.5);
  return Float32Array.from({ length: n }, (_, i) => g * Math.exp(-i / (SR * 0.012)) * (Math.sin((2 * Math.PI * f * i) / SR) + 0.3 * (rand() * 2 - 1)));
}
function clap() { // broadband noise burst
  const n = Math.floor(v(0.12, 0.2) * SR), g = v(0.5, 0.5);
  return Float32Array.from({ length: n }, (_, i) => g * Math.exp(-i / (SR * 0.025)) * (rand() * 2 - 1));
}
function hum() { // low voice-like hum
  const n = Math.floor(v(0.5, 0.2) * SR), f = v(160, 0.1), g = v(0.3, 0.5);
  return Float32Array.from({ length: n }, (_, i) => { const t = i / n; let s = 0; for (let h = 1; h <= 6; h++) s += Math.sin((2 * Math.PI * f * h * i) / SR) / h; return g * 0.4 * s * Math.sin(Math.PI * t); });
}
function knock() { // low thump ~120 Hz
  const n = Math.floor(v(0.15, 0.2) * SR), f = v(120, 0.1), g = v(0.6, 0.4);
  return Float32Array.from({ length: n }, (_, i) => g * Math.exp(-i / (SR * 0.03)) * Math.sin((2 * Math.PI * f * i) / SR));
}

function enroll(gen) {
  const t = [];
  for (let k = 0; k < 3; k++) {
    const rec = pad(gen(), SR * 0.6, SR * 0.8, 0.003); // 2 s-ish recording with room noise
    const ev = D.extractEvent(rec, SR);
    assert(ev, 'should find an event in the recording');
    t.push(D.mfcc(ev, SR));
  }
  return t;
}

function scoreOf(templates, thr, sig) {
  // run through the streaming segmenter like the live listener does
  const stream = pad(sig, SR * 0.5, SR * 0.5, 0.004);
  const scores = [];
  const seg = new D.Segmenter(SR, (ev) => scores.push(D.match(templates, thr, D.mfcc(ev, SR)).score));
  for (let i = 0; i < stream.length; i += 2048) seg.push(stream.subarray(i, i + 2048));
  assert(scores.length >= 1, 'segmenter should catch the sound');
  return Math.min(...scores);
}

const others = { tongueClick, clap, hum, knock };
let failures = 0;
for (const [name, trigger] of Object.entries({ whistle, tongueClick, clap })) {
  const templates = enroll(trigger);
  const thr = D.calibrate(templates, 0.5);
  let hits = 0;
  const N = 20;
  for (let i = 0; i < N; i++) if (scoreOf(templates, thr, trigger()) < 1) hits++;
  const fa = {};
  for (const [on, g] of Object.entries({ whistle, ...others })) {
    if (on === name) continue;
    let f = 0; for (let i = 0; i < N; i++) if (scoreOf(templates, thr, g()) < 1) f++;
    fa[on] = f;
  }
  const faTotal = Object.values(fa).reduce((a, b) => a + b, 0);
  console.log(`${name.padEnd(12)} hits ${hits}/${N}  false triggers ${JSON.stringify(fa)}`);
  if (hits < N * 0.85 || faTotal > 2) failures++;
}

// background-only stream should not produce events
{
  let events = 0;
  const seg = new D.Segmenter(SR, () => events++);
  const bg = noise(SR * 5, 0.01);
  for (let i = 0; i < bg.length; i += 2048) seg.push(bg.subarray(i, i + 2048));
  console.log(`steady background: ${events} events`);
  assert.strictEqual(events, 0);
}

assert.strictEqual(failures, 0, 'matcher quality below target');
console.log('OK');
