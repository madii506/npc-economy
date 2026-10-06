// NPC: the NPC economy. Every wallet that spawns becomes an NPC, takes tasks from the board and earns SOL.
// Nothing is stored off-chain: spawns and accepted tasks are memo transactions sent to the board address,
// completion is checked against the wallet's own on-chain activity, and payouts are memo transfers from the treasury.
const { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const crypto = require('crypto');

const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const CA = E('NPC_CA');
const TREASURY = E('NPC_TREASURY');
const XH = E('NPC_X');
const HOLD_MIN = Number(E('NPC_HOLD_MIN', '100000'));
const ELIGIBLE_MIN = Number(E('NPC_ELIGIBLE_MIN', '0'));
const R = (k, d) => Number(E('NPC_REWARD_' + k, d));
const RPCS = [E('RPC_URL'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL = 'So11111111111111111111111111111111111111112';
const BOARD = PublicKey.findProgramAddressSync([Buffer.from('npc-board-v1')], MEMO)[0];
const H24 = 24 * 3600;

const TASKS = [
  { id: 'trade', name: 'Trader', reward: R('TRADE', '0.005'), window: H24, cooldown: H24, line: 'Make one buy or sell on pump.fun or PumpSwap.', proof: 'a pump.fun or PumpSwap trade signed by your wallet after you accept' },
  { id: 'host', name: 'Host', reward: R('HOST', '0.01'), window: H24, cooldown: H24, line: 'Add liquidity to any PumpSwap pool.', proof: 'a PumpSwap deposit signed by your wallet after you accept' },
  { id: 'newborn', name: 'First responder', reward: R('NEWBORN', '0.008'), window: H24, cooldown: H24, line: 'Buy a coin within 30 minutes of its graduation to PumpSwap.', proof: 'a PumpSwap buy of a coin whose pool was under 30 minutes old' },
  { id: 'hold', name: 'Hold the line', reward: R('HOLD', '0.01'), window: 3 * H24, cooldown: H24, needsCA: true, line: `Hold ${HOLD_MIN.toLocaleString('en-US')} $NPC when you accept and 24 hours later.`, proof: `at least ${HOLD_MIN.toLocaleString('en-US')} $NPC at accept and when checked 24h+ later` },
];
const TASK = Object.fromEntries(TASKS.map(t => [t.id, t]));

/* ---------------- plumbing ---------------- */
function send(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}
function http(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (e) { return {}; }
}
const timedFetch = ms => (url, opt = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
const conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(9000) }));
async function rpc(fn) {
  let last; for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).replace(/https?:\/\/\S+/g, '').slice(0, 120));
}
const mem = {};
async function cached(key, ms, fn) {
  const c = mem[key];
  if (c && c.has && Date.now() - c.t < ms) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    try { const v = await fn(); mem[key] = { t: Date.now(), v, has: true }; return v; }
    catch (e) { if (c && c.has) { mem[key] = { t: c.t, v: c.v, has: true }; return c.v; } delete mem[key]; throw e; }
  })();
  mem[key] = Object.assign({}, c || {}, { p });
  return p;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
const pk = (s, what) => { try { return new PublicKey(String(s || '').trim()); } catch (e) { throw http(400, `That ${what || 'address'} doesn't look right.`); } };
const nowS = () => Math.floor(Date.now() / 1000);
const sol = l => Number(l) / LAMPORTS_PER_SOL;
const round = v => Math.round(v * 1e6) / 1e6;

/* ---------------- NPC identity ---------------- */
const LINES = [
  'nice weather today.', 'have you heard? the dip is back.', 'i used to be a main character, like you.', 'the humans are watching again.',
  'same dialogue. different day.', 'i have a quest for you.', 'i only say this one line.', 'it is dangerous to trade alone.',
  'welcome to the town.', 'i bought the dip. i am the dip.', 'my line was written for me.', 'keep walking, traveler.',
  'i saw a chart once.', 'do not look behind you.', 'the board has new work.', 'everyone here is an npc. even you.',
  'i never log off.', 'you look familiar.', 'the treasury remembers.', 'we were never the main characters.',
];
function npcOf(wallet) {
  const h = crypto.createHash('sha256').update('npc:' + wallet).digest();
  return { tag: 'npc_' + h.toString('hex').slice(0, 4), line: LINES[h[4] % LINES.length], seed: h.readUInt32BE(5) };
}

/* ---------------- reading the chain ---------------- */
const txCache = new Map();
async function tx(sig) {
  if (txCache.has(sig)) return txCache.get(sig);
  const t = await rpc(c => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
  if (t) { txCache.set(sig, t); if (txCache.size > 4000) txCache.delete(txCache.keys().next().value); }
  return t;
}
function memosOf(t) {
  const out = [];
  const all = [...(t.transaction.message.instructions || [])];
  for (const ii of (t.meta && t.meta.innerInstructions) || []) all.push(...ii.instructions);
  for (const ix of all) {
    const pid = String(ix.programId || '');
    if (pid === MEMO.toBase58() || pid === 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo') {
      const txt = typeof ix.parsed === 'string' ? ix.parsed : (ix.parsed && ix.parsed.memo) || '';
      if (txt) out.push(txt);
    }
  }
  return out;
}
const feePayer = t => { const k = t.transaction.message.accountKeys[0]; return String(k.pubkey || k); };

// every spawn and accepted task, read from the board's own history
async function boardEvents() {
  return cached('board', 15000, async () => {
    const sigs = await rpc(c => c.getSignaturesForAddress(BOARD, { limit: 400 }));
    const ok = sigs.filter(s => !s.err);
    const txs = await mapLimit(ok, 6, s => tx(s.signature));
    const ev = [];
    txs.forEach((t, i) => {
      if (!t) return;
      const wallet = feePayer(t), at = t.blockTime || ok[i].blockTime || 0;
      for (const m of memosOf(t)) {
        const p = m.split(':');
        if (p[0] !== 'npc') continue;
        if (p[1] === 'spawn') ev.push({ type: 'spawn', wallet, at, sig: ok[i].signature });
        if (p[1] === 'accept' && TASK[p[2]]) ev.push({ type: 'accept', task: p[2], reward: Math.max(0, Math.min(Number(p[3]) || 0, TASK[p[2]].reward)), wallet, at, sig: ok[i].signature, bal: Number(p[4]) || 0 });
      }
    });
    ev.sort((a, b) => a.at - b.at || (a.sig < b.sig ? -1 : 1));
    return ev;
  });
}
// payouts: memo transfers from the treasury, "npc:pay:<accept signature>"
async function payouts() {
  if (!TREASURY) return [];
  return cached('pay', 20000, async () => {
    const sigs = await rpc(c => c.getSignaturesForAddress(new PublicKey(TREASURY), { limit: 300 }));
    const ok = sigs.filter(s => !s.err);
    const txs = await mapLimit(ok, 6, s => tx(s.signature));
    const out = [];
    txs.forEach((t, i) => {
      if (!t || feePayer(t) !== TREASURY) return;
      const transfers = (t.transaction.message.instructions || []).filter(ix => ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer' && ix.parsed.info.source === TREASURY);
      const memos = memosOf(t).filter(m => m.startsWith('npc:pay:'));
      memos.forEach(m => {
        const acc = m.split(':')[2];
        const tr = transfers.find(x => x.parsed.info.destination && m.endsWith(':' + x.parsed.info.destination.slice(0, 6))) || null;
        out.push({ accept: acc, to: tr ? tr.parsed.info.destination : null, sol: tr ? sol(tr.parsed.info.lamports) : null, at: t.blockTime || 0, sig: ok[i].signature });
      });
    });
    return out;
  });
}
async function treasuryBalance() {
  if (!TREASURY) return null;
  return cached('tbal', 20000, async () => sol(await rpc(c => c.getBalance(new PublicKey(TREASURY)))));
}
async function walletActivity(wallet) {
  return cached('act:' + wallet, 25000, async () => {
    const sigs = await rpc(c => c.getSignaturesForAddress(new PublicKey(wallet), { limit: 80 }));
    return sigs.filter(s => !s.err && s.blockTime).map(s => ({ sig: s.signature, at: s.blockTime }));
  });
}
async function npcBalance(wallet) {
  if (!CA) return null;
  return cached('nb:' + wallet, 20000, async () => {
    const r = await rpc(c => c.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(CA) }));
    return r.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  });
}
const logsHave = (t, re) => ((t.meta && t.meta.logMessages) || []).some(l => re.test(l));
const touches = (t, pid) => (t.transaction.message.accountKeys || []).some(k => String(k.pubkey || k) === pid);
async function pairAge(mint) {
  return cached('pair:' + mint, 3600e3, async () => {
    const r = await timedFetch(6000)('https://api.dexscreener.com/tokens/v1/solana/' + mint);
    const j = await r.json();
    const p = (Array.isArray(j) ? j : []).filter(x => x.dexId === 'pumpswap' && x.pairCreatedAt).sort((a, b) => a.pairCreatedAt - b.pairCreatedAt)[0];
    return p ? Math.floor(p.pairCreatedAt / 1000) : null;
  });
}

// is this accepted task done? everything is decided from chain data after the accept time
const verdicts = new Map();
async function verify(ev) {
  const done = verdicts.get(ev.sig);
  if (done && done.state === 'complete') return done;
  const t = TASK[ev.task], now = nowS();
  let v = { state: 'open', until: ev.at + t.window };
  if (ev.task === 'hold') {
    if (!CA) v = { state: 'open', note: 'starts when $NPC is live', until: ev.at + t.window };
    else if (now - ev.at < H24) v = { state: 'open', ready: ev.at + H24, until: ev.at + t.window };
    else {
      const b = await npcBalance(ev.wallet);
      if (b >= HOLD_MIN && ev.bal >= HOLD_MIN) v = { state: 'complete', at: now, proof: null };
      else v = { state: now > ev.at + t.window ? 'expired' : 'open', note: `holding ${Math.floor(b || 0).toLocaleString('en-US')} $NPC`, until: ev.at + t.window };
    }
  } else {
    const act = (await walletActivity(ev.wallet)).filter(a => a.at > ev.at && a.at <= ev.at + t.window).slice(0, 30);
    for (const a of act.reverse()) {
      const x = await tx(a.sig).catch(() => null);
      if (!x || feePayer(x) !== ev.wallet) continue;
      if (ev.task === 'trade' && (touches(x, PUMPSWAP) || touches(x, PUMPFUN)) && logsHave(x, /Instruction: (Buy|Sell|BuyExactSolIn)/)) { v = { state: 'complete', at: a.at, proof: a.sig }; break; }
      if (ev.task === 'host' && touches(x, PUMPSWAP) && logsHave(x, /Instruction: Deposit/)) { v = { state: 'complete', at: a.at, proof: a.sig }; break; }
      if (ev.task === 'newborn' && touches(x, PUMPSWAP) && logsHave(x, /Instruction: Buy/)) {
        const mints = ((x.meta && x.meta.postTokenBalances) || []).filter(b => b.owner === ev.wallet && b.mint !== WSOL).map(b => b.mint);
        for (const m of [...new Set(mints)]) {
          const born = await pairAge(m).catch(() => null);
          if (born && a.at >= born && a.at - born <= 1800) { v = { state: 'complete', at: a.at, proof: a.sig, mint: m }; break; }
        }
        if (v.state === 'complete') break;
      }
    }
    if (v.state !== 'complete' && now > ev.at + t.window) v = { state: 'expired' };
  }
  verdicts.set(ev.sig, v);
  return v;
}

/* ---------------- the views ---------------- */
async function ledger() {
  return cached('ledger', 20000, async () => {
    const [ev, pays, tbal] = await Promise.all([boardEvents(), payouts().catch(() => []), treasuryBalance().catch(() => null)]);
    const order = {}; let n = 0;
    for (const e of ev) if (e.type === 'spawn' && !(e.wallet in order)) order[e.wallet] = ++n;
    const spawnAt = {}; for (const e of ev) if (e.type === 'spawn' && !(e.wallet in spawnAt)) spawnAt[e.wallet] = e.at;
    // one open task per kind per NPC, cooldown after completion: accepts that break the rules are ignored
    const groups = {};
    for (const e of ev) if (e.type === 'accept' && e.wallet in order && e.at >= spawnAt[e.wallet]) (groups[e.wallet + ':' + e.task] = groups[e.wallet + ':' + e.task] || []).push(e);
    const kept = [];
    await mapLimit(Object.values(groups), 4, async list => {
      let last = null, lastV = null;
      for (const a of list) {
        const t = TASK[a.task];
        if (last) {
          if (lastV.state === 'open') continue;
          if (lastV.state === 'complete' && a.at < (lastV.at || last.at) + t.cooldown) continue;
          if (lastV.state !== 'complete' && a.at < last.at + t.window) continue;
        }
        const v = await verify(a).catch(() => ({ state: 'open' }));
        kept.push({ a, v }); last = a; lastV = v;
      }
    });
    kept.sort((x, y) => x.a.at - y.a.at);
    const paidBy = {}; for (const p of pays) paidBy[p.accept] = p;
    const rows = kept.map(({ a, v }) => ({ ...a, v, paid: paidBy[a.sig.slice(0, 16)] || null }));
    const per = {};
    for (const w of Object.keys(order)) per[w] = { wallet: w, no: order[w], ...npcOf(w), done: 0, earned: 0, paid: 0 };
    for (const r of rows) {
      const p = per[r.wallet]; if (!p) continue;
      if (r.v.state === 'complete') { p.done++; p.earned += r.reward; }
      if (r.paid) p.paid += r.paid.sol || r.reward;
    }
    const feed = [];
    for (const e of ev) if (e.type === 'spawn' && order[e.wallet]) feed.push({ kind: 'spawn', at: e.at, sig: e.sig, wallet: e.wallet, no: order[e.wallet] });
    for (const r of rows) {
      feed.push({ kind: 'accept', at: r.at, sig: r.sig, wallet: r.wallet, no: order[r.wallet], task: r.task, reward: r.reward });
      if (r.v.state === 'complete') feed.push({ kind: 'complete', at: r.v.at || r.at, sig: r.v.proof || r.sig, wallet: r.wallet, no: order[r.wallet], task: r.task, reward: r.reward });
    }
    for (const p of pays) { const r = rows.find(x => x.sig.slice(0, 16) === p.accept); if (r) feed.push({ kind: 'paid', at: p.at, sig: p.sig, wallet: r.wallet, no: order[r.wallet], task: r.task, sol: p.sol || r.reward }); }
    feed.sort((a, b) => b.at - a.at);
    const completed = rows.filter(r => r.v.state === 'complete');
    const paidSol = pays.reduce((a, p) => a + (p.sol || 0), 0);
    const owed = completed.filter(r => !r.paid);
    return {
      updated: Date.now(), rows, per, order,
      stats: { byTask: Object.fromEntries(TASKS.map(t => [t.id, { done: rows.filter(r => r.task === t.id && r.v.state === 'complete').length, open: rows.filter(r => r.task === t.id && r.v.state === 'open').length }])), npcs: n, accepted: rows.length, completed: completed.length, paidSol: round(paidSol), owedSol: round(owed.reduce((a, r) => a + r.reward, 0)), treasurySol: tbal == null ? null : round(tbal) },
      feed: feed.slice(0, 60).map(f => ({ ...f, tag: npcOf(f.wallet).tag })),
      leaderboard: Object.values(per).filter(p => p.done > 0).sort((a, b) => b.earned - a.earned || a.no - b.no).slice(0, 25).map(p => ({ tag: p.tag, no: p.no, done: p.done, earned: round(p.earned), paid: round(p.paid), wallet: p.wallet, line: p.line })),
    };
  });
}
function publicConfig() {
  return {
    ok: true, ca: CA || null, x: XH || null, treasury: TREASURY || null, board: BOARD.toBase58(), holdMin: HOLD_MIN, eligibleMin: ELIGIBLE_MIN,
    tasks: TASKS.map(t => ({ id: t.id, name: t.name, reward: t.reward, window: t.window, cooldown: t.cooldown, line: t.line, proof: t.proof, live: !t.needsCA || !!CA })),
  };
}
async function npcView(walletS) {
  const wallet = pk(walletS, 'wallet').toBase58();
  const L = await ledger();
  const me = L.per[wallet] || null;
  const mine = L.rows.filter(r => r.wallet === wallet);
  // re-check open tasks for this wallet right now
  for (const r of mine) if (r.v.state === 'open') { verdicts.delete(r.sig); mem['act:' + wallet] = undefined; r.v = await verify(r); }
  const tasks = {};
  for (const t of TASKS) {
    const list = mine.filter(r => r.task === t.id);
    const last = list[list.length - 1] || null;
    let state = 'available', next = null;
    if (last) {
      if (last.v.state === 'open') state = 'open';
      else if (last.v.state === 'complete') { const ready = (last.v.at || last.at) + t.cooldown; if (nowS() < ready) { state = 'cooldown'; next = ready; } }
    }
    tasks[t.id] = { state, next, last: last ? { sig: last.sig, at: last.at, reward: last.reward, v: last.v, paid: last.paid } : null, completed: list.filter(r => r.v.state === 'complete').length };
  }
  const bal = await npcBalance(wallet).catch(() => null);
  return {
    wallet, spawned: !!me, npc: me ? { tag: me.tag, no: me.no, line: me.line, seed: me.seed } : npcOf(wallet),
    earned: me ? round(me.earned) : 0, paid: me ? round(me.paid) : 0, owed: me ? round(Math.max(0, me.earned - me.paid)) : 0, done: me ? me.done : 0,
    npcBalance: bal, tasks,
    history: mine.slice().reverse().slice(0, 30).map(r => ({ task: r.task, at: r.at, sig: r.sig, reward: r.reward, state: r.v.state, proof: r.v.proof || null, paid: r.paid ? r.paid.sig : null })),
  };
}

/* ---------------- building transactions (the wallet signs) ---------------- */
async function buildMemo(walletS, text) {
  const user = pk(walletS, 'wallet');
  const { blockhash, lastValidBlockHeight } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: BOARD, lamports: 0 }),
    new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: user, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') }),
  ];
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const t = new VersionedTransaction(msg);
  const sim = await rpc(c => c.simulateTransaction(t, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join(' ');
    if (/insufficient|0x1/.test(logs) || JSON.stringify(sim.value.err).includes('InsufficientFunds')) throw http(400, 'This wallet needs a little SOL for the network fee (about 0.0001 SOL).');
    throw http(400, 'The network would reject this: ' + JSON.stringify(sim.value.err).slice(0, 100));
  }
  return { tx: Buffer.from(t.serialize()).toString('base64'), blockhash, lastValidBlockHeight };
}
async function buildSpawn(b) {
  const wallet = pk(b.wallet, 'wallet').toBase58();
  const L = await ledger();
  if (L.per[wallet]) throw http(409, 'This wallet is already an NPC.');
  return { ...(await buildMemo(wallet, 'npc:spawn')), npc: npcOf(wallet) };
}
async function buildAccept(b) {
  const wallet = pk(b.wallet, 'wallet').toBase58();
  const t = TASK[String(b.task || '')]; if (!t) throw http(400, 'Unknown task.');
  if (t.needsCA && !CA) throw http(409, 'This task starts when $NPC is live.');
  const L = await ledger();
  if (!L.per[wallet]) throw http(409, 'Spawn your NPC first.');
  const v = await npcView(wallet);
  const st = v.tasks[t.id];
  if (st.state === 'open') throw http(409, 'You already have this task open.');
  if (st.state === 'cooldown') throw http(409, 'This task is cooling down for your NPC.');
  let bal = 0;
  if (CA) {
    bal = await npcBalance(wallet);
    if (ELIGIBLE_MIN && bal < ELIGIBLE_MIN) throw http(403, `Hold at least ${ELIGIBLE_MIN.toLocaleString('en-US')} $NPC to take tasks.`);
    if (t.id === 'hold' && bal < HOLD_MIN) throw http(403, `Hold at least ${HOLD_MIN.toLocaleString('en-US')} $NPC first.`);
  }
  const memo = `npc:accept:${t.id}:${t.reward}` + (t.id === 'hold' ? `:${Math.floor(bal)}` : '');
  return await buildMemo(wallet, memo);
}
// owner only: pay every completed, unpaid task from the treasury (the treasury wallet signs in the browser)
async function buildPayout(b) {
  if (!TREASURY) throw http(409, 'Set NPC_TREASURY first.');
  const owner = pk(b.wallet, 'wallet').toBase58();
  if (owner !== TREASURY) throw http(403, 'Connect the treasury wallet to pay NPCs.');
  verdicts.clear(); mem.ledger = undefined; mem.pay = undefined;
  const L = await ledger();
  const owed = L.rows.filter(r => r.v.state === 'complete' && !r.paid).slice(0, 40);
  if (!owed.length) throw http(409, 'Nothing is owed right now.');
  const bal = await rpc(c => c.getBalance(new PublicKey(TREASURY)));
  const need = owed.reduce((a, r) => a + Math.round(r.reward * LAMPORTS_PER_SOL), 0);
  if (bal < need + 5_000_000) throw http(400, `The treasury holds ${sol(bal).toFixed(4)} SOL; these payouts need ${sol(need).toFixed(4)} SOL plus fees.`);
  const { blockhash } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const txs = [];
  const tre = new PublicKey(TREASURY);
  for (let i = 0; i < owed.length; i += 6) {
    const part = owed.slice(i, i + 6);
    const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 })];
    for (const r of part) {
      const to = new PublicKey(r.wallet);
      ixs.push(SystemProgram.transfer({ fromPubkey: tre, toPubkey: to, lamports: Math.round(r.reward * LAMPORTS_PER_SOL) }));
      ixs.push(new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: tre, isSigner: true, isWritable: false }], data: Buffer.from(`npc:pay:${r.sig.slice(0, 16)}:${r.wallet.slice(0, 6)}`) }));
    }
    const msg = new TransactionMessage({ payerKey: tre, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    txs.push({ tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64') });
  }
  return { txs, count: owed.length, sol: round(sol(need)), rows: owed.map(r => ({ tag: npcOf(r.wallet).tag, task: r.task, reward: r.reward, wallet: r.wallet })) };
}

/* ---------------- router ---------------- */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const path = (q.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  try {
    if (path === 'config') return send(res, 200, publicConfig(), 'public, s-maxage=60');
    if (path === 'state') {
      const L = await ledger();
      return send(res, 200, { ok: true, updated: L.updated, stats: L.stats, feed: L.feed, leaderboard: L.leaderboard }, 'public, s-maxage=10, stale-while-revalidate=60');
    }
    if (path === 'npc') return send(res, 200, { ok: true, ...(await npcView(q.get('wallet'))) });
    if (path === 'owed') {
      const L = await ledger();
      const owed = L.rows.filter(r => r.v.state === 'complete' && !r.paid).map(r => ({ tag: npcOf(r.wallet).tag, wallet: r.wallet, task: r.task, reward: r.reward, at: r.v.at || r.at, proof: r.v.proof || null, sig: r.sig }));
      return send(res, 200, { ok: true, treasury: TREASURY || null, treasurySol: L.stats.treasurySol, owed });
    }
    if (path === 'status') {
      const sig = String(q.get('sig') || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw http(400, 'bad signature');
      const r = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: false }));
      const s = r.value[0];
      return send(res, 200, { ok: true, status: s ? s.confirmationStatus : null, err: s ? s.err : null });
    }
    if (req.method !== 'POST') throw http(404, 'Not found');
    const b = await readBody(req);
    if (path === 'spawn') return send(res, 200, { ok: true, ...(await buildSpawn(b)) });
    if (path === 'accept') return send(res, 200, { ok: true, ...(await buildAccept(b)) });
    if (path === 'payout') return send(res, 200, { ok: true, ...(await buildPayout(b)) });
    if (path === 'send') {
      const raw = Buffer.from(String(b.tx || ''), 'base64');
      if (raw.length < 64 || raw.length > 1232) throw http(400, 'bad transaction');
      const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'processed', maxRetries: 3 }));
      if (path === 'send') { mem.board = undefined; mem.ledger = undefined; }
      return send(res, 200, { ok: true, sig });
    }
    if (path === 'refresh') { mem.board = undefined; mem.ledger = undefined; mem['act:' + String(b.wallet || '')] = undefined; return send(res, 200, { ok: true }); }
    throw http(404, 'Not found');
  } catch (e) {
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    return send(res, code, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
module.exports._t = { npcOf, BOARD, TASKS, memosOf };
