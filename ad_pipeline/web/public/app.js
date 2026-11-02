'use strict';
/*
 * AD speech-rate experiment client.
 * Failsafe design:
 *  - Every completed step is an event with a sequence number. Events are saved to localStorage first, then
 *    uploaded through an outbox with exponential-backoff retry. The server stores (pid, seq) idempotently.
 *  - At the end the client asks the server which seqs it holds and re-sends any that are missing.
 *  - All audio is downloaded (and kept in Cache Storage) before the first trial, so a network drop during the
 *    experiment does not stop it; uploads simply wait in the outbox.
 *  - Reload / crash: the participant resumes where they were. A trial whose audio had started but whose
 *    answers were not all given is recorded as "interrupted" and skipped (no replay, per protocol).
 *  - "下載備份" is always available and exports everything recorded locally.
 */
(() => {
  const NS = 'adexp1';
  const $app = document.getElementById('app');
  const $sync = document.getElementById('sync');
  const qs = new URLSearchParams(location.search);
  let D = null;          // design.json
  let S = null;          // persisted participant state
  let ctx = null;        // AudioContext
  let currentSrc = null; // playing source (adjustment block)
  const mem = new Map(); // audio bytes if Cache Storage is unavailable

  // ------------------------------------------------------------------ utilities
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowISO = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = (html) => { $app.innerHTML = html; window.scrollTo(0, 0); };
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; await fn(items[j], j); } })); }
  function randomPid() { const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = 'R'; const r = crypto.getRandomValues(new Uint8Array(6)); for (const x of r) s += c[x % c.length]; return s; }
  const itemById = (id) => [...D.main, D.practice, D.attention].find((x) => x.id === id);

  // ------------------------------------------------------------------ persistence
  const stateKey = (pid) => `${NS}:${pid}`;
  function save() {
    try {
      localStorage.setItem(stateKey(S.pid), JSON.stringify(S));
      localStorage.setItem(`${NS}:current`, S.pid);
      S._storageOk = true;
    } catch {
      if (S._storageOk !== false) { S._storageOk = false; banner('瀏覽器無法暫存進度（可能是無痕視窗或空間不足）。資料仍會上傳，但請不要重新整理頁面。'); }
    }
  }
  function readState(pid) { try { return JSON.parse(localStorage.getItem(stateKey(pid))); } catch { return null; } }
  function banner(msg) { const d = document.createElement('div'); d.className = 'card err small'; d.textContent = msg; document.body.prepend(d); }

  // ------------------------------------------------------------------ events + outbox
  function emit(type, payload) {
    const ev = { seq: S.seq++, type, pid: S.pid, design_version: D.version, client_ts: nowISO(), payload };
    S.records.push(ev);
    S.outbox.push(ev.seq);
    save();
    flush();
    return ev;
  }
  let flushing = false, backoff = 1000, retryTimer = null, lastOk = Date.now();
  async function flush() {
    if (!S || flushing) return updateSync();
    if (!S.outbox.length) { lastOk = Date.now(); return updateSync(); }
    flushing = true;
    try {
      while (S.outbox.length) {
        const seq = S.outbox[0];
        const ev = S.records.find((r) => r.seq === seq);
        if (!ev) { S.outbox.shift(); continue; }
        const r = await fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ev), keepalive: true });
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          // Permanent rejection: keep it in the local backup, stop retrying it.
          S.rejected.push({ seq, status: r.status, body: await r.text().catch(() => '') });
          S.outbox.shift(); save(); continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        S.outbox.shift(); save();
        backoff = 1000; lastOk = Date.now();
      }
    } catch {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, backoff);
      backoff = Math.min(backoff * 2, 30000);
    } finally { flushing = false; updateSync(); }
  }
  async function reconcile() {
    try {
      const r = await fetch(`/api/status?pid=${encodeURIComponent(S.pid)}`, { cache: 'no-store' });
      if (!r.ok) return false;
      const have = new Set((await r.json()).seqs);
      const missing = S.records.map((e) => e.seq).filter((s) => !have.has(s) && !S.outbox.includes(s) && !S.rejected.some((x) => x.seq === s));
      if (missing.length) { S.outbox.push(...missing); save(); }
      await flush();
      return missing.length === 0 && S.outbox.length === 0;
    } catch { return false; }
  }
  function updateSync() {
    if (!S) { $sync.textContent = ''; return; }
    const n = S.outbox.length, stale = n > 0 && Date.now() - lastOk > 60000;
    $sync.textContent = n === 0 ? '資料已上傳 ✓' : `待上傳 ${n} 筆${stale ? '（連線中斷，資料已保存在這台電腦）' : ''}`;
    $sync.className = stale ? 'bad' : '';
  }
  addEventListener('online', () => flush());
  setInterval(() => { if (S?.outbox.length) flush(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });

  function downloadBackup() {
    if (!S) return alert('目前沒有資料。');
    const blob = new Blob([JSON.stringify({ pid: S.pid, list: S.list, mode: S.mode, design_version: D?.version,
      exported_at: nowISO(), outbox: S.outbox, rejected: S.rejected, records: S.records }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup_${S.pid}_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  document.getElementById('backupBtn').onclick = downloadBackup;

  let errCount = 0;
  addEventListener('error', (e) => { if (S && errCount++ < 5) emit('client_error', { msg: String(e.message), src: e.filename, line: e.lineno, step: S.step }); });
  addEventListener('unhandledrejection', (e) => { if (S && errCount++ < 5) emit('client_error', { msg: String(e.reason?.message || e.reason), step: S.step }); });
  addEventListener('storage', (e) => { if (S && e.key === stateKey(S.pid)) banner('這個實驗在另一個分頁也開著。請關閉其他分頁，只保留一個。'); });
  // Warn on leaving until the session is over and every record has reached the server.
  addEventListener('beforeunload', (e) => { if (S && (S.step !== 'done' || S.outbox.length || !S.uploadConfirmed)) { e.preventDefault(); e.returnValue = ''; } });
  history.pushState(null, '', location.href);
  addEventListener('popstate', () => history.pushState(null, '', location.href));

  // ------------------------------------------------------------------ audio
  async function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* resumed on next gesture */ } }
  }
  const stimURL = (f) => `/api/stim?f=${f}`;
  let cacheP = null;
  const getCache = () => ('caches' in window ? (cacheP ||= caches.open('adexp-stim-v1').catch(() => null)) : Promise.resolve(null));
  async function fetchBytes(f, tries = 5) {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(stimURL(f));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ab = await r.arrayBuffer();
        if (ab.byteLength < 2000) throw new Error('short file');
        return ab;
      } catch (e) { if (i >= tries - 1) throw e; await sleep(500 * 2 ** i); }
    }
  }
  async function getBytes(f) {
    if (mem.has(f)) return mem.get(f);
    const c = await getCache();
    if (c) {
      const hit = await c.match(stimURL(f)).catch(() => null);
      if (hit) { const ab = await hit.arrayBuffer(); if (ab.byteLength >= 2000) return ab; }
    }
    const ab = await fetchBytes(f);
    if (c) { try { await c.put(stimURL(f), new Response(ab.slice(0), { headers: { 'content-type': 'audio/mpeg' } })); } catch { mem.set(f, ab); } }
    else mem.set(f, ab);
    return ab;
  }
  async function decode(f) {
    try { return await ctx.decodeAudioData((await getBytes(f)).slice(0)); }
    catch {
      const c = await getCache(); if (c) await c.delete(stimURL(f)).catch(() => {});
      mem.delete(f);
      return await ctx.decodeAudioData((await fetchBytes(f)).slice(0));
    }
  }
  function stopAudio() { try { currentSrc?.stop(); } catch { /* already stopped */ } currentSrc = null; }
  async function playBuffer(buf) {
    await ensureCtx();
    stopAudio();
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      let hidden = document.hidden;
      const onVis = () => { if (document.hidden) hidden = true; };
      document.addEventListener('visibilitychange', onVis);
      const t0 = performance.now();
      src.onended = () => { document.removeEventListener('visibilitychange', onVis); if (currentSrc === src) currentSrc = null;
        resolve({ played_ms: Math.round(performance.now() - t0), buffer_s: +buf.duration.toFixed(3), hidden }); };
      currentSrc = src;
      src.start();
    });
  }
  const playFile = async (f) => playBuffer(await decode(f));

  // Headphone screening tones (Woods et al., 2017): 200 Hz, one 6 dB quieter, one in antiphase across ears.
  function tone(kind) {
    const sr = ctx.sampleRate, n = Math.round(sr * 1.0), ramp = Math.round(sr * 0.1);
    const buf = ctx.createBuffer(2, n, sr), L = buf.getChannelData(0), R = buf.getChannelData(1);
    const amp = kind === 'quiet' ? 0.25 * 0.5 : 0.25;
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / ramp, (n - i) / ramp);
      const v = amp * env * Math.sin(2 * Math.PI * 200 * i / sr);
      L[i] = v; R[i] = kind === 'anti' ? -v : v;
    }
    return buf;
  }

  // ------------------------------------------------------------------ plan
  function makePlan() {
    const r = rng(hashStr(`${S.pid}|${D.version}`));
    const groupOf = {}; D.groups.forEach((g, gi) => g.forEach((id) => { groupOf[id] = gi; }));
    const mk = (kind, it, k) => {
      const s = it.stimuli.find((x) => x.k === k);
      return { kind, id: it.id, clip: it.clip, ver: it.ver, k, bin: D.bin_of_k[k], rate: s.rate, syl_per_s: s.syl_per_s,
        narr_dur: s.narr_dur, file: s.file, opt_order: shuffle([0, 1, 2, 3], r) };
    };
    const main = D.main.map((it) => {
      const bin = (groupOf[it.id] + S.list) % D.n_bins;
      const ks = D.bin_of_k.map((b, k) => (b === bin ? k : -1)).filter((k) => k >= 0);
      return mk('main', it, ks[Math.floor(r() * ks.length)]);
    });
    let order = main;
    for (let t = 0; t < 5000; t++) {
      const o = shuffle(main.slice(), r);
      if (o.every((x, i) => i === 0 || x.clip !== o[i - 1].clip)) { order = o; break; }
      order = o;
    }
    order.splice(9 + Math.floor(r() * 7), 0, mk('attention', D.attention, D.attention.stimuli[0].k));
    const re = order.find((x) => x.kind === 'main' && x.bin === 2) || order.find((x) => x.kind === 'main');
    order.push({ ...re, kind: 'retest', opt_order: shuffle([0, 1, 2, 3], r) });
    const trials = [mk('practice', D.practice, D.practice.stimuli[0].k), ...order];
    trials.forEach((t, i) => { t.trial_no = i; });
    const nMax = D.rates.length - 1;
    const adjust = shuffle(D.adjust.slice(), r).map((it, i) => ({
      id: it.id, start_k: (i + S.list) % 2 === 0 ? Math.floor(r() * 4) : nMax - Math.floor(r() * 4),
    }));
    const nScored = trials.length - 1;
    return { trials, adjust, breakAfter: Math.ceil(nScored / 2) };
  }
  const allFiles = () => {
    const f = new Set(S.plan.trials.map((t) => t.file));
    for (const a of S.plan.adjust) D.adjust.find((x) => x.id === a.id).stimuli.forEach((s) => f.add(s.file));
    return [...f];
  };

  // ------------------------------------------------------------------ boot
  async function boot() {
    for (let i = 0; ; i++) {
      try { const r = await fetch('/api/design', { cache: 'no-store' }); if (!r.ok) throw 0; D = await r.json(); break; }
      catch { if (i >= 4) return view('<div class="card err">無法載入實驗設定，請檢查網路後重新整理頁面。</div>'); await sleep(1000 * 2 ** i); }
    }
    const urlPid = qs.get('pid');
    const curPid = urlPid || localStorage.getItem(`${NS}:current`);
    const prev = curPid ? readState(curPid) : null;
    if (prev && prev.design_version === D.version) {
      // Finished but not yet confirmed uploaded (e.g. page reloaded on the upload screen): keep uploading.
      if (prev.step === 'done' && !prev.uploadConfirmed) { S = prev; return render(); }
      if (prev.step !== 'done') return screenResume(prev);
    }
    screenStart();
  }

  function screenResume(prev) {
    const done = prev.plan ? prev.t : 0, total = prev.plan ? prev.plan.trials.length : '?';
    view(`<div class="card"><h1>繼續未完成的實驗</h1>
      <p>這台電腦上有一份還沒完成的實驗（編號 <b>${esc(prev.pid)}</b>，已完成 ${done}／${total} 題）。</p>
      <div class="row"><button class="primary" id="go">從中斷的地方繼續</button><button id="fresh">開始新的實驗</button></div></div>`);
    document.getElementById('go').onclick = async () => {
      await ensureCtx();
      S = prev; S.resumes = (S.resumes || 0) + 1; save();
      if (S.step === 'trials' && S.cur && S.cur.phase === 'playing') commitTrial('interrupted');
      reconcile(); render();
    };
    document.getElementById('fresh').onclick = () => {
      if (!confirm('確定要開始新的實驗嗎？上一份未完成的資料會保留在這台電腦，但不會再繼續。')) return;
      try { localStorage.removeItem(`${NS}:current`); } catch { /* ignore */ }
      screenStart(true);
    };
  }

  function screenStart(forceNewPid = false) {
    const pid = (!forceNewPid && qs.get('pid')) || randomPid();
    view(`<div class="card"><h1>旁白聆聽實驗</h1>
      <p>這個實驗約需 <b>20 分鐘</b>。請使用電腦（不建議用手機），在安靜的地方<b>戴上耳機</b>進行。</p>
      <label class="field"><span>參與編號</span><input type="text" id="pid" value="${esc(pid)}" autocomplete="off">
        <small class="mute">若實驗人員有給你編號請填入；否則保留系統產生的編號即可。</small></label>
      <p id="msg" class="err small"></p>
      <button class="primary" id="go">開始</button></div>`);
    document.getElementById('go').onclick = async (ev) => {
      const btn = ev.currentTarget, msg = document.getElementById('msg');
      const p = document.getElementById('pid').value.trim();
      const m = 'remote'; // all sessions are remote; kept in the data for compatibility with earlier records
      if (!/^[A-Za-z0-9_-]{2,40}$/.test(p)) return (msg.textContent = '參與編號只能用英文字母、數字、- 或 _。');
      if (readState(p)?.step === 'done') return (msg.textContent = '這個參與編號已經完成過實驗，請改用新的編號。');
      btn.disabled = true; msg.textContent = '連線中…';
      await ensureCtx();
      let list = null, assigned = 'server';
      for (let i = 0; i < 4 && list === null; i++) {
        try {
          const r = await fetch('/api/assign', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pid: p, mode: m, n_lists: D.n_lists }) });
          if (r.ok) list = (await r.json()).list; else throw 0;
        } catch { await sleep(800 * 2 ** i); }
      }
      if (list === null) { list = hashStr(p) % D.n_lists; assigned = 'offline_hash'; }
      S = { pid: p, mode: m, list, assigned, design_version: D.version, seq: 0, records: [], outbox: [], rejected: [],
        step: 'consent', t: 0, cur: null, a: 0, curAdj: null, breakDone: false, created: nowISO() };
      S.plan = makePlan();
      save();
      emit('session', { list, assigned, mode: m, plan: S.plan, ua: navigator.userAgent, lang: navigator.language,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height, devicePixelRatio],
        sample_rate: ctx?.sampleRate, url: location.pathname + location.search });
      render();
    };
  }

  // ------------------------------------------------------------------ router
  function go(step) { S.step = step; save(); render(); }
  function render() {
    updateSync();
    ({ consent: screenConsent, demo: screenDemo, preload: screenPreload, volume: screenVolume, hp: screenHP,
      instructions: screenInstructions, trials: screenTrial, adj_intro: screenAdjIntro, adjust: screenAdjust,
      final: screenFinal, done: screenDone }[S.step] || screenDone)();
  }

  function screenConsent() {
    view(`<div class="card"><h1>參與說明與同意</h1>
      <p>這是「人類感知」課程的研究作業，想了解<b>口述影像旁白的語速</b>如何影響聆聽感受。</p>
      <ul><li>你會聽到約 30 段、每段約 10 秒的電影片段聲音（畫面全黑），並回答幾個簡單問題；最後用滑桿調整 3 段旁白的速度。全程約 20 分鐘。</li>
        <li>部分片段來自驚悚、暴力電影（例如怪物攻擊、車禍爆炸），會聽到尖叫、爆炸等聲音，<b>不會看到畫面</b>。</li>
        <li>參加完全自願，你可以隨時關閉頁面停止，不需說明理由。</li>
        <li>我們不收集姓名或聯絡方式，只以編號記錄你的作答，資料只用於課程報告與期末專題。</li></ul>
      <label class="opts"><label><input type="checkbox" id="ok"> 我已閱讀以上說明，年滿 18 歲，同意參加。</label></label>
      <p><button class="primary" id="go" disabled>同意並繼續</button></p></div>`);
    const ok = document.getElementById('ok'), b = document.getElementById('go');
    ok.onchange = () => { b.disabled = !ok.checked; };
    b.onclick = () => { emit('consent', { agreed: true }); go('demo'); };
  }

  function screenDemo() {
    const radio = (name, opts) => `<div class="opts">${opts.map((o) => `<label><input type="radio" name="${name}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`;
    view(`<div class="card"><h1>基本資料</h1><p class="mute small">不會記錄姓名。標 * 為必填。</p>
      <div class="field"><span><b>年齡 *</b></span>${radio('age', ['18–24', '25–34', '35–44', '45 以上'])}</div>
      <div class="field"><span><b>性別 *</b></span>${radio('gender', ['女', '男', '其他', '不想回答'])}</div>
      <div class="field"><span><b>華語（中文）是你的母語嗎？ *</b></span>${radio('native', ['是', '否'])}</div>
      <div class="field"><span><b>你覺得自己的聽力正常嗎？ *</b></span>${radio('hearing', ['正常', '有些困難', '不確定'])}</div>
      <div class="field"><span><b>你的英語聽力大約如何？ *</b>（片中對白是英文）</span>${radio('english', ['1 幾乎聽不懂', '2', '3', '4', '5 完全沒問題'])}</div>
      <div class="field"><span><b>你平常會用倍速聽影片、Podcast 或有聲書嗎？ *</b></span>${radio('speed', ['從不', '偶爾', '經常'])}
        <label class="field"><span class="small mute">如果會，通常用幾倍速？</span><input type="text" id="speed_x" placeholder="例如 1.5"></label></div>
      <div class="field"><span><b>你有使用螢幕報讀軟體的習慣嗎？ *</b></span>${radio('sr', ['沒有', '有'])}</div>
      <div class="field"><span><b>你看過下列電影嗎？</b>（可複選）</span><div class="opts">
        <label><input type="checkbox" name="seen" value="Liar Liar"> 王牌大騙子（Liar Liar）</label>
        <label><input type="checkbox" name="seen" value="Dragon Tattoo"> 龍紋身的女孩（The Girl with the Dragon Tattoo）</label>
        <label><input type="checkbox" name="seen" value="The Thing"> 突變第三型（The Thing, 2011）</label></div></div>
      <div class="field"><span><b>你現在用的是哪種耳機？ *</b></span>${radio('phones', ['耳罩式', '入耳式／耳塞式', '其他', '沒有耳機'])}</div>
      <p id="msg" class="err small"></p><button class="primary" id="go">繼續</button></div>`);
    document.getElementById('go').onclick = () => {
      const v = (n) => document.querySelector(`input[name=${n}]:checked`)?.value;
      const req = ['age', 'gender', 'native', 'hearing', 'english', 'speed', 'sr', 'phones'];
      if (req.some((n) => !v(n))) return (document.getElementById('msg').textContent = '還有必填題沒有回答。');
      if (v('phones') === '沒有耳機') return (document.getElementById('msg').textContent = '這個實驗需要戴耳機。請準備好耳機後再繼續。');
      const p = Object.fromEntries(req.map((n) => [n, v(n)]));
      p.speed_x = document.getElementById('speed_x').value.trim();
      p.seen = [...document.querySelectorAll('input[name=seen]:checked')].map((x) => x.value);
      emit('demo', p);
      go('preload');
    };
  }

  async function screenPreload() {
    const files = allFiles();
    view(`<div class="card"><h1>下載音檔</h1><p>正在下載實驗用的音檔（約 ${files.length} 個）。下載完成後，即使網路不穩也能繼續作答。</p>
      <div class="progress"><div id="bar"></div></div><p id="pct" class="mute small">0%</p><p id="msg" class="err small"></p></div>`);
    const t0 = performance.now();
    const failed = [];
    let n = 0;
    await pool(files, 4, async (f) => {
      try { await getBytes(f); } catch { failed.push(f); }
      n++;
      const bar = document.getElementById('bar'); if (bar) bar.style.width = `${(100 * n / files.length).toFixed(0)}%`;
      const pct = document.getElementById('pct'); if (pct) pct.textContent = `${n}／${files.length}`;
    });
    if (failed.length) {
      document.getElementById('msg').innerHTML = `有 ${failed.length} 個音檔下載失敗，請確認網路後再試一次。<br><button id="retry">重新下載</button>`;
      document.getElementById('retry').onclick = () => render();
      return;
    }
    S.preload_ms = Math.round(performance.now() - t0); save();
    go('volume');
  }

  function screenVolume() {
    let plays = 0;
    view(`<div class="card"><h1>調整音量</h1><p>請戴上耳機，按「播放範例」。範例是一段電影聲音加上中文旁白。</p>
      <p>請把電腦音量調到<b>能清楚聽到旁白、又不會太大聲</b>的程度。可以重複播放。<b>調好之後，實驗過程中請不要再改音量。</b></p>
      <div class="row"><button id="play">▶ 播放範例</button><button class="primary" id="go" disabled>音量已調好</button></div>
      <p id="msg" class="mute small"></p></div>`);
    document.getElementById('play').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { await playFile(D.practice.stimuli[0].file); plays++; document.getElementById('go').disabled = false; }
      catch { document.getElementById('msg').textContent = '播放失敗，請再按一次。'; }
      e.target.disabled = false;
    };
    document.getElementById('go').onclick = () => { emit('volume', { plays }); go('hp'); };
  }

  function screenHP() {
    const attempt = (S.hpAttempts || 0) + 1;
    const r = rng(hashStr(`${S.pid}|hp|${attempt}`));
    const trials = Array.from({ length: 6 }, () => shuffle(['ref', 'quiet', 'anti'], r));
    const answers = [];
    let i = 0;
    const step = () => {
      if (i >= trials.length) return finish();
      const n = trials.length;
      const dots = trials.map((_, j) => `<span class="${j < i ? 'done' : j === i ? 'cur' : ''}"></span>`).join('');
      view(`<div class="card fadein"><h1>耳機檢查</h1>
        <div class="steps" aria-hidden="true">${dots}</div>
        <p class="qnum">第 ${i + 1} 題（共 ${n} 題）</p>
        <p>你會聽到三個「嗡」聲。請選出<b>最小聲</b>的是第幾個。每題只播放一次。</p>
        <p class="row"><button class="primary" id="play">▶ 播放第 ${i + 1} 題</button><span id="st" class="mute small"></span></p>
        <div class="row" id="ans" hidden>${[1, 2, 3].map((k) => `<button data-n="${k}">第 ${k} 個</button>`).join('')}</div></div>`);
      const st = document.getElementById('st');
      document.getElementById('play').onclick = async (e) => {
        e.currentTarget.disabled = true;
        st.textContent = '播放中…';
        await ensureCtx();
        for (const k of trials[i]) { await playBuffer(tone(k)); await sleep(500); }
        st.textContent = '請選出最小聲的那一個';
        played = true;
        document.getElementById('ans').hidden = false;
      };
      let played = false, answered = false;
      document.querySelectorAll('#ans button').forEach((b) => {
        b.onclick = () => {
          if (!played || answered) return;
          answered = true;
          answers.push(+b.dataset.n);
          document.querySelectorAll('#ans button').forEach((x) => { x.disabled = x !== b; });
          b.classList.add('chosen');
          st.innerHTML = i + 1 < n ? `<span class="okc">已記錄 ✓</span>　接著是第 ${i + 2} 題…` : '<span class="okc">已記錄 ✓</span>';
          setTimeout(() => { i++; step(); }, 1000);
        };
      });
    };
    const finish = () => {
      const correct = trials.reduce((s, t, j) => s + (t[answers[j] - 1] === 'quiet' ? 1 : 0), 0);
      const pass = correct >= 5;
      S.hpAttempts = attempt; save();
      emit('hp_check', { attempt, correct, pass, answers, trials });
      if (!pass && attempt < 2) {
        view(`<div class="card"><h1>耳機檢查</h1><p>這次答對 ${correct}／6 題。請確認<b>兩耳都戴好耳機</b>（不要用電腦或手機喇叭），然後再試一次。</p>
          <button class="primary" id="go">再試一次</button></div>`);
        document.getElementById('go').onclick = () => screenHP();
        return;
      }
      go('instructions');
    };
    step();
  }

  function screenInstructions() {
    view(`<div class="card"><h1>說明</h1>
      <p>接下來你會聽到一段一段的電影聲音，每段約 10 秒，畫面是黑的。每段中間會有一位旁白，用中文描述畫面上發生的事。<b>旁白有時說得比較慢，有時比較快。</b></p>
      <p>每段<b>只會播放一次</b>。聽完後請回答四個問題：</p>
      <ol><li><b>內容題</b>：旁白說了什麼。不確定就選「不知道」，不要猜。</li>
        <li><b>接受度</b>：如果整部電影的旁白都是這個速度，你可以接受嗎？</li>
        <li><b>費力程度</b>：要聽懂剛才的旁白，你覺得有多費力？</li>
        <li><b>速度感</b>：這段旁白的速度對你來說，是太慢、剛好，還是太快？</li></ol>
      <p>我們想知道的是你聽旁白的感受，不是電影好不好看，也不是你喜不喜歡這個聲音。中間會有一次休息。</p>
      <p>先來一題練習。</p><button class="primary" id="go">開始練習</button></div>`);
    document.getElementById('go').onclick = () => { emit('instructions', { read: true }); go('trials'); };
  }

  // ------------------------------------------------------------------ trials
  const EFFORT = [[1, '非常費力', '幾乎聽不懂'], [2, '很費力', ''], [3, '中等費力', ''], [4, '有點費力', ''], [5, '完全不費力', '輕鬆聽懂']];
  // Just-about-right speed scale: -2 much too slow ... 0 just right ... +2 much too fast.
  const JAR = [[-2, '太慢'], [-1, '有點慢'], [0, '剛好'], [1, '有點快'], [2, '太快']];
  function trialLabel(t) {
    if (t.kind === 'practice') return '練習題';
    const scored = S.plan.trials.length - 1;
    return `第 ${t.trial_no}／${scored} 題`;
  }
  function screenTrial() {
    const T = S.plan.trials;
    if (S.t >= T.length) return go('adj_intro');
    const t = T[S.t];
    if (!S.breakDone && t.trial_no === S.plan.breakAfter + 1 && !S.cur) return screenBreak();
    const it = itemById(t.id);
    const cur = S.cur || { phase: 'ready' };
    if (cur.phase === 'ready') {
      view(`<div class="stage"><p class="counter">${trialLabel(t)}</p>
        <p>準備好後，按<b>空白鍵</b>或下面的按鈕播放。<br>這段只會播放一次。</p>
        <button class="primary" id="play">▶ 播放</button></div>`);
      const start = async () => {
        if (S.cur) return; // already started (Space + click at once)
        document.removeEventListener('keydown', onKey);
        const b = document.getElementById('play'); if (b) b.disabled = true;
        S.cur = { phase: 'playing', play_started: nowISO() }; save();
        view('<div class="stage dark"><p>播放中…</p></div>');
        try {
          await ensureCtx();
          S.cur.audio = await playFile(t.file);
        } catch (e) {
          S.cur.audio_error = String(e?.message || e);
          return commitTrial('audio_error');
        }
        S.cur.phase = 'content'; S.cur.shown = performance.now(); save();
        screenTrial();
      };
      const onKey = (e) => { if (e.code === 'Space') { e.preventDefault(); start(); } };
      document.addEventListener('keydown', onKey);
      document.getElementById('play').onclick = start;
      return;
    }
    if (cur.phase === 'content') {
      view(`<div class="card"><p class="counter">${trialLabel(t)}　1／4</p><h2>${esc(it.q)}</h2>
        <div class="choices">${t.opt_order.map((oi) => `<button data-o="${oi}">${esc(it.options[oi])}</button>`).join('')}
        <button data-o="-1" class="mute">不知道</button></div></div>`);
      S.cur.shown = performance.now();
      document.querySelectorAll('.choices button').forEach((b) => { b.onclick = () => answer('content', +b.dataset.o, 'accept'); });
      return;
    }
    if (cur.phase === 'accept') {
      view(`<div class="card"><p class="counter">${trialLabel(t)}　2／4</p>
        <h2>如果整部電影的旁白都是這個速度，你可以接受嗎？</h2>
        <div class="row" style="margin-top:12px"><button data-v="1">可以接受</button><button data-v="0">不能接受</button></div>
        <p class="mute small" style="margin-top:12px">若這段你沒聽到旁白，請依你聽到的情況作答。</p></div>`);
      S.cur.shown = performance.now();
      document.querySelectorAll('button[data-v]').forEach((b) => { b.onclick = () => answer('accept', +b.dataset.v, 'effort'); });
      return;
    }
    if (cur.phase === 'effort') {
      view(`<div class="card"><p class="counter">${trialLabel(t)}　3／4</p>
        <h2>要聽懂剛才的旁白，你覺得有多費力？</h2>
        <div class="scale">${EFFORT.map(([v, a, b]) => `<button data-v="${v}"><b>${v}</b><span>${a}${b ? `<br>${b}` : ''}</span></button>`).join('')}</div>
        <button data-v="0" class="link">沒有聽到旁白</button></div>`);
      S.cur.shown = performance.now();
      document.querySelectorAll('button[data-v]').forEach((b) => { b.onclick = () => answer('effort', +b.dataset.v, 'jar'); });
      return;
    }
    if (cur.phase === 'jar') {
      view(`<div class="card"><p class="counter">${trialLabel(t)}　4／4</p>
        <h2>這段旁白的速度對你來說：</h2>
        <div class="scale">${JAR.map(([v, a]) => `<button data-v="${v}"><b>${a}</b></button>`).join('')}</div></div>`);
      S.cur.shown = performance.now();
      document.querySelectorAll('button[data-v]').forEach((b) => { b.onclick = () => answer('jar', +b.dataset.v, null); });
    }
  }
  function answer(field, value, next) {
    if (!S.cur || S.cur.phase !== field) return; // ignore double clicks
    S.cur[field] = value;
    S.cur[`${field}_rt_ms`] = Math.round(performance.now() - (S.cur.shown || performance.now()));
    if (next) { S.cur.phase = next; save(); return screenTrial(); }
    commitTrial('ok');
  }
  function commitTrial(status) {
    const t = S.plan.trials[S.t];
    const it = itemById(t.id);
    const c = S.cur || {};
    const choice = c.content === undefined ? null : c.content;
    emit('trial', { ...t, status, item: t.id,
      content_choice: choice, content_choice_text: choice >= 0 ? it.options[choice] : (choice === -1 ? '不知道' : null),
      content_correct: choice === null ? null : (choice === it.answer ? 1 : 0), content_rt_ms: c.content_rt_ms ?? null,
      accept: c.accept ?? null, accept_rt_ms: c.accept_rt_ms ?? null,
      effort: c.effort === undefined ? null : (c.effort === 0 ? 'no_narration' : c.effort), effort_rt_ms: c.effort_rt_ms ?? null,
      jar: c.jar ?? null, jar_rt_ms: c.jar_rt_ms ?? null,
      play_started: c.play_started || null, audio: c.audio || null, audio_error: c.audio_error || null,
      hidden_during_audio: c.audio?.hidden ?? null });
    S.t++; S.cur = null; save();
    if (S.step === 'trials') screenTrial();
  }
  function screenBreak() {
    view(`<div class="card"><h1>休息一下</h1><p>已經完成一半了。可以休息一下，準備好再繼續。<b>請不要調整音量。</b></p>
      <button class="primary" id="go">繼續</button></div>`);
    document.getElementById('go').onclick = () => { S.breakDone = true; save(); screenTrial(); };
  }

  // ------------------------------------------------------------------ adjustment block
  function screenAdjIntro() {
    view(`<div class="card"><h1>最後一部分：自己調整語速</h1>
      <p>接下來有 3 段。每一段你都可以用滑桿改變旁白的速度，按「播放」聽聽看，<b>可以重複播放、來回調整</b>。</p>
      <p>請調到<b>你能接受的最快速度</b>：如果整部電影的旁白都是這個速度，你還願意聽下去；再快一點，就會覺得不舒服或聽不下去。</p>
      <button class="primary" id="go">開始</button></div>`);
    document.getElementById('go').onclick = () => go('adjust');
  }
  function screenAdjust() {
    if (S.a >= S.plan.adjust.length) return go('final');
    const a = S.plan.adjust[S.a];
    const it = D.adjust.find((x) => x.id === a.id);
    S.curAdj ||= { k: a.start_k, path: [], plays: 0, started: performance.now(), playedK: null };
    save();
    const c = S.curAdj, nMax = D.rates.length - 1;
    view(`<div class="card"><p class="counter">調整 ${S.a + 1}／${S.plan.adjust.length}</p>
      <h2>調到你能接受的最快速度</h2>
      <div class="row small mute" style="justify-content:space-between"><span>慢</span><span>快</span></div>
      <input type="range" class="slider" id="sl" min="0" max="${nMax}" step="1" value="${c.k}" aria-label="旁白速度">
      <div class="row"><button id="play">▶ 播放</button><button class="primary" id="ok" disabled>就是這個速度</button></div>
      <p class="mute small" id="hint">移動滑桿後請先播放聽聽看，才能確定。</p></div>`);
    const sl = document.getElementById('sl'), ok = document.getElementById('ok');
    const sync = () => { ok.disabled = c.playedK !== c.k; };
    sl.oninput = () => { c.k = +sl.value; stopAudio(); sync(); save(); };
    document.getElementById('play').onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      const k = c.k, file = it.stimuli.find((s) => s.k === k).file;
      c.plays++; c.path.push(k); save();
      const p = playFile(file).catch(() => null);
      c.playedK = k; sync();
      b.disabled = false;
      await p;
    };
    ok.onclick = () => {
      stopAudio();
      const s = it.stimuli.find((x) => x.k === c.k);
      emit('adjust', { adj_no: S.a + 1, item: a.id, start_k: a.start_k, final_k: c.k, final_rate: s.rate, final_syl_per_s: s.syl_per_s,
        n_plays: c.plays, path: c.path, total_ms: Math.round(performance.now() - c.started) });
      S.a++; S.curAdj = null; save();
      screenAdjust();
    };
    sync();
  }

  // ------------------------------------------------------------------ end
  function screenFinal() {
    view(`<div class="card"><h1>最後兩個問題</h1>
      <div class="field"><span><b>過程中有沒有遇到技術問題？</b>（例如聲音斷掉、頁面卡住）</span>
        <div class="opts"><label><input type="radio" name="tech" value="no"> 沒有</label><label><input type="radio" name="tech" value="yes"> 有</label></div></div>
      <label class="field"><span>想補充的話（選填）：例如哪種速度最舒服、旁白哪裡不清楚</span><textarea id="cm" rows="4"></textarea></label>
      <button class="primary" id="go">送出</button></div>`);
    document.getElementById('go').onclick = () => {
      emit('final', { tech: document.querySelector('input[name=tech]:checked')?.value || null, comment: document.getElementById('cm').value.trim() });
      emit('finish', { n_records: S.records.length + 1, resumes: S.resumes || 0, preload_ms: S.preload_ms || null });
      go('done');
    };
  }
  // The thank-you screen and completion code appear only after the server has confirmed every record,
  // so a participant who closes the page as soon as they see "完成" cannot lose data.
  async function screenDone() {
    if (S.uploadConfirmed) return showThanks();
    view(`<div class="card"><h1>正在上傳資料…</h1>
      <p><b>請不要關閉這個頁面。</b>資料上傳完成後，這裡會顯示完成畫面。</p>
      <div class="progress"><div id="bar" style="width:100%" class="pulse"></div></div>
      <p id="st" class="mute small">正在確認資料…</p>
      <p id="bkrow" hidden><button id="bk">下載備份檔</button></p></div>`);
    document.getElementById('bk').onclick = downloadBackup;
    for (let i = 0; ; i++) {
      if (await reconcile()) { S.uploadConfirmed = true; save(); return showThanks(); }
      if (S.step !== 'done') return;
      const st = document.getElementById('st');
      if (!st) return;
      st.textContent = `還有 ${S.outbox.length || '部分'} 筆資料尚未上傳，正在重試…`;
      if (i >= 3) {
        st.innerHTML = `<span class="err">還有 ${S.outbox.length || '部分'} 筆資料尚未上傳。</span>請不要關閉頁面，網路恢復後會自動上傳。若一直無法完成，請按「下載備份檔」，把檔案交給實驗人員。`;
        document.getElementById('bkrow').hidden = false;
      }
      await sleep(Math.min(3000 * (i + 1), 15000));
    }
  }
  function showThanks() {
    const codeStr = `${S.pid}-${(hashStr(S.pid + D.version) % 9000 + 1000)}`;
    view(`<div class="card fadein"><h1>完成了，謝謝你！</h1><p>完成代碼：<b>${esc(codeStr)}</b></p>
      <p><span class="okc">資料已全部上傳 ✓</span> 現在可以關閉這個頁面了。</p></div>`);
  }

  boot();
})();
