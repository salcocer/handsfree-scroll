/*
 * Hands-free Scroll — content script.
 * Modes: auto (next video when the current one ends), sound (next video when
 * it hears your recorded trigger noise), or both.
 */
(() => {
  'use strict';
  if (window.__hfsLoaded) return;
  window.__hfsLoaded = true;
  const D = self.HFDSP;

  // ---------------------------------------------------------------- settings
  const DEFAULTS = {
    mode: 'off',        // off | auto | sound | both
    autoDelay: 0,       // seconds to wait after a video ends
    maxSeconds: 0,      // 0 = no limit, otherwise skip after N seconds
    sensitivity: 0.5,   // 0..1
    cooldown: 1.5,      // seconds between sound triggers
    samples: [],        // MFCC sequences of the trigger sound
  };
  let S = { ...DEFAULTS };
  let threshold = Infinity;

  const hasExtStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  function load(cb) {
    if (hasExtStorage) chrome.storage.local.get('hfs', (r) => cb((r && r.hfs) || {}));
    else { try { cb(JSON.parse(localStorage.getItem('hfs') || '{}')); } catch (e) { cb({}); } }
  }
  function save() {
    if (hasExtStorage) chrome.storage.local.set({ hfs: S });
    else localStorage.setItem('hfs', JSON.stringify(S));
  }
  function recalibrate() {
    threshold = S.samples.length ? D.calibrate(S.samples, S.sensitivity) : Infinity;
  }
  function update(patch) {
    S = { ...S, ...patch };
    recalibrate();
    save();
    apply();
  }
  if (hasExtStorage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.hfs && ch.hfs.newValue) {
        S = { ...DEFAULTS, ...ch.hfs.newValue };
        recalibrate();
        apply();
      }
    });
  }

  const wantsAuto = () => S.mode === 'auto' || S.mode === 'both';
  const wantsSound = () => S.mode === 'sound' || S.mode === 'both';

  // ------------------------------------------------------------ page helpers
  function onFeed() {
    if (window.__HFS_TEST) return true;
    const h = location.hostname, p = location.pathname;
    if (h.endsWith('tiktok.com')) return true;
    if (h.endsWith('youtube.com')) return p.startsWith('/shorts');
    if (h.endsWith('instagram.com')) return /^\/reels?(\/|$)/.test(p);
    if (h.endsWith('facebook.com')) return /^\/reels?(\/|$)/.test(p);
    return false;
  }

  function activeVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      let area = w * h;
      if (!v.paused) area *= 1.5;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  const ids = new WeakMap();
  let nextId = 1;
  function signature() {
    const v = activeVideo();
    if (v && !ids.has(v)) ids.set(v, nextId++);
    return `${location.href}|${v ? ids.get(v) : 0}|${v ? v.currentSrc : ''}`;
  }

  function scrollParent(el) {
    for (let e = el && el.parentElement; e && e !== document.body; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight + 20) return e;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Ways to go to the next video, tried in order until one works.
  const NEXT_BUTTONS = [
    '#navigation-button-down button',          // YouTube Shorts
    'button[aria-label="Next video"]',
    'button[aria-label="Go to next video"]',
    'button[aria-label="Next"]',
    '[data-e2e="arrow-down"]',
  ];
  function clickNextButton() {
    for (const sel of NEXT_BUTTONS) {
      const b = document.querySelector(sel);
      if (b && b.offsetParent !== null && !b.disabled) { b.click(); return true; }
    }
    return false;
  }
  function scrollFeed(v) {
    const sp = scrollParent(v);
    const root = sp === document.scrollingElement || sp === document.documentElement;
    const amount = root ? innerHeight : sp.clientHeight;
    (root ? window : sp).scrollBy({ top: amount, behavior: 'smooth' });
    return true;
  }
  function pressArrowDown() {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => 40 });
      Object.defineProperty(ev, 'which', { get: () => 40 });
      target.dispatchEvent(ev);
    }
    return true;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function changedFrom(before, ms) {
    for (let t = 0; t < ms; t += 100) {
      await sleep(100);
      if (signature() !== before) return true;
    }
    return false;
  }

  let busy = false;
  let lastNext = 0;
  async function goNext(reason) {
    if (busy) return false;
    busy = true;
    try {
      const before = signature();
      const v = activeVideo();
      for (const step of [clickNextButton, scrollFeed, pressArrowDown]) {
        if (!step(v)) continue;
        if (await changedFrom(before, 1200)) { toast(reason === 'sound' ? '🔊 next' : '⏭ next'); return true; }
      }
      toast('couldn’t find next video');
      return false;
    } finally {
      busy = false;
      lastNext = Date.now();
      resetAuto();
    }
  }
  window.__hfsNext = goNext; // handy for testing from the console

  // --------------------------------------------------------------- auto mode
  let autoState = { sig: '', last: 0, watched: 0, pending: null, tick: 0 };
  function resetAuto() {
    if (autoState.pending) clearTimeout(autoState.pending);
    autoState = { sig: signature(), last: 0, watched: 0, pending: null, tick: Date.now() };
  }
  function autoTick() {
    if (!wantsAuto() || !onFeed() || document.hidden || busy) return;
    if (Date.now() - lastNext < 1500) return;
    const v = activeVideo();
    if (!v) return;
    const sig = signature();
    if (sig !== autoState.sig) resetAuto();
    const now = Date.now();
    const dt = (now - autoState.tick) / 1000;
    autoState.tick = now;
    if (autoState.pending) return;
    if (v.paused && !v.ended) { autoState.last = v.currentTime; return; } // user paused: respect it
    autoState.watched += dt;

    const d = v.duration;
    const t = v.currentTime;
    let done = false;
    if (v.ended) done = true;
    else if (isFinite(d) && d > 0) {
      if (t >= d - 0.3) done = true;                                    // about to end
      else if (autoState.last > d - 1.2 && t < autoState.last - 1) done = true; // it looped
    }
    if (S.maxSeconds > 0 && autoState.watched >= S.maxSeconds) done = true;
    autoState.last = t;
    if (done) {
      autoState.pending = setTimeout(() => { autoState.pending = null; goNext('auto'); }, S.autoDelay * 1000);
    }
  }
  setInterval(autoTick, 250);

  // -------------------------------------------------------------- sound mode
  let mic = null;          // { stream, ctx, seg, proc }
  let recording = null;    // { chunks, resolve }
  let lastScore = null;

  async function startMic() {
    if (mic) { if (mic.ctx.state === 'suspended') await mic.ctx.resume(); return mic; }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const seg = new D.Segmenter(ctx.sampleRate, onSoundEvent);
    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      if (recording) recording.chunks.push(Float32Array.from(data));
      else seg.push(data);
      ui.meter(seg.level);
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    mic = { stream, ctx, seg, proc };
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    ui.render();
    return mic;
  }
  function stopMic() {
    if (!mic) return;
    mic.proc.onaudioprocess = null;
    mic.stream.getTracks().forEach((t) => t.stop());
    mic.ctx.close().catch(() => {});
    mic = null;
    ui.render();
  }

  function onSoundEvent(ev) {
    if (!wantsSound() || !S.samples.length || !onFeed()) return;
    const feats = D.mfcc(ev, mic.ctx.sampleRate);
    const { score } = D.match(S.samples, threshold, feats);
    lastScore = score;
    ui.score(score);
    if (score < 1 && Date.now() - lastNext > S.cooldown * 1000) goNext('sound');
  }

  async function recordSample() {
    await startMic();
    ui.status('Make your sound now…');
    const chunks = await new Promise((resolve) => {
      recording = { chunks: [], resolve };
      setTimeout(() => { const c = recording.chunks; recording = null; resolve(c); }, 2000);
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const ev = D.extractEvent(buf, mic.ctx.sampleRate);
    if (!ev) { ui.status('Didn’t hear anything — try again, a bit louder.'); return; }
    const feats = D.mfcc(ev, mic.ctx.sampleRate);
    if (feats.length < 2) { ui.status('Too short — try again.'); return; }
    const samples = S.samples.concat([feats.map((f) => f.map((x) => Math.round(x * 1000) / 1000))]).slice(-5);
    update({ samples });
    ui.status(samples.length < 3 ? `Got it (${samples.length}/3). Record it again.` : 'Trigger ready ✓');
  }

  // ------------------------------------------------------------------- apply
  function apply() {
    const shouldListen = wantsSound() && onFeed() && !document.hidden;
    if (shouldListen && !mic) startMic().catch(() => ui.status('Tap the panel to allow the microphone.'));
    if (!shouldListen && mic && !recording && !ui.isOpen()) stopMic();
    resetAuto();
    ui.render();
  }
  document.addEventListener('visibilitychange', apply);
  // Browsers need a tap before audio can start after a page load.
  document.addEventListener('pointerdown', () => { if (wantsSound() && onFeed() && (!mic || mic.ctx.state !== 'running')) startMic().catch(() => {}); }, true);
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; ui.render(); } }, 1000);

  // ---------------------------------------------------------------------- UI
  const ui = (() => {
    const host = document.createElement('div');
    host.id = 'hfs-root';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:140px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
  * { box-sizing: border-box; }
  .panel, .toast, .fab, button, select { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .panel { color: #f2f2f2; font-size: 14px; line-height: 1.35; }
  .fab { width: 48px; height: 48px; border-radius: 50%; border: 0; display: grid; place-items: center;
         background: #2b2b2b; color: #fff; font-size: 22px; box-shadow: 0 2px 10px rgba(0,0,0,.4); cursor: pointer; margin-left: auto; position: relative; }
  .fab[data-mode=auto] { background: #1f8a4c; } .fab[data-mode=sound] { background: #2563eb; } .fab[data-mode=both] { background: #7c3aed; }
  .dot { position: absolute; right: 3px; top: 3px; width: 10px; height: 10px; border-radius: 50%; background: #f43f5e; display: none; }
  .fab.listening .dot { display: block; }
  .panel { display: none; width: 280px; max-width: calc(100vw - 24px); background: #161616f2; border: 1px solid #333; border-radius: 14px;
           padding: 12px; margin-bottom: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  .panel.open { display: block; }
  h1 { font-size: 15px; margin: 0 0 10px; font-weight: 650; }
  .seg { display: grid; grid-template-columns: repeat(4,1fr); gap: 4px; margin-bottom: 12px; }
  .seg button { border: 1px solid #3a3a3a; background: #222; color: #ddd; border-radius: 8px; padding: 7px 0; font: inherit; font-size: 13px; cursor: pointer; }
  .seg button.on { background: #f2f2f2; color: #111; border-color: #f2f2f2; }
  section { border-top: 1px solid #2c2c2c; padding-top: 10px; margin-top: 10px; }
  section.off { opacity: .4; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
  select { background: #222; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 3px 4px; font: inherit; font-size: 13px; }
  input[type=range] { width: 120px; }
  .row { display: flex; gap: 6px; margin: 8px 0; }
  .btn { flex: 1; border: 0; border-radius: 8px; padding: 8px; font: inherit; font-size: 13px; cursor: pointer; background: #2563eb; color: #fff; }
  .btn.ghost { background: #2a2a2a; color: #ddd; flex: 0 0 auto; padding: 8px 12px; }
  .muted { color: #9a9a9a; font-size: 12px; }
  .meter { height: 6px; background: #2a2a2a; border-radius: 3px; overflow: hidden; margin: 6px 0 2px; }
  .meter > i { display: block; height: 100%; width: 0; background: #22c55e; transition: width .08s; }
  .status { min-height: 17px; font-size: 12px; color: #cbd5e1; }
  .toast { position: fixed; right: 12px; bottom: 196px; background: #000c; color: #fff; padding: 6px 10px; border-radius: 8px; font-size: 13px;
           opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
<div class="toast"></div>
<div class="panel">
  <h1>Hands-free scroll</h1>
  <div class="seg">
    <button data-m="off">Off</button><button data-m="auto">Auto</button><button data-m="sound">Sound</button><button data-m="both">Both</button>
  </div>
  <section class="auto">
    <div class="muted">Auto: goes to the next video when one ends.</div>
    <label>Wait after it ends
      <select name="autoDelay"><option value="0">0 s</option><option value="1">1 s</option><option value="2">2 s</option><option value="3">3 s</option></select></label>
    <label>Max time per video
      <select name="maxSeconds"><option value="0">no limit</option><option value="10">10 s</option><option value="20">20 s</option><option value="30">30 s</option><option value="60">60 s</option></select></label>
  </section>
  <section class="sound">
    <div class="muted">Sound: record any noise (click, whistle, tongue pop) 3 times. Making it again skips to the next video.</div>
    <div class="row"><button class="btn rec">● Record sample</button><button class="btn ghost clear">Clear</button></div>
    <div class="muted samples"></div>
    <div class="meter"><i></i></div>
    <div class="muted score">&nbsp;</div>
    <label>Sensitivity <input type="range" name="sensitivity" min="0" max="1" step="0.05"></label>
    <label>Min time between skips
      <select name="cooldown"><option value="1">1 s</option><option value="1.5">1.5 s</option><option value="2">2 s</option><option value="3">3 s</option></select></label>
  </section>
  <section>
    <div class="row"><button class="btn ghost test" style="flex:1">Skip now (test)</button></div>
    <div class="status"></div>
  </section>
</div>
<button class="fab" title="Hands-free scroll"><span>⇣</span><i class="dot"></i></button>`;

    const $ = (s) => root.querySelector(s);
    const panel = $('.panel'), fab = $('.fab'), toastEl = $('.toast');
    let open = false;

    // keep taps/keys on the panel from reaching the site underneath
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'wheel', 'keydown', 'keyup', 'dblclick'])
      host.addEventListener(t, (e) => e.stopPropagation());

    fab.addEventListener('click', () => { open = !open; apply(); });
    root.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => update({ mode: b.dataset.m })));
    root.querySelectorAll('select, input[type=range]').forEach((el) =>
      el.addEventListener('change', () => update({ [el.name]: parseFloat(el.value) })));
    $('.rec').addEventListener('click', () => recordSample().catch((e) => status('Mic error: ' + e.message)));
    $('.clear').addEventListener('click', () => { update({ samples: [] }); status('Samples cleared.'); });
    $('.test').addEventListener('click', () => goNext('test'));

    let statusTimer;
    function status(msg) {
      $('.status').textContent = msg;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { $('.status').textContent = ''; }, 6000);
    }
    let toastTimer;
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 900);
    }
    function meter(level) {
      const pct = Math.min(100, Math.max(0, (Math.log10(level + 1e-5) + 4) * 30));
      $('.meter > i').style.width = pct + '%';
    }
    function score(s) {
      $('.score').textContent = `Last sound: ${s < 1 ? 'match ✓' : 'no match'} (${s.toFixed(2)}, below 1.00 = match)`;
    }
    function render() {
      if (!document.body) return;
      if (!host.isConnected) document.documentElement.appendChild(host);
      host.style.display = onFeed() ? '' : 'none';
      panel.classList.toggle('open', open);
      fab.dataset.mode = S.mode;
      fab.classList.toggle('listening', !!mic);
      root.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === S.mode));
      $('section.auto').classList.toggle('off', !wantsAuto());
      $('section.sound').classList.toggle('off', !wantsSound());
      root.querySelectorAll('select, input[type=range]').forEach((el) => { el.value = String(S[el.name]); });
      const n = S.samples.length;
      $('.samples').textContent = n ? `${n} sample${n > 1 ? 's' : ''} recorded${n < 3 ? ' — 3 recommended' : ''}` : 'No trigger sound yet.';
    }
    return { render, status, toast, meter, score, isOpen: () => open };
  })();
  const toast = ui.toast;

  // -------------------------------------------------------------------- boot
  load((saved) => {
    S = { ...DEFAULTS, ...saved };
    recalibrate();
    const boot = () => apply();
    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
  });
})();
