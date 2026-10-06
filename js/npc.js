/* NPC: the NPC economy.
   Every number here is read live from Solana. The server builds transactions; your wallet signs them. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  const S = { cfg: null, st: null, me: null, look: null, ff: 'all', busy: '', seen: new Set() };

  /* ---------------- utils ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
  const nowS = () => Date.now() / 1000;
  function fsol(n) { n = Number(n) || 0; const a = Math.abs(n); return a >= 100 ? n.toFixed(1) : a >= 1 ? n.toFixed(3) : a > 0 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : '0'; }
  function dur(s) { s = Math.max(0, Math.floor(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`; }
  const hms = s => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(v => String(v).padStart(2, '0')).join(':'); };
  const span = s => s < 48 * 3600 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + ' days';
  const ago = t => t ? dur(nowS() - t) + ' ago' : '—';
  const tx = s => `https://solscan.io/tx/${s}`;
  const acc = a => `https://solscan.io/account/${a}`;
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  function toast(msg, ms = 2800) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
  async function api(path, body) {
    const opt = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await fetch('/api/' + path, opt);
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('request failed (' + r.status + ')'));
    return j;
  }
  const taskOf = id => (S.cfg && S.cfg.tasks.find(t => t.id === id)) || { id, name: id, reward: 0 };

  /* ---------------- grain + nav ---------------- */
  (() => {
    const c = document.createElement('canvas'); c.width = c.height = 160; const x = c.getContext('2d'); const d = x.createImageData(160, 160);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255 | 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0); $('.grain').style.backgroundImage = `url(${c.toDataURL()})`;
  })();
  const nav = $('#nav');
  const onScroll = () => {
    nav.classList.toggle('solid', scrollY > 30);
    let cur = '';
    for (const a of $$('#links a')) { const s = $(a.getAttribute('href')); if (s && s.getBoundingClientRect().top < innerHeight * .4) cur = a.getAttribute('href'); }
    $$('#links a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === cur));
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
  $$('.head, .tasks, .sheet, .split, .steps, .flow, .qa').forEach(el => { el.classList.add('reveal'); io.observe(el); });

  /* ---------------- the eye sprite (shared by every canvas) ---------------- */
  function eyeSprite(color, glow) {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, glow); g.addColorStop(.32, glow.replace(/[\d.]+\)$/, '.35)')); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    x.fillStyle = color; x.beginPath(); x.arc(32, 32, 9, 0, 7); x.fill();
    return c;
  }
  const EYE = eyeSprite('#ecebf2', 'rgba(235,235,255,.8)');
  const RED = eyeSprite('#ff2a3d', 'rgba(255,40,60,.95)');
  const pointer = { x: null, y: null, t: 0 };
  addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.t = performance.now(); }, { passive: true });
  addEventListener('touchstart', e => { const t = e.touches[0]; if (t) { pointer.x = t.clientX; pointer.y = t.clientY; pointer.t = performance.now(); } }, { passive: true });

  // one NPC tile: a dark rounded body, then two glowing eyes looking at (lx, ly) in -1..1. rage 0..1 turns them red.
  function body(x, cx, top, size, alpha) {
    x.globalAlpha = alpha;
    const g = x.createLinearGradient(0, top, 0, top + size); g.addColorStop(0, '#18181e'); g.addColorStop(1, '#0c0c10');
    x.fillStyle = g; x.beginPath(); x.roundRect(cx - size / 2, top, size, size, size * .26); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = Math.max(.6, size / 110); x.stroke();
    x.globalAlpha = 1;
  }
  function eyes(x, cx, top, size, lx, ly, blink, rage, alpha) {
    const ey = top + size * .5, sp = size * .19, er = size * .064;
    for (const dx of [-sp, sp]) {
      const px = cx + dx + lx * size * .085, py = ey + ly * size * .07;
      if (blink > 0) { x.globalAlpha = alpha; x.fillStyle = rage > .5 ? '#ff2a3d' : '#ecebf2'; const h = Math.max(1, er * 2 * (1 - blink)); x.fillRect(px - er, py - h / 2, er * 2, h); continue; }
      const s = er * 7.1;
      if (rage < 1) { x.globalAlpha = alpha * (1 - rage); x.drawImage(EYE, px - s / 2, py - s / 2, s, s); }
      if (rage > 0) { x.globalAlpha = alpha * rage; x.drawImage(RED, px - s / 2, py - s / 2, s, s); }
    }
    x.globalAlpha = 1;
  }
  function tile(x, cx, top, size, lx, ly, blink, red, alpha) { body(x, cx, top, size, alpha); eyes(x, cx, top, size, lx, ly, blink, red ? 1 : 0, alpha); }

  /* ---------------- the hero crowd: everyone turns to look at you ---------------- */
  const crowd = (() => {
    const cv = $('#crowd'), x = cv.getContext('2d'), layer = document.createElement('canvas'), lx = layer.getContext('2d');
    let W = 0, H = 0, tiles = [], vis = true, raf = 0, rage = 0, rageTo = 0;
    function build() {
      const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
      cv.width = layer.width = Math.round(W * DPR); cv.height = layer.height = Math.round(H * DPR);
      let seed = 42; const R = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      tiles = [];
      const HOR = H * .2, scale = Math.max(.62, Math.min(1.25, W / 1400));
      const rows = []; for (let z = 9; z >= 1.05; z *= .86) rows.push(z);
      rows.forEach((z, ri) => {
        const s = 1 / z, y = HOR + (H + 140 - HOR) * s * .92, size = 150 * s * scale, gap = 200 * s * scale;
        const n = Math.ceil(W / gap) + 2, off = (ri % 2) * gap / 2, alpha = Math.max(0, Math.min(1, 1.12 - z * .12));
        for (let k = -1; k < n; k++) {
          const cx = off + k * gap + (R() - .5) * gap * .12;
          if (cx < -size || cx > W + size) continue;
          tiles.push({ cx, top: y - size, size, alpha, lx: 0, ly: 0, blinkAt: performance.now() + R() * 9000, red: false, lag: .035 + R() * .05, wake: R() });
        }
      });
      // one of them is not like the others
      const cand = tiles.filter(t => { const y = t.top + t.size / 2; return y > H * .6 && y < H * .76 && t.cx > W * .8 && t.cx < W * .94; });
      (cand[0] || tiles[Math.floor(tiles.length * .6)] || {}).red = true;
      // the bodies never move: draw them once
      lx.setTransform(DPR, 0, 0, DPR, 0, 0); lx.fillStyle = '#060608'; lx.fillRect(0, 0, W, H);
      for (const t of tiles) body(lx, t.cx, t.top, t.size, t.alpha);
    }
    function frame(now) {
      raf = 0; if (!vis) return;
      x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(layer, 0, 0);
      x.setTransform(DPR, 0, 0, DPR, 0, 0);
      const r = cv.getBoundingClientRect();
      const idle = pointer.x == null || now - pointer.t > 6000;
      const tx = idle ? W / 2 + Math.sin(now / 2600) * W * .18 : pointer.x - r.left;
      const ty = idle ? H * .62 : pointer.y - r.top;
      rage += (rageTo - rage) * (rageTo ? .045 : .08);
      for (const t of tiles) {
        const ex = t.cx, ey = t.top + t.size / 2;
        const gx = Math.max(-1, Math.min(1, (tx - ex) / 520)), gy = Math.max(-1, Math.min(1, (ty - ey) / 380));
        const k = reduce ? 1 : t.red ? .02 : t.lag;
        t.lx += (gx - t.lx) * k; t.ly += (gy - t.ly) * k;
        let b = 0;
        if (!t.red && !reduce && rage < .5) { const d = now - t.blinkAt; if (d > 0 && d < 160) b = 1 - Math.abs(d - 80) / 80; else if (d >= 160) t.blinkAt = now + 2500 + Math.random() * 9000; }
        // the red spreads from the front rows to the back
        const mine = t.red ? 1 : Math.max(0, Math.min(1, (rage * 1.6 - t.wake * .6)));
        eyes(x, t.cx, t.top, t.size, t.lx, t.ly, b, mine, t.alpha);
      }
      if (!reduce) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    new IntersectionObserver(es => { vis = es[0].isIntersecting; if (vis) kick(); }).observe(cv);
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { build(); kick(); }, 120); });
    build(); kick();
    return { kick, rage(on) { rageTo = on ? 1 : 0; kick(); } };
  })();
  // hover the way in and the whole town notices
  const sb = $('#spawnBtn');
  sb.addEventListener('pointerenter', () => crowd.rage(true)); sb.addEventListener('pointerleave', () => crowd.rage(false));
  sb.addEventListener('focus', () => crowd.rage(true)); sb.addEventListener('blur', () => crowd.rage(false));

  /* ---------------- small NPC faces (feed, leaderboard, your sheet) ---------------- */
  function face(cv, seed, opts = {}) {
    const n = cv.width, x = cv.getContext('2d'); x.clearRect(0, 0, n, n);
    const pad = n * .06, size = n - pad * 2;
    const r = seed || 1, lx = opts.lx != null ? opts.lx : ((r % 7) - 3) / 6, ly = opts.ly != null ? opts.ly : (((r >> 3) % 5) - 2) / 8;
    tile(x, n / 2, pad, size, lx, ly, opts.blink || 0, !!opts.red, 1);
  }
  const miniCache = new Map();
  function mini(tag) {
    if (miniCache.has(tag)) return miniCache.get(tag);
    const c = document.createElement('canvas'); c.width = c.height = 68; face(c, hash(tag));
    const u = c.toDataURL(); miniCache.set(tag, u); return u;
  }

  /* ---------------- a face that follows the pointer (hero logo, your NPC) ---------------- */
  function liveFace(cv, range) {
    let seed = 7, red = false, lx = 0, ly = 0, blinkAt = performance.now() + 2000 + Math.random() * 2000, raf = 0, vis = false;
    function frame(now) {
      raf = 0; if (!vis) return;
      const r = cv.getBoundingClientRect();
      const tx = pointer.x == null ? 0 : Math.max(-1, Math.min(1, (pointer.x - (r.left + r.width / 2)) / range));
      const ty = pointer.y == null ? .25 : Math.max(-1, Math.min(1, (pointer.y - (r.top + r.height / 2)) / (range * .75)));
      lx += (tx - lx) * .12; ly += (ty - ly) * .12;
      let b = 0; const d = now - blinkAt; if (d > 0 && d < 170) b = 1 - Math.abs(d - 85) / 85; else if (d >= 170) blinkAt = now + 2200 + Math.random() * 5000;
      face(cv, seed, { lx, ly, blink: reduce ? 0 : b, red });
      if (!reduce) raf = requestAnimationFrame(frame);
    }
    new IntersectionObserver(es => { vis = es[0].isIntersecting; if (vis && !raf) raf = requestAnimationFrame(frame); }).observe(cv);
    face(cv, seed, { lx: 0, ly: .25 });
    return { set(s, isRed) { seed = s; red = !!isRed; face(cv, seed, { lx, ly, red }); if (!raf && vis) raf = requestAnimationFrame(frame); } };
  }
  liveFace($('#logo'), 520);
  const meFace = liveFace($('#me'), 400);

  // the NPC speaks its one line, one character at a time
  let typing = 0;
  function say(text) {
    const el = $('#meLine'); if (el.dataset.t === text) return; el.dataset.t = text;
    clearInterval(typing); if (reduce) { el.textContent = text; return; }
    let i = 0; el.textContent = '';
    typing = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typing); }, 34);
  }

  /* ---------------- task board ---------------- */
  const ICONS = {
    trade: '<path d="M4 17l5-5 4 4 7-8"/><path d="M15 8h5v5"/>',
    host: '<path d="M12 3c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0C6 10.4 8.5 7.2 12 3z"/><path d="M9.5 14.5a2.6 2.6 0 0 0 2.5 2.4"/>',
    newborn: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/>',
    hold: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  };
  const GO = {
    trade: '<a class="go" href="https://pump.fun" target="_blank" rel="noopener">pump.fun ↗</a>',
    host: '<a class="go" href="https://swap.pump.fun" target="_blank" rel="noopener">PumpSwap pools ↗</a>',
    newborn: '<a class="go" href="https://pump.fun" target="_blank" rel="noopener">pump.fun, newly graduated ↗</a>',
    hold: '<span>your wallet</span>',
  };
  function count(id) {
    const b = S.st && S.st.stats && S.st.stats.byTask && S.st.stats.byTask[id];
    return b ? `<span class="count"><b>${b.done}</b> done · <b>${b.open}</b> open</span>` : '';
  }
  // where this NPC is in the quest: 0 nothing yet, 2 accepted, 3 verified and owed, 4 paid
  function stage(ts) {
    if (!ts || !ts.last) return 0;
    const v = ts.last.v || {};
    if (ts.state === 'open') return 2;
    if (v.state === 'complete') return ts.last.paid ? 4 : 3;
    return 0;
  }
  function track(n) {
    return `<ol class="track">${['Accept', 'Do it', 'Verified', 'Paid'].map((l, i) => { const k = i + 1; const c = n === 4 || k < n ? 'done' : k === n ? 'cur' : ''; return `<li class="${c}"><i></i><span>${l}</span></li>`; }).join('')}</ol>`;
  }
  function taskState(t) {
    if (!t.live) return { cls: 'off', st: '<span class="st"><i></i>Opens when $NPC is live</span>', btn: '' };
    if (!W.acct) return { st: '<span class="st"><i></i>Open to every NPC</span>', btn: `<button class="btn pri" data-do="connect" type="button">Connect to accept</button>`, mark: true };
    const me = S.me;
    if (!me) return { st: '<span class="st"><i></i>Loading your NPC…</span>', btn: '' };
    if (!me.spawned) return { st: '<span class="st"><i></i>Spawn your NPC to take tasks</span>', btn: `<button class="btn pri" data-do="spawn" type="button">Become an NPC</button>`, mark: true };
    const ts = me.tasks[t.id] || { state: 'available' };
    const busy = S.busy === t.id, last = ts.last, n = stage(ts);
    const lastLine = n === 4 ? `<span class="st paid"><i></i>Last one paid</span>` : n === 3 ? `<span class="st done"><i></i>${fsol(last.reward)} SOL owed to you</span>` : '';
    if (ts.state === 'open') {
      const v = last.v || {};
      const until = v.ready ? `checkable in <b data-cd="${v.ready}">${hms(v.ready - nowS())}</b>` : v.until ? `<b data-cd="${v.until}">${hms(v.until - nowS())}</b> left` : '';
      return { n, st: `<span class="st open"><i></i>${until}${v.note ? ' · ' + esc(v.note) : ''}</span>`, btn: `<button class="btn alt" data-do="check" data-t="${t.id}" type="button" ${busy ? 'disabled' : ''}>${busy ? '<span class="spin"></span>Checking' : 'Check now'}</button>` };
    }
    if (ts.state === 'cooldown') return { n, st: lastLine, btn: `<button class="btn alt" type="button" disabled>Back in <span data-cd="${ts.next}">${hms(ts.next - nowS())}</span></button>` };
    return { n, st: lastLine || '<span class="st"><i></i>Available</span>', btn: `<button class="btn pri" data-do="accept" data-t="${t.id}" type="button" ${busy ? 'disabled' : ''}>${busy ? '<span class="spin"></span>Sign in wallet' : 'Accept task'}</button>`, mark: true };
  }
  function renderTasks() {
    if (!S.cfg) return;
    $('#tasks').innerHTML = S.cfg.tasks.map((t, i) => {
      const s = taskState(t);
      return `<article class="task ${s.cls || ''}" data-id="${t.id}">
        <div class="top"><div class="ico">${s.mark ? '<span class="mark">!</span>' : ''}<svg viewBox="0 0 24 24">${ICONS[t.id] || ''}</svg></div>
          <div><h3>${esc(t.name)}</h3><p class="line">${esc(t.line)}</p></div>
          <div class="pay"><b>${fsol(t.reward)}</b><small>SOL reward</small></div></div>
        ${track(s.n || 0)}
        <dl><dt>proof</dt><dd>${esc(t.proof)}</dd><dt>window</dt><dd>${span(t.window)} after you accept</dd><dt>cooldown</dt><dd>${span(t.cooldown)} after it's done</dd><dt>where</dt><dd>${GO[t.id] || '—'}</dd></dl>
        <div class="act">${s.btn}${s.st}${count(t.id)}</div>
      </article>`;
    }).join('');
  }
  $('#tasks').addEventListener('pointermove', e => { const c = e.target.closest('.task'); if (!c) return; const r = c.getBoundingClientRect(); c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px'); });
  document.addEventListener('click', e => {
    const lk = e.target.closest('[data-look]'); if (lk) { e.preventDefault(); look(lk.dataset.look); return; }
    const b = e.target.closest('[data-do]'); if (!b) return;
    const d = b.dataset.do;
    if (d === 'connect') connect();
    if (d === 'spawn') spawn();
    if (d === 'accept') accept(b.dataset.t);
    if (d === 'check') check(b.dataset.t);
    if (d === 'card') idCard();
    if (d === 'mine') { S.look = null; renderMe(); }
  });

  /* ---------------- your NPC sheet ---------------- */
  // a title from tasks finished on-chain. it never changes rewards.
  const RANKS = [[0, 'Background NPC'], [1, 'Villager'], [3, 'Shopkeeper'], [7, 'Guard'], [15, 'Quest giver'], [30, 'Main character']];
  function rankOf(done) {
    let i = 0; for (let k = 0; k < RANKS.length; k++) if (done >= RANKS[k][0]) i = k;
    const next = RANKS[i + 1] || null;
    return { name: RANKS[i][1], i, next: next && next[1], need: next ? next[0] : null, from: RANKS[i][0], pct: next ? (done - RANKS[i][0]) / (next[0] - RANKS[i][0]) : 1 };
  }
  function heroBtn() { $('#spawnBtn').textContent = S.me && S.me.spawned ? 'Open your NPC' : 'Become an NPC'; }
  function renderMe() {
    const L = $('#meLedger'), view = S.look, me = view || S.me;
    heroBtn();
    $$('.who .btn, .who .card-btn').forEach(b => b.remove());
    const vb = $('#viewing');
    vb.hidden = !view;
    if (view) vb.innerHTML = `<span>Viewing <b>${esc(view.npc.tag)}</b> · ${short(view.wallet)}</span><button type="button" data-do="mine">${W.acct ? 'Back to yours' : 'Close'}</button>`;
    if (!me) {
      if (!W.acct) {
        $('#meTag').textContent = 'npc_????'; $('#meNo').textContent = 'not spawned'; meFace.set(7); say('connect a wallet, traveler.');
        L.innerHTML = `<div class="gate"><h3>Who are you in town?</h3><p>Connect a wallet to see the NPC it becomes. Nothing is signed until you spawn.</p><button class="btn pri" data-do="connect" type="button">Connect wallet</button></div>`;
      } else L.innerHTML = `<div class="gate"><p class="mono">reading the board…</p></div>`;
      return;
    }
    $('#meTag').textContent = me.npc.tag;
    $('#meNo').textContent = me.spawned ? `npc #${me.npc.no} · ${short(me.wallet)}` : `not spawned · ${short(me.wallet)}`;
    meFace.set(me.npc.seed, false); say(me.npc.line);
    if (!me.spawned) {
      L.innerHTML = view
        ? `<div class="gate"><h3>Not an NPC yet.</h3><p>This wallet hasn't spawned. If it does, it becomes ${esc(me.npc.tag)}.</p></div>`
        : `<div class="gate"><h3>This is who you'd be.</h3><p>Sign one memo to the board and ${esc(me.npc.tag)} joins the town. It sends 0 SOL; you pay only the network fee.</p><button class="btn pri" data-do="spawn" type="button" ${S.busy === 'spawn' ? 'disabled' : ''}>${S.busy === 'spawn' ? '<span class="spin"></span>Spawning' : 'Spawn ' + esc(me.npc.tag)}</button></div>`;
      return;
    }
    $('.who').insertAdjacentHTML('beforeend', '<button class="card-btn" data-do="card" type="button">save ID card ↓</button>');
    const bal = me.npcBalance == null ? '—' : Math.floor(me.npcBalance).toLocaleString('en-US');
    const rk = rankOf(me.done);
    const rows = me.history.map(h => {
      const t = taskOf(h.task);
      const st = h.paid ? `<span class="st paid"><i></i><a href="${tx(h.paid)}" target="_blank" rel="noopener">paid</a></span>` : h.state === 'complete' ? `<span class="st done"><i></i>owed</span>` : h.state === 'expired' ? `<span class="st red"><i></i>expired</span>` : `<span class="st open"><i></i>open</span>`;
      return `<tr><td>${esc(t.name)}</td><td class="mono">${fsol(h.reward)} SOL</td><td>${st}</td><td><a href="${tx(h.sig)}" target="_blank" rel="noopener">${ago(h.at)}</a></td><td>${h.proof ? `<a href="${tx(h.proof)}" target="_blank" rel="noopener">proof</a>` : '<span class="mono">—</span>'}</td></tr>`;
    }).join('');
    L.innerHTML = `<div class="rank"><div><small>rank</small><b>${rk.name}</b></div><div class="bar"><i style="width:${Math.round(rk.pct * 100)}%"></i></div><span>${rk.next ? `${me.done} / ${rk.need} to ${rk.next}` : 'top rank'}</span></div>
      <div class="figs">
        <div><small>earned</small><b>${fsol(me.earned)}<em>SOL</em></b></div>
        <div><small>paid</small><b>${fsol(me.paid)}<em>SOL</em></b></div>
        <div class="owed"><small>owed</small><b>${fsol(me.owed)}<em>SOL</em></b></div>
        <div><small>tasks done</small><b>${me.done}</b></div>
      </div>
      <div class="hist"><h4>quest log · $NPC held: ${bal}</h4>${rows ? `<div class="tw"><table><thead><tr><th>task</th><th>reward</th><th>state</th><th>accepted</th><th>proof</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">${view ? 'No tasks yet.' : 'No tasks yet. Pick one from the board above.'}</p>`}</div>`;
  }
  // read-only view of any wallet's NPC
  async function look(w) {
    w = String(w || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) { toast("That address doesn't look right."); return; }
    $('#you').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    if (W.acct && W.acct.address === w) { S.look = null; renderMe(); return; }
    try { S.look = await api('npc?wallet=' + w); renderMe(); }
    catch (e) { toast(e.message); }
  }
  $('#look').addEventListener('submit', e => { e.preventDefault(); look($('#lookIn').value); });

  // a 1200x630 card of an NPC, drawn in the browser from the same numbers you see
  async function idCard() {
    const me = S.look || S.me; if (!me || !me.spawned) return;
    try { await Promise.all([document.fonts.load('700 60px M'), document.fonts.load('400 20px M'), document.fonts.load('500 20px I')]); } catch (e) { }
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 630; const x = cv.getContext('2d');
    x.fillStyle = '#060608'; x.fillRect(0, 0, 1200, 630);
    for (let r = 0; r < 3; r++) for (let i = 0; i < 14; i++) { const sz = 60 + r * 22, cx = 40 + i * 92 + (r % 2) * 46, top = 360 + r * 70; tile(x, cx, top, sz, 0, -.4, 0, false, .25 + r * .12); }
    const g = x.createLinearGradient(0, 0, 0, 630); g.addColorStop(0, 'rgba(6,6,8,1)'); g.addColorStop(.45, 'rgba(6,6,8,.9)'); g.addColorStop(1, 'rgba(6,6,8,.55)'); x.fillStyle = g; x.fillRect(0, 0, 1200, 630);
    tile(x, 250, 120, 300, .15, .1, 0, false, 1);
    x.fillStyle = '#5f5d6b'; x.font = '400 20px M'; x.fillText(`NPC #${me.npc.no} · ${rankOf(me.done).name}`, 480, 160);
    x.fillStyle = '#ecebf2'; x.font = '700 72px M'; x.fillText(me.npc.tag, 476, 236);
    x.strokeStyle = '#292934'; x.lineWidth = 2; x.beginPath(); x.roundRect(480, 268, 640, 76, 14); x.stroke();
    x.fillStyle = '#ecebf2'; x.font = '400 24px M'; x.fillText('“' + me.npc.line + '”', 506, 315);
    [['earned', fsol(me.earned) + ' SOL'], ['paid', fsol(me.paid) + ' SOL'], ['tasks done', String(me.done)]].forEach(([k, v], i) => { const fx = 480 + i * 215; x.fillStyle = '#5f5d6b'; x.font = '400 18px M'; x.fillText(k, fx, 396); x.fillStyle = k === 'earned' ? '#ffc21a' : '#ecebf2'; x.font = '700 34px M'; x.fillText(v, fx, 438); });
    x.fillStyle = '#9a98a6'; x.font = '500 20px I'; x.fillText('The NPC economy.', 80, 560);
    x.textAlign = 'right'; x.fillStyle = '#5f5d6b'; x.font = '400 20px M'; x.fillText(location.host, 1120, 560);
    const d = x.getImageData(0, 0, 1200, 630); for (let i = 0; i < d.data.length; i += 4) { const n = (Math.random() - .5) * 12; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } x.putImageData(d, 0, 0);
    const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = me.npc.tag + '.png'; document.body.appendChild(a); a.click(); a.remove();
    toast('ID card saved');
  }

  /* ---------------- town: population, feed, leaderboard ---------------- */
  // every NPC is a tile in town. the next empty slot waits with its eyes shut.
  const pop = (() => {
    const cv = $('#pop'), x = cv.getContext('2d'), layer = document.createElement('canvas'), lx = layer.getContext('2d'), tip = $('#ptip');
    let W = 0, H = 0, cells = [], size = 30, vis = false, raf = 0, list = [], built = '';
    function build() {
      const w = cv.parentElement.clientWidth; if (!w) return;
      size = w < 640 ? 24 : 30; const gap = Math.round(size * .32), pad = 22;
      const cols = Math.max(6, Math.floor((w - pad * 2 + gap) / (size + gap)));
      const slots = Math.max(cols * 3, Math.ceil((list.length + 1) / cols) * cols);
      const rows = slots / cols;
      W = w; H = pad * 2 + rows * (size + gap) - gap;
      cv.style.height = H + 'px'; cv.width = layer.width = Math.round(W * DPR); cv.height = layer.height = Math.round(H * DPR);
      const ox = (W - (cols * (size + gap) - gap)) / 2;
      cells = [];
      for (let i = 0; i < slots; i++) { const c = i % cols, r = Math.floor(i / cols); cells.push({ cx: ox + c * (size + gap) + size / 2, top: pad + r * (size + gap), p: list[i] || null, lx: 0, ly: 0, blinkAt: performance.now() + Math.random() * 8000, i }); }
      lx.setTransform(DPR, 0, 0, DPR, 0, 0); lx.clearRect(0, 0, W, H);
      for (const c of cells) {
        if (c.p) { body(lx, c.cx, c.top, size, 1); continue; }
        lx.globalAlpha = c.i === list.length ? 1 : .55;
        lx.strokeStyle = c.i === list.length ? 'rgba(255,194,26,.6)' : 'rgba(255,255,255,.08)'; lx.lineWidth = 1; lx.setLineDash(c.i === list.length ? [3, 3] : []);
        lx.beginPath(); lx.roundRect(c.cx - size / 2 + .5, c.top + .5, size - 1, size - 1, size * .26); lx.stroke(); lx.setLineDash([]);
        lx.fillStyle = 'rgba(255,255,255,.12)'; const ey = c.top + size / 2, sp = size * .19; lx.fillRect(c.cx - sp - size * .06, ey, size * .12, 1); lx.fillRect(c.cx + sp - size * .06, ey, size * .12, 1);
        lx.globalAlpha = 1;
      }
    }
    function frame(now) {
      raf = 0; if (!vis) return;
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height); x.drawImage(layer, 0, 0);
      x.setTransform(DPR, 0, 0, DPR, 0, 0);
      const r = cv.getBoundingClientRect(), mine = W_addr();
      const tx = pointer.x == null ? W / 2 : pointer.x - r.left, ty = pointer.y == null ? -200 : pointer.y - r.top;
      for (const c of cells) {
        if (!c.p) continue;
        const gx = Math.max(-1, Math.min(1, (tx - c.cx) / 300)), gy = Math.max(-1, Math.min(1, (ty - c.top - size / 2) / 240));
        c.lx += (gx - c.lx) * .08; c.ly += (gy - c.ly) * .08;
        let b = 0; if (!reduce) { const d = now - c.blinkAt; if (d > 0 && d < 160) b = 1 - Math.abs(d - 80) / 80; else if (d >= 160) c.blinkAt = now + 3000 + Math.random() * 9000; }
        eyes(x, c.cx, c.top, size, c.lx, c.ly, b, c.p.wallet === mine ? 1 : 0, 1);
      }
      if (!reduce) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && vis) raf = requestAnimationFrame(frame); };
    new IntersectionObserver(es => { vis = es[0].isIntersecting; kick(); }).observe(cv);
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { build(); kick(); }, 150); });
    const at = e => { const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; return cells.find(c => Math.abs(px - c.cx) <= size / 2 && py >= c.top && py <= c.top + size); };
    cv.addEventListener('pointermove', e => {
      const c = at(e);
      if (!c) { tip.hidden = true; cv.style.cursor = ''; return; }
      tip.hidden = false; cv.style.cursor = c.p ? 'pointer' : '';
      tip.innerHTML = c.p ? `<b>${esc(c.p.tag)}</b> #${c.p.no} · ${c.p.done} done · ${rankOf(c.p.done).name}` : c.i === list.length ? `<b>slot #${c.i + 1}</b> is open` : `empty`;
      tip.style.left = Math.min(c.cx, W - 120) + 'px'; tip.style.top = (c.top - 8) + 'px';
    });
    cv.addEventListener('pointerleave', () => { tip.hidden = true; });
    cv.addEventListener('click', e => { const c = at(e); if (c && c.p) look(c.p.wallet); else if (c && c.i === list.length) spawn(); });
    return { set(l) { const key = l.map(p => p.no + ':' + p.done).join(','); list = l; if (key !== built || !cells.length) { built = key; build(); } kick(); }, build };
  })();
  const W_addr = () => W.acct ? W.acct.address : '';

  function renderTicker() {
    const st = S.st, items = [];
    if (st && st.feed.length) st.feed.slice(0, 14).forEach(f => {
      const t = taskOf(f.task).name;
      items.push(f.kind === 'spawn' ? `<b>${esc(f.tag)}</b> joined the town` : f.kind === 'accept' ? `<b>${esc(f.tag)}</b> took ${esc(t)}` : f.kind === 'complete' ? `<b>${esc(f.tag)}</b> finished ${esc(t)}` : `<b>${esc(f.tag)}</b> was paid <span class="g">${fsol(f.sol)} SOL</span>`);
    });
    if (S.cfg) S.cfg.tasks.filter(t => t.live).forEach(t => items.push(`<span class="y">!</span> ${esc(t.name)} pays <b>${fsol(t.reward)} SOL</b>`));
    if (st && !st.feed.length) items.push(`<b>${st.stats.npcs}</b> NPCs in town`, `slot <b>#${st.stats.npcs + 1}</b> is open`);
    if (!items.length) return;
    const row = items.map(h => `<span class="ti">${h}</span>`).join('');
    const el = $('#tk'); if (el.dataset.k === row) return; el.dataset.k = row;
    el.innerHTML = row + row; el.style.animationDuration = Math.max(24, items.length * 5) + 's';
  }

  function renderTown() {
    const st = S.st; if (!st) return;
    const s = st.stats;
    $('#lTre').textContent = s.treasurySol == null ? '—' : fsol(s.treasurySol);
    $('#lNpc').textContent = s.npcs; $('#lDone').textContent = s.completed; $('#lPaid').textContent = fsol(s.paidSol);
    $('#popN').textContent = `${s.npcs} NPC${s.npcs === 1 ? '' : 's'} · next slot #${s.npcs + 1}`;
    pop.set(st.town || []);
    renderTicker(); renderFlow();
    const words = f => {
      const t = taskOf(f.task).name, who = `<b data-look="${esc(f.wallet)}">${esc(f.tag)}</b>`;
      if (f.kind === 'spawn') return `${who} spawned as NPC #${f.no}`;
      if (f.kind === 'accept') return `${who} took <em>${esc(t)}</em> for ${fsol(f.reward)} SOL`;
      if (f.kind === 'complete') return `${who} finished <em>${esc(t)}</em>`;
      if (f.kind === 'paid') return `${who} was paid <span class="g">${fsol(f.sol)} SOL</span>`;
      return '';
    };
    const ICON = { spawn: '+', accept: '!', complete: '✓', paid: '◎' };
    const first = !S.seen.size;
    const list = st.feed.filter(f => S.ff === 'all' || f.kind === S.ff);
    $('#feed').innerHTML = list.length ? list.map(f => {
      const k = f.kind + f.sig; const fresh = !first && !S.seen.has(k); S.seen.add(k);
      return `<li class="${fresh ? 'new' : ''} k-${f.kind}"><img class="mini" src="${mini(f.tag)}" alt=""><span class="what"><i class="kd">${ICON[f.kind] || ''}</i>${words(f)}</span><time><a href="${tx(f.sig)}" target="_blank" rel="noopener">${ago(f.at)}</a></time></li>`;
    }).join('') : `<li class="empty">${st.feed.length ? 'Nothing here yet.' : 'The town is quiet. Be the first NPC.'}</li>`;
    $('#lb').innerHTML = st.leaderboard.length ? st.leaderboard.map((p, i) => `<li class="${i < 3 ? 'top' : ''}" data-look="${esc(p.wallet)}"><span class="n">${String(i + 1).padStart(2, '0')}</span><img class="mini" src="${mini(p.tag)}" alt=""><span class="nm"><b>${esc(p.tag)}</b><small>${rankOf(p.done).name} · “${esc(p.line)}”</small></span><span class="v">${fsol(p.earned)}<small>${p.done} done</small></span></li>`).join('') : `<li class="empty">No one has finished a task yet.<br>The first name here is still open.</li>`;
  }
  $('#ff').addEventListener('click', e => { const b = e.target.closest('button[data-f]'); if (!b) return; S.ff = b.dataset.f; $$('#ff button').forEach(x => x.classList.toggle('on', x === b)); renderTown(); });

  function renderFlow() {
    const c = S.cfg, st = S.st && S.st.stats;
    if (c) {
      $('#flowIn').textContent = '$NPC creator fees';
      $('#flowInSub').textContent = c.ca ? 'from every $NPC trade' : 'starts when $NPC launches';
      $('#flowTre').textContent = c.treasury ? short(c.treasury) : 'not set yet';
    }
    if (st) {
      $('#flowTreSub').textContent = st.treasurySol == null ? '—' : `${fsol(st.treasurySol)} SOL now`;
      $('#flowOut').textContent = `${fsol(st.paidSol)} SOL paid`;
      $('#flowOutSub').textContent = `${st.completed} tasks done · ${fsol(st.owedSol)} SOL owed`;
    }
  }
  function renderCfg() {
    const c = S.cfg; if (!c) return;
    const links = [];
    if (c.ca) links.push(`<button class="chip" type="button" id="caBtn">CA ${short(c.ca)} · copy</button>`);
    if (c.x) links.push(`<a class="chip" href="${esc(/^https?:/.test(c.x) ? c.x : 'https://x.com/' + c.x.replace(/^@/, ''))}" target="_blank" rel="noopener">X</a>`);
    if (c.ca) links.push(`<a class="chip" href="https://pump.fun/coin/${esc(c.ca)}" target="_blank" rel="noopener">pump.fun</a>`);
    $('#heroLinks').innerHTML = links.join('');
    const ca = $('#caBtn'); if (ca) ca.onclick = () => navigator.clipboard && navigator.clipboard.writeText(c.ca).then(() => toast('CA copied'));
    const a = [`<a class="chip" href="${acc(c.board)}" target="_blank" rel="noopener">board ${short(c.board)} ↗</a>`];
    if (c.treasury) a.push(`<a class="chip" href="${acc(c.treasury)}" target="_blank" rel="noopener">treasury ${short(c.treasury)} ↗</a>`);
    if (c.ca) a.push(`<a class="chip" href="${acc(c.ca)}" target="_blank" rel="noopener">$NPC ${short(c.ca)} ↗</a>`);
    $('#addrs').innerHTML = a.join('');
    renderFlow(); renderTicker();
  }

  /* ---------------- data ---------------- */
  async function loadCfg() { try { S.cfg = await api('config'); renderCfg(); renderTasks(); renderMe(); if (S.st) renderTown(); } catch (e) { setTimeout(loadCfg, 4000); } }
  async function loadState() { try { S.st = await api('state'); renderTown(); if (!S.busy) renderTasks(); } catch (e) { } }
  async function loadMe() {
    if (!W.acct) { S.me = null; renderMe(); renderTasks(); return; }
    const w = W.acct.address;
    try { const j = await api('npc?wallet=' + w); if (W.acct && W.acct.address === w) { S.me = j; renderMe(); renderTasks(); } }
    catch (e) { if (W.acct && W.acct.address === w && !S.look) $('#meLedger').innerHTML = `<div class="gate"><p class="mono">${esc(e.message)}</p></div>`; }
  }
  setInterval(() => { if (!document.hidden) loadState(); }, 20000);
  setInterval(() => { if (!document.hidden && W.acct && !S.busy) loadMe(); }, 45000);
  setInterval(() => { $$('[data-cd]').forEach(el => { const left = +el.dataset.cd - nowS(); el.textContent = hms(left); if (left <= 0 && !el._fired) { el._fired = 1; setTimeout(loadMe, 1500); } }); }, 1000);

  /* ---------------- wallet (Wallet Standard) ---------------- */
  const W = { list: [], w: null, acct: null };
  function addWallet(w) {
    try {
      if (!w || !w.features || !w.name) return;
      const sol = (w.chains || []).some(c => String(c).startsWith('solana:'));
      const can = w.features['standard:connect'] && (w.features['solana:signTransaction'] || w.features['solana:signAndSendTransaction']);
      if (!sol || !can || W.list.some(x => x.name === w.name)) return;
      W.list.push(w);
      if (!W.w && store.get('npc:wallet') === w.name && w.accounts && w.accounts.length) use(w, w.accounts[0]);
      if (!$('#wModal').hidden) renderWallets();
    } catch (e) { }
  }
  const walletApi = Object.freeze({ register: (...ws) => { ws.forEach(addWallet); return () => { }; } });
  addEventListener('wallet-standard:register-wallet', e => { try { e.detail(walletApi); } catch (_) { } });
  try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletApi })); } catch (_) { }
  function use(w, acct) {
    const changed = !W.acct || W.acct.address !== acct.address;
    W.w = w; W.acct = acct; store.set('npc:wallet', w.name);
    $('#walletBtn').classList.add('on'); $('#walletLabel').textContent = short(acct.address);
    try { w.features['standard:events'] && w.features['standard:events'].on('change', ({ accounts }) => { if (accounts && W.w === w) { if (accounts.length) use(w, accounts[0]); else disconnect(); } }); } catch (e) { }
    if (changed) { S.me = null; renderMe(); renderTasks(); loadMe(); }
  }
  function disconnect() {
    try { W.w && W.w.features['standard:disconnect'] && W.w.features['standard:disconnect'].disconnect(); } catch (e) { }
    W.w = null; W.acct = null; store.set('npc:wallet', ''); S.me = null;
    $('#walletBtn').classList.remove('on'); $('#walletLabel').textContent = 'Connect';
    renderMe(); renderTasks();
  }
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  function renderWallets() {
    const box = $('#wList');
    $('#wTitle').textContent = W.w ? 'Wallet' : 'Connect';
    if (W.w) {
      box.innerHTML = `<p>${esc(W.w.name)}<br><code>${esc(W.acct.address)}</code></p><button class="wopt" type="button" id="wCopy">Copy address</button><button class="wopt" type="button" id="wOut">Disconnect</button>`;
      $('#wCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(W.acct.address).then(() => toast('Copied')); };
      $('#wOut').onclick = () => { disconnect(); $('#wModal').hidden = true; toast('Disconnected'); };
      return;
    }
    if (!W.list.length) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      box.innerHTML = mobile
        ? `<p>Open NPC inside your wallet's browser:</p><a class="wopt" href="https://phantom.app/ul/browse/${here}?ref=${ref}">Phantom</a><a class="wopt" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Solflare</a>`
        : `<p>No Solana wallet found in this browser. Install one, then reload:</p><a class="wopt" href="https://phantom.com/download" target="_blank" rel="noopener">Phantom</a><a class="wopt" href="https://solflare.com/download" target="_blank" rel="noopener">Solflare</a><a class="wopt" href="https://backpack.app/download" target="_blank" rel="noopener">Backpack</a>`;
      return;
    }
    box.innerHTML = W.list.map((w, i) => `<button class="wopt" data-i="${i}" type="button">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}<small>detected</small></button>`).join('');
  }
  function connect() { renderWallets(); $('#wModal').hidden = false; }
  $('#wList').addEventListener('click', async e => {
    const b = e.target.closest('button.wopt[data-i]'); if (!b) return;
    const w = W.list[+b.dataset.i];
    try {
      b.disabled = true;
      const r = await w.features['standard:connect'].connect();
      const acct = (r && r.accounts && r.accounts[0]) || (w.accounts && w.accounts[0]);
      if (!acct) throw new Error('No account shared');
      $('#wModal').hidden = true; use(w, acct); toast('Connected ' + short(acct.address));
    } catch (err) { toast(err && err.message ? err.message : 'Cancelled'); }
    finally { b.disabled = false; }
  });
  $('#walletBtn').addEventListener('click', connect);
  $('#wClose').addEventListener('click', () => { $('#wModal').hidden = true; });
  $('#wModal').addEventListener('click', e => { if (e.target.id === 'wModal') $('#wModal').hidden = true; });
  addEventListener('keydown', e => { if (e.key === 'Escape') $('#wModal').hidden = true; });

  async function waitFor(sig) {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 1300));
      try {
        const s = await api('status?sig=' + sig);
        if (s.err) throw Object.assign(new Error('The transaction failed on-chain.'), { chain: 1 });
        if (s.status === 'confirmed' || s.status === 'finalized') return true;
      } catch (e) { if (e.chain) throw e; }
    }
    throw new Error('Not confirmed after 90 seconds. Check Solscan before trying again.');
  }
  async function signSend(b64) {
    const f = W.w.features, chain = 'solana:mainnet', bytes = fromB64(b64);
    let sig;
    if (f['solana:signAndSendTransaction']) {
      const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes, options: { commitment: 'confirmed', preflightCommitment: 'processed', maxRetries: 3 } });
      sig = typeof r.signature === 'string' ? r.signature : b58(r.signature);
    } else {
      const [o] = await f['solana:signTransaction'].signTransaction({ account: W.acct, chain, transaction: bytes });
      sig = (await api('send', { tx: toB64(o.signedTransaction) })).sig;
    }
    await waitFor(sig);
    return sig;
  }
  const cancelled = e => /reject|denied|cancel|declin/i.test(e && e.message || '');
  // the board is read from the chain, so a fresh memo can take a few seconds to show up
  async function settle(test) {
    for (let i = 0; i < 8; i++) {
      await api('refresh', { wallet: W.acct.address }).catch(() => { });
      await loadMe(); if (test()) break;
      await new Promise(r => setTimeout(r, 2500));
    }
    loadState();
  }

  async function spawn() {
    if (!W.acct) { connect(); return; }
    if (S.busy) return;
    if (S.me && S.me.spawned) { $('#you').scrollIntoView(); return; }
    S.busy = 'spawn'; renderMe(); renderTasks();
    try {
      const j = await api('spawn', { wallet: W.acct.address });
      toast('Sign the spawn memo in your wallet');
      await signSend(j.tx);
      toast(`You are ${j.npc.tag} now.`, 4000);
      S.busy = ''; await settle(() => S.me && S.me.spawned);
      $('#you').scrollIntoView();
    } catch (e) { toast(cancelled(e) ? 'Cancelled' : e.message, 5000); }
    finally { S.busy = ''; renderMe(); renderTasks(); }
  }
  async function accept(id) {
    if (!W.acct) { connect(); return; }
    if (S.busy) return;
    S.busy = id; renderTasks();
    try {
      const j = await api('accept', { wallet: W.acct.address, task: id });
      await signSend(j.tx);
      toast(`${taskOf(id).name} accepted. Go do it.`, 4000);
      S.busy = ''; await settle(() => S.me && S.me.tasks[id] && S.me.tasks[id].state === 'open');
    } catch (e) { toast(cancelled(e) ? 'Cancelled' : e.message, 5000); }
    finally { S.busy = ''; renderTasks(); }
  }
  async function check(id) {
    if (S.busy) return;
    S.busy = id; renderTasks();
    try {
      await api('refresh', { wallet: W.acct.address }).catch(() => { });
      await loadMe();
      const ts = S.me && S.me.tasks[id];
      toast(ts && ts.state !== 'open' ? `${taskOf(id).name}: done. Reward owed.` : 'Not done yet. The proof has to come from this wallet after you accepted.', 4200);
      loadState();
    } finally { S.busy = ''; renderTasks(); }
  }
  $('#spawnBtn').addEventListener('click', () => { if (S.me && S.me.spawned) $('#you').scrollIntoView(); else if (!W.acct) connect(); else spawn(); });

  renderMe(); loadCfg(); loadState();
})();
