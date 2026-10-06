/* NPC treasury: lists completed, unpaid tasks and builds payout batches for the treasury wallet to sign. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
  const ago = t => { const s = Math.max(0, Date.now() / 1000 - t); return s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
  function toast(m, ms = 3200) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
  async function api(p, body) { const r = await fetch('/api/' + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); const j = await r.json().catch(() => null); if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'request failed'); return j; }
  const S = { owed: null, treasury: null, busy: false };
  const W = { list: [], w: null, acct: null };

  async function load() {
    try {
      const j = await api('owed'); S.owed = j.owed; S.treasury = j.treasury;
      const total = j.owed.reduce((a, r) => a + r.reward, 0);
      $('#info').innerHTML = !j.treasury ? '<i></i>NPC_TREASURY is not set' : `<i></i>${j.owed.length} owed · ${total.toFixed(4)} SOL · treasury holds ${j.treasurySol == null ? '—' : j.treasurySol.toFixed(4)} SOL`;
      $('#rows').innerHTML = j.owed.length ? j.owed.map(r => `<tr><td style="padding-left:20px">${esc(r.tag)} <span class="mono" style="color:var(--m)">${short(r.wallet)}</span></td><td>${esc(r.task)}</td><td>${ago(r.at)}</td><td>${r.proof ? `<a href="https://solscan.io/tx/${r.proof}" target="_blank" rel="noopener">proof</a>` : '—'}</td><td class="mono">${r.reward} SOL</td></tr>`).join('') : `<tr><td colspan="5" class="empty" style="padding-left:20px">Nothing is owed.</td></tr>`;
      paint();
    } catch (e) { $('#info').innerHTML = '<i></i>' + esc(e.message); }
  }
  function paint() {
    const b = $('#payBtn');
    const isT = W.acct && S.treasury && W.acct.address === S.treasury;
    b.disabled = S.busy || !S.owed || !S.owed.length || (W.acct && !isT);
    b.textContent = S.busy ? 'Paying…' : !W.acct ? 'Connect treasury' : isT ? 'Pay all owed' : 'Not the treasury wallet';
  }
  async function waitFor(sig) { const t0 = Date.now(); while (Date.now() - t0 < 90000) { await new Promise(r => setTimeout(r, 1300)); try { const s = await api('status?sig=' + sig); if (s.err) throw Object.assign(new Error('failed on-chain'), { c: 1 }); if (s.status === 'confirmed' || s.status === 'finalized') return; } catch (e) { if (e.c) throw e; } } throw new Error('not confirmed after 90s'); }
  async function pay() {
    if (!W.acct) { connect(); return; }
    S.busy = true; paint();
    try {
      const j = await api('payout', { wallet: W.acct.address });
      const f = W.w.features, chain = 'solana:mainnet';
      for (let i = 0; i < j.txs.length; i++) {
        toast(`Sign batch ${i + 1} of ${j.txs.length}`);
        const bytes = fromB64(j.txs[i].tx); let sig;
        if (f['solana:signAndSendTransaction']) { const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes }); sig = typeof r.signature === 'string' ? r.signature : b58(r.signature); }
        else { const [o] = await f['solana:signTransaction'].signTransaction({ account: W.acct, chain, transaction: bytes }); sig = (await api('send', { tx: toB64(o.signedTransaction) })).sig; }
        await waitFor(sig);
      }
      toast(`Paid ${j.count} tasks · ${j.sol} SOL`, 5000);
    } catch (e) { toast(/reject|cancel|declin/i.test(e.message) ? 'Cancelled' : e.message, 5000); }
    S.busy = false; await api('refresh', {}).catch(() => { }); setTimeout(load, 2500);
  }
  function addWallet(w) {
    try {
      if (!w || !w.features || !w.name) return;
      if (!(w.chains || []).some(c => String(c).startsWith('solana:')) || !w.features['standard:connect'] || W.list.some(x => x.name === w.name)) return;
      W.list.push(w); if (!$('#wModal').hidden) renderWallets();
    } catch (e) { }
  }
  const wa = Object.freeze({ register: (...ws) => { ws.forEach(addWallet); return () => { }; } });
  addEventListener('wallet-standard:register-wallet', e => { try { e.detail(wa); } catch (_) { } });
  try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: wa })); } catch (_) { }
  function renderWallets() { $('#wList').innerHTML = W.list.length ? W.list.map((w, i) => `<button class="wopt" data-i="${i}" type="button">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}</button>`).join('') : '<p>No Solana wallet found in this browser.</p>'; }
  function connect() { renderWallets(); $('#wModal').hidden = false; }
  $('#wList').addEventListener('click', async e => {
    const b = e.target.closest('button.wopt'); if (!b) return; const w = W.list[+b.dataset.i];
    try { const r = await w.features['standard:connect'].connect(); const a = (r && r.accounts && r.accounts[0]) || w.accounts[0]; W.w = w; W.acct = a; $('#wModal').hidden = true; $('#walletBtn').classList.add('on'); $('#walletLabel').textContent = short(a.address); paint(); } catch (err) { toast('Cancelled'); }
  });
  $('#walletBtn').onclick = connect; $('#wClose').onclick = () => { $('#wModal').hidden = true; };
  $('#payBtn').onclick = pay; $('#reBtn').onclick = () => api('refresh', {}).catch(() => { }).then(load);
  load();
})();
