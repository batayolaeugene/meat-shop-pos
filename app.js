/* Karnehan POS — offline-first meat shop POS & customer credit ledger.
 * All data lives in localStorage. Money is stored as integer centavos to avoid float drift.
 */

// ───────────────────────── Utilities ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PESO = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const fmt = (c) => PESO.format((c || 0) / 100);
const toCents = (v) => Math.max(0, Math.round((parseFloat(v) || 0) * 100));
const kg = (w) => `${(+w).toLocaleString('en-PH', { maximumFractionDigits: 3 })} kg`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) =>
  new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });

// ───────────────────────── Domain constants ─────────────────────────
const CUTS = [
  { id: 'liempo', label: 'Liempo', emoji: '🥓', price: 380 },
  { id: 'kasim', label: 'Kasim', emoji: '🍖', price: 320 },
  { id: 'pigue', label: 'Pigue', emoji: '🍗', price: 330 },
  { id: 'ribs', label: 'Ribs/Costillas', emoji: '🦴', price: 360 },
  { id: 'pata', label: 'Pata', emoji: '🦶', price: 280 },
  { id: 'ulo', label: 'Ulo/Maskara', emoji: '🐷', price: 200 },
  { id: 'innards', label: 'Ginabot/Innards', emoji: '🫀', price: 180 },
  { id: 'custom', label: 'Custom Cut', emoji: '🔪', price: 0 },
];
const cutDef = (id) => CUTS.find((c) => c.id === id) ?? CUTS[CUTS.length - 1];

// ───────────────────────── Batches ─────────────────────────
// Each month is split into 4 weekly batches: 1–7, 8–14, 15–21, 22–end.
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const batchOfDate = (d) => { const x = d.getDate(); return x <= 7 ? 1 : x <= 14 ? 2 : x <= 21 ? 3 : 4; };
const parseMonth = (m) => m.split('-').map(Number);
const shiftMonth = (m, n) => { const [y, mo] = parseMonth(m); return monthKey(new Date(y, mo - 1 + n, 1)); };
const monthLabel = (m) => { const [y, mo] = parseMonth(m); return new Date(y, mo - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }); };
const batchDays = (m, b) => {
  const [y, mo] = parseMonth(m);
  const last = new Date(y, mo, 0).getDate();
  const s = [1, 8, 15, 22][b - 1];
  return [s, b === 4 ? last : s + 6];
};
const batchRange = (m, b) => { const [s, e] = batchDays(m, b); return `${MON[parseMonth(m)[1] - 1]} ${s}–${e}`; };
const batchShort = (m, b) => `B${b} · ${MON[parseMonth(m)[1] - 1]}`;
const batchSortKey = (m, b) => `${m}#${b}`;
const prevBatch = ({ month, batch }) => (batch > 1 ? { month, batch: batch - 1 } : { month: shiftMonth(month, -1), batch: 4 });

// ───────────────────────── Storage ─────────────────────────
const DB_KEY = 'karnehan-pos:data:v1';
const UI_KEY = 'karnehan-pos:ui:v1';
const emptyDb = () => ({ customers: [], txns: [], prices: {} });

function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(DB_KEY));
    if (d && Array.isArray(d.txns) && Array.isArray(d.customers)) return { ...emptyDb(), ...d };
  } catch { /* corrupted → start fresh */ }
  return emptyDb();
}
let db = loadDb();
let lastSaved = null;

function save() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    lastSaved = new Date();
  } catch {
    toast('⚠️ Could not save — storage may be full. Export a backup now.', 'error');
  }
  renderSaveStatus();
  scheduleAutoBackup();
}

const today = new Date();
const persistedUi = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) ?? {}; } catch { return {}; } })();
// Period always opens on today's batch; tab and filters are remembered.
const ui = {
  tab: 'register', filter: 'all', lfilter: 'debt', lsort: 'debt',
  ...persistedUi,
  q: '', lq: '',
  month: monthKey(today), batch: batchOfDate(today),
};
const saveUi = () => {
  const { tab, filter, lfilter, lsort } = ui;
  try { localStorage.setItem(UI_KEY, JSON.stringify({ tab, filter, lfilter, lsort })); } catch { /* ignore */ }
};

// ───────────────────────── Selectors ─────────────────────────
const paidOf = (t) => t.payments.reduce((s, p) => s + p.amount, 0);
const balOf = (t) => Math.max(0, t.total - paidOf(t));
const statusOf = (t) => (balOf(t) === 0 ? 'paid' : paidOf(t) > 0 ? 'partial' : 'unpaid');
const custById = (id) => db.customers.find((c) => c.id === id);
const custName = (id) => custById(id)?.name ?? 'Unknown';
const findCustByName = (name) => {
  const n = name.trim().toLowerCase();
  return n ? db.customers.find((c) => c.name.toLowerCase() === n) : undefined;
};
const byOldest = (a, b) =>
  batchSortKey(a.month, a.batch).localeCompare(batchSortKey(b.month, b.batch)) || a.createdAt.localeCompare(b.createdAt);
const custTxns = (id) => db.txns.filter((t) => t.customerId === id).sort(byOldest);
const custDebt = (id) => db.txns.reduce((s, t) => (t.customerId === id ? s + balOf(t) : s), 0);
const custStatus = (id) => {
  const open = db.txns.filter((t) => t.customerId === id && balOf(t) > 0);
  if (!open.length) return 'paid';
  return open.some((t) => paidOf(t) > 0) ? 'partial' : 'unpaid';
};
/** Outstanding balance per batch for a customer → [{month,batch,amount}] oldest first. */
const custBreakdown = (id) => {
  const map = new Map();
  for (const t of custTxns(id)) {
    const b = balOf(t);
    if (!b) continue;
    const k = batchSortKey(t.month, t.batch);
    const e = map.get(k) ?? { month: t.month, batch: t.batch, amount: 0 };
    e.amount += b;
    map.set(k, e);
  }
  return [...map.values()];
};
const lastActivity = (id) => {
  let last = '';
  for (const t of db.txns) {
    if (t.customerId !== id) continue;
    if (t.createdAt > last) last = t.createdAt;
    for (const p of t.payments) if (p.at > last) last = p.at;
  }
  return last;
};
const totalReceivables = () => db.txns.reduce((s, t) => s + balOf(t), 0);

/** FIFO allocation of a payment across a customer's open items (optionally starting with one item). */
function allocate(customerId, amount, firstTxnId) {
  const open = custTxns(customerId).filter((t) => balOf(t) > 0);
  if (firstTxnId) {
    const i = open.findIndex((t) => t.id === firstTxnId);
    if (i > 0) open.unshift(open.splice(i, 1)[0]);
  }
  const plan = [];
  let left = amount;
  for (const t of open) {
    if (left <= 0) break;
    const b = balOf(t);
    const a = Math.min(left, b);
    plan.push({ t, a, clears: a === b });
    left -= a;
  }
  return { plan, change: Math.max(0, left), applied: amount - Math.max(0, left) };
}

// ───────────────────────── UI helpers ─────────────────────────
const BADGE = {
  paid: ['Fully Paid', 'bg-emerald-100 text-emerald-800 ring-emerald-600/25'],
  partial: ['With Balance', 'bg-amber-100 text-amber-800 ring-amber-600/30'],
  unpaid: ['Unpaid', 'bg-red-100 text-red-700 ring-red-600/25'],
};
const badge = (s) =>
  `<span class="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${BADGE[s][1]}"><span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>${BADGE[s][0]}</span>`;

const ICON_CASH = `<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>`;
const ICON_ROLL = `<svg class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/></svg>`;

let toastTimer;
const TOAST_CLS = {
  info: 'bg-stone-900',
  success: 'bg-emerald-700',
  error: 'bg-red-700',
};
function toast(msg, type = 'info') {
  const wrap = $('#toast');
  const p = $('#toast-msg');
  p.textContent = msg;
  p.className = `max-w-md rounded-xl px-4 py-3 text-sm font-medium text-white shadow-xl ${TOAST_CLS[type]}`;
  wrap.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (wrap.hidden = true), 3200);
}

function renderSaveStatus() {
  const el = $('#save-status');
  const net = navigator.onLine ? '' : 'Offline · ';
  const cloud = sbCfg?.url && sbCfg?.key ? ' · ☁️ Supabase' : '';
  el.textContent = lastSaved
    ? `${net}Saved locally ${lastSaved.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}${cloud}`
    : `${net}Saved on this device${cloud}`;
}

// ───────────────────────── Render: header / summary ─────────────────────────
function renderPeriod() {
  const all = ui.batch === 'all';
  $('#period-bar').hidden = ui.tab !== 'register';
  $('#ledger-bar').classList.toggle('hidden', ui.tab !== 'ledgers');
  $('#month-label').textContent = all ? 'All months · Active debts' : monthLabel(ui.month);
  document.querySelectorAll('[data-act^="month-"]').forEach((b) => (b.disabled = all));

  const todayM = monthKey(new Date());
  const todayB = batchOfDate(new Date());
  const openCount = db.txns.filter((t) => balOf(t) > 0).length;
  const chips = [1, 2, 3, 4].map((b) => {
    const active = ui.batch === b;
    const [s, e] = batchDays(ui.month, b);
    const hasDebt = db.txns.some((t) => t.month === ui.month && t.batch === b && balOf(t) > 0);
    const isNow = ui.month === todayM && b === todayB;
    return `<button type="button" data-act="batch" data-b="${b}" aria-pressed="${active}"
      class="relative rounded-xl px-1 py-1.5 text-center transition ${active ? 'bg-white text-red-700 shadow' : 'bg-white/10 text-white hover:bg-white/20'}">
      <span class="block text-sm font-bold">Batch ${b}</span>
      <span class="block text-[10px] ${active ? 'text-red-500' : 'text-red-100'}">${s}–${e}${isNow ? ' · now' : ''}</span>
      ${hasDebt ? `<span class="absolute top-1 right-1 size-2 rounded-full bg-amber-400 ring-2 ${active ? 'ring-white' : 'ring-red-800'}" title="Has unpaid balances"></span>` : ''}
    </button>`;
  });
  chips.push(`<button type="button" data-act="batch" data-b="all" aria-pressed="${all}"
    class="rounded-xl px-1 py-1.5 text-center transition ${all ? 'bg-amber-300 text-stone-900 shadow' : 'bg-amber-400/20 text-amber-100 hover:bg-amber-400/30'}">
    <span class="block text-sm leading-tight font-bold">All Debts</span>
    <span class="block text-[10px]">${openCount} open</span>
  </button>`);
  $('#batch-chips').innerHTML = chips.join('');
}

function card(label, value, sub, tone, wide = false) {
  const tones = {
    stone: 'bg-white ring-stone-200 text-stone-900',
    emerald: 'bg-emerald-50 ring-emerald-200 text-emerald-900',
    red: 'bg-red-50 ring-red-200 text-red-900',
  };
  return `<div class="rounded-2xl p-3.5 shadow-sm ring-1 ${tones[tone]} ${wide ? 'col-span-2 sm:col-span-1' : ''}">
    <p class="text-[11px] font-semibold tracking-wide uppercase opacity-70">${label}</p>
    <p class="mt-1 text-xl font-extrabold tracking-tight tabular-nums">${value}</p>
    <p class="mt-0.5 text-[11px] opacity-70">${sub}</p>
  </div>`;
}

function renderSummary() {
  let list, gross, cash, out, sub1, sub2, sub3;
  if (ui.tab === 'ledgers') {
    list = db.txns;
    gross = list.reduce((s, t) => s + t.total, 0);
    cash = list.reduce((s, t) => s + paidOf(t), 0);
    out = totalReceivables();
    const owing = db.customers.filter((c) => custDebt(c.id) > 0).length;
    sub1 = `All time · ${list.length} sales`;
    sub2 = `All time · ${pct(cash, gross)} collected`;
    sub3 = `${owing} customer${owing === 1 ? '' : 's'} with balance`;
  } else if (ui.batch === 'all') {
    list = db.txns.filter((t) => balOf(t) > 0);
    gross = list.reduce((s, t) => s + t.total, 0);
    cash = list.reduce((s, t) => s + paidOf(t), 0);
    out = totalReceivables();
    const batches = new Set(list.map((t) => batchSortKey(t.month, t.batch))).size;
    sub1 = `${list.length} open sales`;
    sub2 = 'Down/partial payments on open sales';
    sub3 = `Across ${batches} batch${batches === 1 ? '' : 'es'}`;
  } else {
    list = db.txns.filter((t) => t.month === ui.month && t.batch === ui.batch);
    gross = list.reduce((s, t) => s + t.total, 0);
    cash = list.reduce((s, t) => s + paidOf(t), 0);
    out = gross - cash;
    // Cash physically received during this batch's dates (includes collections of older debts).
    const [s, e] = batchDays(ui.month, ui.batch);
    let drawer = 0;
    for (const t of db.txns) for (const p of t.payments) {
      const d = new Date(p.at);
      if (monthKey(d) === ui.month && d.getDate() >= s && d.getDate() <= e) drawer += p.amount;
    }
    const weight = list.reduce((a, t) => a + t.weight, 0);
    sub1 = `${list.length} sales · ${kg(Math.round(weight * 1000) / 1000)}`;
    sub2 = `Drawer this week: ${fmt(drawer)}`;
    sub3 = `All batches total: ${fmt(totalReceivables())}`;
  }
  $('#summary').innerHTML =
    card('Total Sales (Gross)', fmt(gross), sub1, 'stone') +
    card('Cash Collected', fmt(cash), sub2, 'emerald') +
    card('Outstanding Credit', fmt(out), sub3, 'red', true);
}
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

// ───────────────────────── Render: Sales Register ─────────────────────────
function txnCard(t) {
  const s = statusOf(t);
  const b = balOf(t);
  const debt = custDebt(t.customerId);
  const other = debt - b;
  const rollover =
    b > 0 && other > 0
      ? `<p class="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 ring-1 ring-amber-200">
          ${ICON_ROLL}<span>+${fmt(other)} from other sales · <b>Total owed ${fmt(debt)}</b></span></p>`
      : '';
  return `<li><article class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-200">
    <button type="button" data-act="txn-detail" data-id="${t.id}" class="block w-full text-left">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="truncate font-bold">${esc(custName(t.customerId))}</h3>
          <p class="truncate text-sm text-stone-500">${cutDef(t.cut).emoji} ${esc(t.cutLabel)} · ${kg(t.weight)} × ${fmt(t.price)}</p>
        </div>
        ${badge(s)}
      </div>
      <dl class="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-stone-50 p-2.5 text-center text-sm tabular-nums">
        <div><dt class="text-[10px] font-semibold text-stone-500 uppercase">Total</dt><dd class="font-bold">${fmt(t.total)}</dd></div>
        <div><dt class="text-[10px] font-semibold text-stone-500 uppercase">Paid</dt><dd class="font-bold text-emerald-700">${fmt(paidOf(t))}</dd></div>
        <div><dt class="text-[10px] font-semibold text-stone-500 uppercase">Balance</dt><dd class="font-bold ${b ? 'text-red-700' : 'text-stone-400'}">${fmt(b)}</dd></div>
      </dl>
    </button>
    ${rollover}
    <div class="mt-3 flex items-center justify-between gap-2">
      <p class="text-xs text-stone-400">${batchShort(t.month, t.batch)} · ${fmtDate(t.createdAt)}</p>
      ${b > 0 ? `<button type="button" data-act="collect" data-cid="${t.customerId}" data-tid="${t.id}" class="btn-collect">${ICON_CASH} Collect</button>` : ''}
    </div>
  </article></li>`;
}

function emptyState(title, body, withActions = false) {
  return `<li class="rounded-2xl border-2 border-dashed border-stone-300 bg-white/60 px-6 py-10 text-center">
    <p class="text-4xl" aria-hidden="true">🥩</p>
    <p class="mt-2 font-bold">${title}</p>
    <p class="mt-1 text-sm text-stone-500">${body}</p>
    ${withActions ? `<div class="mt-4 flex justify-center gap-2">
      <button type="button" data-act="new-sale" class="btn-primary">Record a sale</button>
      <button type="button" data-act="sample" class="btn-secondary">Load sample data</button></div>` : ''}
  </li>`;
}

function renderRegister() {
  const all = ui.batch === 'all';
  let base = all ? db.txns.filter((t) => balOf(t) > 0) : db.txns.filter((t) => t.month === ui.month && t.batch === ui.batch);
  const q = ui.q.trim().toLowerCase();
  if (q) base = base.filter((t) => custName(t.customerId).toLowerCase().includes(q) || t.cutLabel.toLowerCase().includes(q));

  if (all && ui.filter === 'paid') ui.filter = 'all';
  const counts = { all: base.length, unpaid: 0, partial: 0, paid: 0 };
  base.forEach((t) => counts[statusOf(t)]++);
  const filters = [['all', 'All'], ['unpaid', 'Unpaid'], ['partial', 'With Balance'], ...(all ? [] : [['paid', 'Fully Paid']])];
  $('#reg-filters').innerHTML = filters
    .map(([k, l]) => `<button type="button" class="chip" data-act="filter" data-f="${k}" aria-pressed="${ui.filter === k}">${l} <span class="opacity-60">${counts[k]}</span></button>`)
    .join('');

  const list = ui.filter === 'all' ? base : base.filter((t) => statusOf(t) === ui.filter);
  $('#register-title').textContent = all ? 'All Active Debts' : 'Sales Register';
  $('#register-sub').textContent = all ? 'Unpaid sales from every batch' : `Batch ${ui.batch} · ${batchRange(ui.month, ui.batch)}`;

  const el = $('#txn-list');
  if (!db.txns.length) {
    el.innerHTML = emptyState('No sales yet', 'Tap the red ＋ button to record your first sale.', true);
    return;
  }
  if (!list.length) {
    el.innerHTML = all
      ? emptyState('No active debts 🎉', 'Every customer is fully paid.')
      : emptyState(q || ui.filter !== 'all' ? 'No matching sales' : `No sales in Batch ${ui.batch} yet`,
          q || ui.filter !== 'all' ? 'Try a different search or filter.' : `${batchRange(ui.month, ui.batch)} · tap ＋ to add one.`);
    return;
  }

  if (all) {
    // Group open debts by batch, newest batch first.
    const groups = new Map();
    for (const t of [...list].sort(byOldest).reverse()) {
      const k = batchSortKey(t.month, t.batch);
      if (!groups.has(k)) groups.set(k, { month: t.month, batch: t.batch, items: [] });
      groups.get(k).items.push(t);
    }
    el.innerHTML = [...groups.values()]
      .map((g) => {
        const sum = g.items.reduce((s, t) => s + balOf(t), 0);
        return `<li class="flex items-center justify-between px-1 pt-2 text-xs font-semibold text-stone-500">
            <span>Batch ${g.batch} · ${batchRange(g.month, g.batch)}, ${parseMonth(g.month)[0]}</span>
            <span class="text-red-700">${fmt(sum)} unpaid</span></li>` + g.items.map(txnCard).join('');
      })
      .join('');
  } else {
    el.innerHTML = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(txnCard).join('');
  }
}

// ───────────────────────── Render: Customer Ledgers ─────────────────────────
function breakdownChips(id) {
  return custBreakdown(id)
    .map((g) => `<span class="rounded-lg bg-stone-100 px-2 py-1 text-[11px] text-stone-600 tabular-nums">${batchShort(g.month, g.batch)} <b class="text-stone-900">${fmt(g.amount)}</b></span>`)
    .join('');
}

function custCard(c) {
  const debt = custDebt(c.id);
  const bd = custBreakdown(c.id);
  const st = custStatus(c.id);
  const last = lastActivity(c.id);
  return `<li><article class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-200">
    <button type="button" data-act="cust-detail" data-id="${c.id}" class="block w-full text-left">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-full bg-red-100 font-bold text-red-700" aria-hidden="true">${esc(c.name.trim()[0]?.toUpperCase() ?? '?')}</span>
          <div class="min-w-0">
            <h3 class="truncate font-bold">${esc(c.name)}</h3>
            <p class="text-xs text-stone-500">${last ? `Last activity ${fmtDay(last)}` : 'No activity'}</p>
          </div>
        </div>
        ${badge(st)}
      </div>
      <div class="mt-3 flex items-end justify-between gap-2">
        <div>
          <p class="text-[10px] font-semibold text-stone-500 uppercase">Total balance</p>
          <p class="text-2xl font-extrabold tabular-nums ${debt ? 'text-red-700' : 'text-emerald-700'}">${fmt(debt)}</p>
        </div>
        ${bd.length > 1 ? `<p class="flex items-center gap-1 text-xs font-semibold text-amber-700">${ICON_ROLL} Rolled over · ${bd.length} batches</p>` : ''}
      </div>
      ${bd.length ? `<div class="mt-2 flex flex-wrap gap-1.5">${breakdownChips(c.id)}</div>` : ''}
    </button>
    <div class="mt-3 flex justify-end gap-2">
      <button type="button" data-act="new-sale" data-name="${esc(c.name)}" class="rounded-xl bg-stone-100 px-3.5 py-2 text-sm font-bold text-stone-700 hover:bg-stone-200">＋ Sale</button>
      ${debt > 0 ? `<button type="button" data-act="collect" data-cid="${c.id}" class="btn-collect">${ICON_CASH} Collect Payment</button>` : ''}
    </div>
  </article></li>`;
}

function renderLedgers() {
  const q = ui.lq.trim().toLowerCase();
  let rows = db.customers.map((c) => ({ c, debt: custDebt(c.id), last: lastActivity(c.id) }));
  const owing = rows.filter((r) => r.debt > 0).length;
  $('#led-filters').innerHTML = [['debt', `With balance ${owing}`], ['all', `All ${rows.length}`]]
    .map(([k, l]) => `<button type="button" class="chip" data-act="lfilter" data-f="${k}" aria-pressed="${ui.lfilter === k}">${l}</button>`)
    .join('');
  $('#led-sort').value = ui.lsort;
  $('#ledger-sub').textContent = `${fmt(totalReceivables())} total receivables`;

  if (ui.lfilter === 'debt') rows = rows.filter((r) => r.debt > 0);
  if (q) rows = rows.filter((r) => r.c.name.toLowerCase().includes(q));
  const sorters = {
    debt: (a, b) => b.debt - a.debt || a.c.name.localeCompare(b.c.name),
    recent: (a, b) => b.last.localeCompare(a.last),
    name: (a, b) => a.c.name.localeCompare(b.c.name),
  };
  rows.sort(sorters[ui.lsort] ?? sorters.debt);

  const el = $('#cust-list');
  if (!db.customers.length) el.innerHTML = emptyState('No customers yet', 'Customers are added automatically when you record a sale.', true);
  else if (!rows.length) el.innerHTML = emptyState(ui.lfilter === 'debt' && !q ? 'Nobody owes you 🎉' : 'No matching customers', ui.lfilter === 'debt' && !q ? 'All customer balances are cleared.' : 'Try another name.');
  else el.innerHTML = rows.map((r) => custCard(r.c)).join('');
}

// ───────────────────────── Render root ─────────────────────────
function render() {
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.dataset.tab === ui.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('#view-register').hidden = ui.tab !== 'register';
  $('#view-ledgers').hidden = ui.tab !== 'ledgers';
  renderPeriod();
  renderSummary();
  if (ui.tab === 'register') renderRegister();
  else renderLedgers();
  refreshDetail();
  saveUi();
}

// ───────────────────────── Dialog plumbing ─────────────────────────
const saleDlg = $('#sale-dialog');
const payDlg = $('#pay-dialog');
const detailDlg = $('#detail-dialog');
const menuDlg = $('#menu-dialog');
const sbDlg = $('#supabase-dialog');

// Light-dismiss fallback for browsers without <dialog closedby> (e.g. Safari).
if (!('closedBy' in HTMLDialogElement.prototype)) {
  for (const d of [payDlg, detailDlg, menuDlg, sbDlg]) {
    d.addEventListener('click', (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) d.close();
    });
  }
}
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog')?.close();
});

// ───────────────────────── New Sale form ─────────────────────────
const sf = $('#sale-form');
const F = sf.elements;

$('#f-cuts').innerHTML = CUTS.map(
  (c) => `<label class="cut-opt">
    <input type="radio" name="cut" value="${c.id}" class="sr-only">
    <span class="text-sm font-bold">${c.emoji} ${c.label}</span>
    <span class="text-[11px] text-stone-500" data-cut-price="${c.id}"></span>
  </label>`,
).join('');

const priceFor = (cut) => db.prices[cut] ?? cutDef(cut).price * 100;

function fillPeriodSelects(month, batch) {
  const months = [];
  for (let i = -6; i <= 1; i++) months.push(shiftMonth(monthKey(new Date()), i));
  if (!months.includes(month)) months.push(month);
  months.sort();
  F.month.innerHTML = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  F.month.value = month;
  fillBatchSelect(batch);
}
function fillBatchSelect(batch) {
  F.batch.innerHTML = [1, 2, 3, 4].map((b) => `<option value="${b}">Batch ${b} (${batchRange(F.month.value, b)})</option>`).join('');
  F.batch.value = String(batch);
}

function setCut(id) {
  sf.querySelector(`input[name="cut"][value="${id}"]`).checked = true;
  onCutChange();
}
function onCutChange() {
  const cut = F.cut.value;
  $('#f-custom').hidden = cut !== 'custom';
  const p = priceFor(cut);
  F.price.value = p ? (p / 100).toString() : '';
  if (cut === 'custom') F.customCut.focus();
  updateSale();
}

function renderCustomerOptions() {
  $('#customer-list').innerHTML = [...db.customers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${esc(c.name)}">${custDebt(c.id) ? `Balance ${fmt(custDebt(c.id))}` : ''}</option>`)
    .join('');
  const recent = [...db.customers].sort((a, b) => lastActivity(b.id).localeCompare(lastActivity(a.id))).slice(0, 8);
  $('#f-recent').innerHTML = recent.length
    ? `<span class="shrink-0 self-center text-[11px] text-stone-400">Recent:</span>` +
      recent.map((c) => `<button type="button" class="chip" data-pick="${esc(c.name)}">${esc(c.name)}</button>`).join('')
    : '';
}

function readSale() {
  const name = F.customer.value.trim().replace(/\s+/g, ' ');
  const cut = F.cut.value;
  const customName = F.customCut.value.trim();
  const weight = Math.round((parseFloat(F.weight.value) || 0) * 1000) / 1000;
  const price = toCents(F.price.value);
  const total = Math.round(weight * price);
  const payType = F.payType.value;
  const cash = toCents(F.cash.value);
  const tendered = toCents(F.tendered.value);
  const initial = payType === 'cash' ? total : payType === 'credit' ? 0 : Math.min(cash, total);
  const errors = [];
  if (!name) errors.push(['Enter the customer name', F.customer]);
  if (cut === 'custom' && !customName) errors.push(['Enter the custom cut name', F.customCut]);
  if (weight <= 0) errors.push(['Enter the weight in kg', F.weight]);
  if (price <= 0) errors.push(['Enter the price per kg', F.price]);
  if (payType === 'partial' && total > 0) {
    if (cash <= 0) errors.push(['Enter the downpayment received (or choose Full Credit)', F.cash]);
    else if (cash >= total) errors.push(['Downpayment covers the full price — choose Cash (Full)', F.cash]);
  }
  return {
    name, cut, customName, weight, price, total, payType, cash, tendered, initial,
    balance: total - initial, cust: findCustByName(name),
    month: F.month.value, batch: Number(F.batch.value), note: F.note.value.trim(), errors,
  };
}

function updateSale() {
  const s = readSale();
  $('#f-total').textContent = fmt(s.total);
  CUTS.forEach((c) => {
    const p = priceFor(c.id);
    sf.querySelector(`[data-cut-price="${c.id}"]`).textContent = p ? `${fmt(p)}/kg` : 'Set your price';
  });
  sf.querySelectorAll('[data-kg]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.kg === s.weight)));

  // Partial payment box
  $('#f-partial').hidden = s.payType !== 'partial';
  const pm = $('#f-partial-msg');
  if (s.payType === 'partial') {
    if (!s.total) pm.innerHTML = '<span class="text-stone-500">Enter weight and price first.</span>';
    else if (s.cash >= s.total) pm.innerHTML = '<span class="font-semibold text-red-700">That covers the full price — choose Cash (Full) instead.</span>';
    else pm.innerHTML = `Remaining balance: <b class="text-lg text-red-700 tabular-nums">${fmt(s.total - s.cash)}</b>`;
  }

  // Cash change box
  $('#f-cashbox').hidden = s.payType !== 'cash';
  const ch = $('#f-change');
  if (s.payType === 'cash' && s.tendered) {
    ch.innerHTML = s.tendered >= s.total
      ? `Change: <b class="text-lg text-emerald-700 tabular-nums">${fmt(s.tendered - s.total)}</b>`
      : `<span class="font-semibold text-red-700">Short by ${fmt(s.total - s.tendered)} — use Downpayment instead?</span>`;
  } else ch.textContent = '';

  // Customer info + rollover preview
  const info = $('#f-cust-info');
  const roll = $('#f-rollover');
  if (!s.name) { info.innerHTML = ''; roll.innerHTML = ''; return; }
  if (!s.cust) {
    info.innerHTML = `<p class="text-xs font-semibold text-sky-700">✨ New customer — will be added to your ledger.</p>`;
  } else {
    const debt = custDebt(s.cust.id);
    info.innerHTML = debt
      ? `<div class="rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
          <p class="flex items-center justify-between gap-2"><span class="font-semibold text-amber-900">Existing balance</span><b class="tabular-nums text-red-700">${fmt(debt)}</b></p>
          <div class="mt-1.5 flex flex-wrap gap-1.5">${breakdownChips(s.cust.id)}</div></div>`
      : `<p class="text-xs font-semibold text-emerald-700">✓ ${esc(s.cust.name)} has no outstanding balance.</p>`;
  }
  const prev = s.cust ? custDebt(s.cust.id) : 0;
  if (s.total && s.balance > 0) {
    roll.innerHTML = `<div class="rounded-2xl bg-red-50 p-4 ring-1 ring-red-200">
      <p class="flex items-center gap-1.5 text-xs font-bold text-red-800 uppercase">${ICON_ROLL} Credit rollover</p>
      <dl class="mt-2 space-y-1 text-sm tabular-nums">
        <div class="flex justify-between"><dt class="text-stone-600">Previous balance</dt><dd>${fmt(prev)}</dd></div>
        <div class="flex justify-between"><dt class="text-stone-600">+ Unpaid from this sale</dt><dd>${fmt(s.balance)}</dd></div>
        <div class="flex justify-between border-t border-red-200 pt-1 text-base font-extrabold text-red-800"><dt>New total debt</dt><dd>${fmt(prev + s.balance)}</dd></div>
      </dl></div>`;
  } else roll.innerHTML = '';
}

function openSale(prefillName = '') {
  sf.reset();
  const period = ui.batch === 'all' ? { month: monthKey(new Date()), batch: batchOfDate(new Date()) } : { month: ui.month, batch: ui.batch };
  fillPeriodSelects(period.month, period.batch);
  renderCustomerOptions();
  F.customer.value = prefillName;
  setCut('liempo');
  saleDlg.showModal();
  (prefillName ? F.weight : F.customer).focus();
}

function commitSale(keepOpen) {
  const s = readSale();
  if (s.errors.length) {
    const [msg, el] = s.errors[0];
    toast(msg, 'error');
    el.focus();
    return;
  }
  let c = s.cust;
  if (!c) {
    c = { id: uid(), name: s.name, createdAt: new Date().toISOString() };
    db.customers.push(c);
  }
  if (s.cut !== 'custom') db.prices[s.cut] = s.price;
  const at = new Date().toISOString();
  const t = {
    id: uid(), customerId: c.id, month: s.month, batch: s.batch, createdAt: at,
    cut: s.cut, cutLabel: s.cut === 'custom' ? s.customName : cutDef(s.cut).label,
    weight: s.weight, price: s.price, total: s.total, payType: s.payType, note: s.note, payments: [],
  };
  if (s.initial > 0) t.payments.push({ id: uid(), ref: uid(), amount: s.initial, at, kind: 'initial' });
  db.txns.push(t);
  save();

  const debt = custDebt(c.id);
  toast(debt ? `Saved · ${c.name} now owes ${fmt(debt)}` : `Saved · ${fmt(s.total)} paid in full`, debt ? 'info' : 'success');
  if (ui.tab === 'register' && ui.batch !== 'all') { ui.month = s.month; ui.batch = s.batch; }
  render();

  if (keepOpen) {
    // Same customer & batch, next cut.
    F.weight.value = ''; F.cash.value = ''; F.tendered.value = ''; F.note.value = ''; F.customCut.value = '';
    sf.querySelector('input[name="payType"][value="cash"]').checked = true;
    renderCustomerOptions();
    setCut(s.cut === 'custom' ? 'liempo' : s.cut);
    F.weight.focus();
  } else saleDlg.close();
}

sf.addEventListener('input', (e) => {
  if (e.target.name === 'cut') return onCutChange();
  if (e.target === F.month) fillBatchSelect(F.batch.value);
  updateSale();
});
sf.addEventListener('change', (e) => { if (e.target.name === 'payType') updateSale(); });
sf.addEventListener('submit', (e) => { e.preventDefault(); commitSale(false); });
$('#f-save-more').addEventListener('click', () => commitSale(true));
sf.addEventListener('click', (e) => {
  const kgBtn = e.target.closest('[data-kg]');
  if (kgBtn) { F.weight.value = kgBtn.dataset.kg; updateSale(); }
  const pick = e.target.closest('[data-pick]');
  if (pick) { F.customer.value = pick.dataset.pick; updateSale(); F.weight.focus(); }
});

// ───────────────────────── Collect Payment ─────────────────────────
let payCtx = null;
const pf = $('#pay-form');
const pAmount = $('#p-amount');

function openPay(customerId, txnId = null) {
  const debt = custDebt(customerId);
  if (debt <= 0) return toast('No balance to collect — already fully paid.', 'success');
  payCtx = { customerId, txnId };
  const t = txnId ? db.txns.find((x) => x.id === txnId) : null;
  const bd = custBreakdown(customerId);
  $('#p-head').innerHTML = `
    <div class="rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200">
      <p class="font-bold">${esc(custName(customerId))}</p>
      ${t ? `<p class="mt-0.5 text-sm text-stone-500">${esc(t.cutLabel)} · ${batchShort(t.month, t.batch)} — item balance <b class="text-stone-800">${fmt(balOf(t))}</b></p>` : ''}
      <p class="mt-2 flex items-baseline justify-between"><span class="text-sm text-stone-600">Total owed (all batches)</span><b class="text-xl text-red-700 tabular-nums">${fmt(debt)}</b></p>
      ${bd.length > 1 ? `<div class="mt-2 flex flex-wrap gap-1.5">${breakdownChips(customerId)}</div>` : ''}
    </div>`;
  const quick = [];
  if (t && balOf(t) < debt) quick.push([`This item ${fmt(balOf(t))}`, balOf(t)]);
  quick.push([`Full balance ${fmt(debt)}`, debt]);
  [10000, 20000, 50000, 100000].filter((v) => v < debt).forEach((v) => quick.push([fmt(v).replace('.00', ''), v]));
  $('#p-quick').innerHTML = quick.map(([l, v]) => `<button type="button" class="chip" data-amt="${v}">${l}</button>`).join('');
  pAmount.value = '';
  updatePay();
  payDlg.showModal();
  pAmount.focus();
}

function updatePay() {
  if (!payCtx) return;
  const amt = toCents(pAmount.value);
  const { plan, change, applied } = allocate(payCtx.customerId, amt, payCtx.txnId);
  $('#p-quick').querySelectorAll('[data-amt]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.amt === amt)));
  const btn = $('#p-submit');
  btn.disabled = amt <= 0;
  btn.textContent = amt > 0 ? `Record ${fmt(applied)}` : 'Record Payment';
  if (amt <= 0) { $('#p-preview').innerHTML = ''; return; }
  const remaining = custDebt(payCtx.customerId) - applied;
  $('#p-preview').innerHTML = `
    <p class="label">Applied to (oldest first)</p>
    <ul class="divide-y divide-stone-100 rounded-2xl ring-1 ring-stone-200">
      ${plan.map(({ t, a, clears }) => `<li class="flex items-center justify-between gap-2 px-3 py-2 text-sm">
        <span class="min-w-0"><span class="block truncate font-semibold">${esc(t.cutLabel)} · ${kg(t.weight)}</span>
        <span class="text-xs text-stone-500">${batchShort(t.month, t.batch)} · ${fmtDay(t.createdAt)}</span></span>
        <span class="shrink-0 text-right tabular-nums"><b>${fmt(a)}</b><br>
        ${clears ? '<span class="text-xs font-semibold text-emerald-700">✓ Cleared</span>' : `<span class="text-xs text-amber-700">${fmt(balOf(t) - a)} left</span>`}</span>
      </li>`).join('')}
    </ul>
    <div class="mt-3 space-y-2">
      ${remaining === 0
        ? `<p class="rounded-xl bg-emerald-50 px-3 py-2 text-center font-bold text-emerald-800 ring-1 ring-emerald-200">🎉 Account will be Fully Paid</p>`
        : `<p class="flex justify-between rounded-xl bg-amber-50 px-3 py-2 text-sm ring-1 ring-amber-200"><span>Remaining balance after</span><b class="tabular-nums text-red-700">${fmt(remaining)}</b></p>`}
      ${change > 0 ? `<p class="flex justify-between rounded-xl bg-sky-50 px-3 py-2 text-sm ring-1 ring-sky-200"><span>Change to give back</span><b class="tabular-nums text-sky-800">${fmt(change)}</b></p>` : ''}
    </div>`;
}

pAmount.addEventListener('input', updatePay);
$('#p-quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-amt]');
  if (b) { pAmount.value = (+b.dataset.amt / 100).toString(); updatePay(); }
});
pf.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!payCtx) return;
  const amt = toCents(pAmount.value);
  if (amt <= 0) return toast('Enter the amount received', 'error');
  const { plan, applied, change } = allocate(payCtx.customerId, amt, payCtx.txnId);
  const ref = uid();
  const at = new Date().toISOString();
  plan.forEach(({ t, a }) => t.payments.push({ id: uid(), ref, amount: a, at, kind: 'collection' }));
  save();
  const name = custName(payCtx.customerId);
  const remaining = custDebt(payCtx.customerId);
  payDlg.close();
  render();
  const chg = change ? ` · Give change ${fmt(change)}` : '';
  toast(remaining ? `Collected ${fmt(applied)} from ${name} · ${fmt(remaining)} left${chg}` : `🎉 ${name} is now Fully Paid!${chg}`, 'success');
});
payDlg.addEventListener('close', () => (payCtx = null));

// ───────────────────────── Detail dialogs ─────────────────────────
let detailCtx = null;
detailDlg.addEventListener('close', () => (detailCtx = null));

const detailHeader = (title, sub = '') => `
  <header class="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
    <div class="min-w-0"><h2 id="detail-title" class="truncate text-lg font-bold">${title}</h2>${sub ? `<p class="text-xs text-stone-500">${sub}</p>` : ''}</div>
    <button type="button" data-close class="grid size-9 shrink-0 place-items-center rounded-full bg-stone-100 text-stone-600 hover:bg-stone-200" aria-label="Close">✕</button>
  </header>`;

function openDetail(type, id) {
  detailCtx = { type, id };
  refreshDetail();
  if (!detailDlg.open) detailDlg.showModal();
  detailDlg.querySelector('.overflow-y-auto')?.scrollTo(0, 0);
}

function refreshDetail() {
  if (!detailCtx) return;
  const body = $('#detail-body');
  if (detailCtx.type === 'txn') {
    const t = db.txns.find((x) => x.id === detailCtx.id);
    if (!t) return detailDlg.close();
    body.innerHTML = txnDetailHtml(t);
  } else {
    const c = custById(detailCtx.id);
    if (!c) return detailDlg.close();
    body.innerHTML = custDetailHtml(c);
  }
}

function txnDetailHtml(t) {
  const b = balOf(t);
  const debt = custDebt(t.customerId);
  const payLabel = { cash: 'Cash (Full)', credit: 'Full Credit', partial: 'Credit with Downpayment' }[t.payType] ?? '';
  return `${detailHeader(esc(custName(t.customerId)), `Batch ${t.batch} · ${batchRange(t.month, t.batch)} · ${fmtDate(t.createdAt)}`)}
  <div class="relative flex-1 min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
    <div class="flex items-start justify-between gap-3">
      <div><p class="text-lg font-bold">${cutDef(t.cut).emoji} ${esc(t.cutLabel)}</p>
      <p class="text-sm text-stone-500">${kg(t.weight)} × ${fmt(t.price)}/kg · ${payLabel}</p>
      ${t.note ? `<p class="mt-1 text-sm text-stone-600 italic">“${esc(t.note)}”</p>` : ''}</div>
      ${badge(statusOf(t))}
    </div>
    <dl class="grid grid-cols-3 gap-2 rounded-2xl bg-stone-50 p-3 text-center tabular-nums ring-1 ring-stone-200">
      <div><dt class="text-[10px] font-semibold text-stone-500 uppercase">Total</dt><dd class="font-bold">${fmt(t.total)}</dd></div>
      <div><dt class="text-[10px] font-semibold text-stone-500 uppercase">Paid</dt><dd class="font-bold text-emerald-700">${fmt(paidOf(t))}</dd></div>
      <div><dt class="text-[10px] font-semibold text-stone-500 uppercase">Balance</dt><dd class="font-bold ${b ? 'text-red-700' : 'text-stone-400'}">${fmt(b)}</dd></div>
    </dl>
    <button type="button" data-act="cust-detail" data-id="${t.customerId}" class="flex w-full items-center justify-between rounded-2xl bg-amber-50 px-4 py-3 text-left text-sm ring-1 ring-amber-200 hover:bg-amber-100">
      <span><span class="block text-xs text-amber-800">Customer's total balance (all batches)</span><b class="text-base tabular-nums text-red-700">${fmt(debt)}</b></span>
      <span class="text-xs font-semibold text-amber-900">View ledger ›</span>
    </button>
    <div>
      <p class="label">Payment history</p>
      ${t.payments.length ? `<ul class="divide-y divide-stone-100 rounded-2xl ring-1 ring-stone-200">
        ${[...t.payments].sort((a, b) => a.at.localeCompare(b.at)).map((p) => `<li class="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
          <span><b class="tabular-nums text-emerald-700">${fmt(p.amount)}</b>
          <span class="block text-xs text-stone-500">${p.kind === 'initial' ? (t.payType === 'cash' ? 'Paid at purchase' : 'Downpayment') : 'Collected'} · ${fmtDate(p.at)}</span></span>
          <button type="button" data-act="void-pay" data-tid="${t.id}" data-pid="${p.id}" class="rounded-lg px-2 py-1 text-xs font-semibold text-stone-400 hover:bg-red-50 hover:text-red-700">Void</button>
        </li>`).join('')}</ul>`
      : '<p class="rounded-2xl bg-stone-50 px-3 py-3 text-sm text-stone-500 ring-1 ring-stone-200">No payments yet.</p>'}
    </div>
    <button type="button" data-act="delete-txn" data-id="${t.id}" class="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50">Delete this sale</button>
  </div>
  ${b > 0 ? `<footer class="border-t border-stone-200 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
    <button type="button" data-act="collect" data-cid="${t.customerId}" data-tid="${t.id}" class="btn-success w-full">Collect Payment · ${fmt(b)} due</button></footer>` : ''}`;
}

/** Chronological ledger entries with running balance. Collections spanning several items are merged by ref. */
function statement(customerId) {
  const entries = [];
  const refs = new Map();
  for (const t of custTxns(customerId)) {
    entries.push({ at: t.createdAt, order: 0, kind: 'sale', label: `${t.cutLabel} ${kg(t.weight)} @ ${fmt(t.price)}`, batch: batchShort(t.month, t.batch), amt: t.total });
    for (const p of t.payments) {
      const key = p.ref ?? p.id;
      if (refs.has(key)) { refs.get(key).amt -= p.amount; refs.get(key).items++; continue; }
      const e = { at: p.at, order: 1, kind: 'pay', label: p.kind === 'initial' ? (t.payType === 'cash' ? 'Cash payment' : 'Downpayment') : 'Payment collected', amt: -p.amount, items: 1 };
      refs.set(key, e);
      entries.push(e);
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  let run = 0;
  for (const e of entries) { run += e.amt; e.run = run; }
  return entries;
}

function custDetailHtml(c) {
  const debt = custDebt(c.id);
  const bd = custBreakdown(c.id);
  const open = custTxns(c.id).filter((t) => balOf(t) > 0);
  const st = statement(c.id);
  return `${detailHeader(esc(c.name), `Customer since ${fmtDay(c.createdAt)} · ${custTxns(c.id).length} purchases`)}
  <div class="relative flex-1 min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
    <div class="rounded-2xl p-4 ring-1 ${debt ? 'bg-red-50 ring-red-200' : 'bg-emerald-50 ring-emerald-200'}">
      <div class="flex items-center justify-between gap-2">
        <p class="text-xs font-semibold uppercase ${debt ? 'text-red-800' : 'text-emerald-800'}">Total balance</p>${badge(custStatus(c.id))}
      </div>
      <p class="mt-1 text-3xl font-extrabold tabular-nums ${debt ? 'text-red-700' : 'text-emerald-700'}">${fmt(debt)}</p>
      ${bd.length ? `<p class="mt-3 flex items-center gap-1 text-xs font-semibold text-stone-600">${ICON_ROLL} Rolled-over balance by batch</p>
        <div class="mt-1.5 space-y-1">${bd.map((g) => `<div class="flex items-center gap-2 text-sm">
          <span class="w-28 shrink-0 text-stone-600">${batchShort(g.month, g.batch)} ${parseMonth(g.month)[0]}</span>
          <span class="h-2 flex-1 overflow-hidden rounded-full bg-white"><span class="block h-full rounded-full bg-red-400" style="width:${Math.max(6, Math.round((g.amount / debt) * 100))}%"></span></span>
          <b class="w-24 shrink-0 text-right tabular-nums">${fmt(g.amount)}</b></div>`).join('')}</div>` : ''}
    </div>
    <div class="grid grid-cols-3 gap-2">
      <button type="button" data-act="new-sale" data-name="${esc(c.name)}" class="btn-secondary px-2">＋ Sale</button>
      <button type="button" data-act="share" data-id="${c.id}" class="btn-secondary px-2">Share</button>
      <button type="button" data-act="rename" data-id="${c.id}" class="btn-secondary px-2">Rename</button>
    </div>
    ${open.length ? `<div><p class="label">Unpaid items (${open.length})</p>
      <ul class="space-y-2">${open.map((t) => `<li><button type="button" data-act="txn-detail" data-id="${t.id}" class="flex w-full items-center justify-between gap-2 rounded-xl bg-white px-3 py-2.5 text-left text-sm ring-1 ring-stone-200 hover:bg-stone-50">
        <span class="min-w-0"><span class="block truncate font-semibold">${esc(t.cutLabel)} · ${kg(t.weight)}</span>
        <span class="text-xs text-stone-500">${batchShort(t.month, t.batch)} · ${fmtDay(t.createdAt)} · of ${fmt(t.total)}</span></span>
        <span class="flex shrink-0 flex-col items-end gap-1"><b class="tabular-nums text-red-700">${fmt(balOf(t))}</b>${badge(statusOf(t))}</span>
      </button></li>`).join('')}</ul></div>` : ''}
    <div><p class="label">Statement of account</p>
      ${st.length ? `<ol class="divide-y divide-stone-100 rounded-2xl ring-1 ring-stone-200">${st.map((e) => `<li class="flex items-center justify-between gap-2 px-3 py-2 text-sm">
        <span class="min-w-0"><span class="block truncate ${e.kind === 'pay' ? 'text-emerald-800' : ''}">${e.kind === 'pay' ? '💵 ' : ''}${esc(e.label)}${e.items > 1 ? ` <span class="text-xs text-stone-400">(${e.items} items)</span>` : ''}</span>
        <span class="text-xs text-stone-400">${fmtDate(e.at)}${e.batch ? ` · ${e.batch}` : ''}</span></span>
        <span class="shrink-0 text-right tabular-nums"><span class="block font-semibold ${e.kind === 'pay' ? 'text-emerald-700' : ''}">${e.amt < 0 ? '−' : '+'}${fmt(Math.abs(e.amt))}</span>
        <span class="text-xs text-stone-400">Bal ${fmt(e.run)}</span></span>
      </li>`).join('')}</ol>` : '<p class="text-sm text-stone-500">No transactions yet.</p>'}
    </div>
  </div>
  ${debt > 0 ? `<footer class="border-t border-stone-200 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
    <button type="button" data-act="collect" data-cid="${c.id}" class="btn-success w-full">Collect Payment · ${fmt(debt)} owed</button></footer>` : ''}`;
}

async function shareStatement(id) {
  const c = custById(id);
  const lines = [
    `STATEMENT OF ACCOUNT`,
    `Customer: ${c.name}`,
    `As of: ${new Date().toLocaleDateString('en-PH', { dateStyle: 'medium' })}`,
    '',
    ...statement(id).map((e) => `${fmtDay(e.at)}  ${e.kind === 'pay' ? 'PAYMENT' : e.label}${e.batch ? ` [${e.batch}]` : ''}  ${e.amt < 0 ? '-' : '+'}${fmt(Math.abs(e.amt))}  = ${fmt(e.run)}`),
    '',
    ...custBreakdown(id).map((g) => `  ${batchShort(g.month, g.batch)} ${parseMonth(g.month)[0]}: ${fmt(g.amount)}`),
    `TOTAL BALANCE: ${fmt(custDebt(id))}`,
    '— Salamat po!',
  ];
  const text = lines.join('\n');
  try {
    if (navigator.share) await navigator.share({ title: `Statement – ${c.name}`, text });
    else { await navigator.clipboard.writeText(text); toast('Statement copied — paste it in Messenger/SMS', 'success'); }
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Could not share on this browser', 'error');
  }
}

// ───────────────────────── Menu: backup / sample / reset ─────────────────────────
function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'karnehan-pos', version: 1, exportedAt: new Date().toISOString(), ...db }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `karnehan-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded', 'success');
}

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.txns) || !Array.isArray(d.customers)) throw new Error('bad');
    if (!confirm(`Replace current data with backup?\n${d.customers.length} customers · ${d.txns.length} sales`)) return;
    db = { customers: d.customers, txns: d.txns, prices: d.prices ?? {} };
    save();
    menuDlg.close();
    render();
    toast('Backup restored', 'success');
  } catch {
    toast('That file is not a valid backup', 'error');
  }
});

function loadSample() {
  if (db.txns.length && !confirm('Add sample data on top of your existing records?')) return;
  const names = ['Aling Nena', 'Mang Tonyo', 'Carinderia ni Loleng', 'Kuya Jun (Lechonero)', 'Ate Baby', 'Sir Ramon'];
  const custs = names.map((n) => {
    let c = findCustByName(n);
    if (!c) { c = { id: uid(), name: n, createdAt: new Date(Date.now() - 40 * 864e5).toISOString() }; db.customers.push(c); }
    return c;
  });
  const now = new Date();
  let p = { month: monthKey(now), batch: batchOfDate(now) };
  const periods = [p];
  for (let i = 0; i < 3; i++) periods.unshift((p = prevBatch(p)));
  const dateIn = ({ month, batch }, dayOff, hour) => {
    const [y, m] = parseMonth(month);
    const [s, e] = batchDays(month, batch);
    const d = new Date(y, m - 1, Math.min(s + dayOff, e), hour, (dayOff * 17) % 60);
    return d > now ? new Date(now.getTime() - (10 - hour) * 6e5 - 6e4) : d;
  };
  // [customer, period, cut, kg, payType, cash₱, laterCollections₱[], customLabel, customPrice₱]
  const S = [
    [0, 0, 'liempo', 2, 'credit', 0, [400]],
    [1, 0, 'kasim', 1.5, 'cash'],
    [2, 0, 'pata', 3, 'partial', 300, []],
    [3, 1, 'ulo', 5, 'partial', 500, [300]],
    [0, 1, 'ribs', 1, 'credit', 0, []],
    [4, 1, 'pigue', 1.25, 'cash'],
    [2, 2, 'innards', 2, 'credit', 0, []],
    [5, 2, 'liempo', 1, 'cash'],
    [1, 2, 'kasim', 2, 'partial', 200, [440]],
    [0, 3, 'kasim', 1, 'partial', 100, []],
    [3, 3, 'liempo', 3, 'credit', 0, []],
    [4, 3, 'ribs', 0.75, 'cash'],
    [5, 3, 'custom', 1, 'credit', 0, [], 'Tuwalya (Tripe)', 220],
  ];
  S.forEach(([ci, pi, cut, w, type, cash = 0, later = [], label, cprice], i) => {
    const per = periods[pi];
    const at = dateIn(per, i % 4, 7 + (i % 3)).toISOString();
    const price = (cut === 'custom' ? cprice : cutDef(cut).price) * 100;
    const total = Math.round(w * price);
    const t = { id: uid(), customerId: custs[ci].id, month: per.month, batch: per.batch, createdAt: at, cut, cutLabel: label ?? cutDef(cut).label, weight: w, price, total, payType: type, note: '', payments: [] };
    const init = type === 'cash' ? total : type === 'partial' ? cash * 100 : 0;
    if (init) t.payments.push({ id: uid(), ref: uid(), amount: init, at, kind: 'initial' });
    later.forEach((amt) => {
      const nextPer = periods[Math.min(pi + 1, periods.length - 1)];
      t.payments.push({ id: uid(), ref: uid(), amount: amt * 100, at: dateIn(nextPer, 1, 16).toISOString(), kind: 'collection' });
    });
    db.txns.push(t);
  });
  save();
  menuDlg.close();
  render();
  toast('Sample data loaded — try “All Debts” and Customer Ledgers', 'success');
}

// ───────────────────────── Supabase Cloud Backup ─────────────────────────
const SB_CFG_KEY = 'karnehan-pos:supabase:cfg:v1';
const SB_LAST_KEY = 'karnehan-pos:supabase:last:v1';

const DEFAULT_SB_URL = 'https://pxfjvayzucpqljozpvna.supabase.co';
const DEFAULT_SB_KEY = 'sb_publishable_9JUOaxzxaJszZ-FhNwXq7w_bOqKtFYI';

const SQL_SCHEMA = `-- Configured in your Supabase project:
CREATE TABLE IF NOT EXISTS public.meat_pos_backups (
    id TEXT PRIMARY KEY DEFAULT 'current',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    data JSONB NOT NULL
);

ALTER TABLE public.meat_pos_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public select" ON public.meat_pos_backups FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON public.meat_pos_backups FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update" ON public.meat_pos_backups FOR UPDATE USING (true);`;

function loadSbCfg() {
  try {
    const saved = JSON.parse(localStorage.getItem(SB_CFG_KEY));
    if (saved && saved.url && saved.key) {
      return {
        url: saved.url,
        key: saved.key,
        autoSync: saved.autoSync ?? true,
      };
    }
  } catch {}
  return {
    url: DEFAULT_SB_URL,
    key: DEFAULT_SB_KEY,
    autoSync: true,
  };
}

let sbCfg = loadSbCfg();
let sbLastBackup = localStorage.getItem(SB_LAST_KEY) || null;

function saveSbCfg(cfg) {
  sbCfg = { ...sbCfg, ...cfg };
  localStorage.setItem(SB_CFG_KEY, JSON.stringify(sbCfg));
  renderSbStatus();
}

function renderSbStatus() {
  const isConfigured = Boolean(sbCfg.url && sbCfg.key);
  const badge = $('#sb-status-badge');
  const text = $('#sb-status-text');
  const lastSync = $('#sb-last-sync');
  const actions = $('#sb-actions');
  const quickBtn = $('#sb-backup-quick');

  if (isConfigured) {
    if (badge) {
      badge.textContent = 'Active';
      badge.className = 'rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 ring-1 ring-emerald-300';
    }
    if (text) {
      try {
        const host = new URL(sbCfg.url).hostname.split('.')[0];
        text.textContent = `Connected: ${host}`;
      } catch {
        text.textContent = 'Connected';
      }
    }
    if (actions) actions.hidden = false;
    if (quickBtn) quickBtn.disabled = false;
  } else {
    if (badge) {
      badge.textContent = 'Off';
      badge.className = 'rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600';
    }
    if (text) text.textContent = 'Not configured';
    if (actions) actions.hidden = true;
  }

  if (lastSync) {
    lastSync.textContent = sbLastBackup
      ? `Last cloud backup: ${fmtDate(sbLastBackup)}`
      : 'Last cloud backup: Never';
  }

  renderSaveStatus();
}

async function backupToSupabase(silent = false) {
  if (!sbCfg.url || !sbCfg.key) {
    if (!silent) toast('Please set up Supabase URL and Key first.', 'error');
    return false;
  }
  if (!navigator.onLine) {
    if (!silent) toast('Offline — cannot reach Supabase right now.', 'error');
    return false;
  }

  const endpoint = `${sbCfg.url.replace(/\/+$/, '')}/rest/v1/meat_pos_backups`;
  const snapshot = {
    app: 'karnehan-pos',
    version: 1,
    savedAt: new Date().toISOString(),
    device_name: navigator.userAgent.includes('Mobile') ? 'Mobile Phone' : 'Desktop POS',
    customer_count: db.customers.length,
    sale_count: db.txns.length,
    total_receivables: totalReceivables() / 100,
    customers: db.customers,
    txns: db.txns,
    prices: db.prices || {},
  };

  const nowIso = new Date().toISOString();
  const snapshotId = `backup-${Date.now()}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': sbCfg.key,
        'Authorization': `Bearer ${sbCfg.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        id: snapshotId,
        updated_at: nowIso,
        data: snapshot,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }

    // Keep 'current' record updated for fast sync/restore
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': sbCfg.key,
        'Authorization': `Bearer ${sbCfg.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        id: 'current',
        updated_at: nowIso,
        data: snapshot,
      }),
    }).catch(() => {});

    sbLastBackup = nowIso;
    localStorage.setItem(SB_LAST_KEY, sbLastBackup);
    renderSbStatus();
    if (!silent) toast('☁️ Backed up successfully to Supabase!', 'success');
    loadSbSnapshots();
    return true;
  } catch (err) {
    console.error('Supabase backup error:', err);
    if (!silent) toast(`Cloud backup failed: ${err.message || 'Network error'}`, 'error');
    return false;
  }
}

async function loadSbSnapshots() {
  const listEl = $('#sb-snapshots');
  const countBadge = $('#sb-count-badge');
  if (!listEl) return;

  if (!sbCfg.url || !sbCfg.key) {
    listEl.innerHTML = '<li class="text-xs text-stone-400 py-2">Set up credentials above to view cloud backups.</li>';
    if (countBadge) countBadge.textContent = '';
    return;
  }
  if (!navigator.onLine) {
    listEl.innerHTML = '<li class="text-xs text-stone-400 py-2">Device is offline. Connect to internet to view cloud backups.</li>';
    return;
  }

  listEl.innerHTML = '<li class="text-xs text-stone-500 py-2">Loading cloud backups…</li>';
  const endpoint = `${sbCfg.url.replace(/\/+$/, '')}/rest/v1/meat_pos_backups?select=id,updated_at,data&order=updated_at.desc&limit=15`;

  try {
    const res = await fetch(endpoint, {
      headers: {
        'apikey': sbCfg.key,
        'Authorization': `Bearer ${sbCfg.key}`,
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const displayRows = rows.filter((r) => r.id !== 'current');
    const finalRows = displayRows.length ? displayRows : rows;

    if (countBadge) countBadge.textContent = `${finalRows.length} snapshot${finalRows.length === 1 ? '' : 's'}`;

    if (!finalRows.length) {
      listEl.innerHTML = '<li class="text-xs text-stone-400 py-3 text-center rounded-xl bg-stone-100">No cloud backups found yet. Tap "Backup Now" above.</li>';
      return;
    }

    listEl.innerHTML = finalRows.map((r) => {
      const d = r.data || {};
      const dev = d.device_name || (r.id === 'current' ? 'Latest Sync' : 'POS Backup');
      const custs = d.customer_count ?? (d.customers?.length || 0);
      const sales = d.sale_count ?? (d.txns?.length || 0);
      const debt = d.total_receivables != null ? Number(d.total_receivables).toFixed(2) : '0.00';
      const timeStr = r.updated_at ? fmtDate(r.updated_at) : 'Recent';
      return `
        <li class="flex items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white p-3 text-xs">
          <div class="min-w-0">
            <p class="font-bold text-stone-800">${timeStr}</p>
            <p class="text-[11px] text-stone-500">${esc(dev)} · ${custs} customers · ${sales} sales · ₱${debt} debt</p>
          </div>
          <button type="button" data-act="sb-restore" data-id="${r.id}" class="rounded-lg bg-stone-100 px-3 py-1.5 font-bold text-stone-700 hover:bg-emerald-50 hover:text-emerald-800 active:scale-95">
            Restore
          </button>
        </li>
      `;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<li class="text-xs text-red-600 py-2">Could not load backups: ${esc(err.message)}</li>`;
  }
}

async function restoreFromSupabase(id) {
  if (!confirm('Restore this cloud backup? Your current local data will be replaced by the snapshot.')) return;

  const endpoint = `${sbCfg.url.replace(/\/+$/, '')}/rest/v1/meat_pos_backups?id=eq.${id}&select=data`;
  try {
    const res = await fetch(endpoint, {
      headers: {
        'apikey': sbCfg.key,
        'Authorization': `Bearer ${sbCfg.key}`,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length || !rows[0].data) throw new Error('Backup data missing');

    const d = rows[0].data;
    if (!Array.isArray(d.customers) || !Array.isArray(d.txns)) throw new Error('Invalid backup format');

    db = { customers: d.customers, txns: d.txns, prices: d.prices || {} };
    save();
    sbDlg.close();
    menuDlg.close();
    render();
    toast(`Restored cloud backup (${d.customers.length} customers, ${d.txns.length} sales)`, 'success');
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 'error');
  }
}

let autoBackupTimer;
function scheduleAutoBackup() {
  if (!sbCfg.url || !sbCfg.key || !sbCfg.autoSync || !navigator.onLine) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => {
    backupToSupabase(true);
  }, 4000);
}

// Supabase UI event wiring
$('#sb-open-cfg')?.addEventListener('click', () => {
  $('#sb-url').value = sbCfg.url || '';
  $('#sb-key').value = sbCfg.key || '';
  $('#sb-auto-sync').checked = Boolean(sbCfg.autoSync);
  const sqlCode = $('#sb-sql-code');
  if (sqlCode) sqlCode.textContent = SQL_SCHEMA;
  sbDlg.showModal();
  loadSbSnapshots();
});

$('#sb-backup-quick')?.addEventListener('click', () => {
  if (!sbCfg.url || !sbCfg.key) {
    $('#sb-open-cfg').click();
  } else {
    backupToSupabase(false);
  }
});

$('#sb-backup-btn')?.addEventListener('click', () => backupToSupabase(false));
$('#sb-refresh-btn')?.addEventListener('click', () => loadSbSnapshots());

$('#sb-copy-sql')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(SQL_SCHEMA);
    toast('SQL copied to clipboard!', 'success');
  } catch {
    toast('Could not copy automatically', 'error');
  }
});

$('#sb-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#sb-url').value.trim().replace(/\/+$/, '');
  const key = $('#sb-key').value.trim();
  const autoSync = $('#sb-auto-sync').checked;

  if (!url || !key) {
    toast('Please enter both Supabase URL and Key', 'error');
    return;
  }

  saveSbCfg({ url, key, autoSync });
  toast('Checking connection…', 'info');

  try {
    const res = await fetch(`${url}/rest/v1/meat_pos_backups?select=id&limit=1`, {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
    });

    if (res.ok) {
      toast('✓ Connected to Supabase!', 'success');
      loadSbSnapshots();
    } else {
      const errText = await res.text();
      toast(`Warning: HTTP ${res.status}. Check if table exists.`, 'error');
    }
  } catch (err) {
    toast(`Connection failed: ${err.message}`, 'error');
  }
});

// ───────────────────────── Global events ─────────────────────────
document.addEventListener('click', (e) => {
  const sbRestoreBtn = e.target.closest('[data-act="sb-restore"]');
  if (sbRestoreBtn) {
    restoreFromSupabase(sbRestoreBtn.dataset.id);
    return;
  }
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { ui.tab = tabBtn.dataset.tab; render(); window.scrollTo({ top: 0 }); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act } = el.dataset;
  switch (act) {
    case 'month-prev': ui.month = shiftMonth(ui.month, -1); break;
    case 'month-next': ui.month = shiftMonth(ui.month, 1); break;
    case 'batch': ui.batch = el.dataset.b === 'all' ? 'all' : Number(el.dataset.b); break;
    case 'filter': ui.filter = el.dataset.f; break;
    case 'lfilter': ui.lfilter = el.dataset.f; break;
    case 'new-sale': detailDlg.close(); menuDlg.close(); openSale(el.dataset.name ?? ''); return;
    case 'collect': openPay(el.dataset.cid, el.dataset.tid || null); return;
    case 'txn-detail': openDetail('txn', el.dataset.id); return;
    case 'cust-detail': openDetail('cust', el.dataset.id); return;
    case 'share': shareStatement(el.dataset.id); return;
    case 'rename': {
      const c = custById(el.dataset.id);
      const n = prompt('Rename customer', c.name)?.trim().replace(/\s+/g, ' ');
      if (!n || n === c.name) return;
      const clash = findCustByName(n);
      if (clash && clash.id !== c.id) return toast(`"${n}" already exists`, 'error');
      c.name = n; save(); break;
    }
    case 'void-pay': {
      const t = db.txns.find((x) => x.id === el.dataset.tid);
      const p = t?.payments.find((x) => x.id === el.dataset.pid);
      if (!p || !confirm(`Void this ${fmt(p.amount)} payment? The amount goes back to the customer's balance.`)) return;
      t.payments = t.payments.filter((x) => x.id !== p.id);
      save(); toast('Payment voided'); break;
    }
    case 'delete-txn': {
      const t = db.txns.find((x) => x.id === el.dataset.id);
      if (!t || !confirm(`Delete this ${t.cutLabel} sale (${fmt(t.total)}) for ${custName(t.customerId)}? This cannot be undone.`)) return;
      db.txns = db.txns.filter((x) => x.id !== t.id);
      save(); detailDlg.close(); toast('Sale deleted'); break;
    }
    case 'export': exportData(); return;
    case 'sample': loadSample(); return;
    case 'reset':
      if (!confirm('Erase ALL customers, sales and payments on this device?')) return;
      if (!confirm('Are you absolutely sure? Export a backup first if unsure.')) return;
      db = emptyDb(); save(); menuDlg.close(); toast('All data erased'); break;
    default: return;
  }
  render();
});

$('#fab').addEventListener('click', () => openSale());
$('#menu-btn').addEventListener('click', () => {
  const n = db.txns.length;
  const bytes = new Blob([localStorage.getItem(DB_KEY) ?? '']).size;
  $('#menu-stats').textContent = `${db.customers.length} customers · ${n} sales · ${(bytes / 1024).toFixed(1)} KB used`;
  menuDlg.showModal();
});
$('#reg-search').addEventListener('input', (e) => { ui.q = e.target.value; renderRegister(); });
$('#led-search').addEventListener('input', (e) => { ui.lq = e.target.value; renderLedgers(); });
$('#led-sort').addEventListener('change', (e) => { ui.lsort = e.target.value; render(); });

// Keep multiple tabs in sync.
window.addEventListener('storage', (e) => { if (e.key === DB_KEY) { db = loadDb(); render(); } });
window.addEventListener('online', () => { renderSaveStatus(); renderSbStatus(); });
window.addEventListener('offline', () => { renderSaveStatus(); renderSbStatus(); });

// ───────────────────────── Boot ─────────────────────────
render();
renderSaveStatus();
renderSbStatus();
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
