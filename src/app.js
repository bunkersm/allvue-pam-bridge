/*
 * Loan Event Bridge UI. Plain DOM rendering over a single state object that
 * is saved to this browser's localStorage. All business rules live in engine.js.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const S = window.SampleData;
  const STORE_KEY = 'loan-event-bridge:v10';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = E.formatMoney;
  const now = () => new Date().toISOString();
  const fmtTime = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const STATUS = {
    verified: { label: 'Clean, no IAS action', chip: 'c-auto', group: 'auto' },
    ready: { label: 'Clean, ready to approve', chip: 'c-auto', group: 'auto' },
    trade_feed: { label: 'Booked by trade feed', chip: 'c-trade', group: 'trades' },
    pending: { label: 'Needs review', chip: 'c-review', group: 'review' },
    failed: { label: 'Import failed', chip: 'c-exception', group: 'review' },
    exception: { label: 'Exception', chip: 'c-exception', group: 'exception' },
    approved: { label: 'Approved', chip: 'c-approved', group: 'approved' },
    auto_approved: { label: 'Auto-approved, units tie', chip: 'c-approved', group: 'approved' },
    in_batch: { label: 'In IAS file', chip: 'c-batch', group: 'batch' },
    loaded: { label: 'Loaded in IAS', chip: 'c-loaded', group: 'done' },
    closed: { label: 'Approved, nothing to send', chip: 'c-done', group: 'done' },
    rejected: { label: 'Rejected', chip: 'c-done', group: 'done' },
    manual: { label: 'Handled outside the app', chip: 'c-done', group: 'done' },
  };
  // Statuses set by the system from the detection route; anything else is a person's decision and survives a re-run.
  // A person putting an auto-approved paydown back for review sets hold, which also survives a re-run.
  const SYSTEM_STATUSES = new Set(['pending', 'exception', 'ready', 'trade_feed', 'auto_approved']);
  // Both kinds of approval go in the next IAS file.
  const isApproved = item => ['approved', 'auto_approved'].includes(statusOf(item));
  const autoApproveSettings = () => {
    const st = state.settings || {};
    return { paydowns: st.autoApprovePaydowns !== false, maxPct: st.autoPaydownMaxPct ?? null };
  };

  const GROUPS = [
    { id: 'review', label: 'Needs review', desc: 'Approve or reject', cls: 't-review' },
    { id: 'exception', label: 'Exceptions', desc: 'Data or setup to fix', cls: 't-exception' },
    { id: 'auto', label: 'Clean rollovers', desc: 'Verified, nothing to send', cls: 't-auto' },
    { id: 'trades', label: 'Trades', desc: 'Booked by the trade feed', cls: 't-trade' },
    { id: 'approved', label: 'Approved', desc: 'Waiting for an IAS file', cls: 't-approved' },
    { id: 'batch', label: 'Awaiting import', desc: 'In an IAS file', cls: 't-batch' },
    { id: 'done', label: 'Done', desc: 'Loaded, closed or rejected', cls: 't-done' },
    { id: 'all', label: 'All events', desc: 'Everything detected', cls: '' },
  ];

  const FEE_GROUPS = [
    { id: 'review', label: 'Needs review', desc: 'Approve or reject', cls: 't-review' },
    { id: 'exception', label: 'Exceptions', desc: 'Data or setup to fix', cls: 't-exception' },
    { id: 'auto', label: 'Clean fees', desc: 'Tie to rate, ready to approve', cls: 't-auto' },
    { id: 'approved', label: 'Approved', desc: 'Waiting for an IAS file', cls: 't-approved' },
    { id: 'batch', label: 'Awaiting import', desc: 'In an IAS file', cls: 't-batch' },
    { id: 'done', label: 'Done', desc: 'Loaded or rejected', cls: 't-done' },
    { id: 'all', label: 'All fees', desc: 'Every row in the export', cls: '' },
  ];

  const INPUTS = [
    { key: 'prior', title: 'Loan System contracts, prior day', layout: 'loanSystem', report: true, desc: 'The Loan System contracts report as of the end of the previous business day, loaded as-is. Detection compares it with the current day.' },
    { key: 'current', title: 'Loan System contracts, current day', layout: 'loanSystem', report: true, desc: 'The same report as of the end of the business day you are processing.' },
    { key: 'portfolioMap', title: 'Portfolio map', layout: 'portfolioMap', desc: 'One row per IAS portfolio fed by a Loan System portfolio, with the BNK() details used in its IAS messages: bank, bank name, custody account and cash bank.' },
    { key: 'trancheMap', title: 'Tranche map', layout: 'trancheMap', desc: 'Links each Loan System asset to its IAS facility security ID, with the maturity date and IAS currency code used in contract creates and splits.' },
    { key: 'iasPositions', title: 'IAS holdings', layout: 'iasPositions', desc: 'Funded and unfunded position per IAS portfolio and tranche, as of the same date as the Loan System prior snapshot. Used for tie-out and allocation.' },
    { key: 'lineage', title: 'Contract lineage', layout: 'lineage', desc: 'Which IAS contract each live Loan System contract represents. Load the end-of-day lineage file from the IAS files tab here to carry links to another computer or browser.' },
    { key: 'fees', title: 'Loan System unfunded fee export', layout: 'fees', desc: 'Monthly commitment and ticking fees. PeriodEnd is the last accrual day.' },
  ];

  // ------------------------------------------------------------------ state

  function freshState() {
    const inputs = S.build();
    return {
      version: 1,
      user: 'Ops analyst',
      sourceLabel: S.label,
      asOfDate: S.asOfDate,
      priorAsOfDate: S.priorAsOfDate,
      inputs,
      lineage: E.normalizeLineage(inputs.lineage),
      events: [],
      status: {},
      batches: [],
      audit: [],
      view: 'queue',
      filter: 'review',
      search: '',
      selectedKey: null,
      selectedBatch: null,
      lastRun: null,
      feeLabel: S.feeLabel,
      fees: [],
      feeFilter: 'review',
      lastFeeRun: null,
    };
  }

  function load() {
    try {
      const st = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return st && st.version === 1 ? st : null;
    } catch { return null; }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable: state lasts for this visit */ }
  }

  let state = load();
  if (!state) { state = freshState(); runDetection({ quiet: true }); runFeeCheck({ quiet: true }); }
  if (!state.inputs.fees) {
    // Saved before the fees tab existed: add the sample fee export without touching contract work.
    const sample = S.build();
    ['fees', 'trancheMap', 'iasPositions'].forEach(k => { if (k === 'fees' || state.sourceLabel === S.label) state.inputs[k] = sample[k]; });
    Object.assign(state, { feeLabel: S.feeLabel, fees: [], feeFilter: 'review', lastFeeRun: null });
    runFeeCheck({ quiet: true });
  }

  const statusOf = ev => (state.status[ev.key] || {}).status || 'pending';
  const statusInfo = ev => state.status[ev.key] || {};
  const eventByKey = key => state.events.find(e => e.key === key);
  // Messages that go in the IAS file (events also carry manual steps; fees are all file rows).
  const fileMsgs = ev => ev.messages.filter(m => !m.manual);
  const feeByKey = key => state.fees.find(f => f.key === key);
  const itemByKey = key => eventByKey(key) || feeByKey(key);
  const periodText = f => `${f.periodStart} to ${f.periodEnd}`;
  // Display names. Fees borrow the portfolio and issuer names from the contract data.
  let nameIndex = null;
  function names() {
    if (nameIndex) return nameIndex;
    nameIndex = { portfolios: {}, issuers: {} };
    try {
      [...(state.inputs.prior || []), ...(state.inputs.current || [])].forEach(r => {
        if (r.PortfolioName) nameIndex.portfolios[r.LoanPortfolio] = r.PortfolioName;
        if (r.IssuerName) nameIndex.issuers[r.AssetID] = { issuer: r.IssuerName, instrument: r.AssetName };
      });
    } catch { /* names are optional */ }
    return nameIndex;
  }
  const portfolioName = item => item.portfolioName || names().portfolios[item.loanPortfolio] || item.loanPortfolio;
  const issuerOf = item => item.issuerName || (names().issuers[item.assetId] || {}).issuer || '';
  const instrumentOf = item => (item.issuerName ? item.assetName : (names().issuers[item.assetId] || {}).instrument) || item.assetName;
  const assetTitle = item => [issuerOf(item), instrumentOf(item)].filter(Boolean).join(' ');
  const eventLabel = ev => ev.kind === 'fee'
    ? `${ev.feeType}, ${assetTitle(ev)} (${portfolioName(ev)}), ${periodText(ev)}`
    : `${ev.typeLabel}, ${assetTitle(ev)}`;

  /** Issuer over instrument, with the facility ID and type underneath. */
  function assetCell(item) {
    const issuer = issuerOf(item);
    return `${issuer ? `<div>${esc(issuer)}</div><div class="small">${esc(instrumentOf(item))}</div>` : esc(item.assetName)}<div class="muted small"><span class="mono">${esc(item.assetId)}</span> · ${esc(item.facilityType)}</div>`;
  }

  /** Where an event's facility is held: Loan System portfolios, with the IAS portfolio count. */
  function heldInCell(ev) {
    const hs = ev.holdings || [];
    const ias = hs.reduce((t, h) => t + (h.iasPortfolios || []).length, 0);
    const names = hs.map(h => h.portfolioName || h.loanPortfolio);
    return `<div>${hs.length === 1 ? esc(names[0]) : `${hs.length} Loan System portfolios`}</div><div class="muted small">${ias} IAS ${ias === 1 ? 'portfolio' : 'portfolios'}</div>`;
  }

  function portfolioCell(item) {
    const name = portfolioName(item);
    return name !== item.loanPortfolio
      ? `<div>${esc(name)}</div><div class="muted small mono">${esc(item.loanPortfolio)}</div>`
      : `<span class="mono">${esc(item.loanPortfolio)}</span>`;
  }

  function log(action, ref, label, note) {
    state.audit.unshift({ at: now(), user: state.user || 'Unknown user', action, ref: ref || '', label: label || '', note: note || '' });
  }

  function setStatus(key, status, note, extra = {}) {
    state.status[key] = { ...state.status[key], status, note: note || '', at: now(), by: state.user, ...extra };
  }

  function applyLineage(ev) { (ev.lineageUpdates || []).forEach(u => { state.lineage[u.loanContractId] = u.iasContractId; }); }
  function removeLineage(ev) { (ev.lineageUpdates || []).forEach(u => { delete state.lineage[u.loanContractId]; }); }

  // ------------------------------------------------------------------ detection

  function runDetection({ quiet } = {}) {
    let events;
    try {
      const i = state.inputs;
      const opts = { addSpreadAdjustment: !(state.settings && state.settings.addSpreadAdjustment === false) };
      const prior = E.normalizeLoanSystem(i.prior, opts);
      const current = E.normalizeLoanSystem(i.current, opts);
      const dates = E.checkRunDates({ prior, current, iasPositions: E.normalizeIasPositions(i.iasPositions) });
      state.dateCheck = dates;
      if (dates.priorDate) state.priorAsOfDate = dates.priorDate;
      if (dates.currentDate) state.asOfDate = dates.currentDate;
      if (dates.errors.length) {
        log('Detection stopped', '', 'Date check', dates.errors.join(' '));
        if (!quiet) toast(`Detection didn't run: ${dates.errors.join(' ')}`);
        return;
      }
      events = E.detectEvents({
        asOfDate: state.asOfDate,
        autoApprove: autoApproveSettings(),
        prior,
        current,
        trancheMap: E.normalizeTrancheMap(i.trancheMap),
        portfolioMap: E.normalizePortfolioMap(i.portfolioMap),
        accounts: E.normalizePortfolioAccounts(i.portfolioMap),
        iasPositions: E.normalizeIasPositions(i.iasPositions),
        lineage: state.lineage,
      });
    } catch (err) {
      toast(`Detection stopped: ${err.message}. Check the uploaded files on the Setup tab.`);
      return;
    }

    let kept = 0;
    const previous = new Map((state.events || []).map(ev => [ev.key, ev]));
    events.forEach(ev => {
      const existing = state.status[ev.key];
      if (existing && (!SYSTEM_STATUSES.has(existing.status) || existing.hold)) { kept++; return; }
      const status = { auto: 'verified', trade: 'trade_feed', exception: 'exception', auto_approve: 'auto_approved' }[ev.route] || 'pending';
      // An auto-approval that no longer qualifies gives back the contract links it made.
      if (existing && existing.status === 'auto_approved' && status !== 'auto_approved' && previous.has(ev.key)) removeLineage(previous.get(ev.key));
      const fresh = status === 'auto_approved' && !(existing && existing.status === 'auto_approved');
      state.status[ev.key] = { status, at: now(), by: status === 'auto_approved' ? 'Auto-approval' : 'Detection' };
      if (status === 'verified' || status === 'trade_feed' || status === 'auto_approved') applyLineage(ev);
      if (fresh) log('Auto-approved', ev.key, E.displayName(ev), `Paydown of ${money(ev.paydownTieOut.globalPaydown)} global (${ev.paydownTieOut.pct.toFixed(2)}%). Units tie in every portfolio before and after.`);
    });
    state.events = events;

    const counts = { auto: 0, auto_approve: 0, review: 0, exception: 0, trade: 0 };
    events.forEach(ev => { counts[ev.route]++; });
    state.lastRun = { at: now(), total: events.length, ...counts };
    const summary = `${events.length} events: ${counts.auto} clean rollovers, ${counts.auto_approve} paydowns auto-approved, ${counts.trade} trades for the trade feed, ${counts.review} for review, ${counts.exception} exceptions`;
    log('Ran detection', '', `${state.priorAsOfDate} to ${state.asOfDate}`, summary + (kept ? `. ${kept} already decided, kept as they were.` : ''));
    if (!quiet) toast(`Detection finished. ${summary}.`);
  }

  function runFeeCheck({ quiet } = {}) {
    let fees;
    try {
      const i = state.inputs;
      fees = E.checkFees({
        fees: E.normalizeFees(i.fees || []),
        trancheMap: E.normalizeTrancheMap(i.trancheMap),
        portfolioMap: E.normalizePortfolioMap(i.portfolioMap),
        iasPositions: E.normalizeIasPositions(i.iasPositions),
      });
    } catch (err) {
      toast(`Fee check stopped: ${err.message}. Check the fee export.`);
      return;
    }
    let kept = 0;
    fees.forEach(f => {
      const existing = state.status[f.key];
      if (existing && !SYSTEM_STATUSES.has(existing.status)) { kept++; return; }
      state.status[f.key] = { status: f.route === 'clean' ? 'ready' : f.route === 'exception' ? 'exception' : 'pending', at: now(), by: 'Fee check' };
    });
    state.fees = fees;
    const counts = { clean: 0, review: 0, exception: 0 };
    fees.forEach(f => { counts[f.route]++; });
    const total = fees.reduce((s, f) => s + f.amount, 0);
    state.lastFeeRun = { at: now(), total: fees.length, amount: total, ...counts };
    const summary = `${fees.length} fees totalling ${money(total)}: ${counts.clean} clean, ${counts.review} for review, ${counts.exception} exceptions`;
    log('Checked fee export', '', state.feeLabel, summary + (kept ? `. ${kept} already decided, kept as they were.` : ''));
    if (!quiet) toast(`Fee check finished. ${summary}.`);
  }

  // ------------------------------------------------------------------ actions

  function requireUser() {
    if (state.user && state.user.trim()) return true;
    toast('Enter your name in the top bar first, so the approval is recorded against you.');
    document.getElementById('user-name')?.focus();
    return false;
  }

  function commentValue() { return (document.getElementById('comment')?.value || '').trim(); }

  const actions = {
    approve(key) {
      const ev = itemByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      const n = fileMsgs(ev).length;
      setStatus(key, n ? 'approved' : 'closed', note);
      applyLineage(ev);
      log('Approved', key, eventLabel(ev), note);
      toast(n ? `Approved. ${n} IAS messages will go in the next file.` : 'Approved. Nothing is sent to IAS for this event.');
    },
    approveCleanFees() {
      const ready = state.fees.filter(f => statusOf(f) === 'ready');
      if (!ready.length) { toast('No clean fees are waiting for approval.'); return; }
      if (!requireUser()) return;
      ready.forEach(f => {
        setStatus(f.key, 'approved', 'Approved with all clean fees');
        log('Approved', f.key, eventLabel(f), 'Approved with all clean fees');
      });
      toast(`Approved ${ready.length} clean fees totalling ${money(ready.reduce((s, f) => s + f.amount, 0))}.`);
    },
    reject(key) {
      const ev = itemByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      if (!note) { toast('Add a comment saying why before rejecting.'); document.getElementById('comment')?.focus(); return; }
      setStatus(key, 'rejected', note);
      log('Rejected', key, eventLabel(ev), note);
      toast('Rejected. Nothing will be sent to IAS.');
    },
    manual(key) {
      const ev = itemByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      if (!note) { toast('Add a comment saying how it was handled.'); document.getElementById('comment')?.focus(); return; }
      setStatus(key, 'manual', note);
      log('Marked handled outside the app', key, eventLabel(ev), note);
      toast('Recorded as handled outside the app.');
    },
    unapprove(key) {
      const ev = itemByKey(key);
      if (!ev) return;
      if (statusOf(ev) === 'auto_approved') {
        if (!requireUser()) return;
        setStatus(key, 'pending', commentValue(), { hold: true });
        removeLineage(ev);
        log('Held auto-approved paydown for review', key, eventLabel(ev), commentValue());
        toast('Held for review. Re-running detection won\'t auto-approve it again.');
        return;
      }
      setStatus(key, ev.kind === 'fee' && ev.route === 'clean' ? 'ready' : 'pending', '');
      removeLineage(ev);
      log('Undid approval', key, eventLabel(ev));
      toast('Approval undone. It is back in the queue.');
    },
    reapprove(key) {
      const ev = itemByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      setStatus(key, 'approved', note, { batchId: null, error: null });
      log('Re-approved after failed import', key, eventLabel(ev), note);
      toast('Re-approved. It will go in the next IAS file.');
    },
    createBatch() { makeBatch('event'); },
    createFeeBatch() { makeBatch('fee'); },
    saveResults(batchId) {
      const batch = state.batches.find(b => b.id === batchId);
      if (!batch || !requireUser()) return;
      let failed = 0;
      for (const [i, item] of batch.events.entries()) {
        const result = document.getElementById(`result-${batchId}-${i}`)?.value || 'loaded';
        const error = (document.getElementById(`error-${batchId}-${i}`)?.value || '').trim();
        if (result === 'failed' && !error) {
          toast('Paste the IAS import browser error for each failed event.');
          document.getElementById(`error-${batchId}-${i}`)?.focus();
          return;
        }
        batch.results[item.key] = { result, error };
        if (result === 'failed') failed++;
        setStatus(item.key, result === 'failed' ? 'failed' : 'loaded', '', { batchId, error: result === 'failed' ? error : null });
      }
      batch.status = failed ? 'partial' : 'loaded';
      batch.resultAt = now();
      batch.resultBy = state.user;
      log('Recorded import result', batchId, batch.fileName, failed ? `${failed} failed, ${batch.events.length - failed} loaded` : `All ${batch.events.length} loaded`);
      toast(failed ? `${failed} ${failed === 1 ? 'item' : 'items'} marked failed. They are back in Needs review to fix and re-approve.` : 'All items marked loaded in IAS.');
    },
  };

  function makeBatch(kind) {
    const isFee = kind === 'fee';
    const items = (isFee ? state.fees : state.events).filter(isApproved);
    if (!items.length) { toast(`No approved ${isFee ? 'fees' : 'events'} are waiting for a file.`); return; }
    if (!requireUser()) return;
    const prefix = isFee ? 'F' : 'B';
    const n = state.batches.filter(b => b.asOfDate === state.asOfDate && b.id.startsWith(prefix)).length + 1;
    const id = `${prefix}${state.asOfDate.replace(/-/g, '')}-${String(n).padStart(2, '0')}`;
    let file = null;
    let rows = [];
    if (isFee) rows = E.buildBatchRows(items, id);
    else {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      file = E.buildIasFile(items, { batchId: id, today });
      if (file.errors.length) { toast(`File not created: ${file.errors.join(' ')}`); return; }
    }
    const count = isFee ? rows.length : file.messageCount;
    const fileName = isFee ? `IAS_FEES_${id}.csv` : `IAS_IMPORT_${id}.txt`;
    state.batches.unshift({
      id,
      kind,
      layout: isFee ? 'iasFeeImport' : null,
      format: isFee ? 'csv' : 'ias',
      text: file ? file.text : null,
      before: file ? file.before : [],
      warnings: file ? file.warnings : [],
      after: file ? file.after : [],
      messageCount: count,
      fileName,
      asOfDate: state.asOfDate,
      createdAt: now(),
      createdBy: state.user,
      events: items.map(e => ({ key: e.key, label: eventLabel(e), messages: fileMsgs(e).length })),
      rows,
      status: 'awaiting',
      results: {},
    });
    items.forEach(e => setStatus(e.key, 'in_batch', '', { batchId: id }));
    log('Created IAS file', id, fileName, `${items.length} ${isFee ? 'fees' : 'events'}, ${count} messages`);
    state.selectedBatch = id;
    state.view = 'batches';
    state.selectedKey = null;
    toast(`Created ${id} with ${count} messages. Import it through IAS's import browser, then record the result.`);
  }

  // ------------------------------------------------------------------ rendering helpers

  function chip(status) {
    const s = STATUS[status] || STATUS.pending;
    return `<span class="chip ${s.chip}">${esc(s.label)}</span>`;
  }

  function groupCounts() {
    const counts = Object.fromEntries(GROUPS.map(g => [g.id, 0]));
    state.events.forEach(ev => { counts[STATUS[statusOf(ev)].group]++; counts.all++; });
    return counts;
  }

  function feeGroupCounts() {
    const counts = Object.fromEntries(FEE_GROUPS.map(g => [g.id, 0]));
    state.fees.forEach(f => { counts[STATUS[statusOf(f)].group]++; counts.all++; });
    return counts;
  }

  function contractsSummary(ev) {
    const ids = list => list.map(c => c.contractId).join(', ');
    const parts = [];
    if (ev.expired.length || ev.added.length) parts.push(`${ids(ev.expired) || 'none'} → ${ids(ev.added) || 'none'}`);
    ev.amended.forEach(a => parts.push(`${a.cur.contractId} amended`));
    return parts.join('; ');
  }

  function deltaCell(cents) {
    if (!cents) return '<span class="muted">0.00</span>';
    return `<span class="${cents < 0 ? 'delta-neg' : 'delta-pos'}">${cents > 0 ? '+' : ''}${money(cents)}</span>`;
  }

  function issueCount(ev) {
    const n = ev.flags.filter(f => f.level !== 'info').length;
    return n ? `${n} ${n === 1 ? 'issue' : 'issues'}` : '';
  }

  // ------------------------------------------------------------------ views

  function renderTabs() {
    const counts = groupCounts();
    const open = state.batches.filter(b => b.status === 'awaiting').length;
    const fc = feeGroupCounts();
    const tabCounts = { queue: counts.review + counts.exception, fees: fc.review + fc.exception, batches: open, setup: 0, audit: 0 };
    document.querySelectorAll('.tab').forEach(t => {
      const v = t.dataset.view;
      t.setAttribute('aria-selected', String(state.view === v));
      const c = t.querySelector('.count');
      if (c) { c.textContent = tabCounts[v]; c.hidden = !tabCounts[v]; }
    });
    const user = document.getElementById('user-name');
    if (user && document.activeElement !== user) user.value = state.user;
  }

  function dateFlags() {
    const d = state.dateCheck;
    if (!d || (!d.errors.length && !d.warnings.length)) return '';
    return `<ul class="flags">${d.errors.map(e => `<li class="flag exception"><b>Detection stopped.</b>${esc(e)} Load matching files on the Setup tab.</li>`).join('')}${d.warnings.map(w => `<li class="flag review"><b>Check dates.</b>${esc(w)}</li>`).join('')}</ul>`;
  }

  function viewQueue() {
    const counts = groupCounts();
    const run = state.lastRun;
    const tiles = GROUPS.filter(g => g.id !== 'all').map(g => `
      <button class="tile ${g.cls}" data-action="filter" data-group="${g.id}" aria-pressed="${state.filter === g.id}">
        <span class="n">${counts[g.id]}</span><span class="l">${esc(g.label)}</span><span class="d">${esc(g.desc)}</span>
      </button>`).join('');
    const group = GROUPS.find(g => g.id === state.filter) || GROUPS[0];
    return `
      <section class="section">
        <div class="panel run">
          <dl>
            <div><dt>Business date</dt><dd class="mono">${esc(state.asOfDate)}</dd></div>
            <div><dt>Loan System compared</dt><dd class="mono">${esc(state.priorAsOfDate)} → ${esc(state.asOfDate)}</dd></div>
            <div><dt>IAS holdings as of</dt><dd class="mono">${esc((state.dateCheck && state.dateCheck.iasDate) || 'no date')}</dd></div>
            <div><dt>Source</dt><dd>${esc(state.sourceLabel)}</dd></div>
            <div><dt>Last detection</dt><dd>${run ? `${fmtTime(run.at)}, ${run.total} events` : 'Not run yet'}</dd></div>
          </dl>
          <div class="row">
            <button class="btn" data-action="rerun">Re-run detection</button>
            <button class="btn" data-action="view" data-view="setup">Load files</button>
          </div>
        </div>
        ${dateFlags()}
        <div class="tiles">${tiles}</div>
      </section>
      <section class="section">
        <div class="section-head">
          <div class="row"><h2>${esc(group.label)}</h2>${state.filter !== 'all' ? '<button class="btn ghost" data-action="filter" data-group="all">Show all events</button>' : ''}</div>
          <div style="width:min(320px,100%)"><input type="text" id="queue-search" placeholder="Search issuer, asset or contract ID" value="${esc(state.search)}" aria-label="Search events"></div>
        </div>
        <div id="queue-table">${queueTable()}</div>
      </section>`;
  }

  function queueTable() {
    const q = state.search.trim().toLowerCase();
    const rows = state.events.filter(ev => {
      if (state.filter !== 'all' && STATUS[statusOf(ev)].group !== state.filter) return false;
      if (!q) return true;
      const hay = [ev.assetName, issuerOf(ev), ...(ev.holdings || []).flatMap(h => [h.portfolioName, h.loanPortfolio, ...(h.iasPortfolios || [])]), ev.assetId, ev.typeLabel, ...ev.expired.map(c => c.contractId), ...ev.added.map(c => c.contractId), ...ev.amended.map(a => a.cur.contractId)].join(' ').toLowerCase();
      return hay.includes(q);
    });
    if (!rows.length) {
      const msg = q ? 'No events match that search.' : state.filter === 'review' ? 'Nothing waiting for review.' : 'No events in this group.';
      return `<div class="table-wrap"><div class="empty">${msg}</div></div>`;
    }
    // The trades view shows each facility's position after the trade, and totals for all of them.
    const trades = state.filter === 'trades';
    const pos = (after, before) => `${money(after)}<div class="small">${deltaCell(after - before)}</div>`;
    const sumOf = f => rows.reduce((t, ev) => t + ev.totals[f], 0);
    const positionCells = ev => `<td class="num">${pos(ev.totals.commitmentAfter, ev.totals.commitmentBefore)}</td>
          <td class="num">${pos(ev.totals.fundedAfter, ev.totals.fundedBefore)}</td>
          <td class="num">${pos(ev.totals.unfundedAfter, ev.totals.unfundedBefore)}</td>`;
    const tradeTotals = trades ? `<tfoot><tr><td colspan="6">Total, ${rows.length} ${rows.length === 1 ? 'facility' : 'facilities'}</td>
        <td class="num">${pos(sumOf('commitmentAfter'), sumOf('commitmentBefore'))}</td>
        <td class="num">${pos(sumOf('fundedAfter'), sumOf('fundedBefore'))}</td>
        <td class="num">${pos(sumOf('unfundedAfter'), sumOf('unfundedBefore'))}</td><td></td></tr></tfoot>` : '';
    return `<div class="table-wrap"><table>
      <thead><tr><th>Status</th><th>Event</th><th>Asset</th><th>Held in</th><th>Effective</th><th>Loan System contracts</th>${trades
        ? '<th class="num">Commitment</th><th class="num">Funded</th><th class="num">Unfunded</th>'
        : '<th class="num">Funded change</th><th class="num">IAS msgs</th>'}<th>Checks</th></tr></thead>
      <tbody>${rows.map(ev => {
        const st = statusOf(ev);
        const info = statusInfo(ev);
        return `<tr class="clickable${state.selectedKey === ev.key ? ' selected' : ''}" data-key="${esc(ev.key)}" tabindex="0">
          <td>${chip(st)}</td>
          <td><span class="type">${esc(ev.typeLabel)}</span> ${ev.legs.map(l => `<span class="tag">+ ${esc(E.TYPE_LABELS[l].toLowerCase())}</span>`).join(' ')}
            ${st === 'failed' && info.error ? `<div class="small" style="color:var(--bad)">${esc(info.error)}</div>` : ''}</td>
          <td>${assetCell(ev)}</td>
          <td>${heldInCell(ev)}</td>
          <td class="mono nowrap">${esc(ev.effectiveDate)}</td>
          <td class="mono">${esc(contractsSummary(ev))}</td>
          ${trades ? positionCells(ev) : `<td class="num">${deltaCell(ev.totals.fundedDelta)}</td>
          <td class="num">${fileMsgs(ev).length || '<span class="muted">0</span>'}</td>`}
          <td class="small">${ev.flags.some(f => f.level === 'exception') ? `<span style="color:var(--bad)">${issueCount(ev)}</span>` : issueCount(ev) ? `<span style="color:var(--warn)">${issueCount(ev)}</span>` : '<span class="muted">Passed</span>'}</td>
        </tr>`;
      }).join('')}</tbody>${tradeTotals}</table></div>
      ${trades ? '<p class="small muted">Positions after the trade, across every Loan System portfolio holding the facility, with the change from the prior day underneath. The trade feed books these in IAS.</p>' : ''}`;
  }

  // ---- event detail

  function describe(ev) {
    const c = x => `<span class="mono">${esc(x.contractId)}</span>`;
    const t = ev.totals;
    const amt = x => `${money(x.amount)} (${esc(x.tenor)})`;
    const diffText = diffs => diffs.map(d => `${esc(d.label)} ${esc(d.from)} → ${esc(d.to)}`).join(', ');
    const legText = t.fundedDelta < 0 ? ` and was paid down by ${money(-t.fundedDelta)}`
      : t.fundedDelta > 0 ? (ev.legs.includes('CAPITALIZE') ? ` with ${money(t.fundedDelta)} of interest capitalized` : ` with a draw of ${money(t.fundedDelta)}`) : '';
    switch (ev.type) {
      case 'ROLLOVER':
        if (ev.route === 'auto') return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])} with the same amount and terms. IAS accrues from the contract attributes, so nothing is sent.`;
        if (ev.legs.length) return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])}${legText}. Terms are unchanged, so the IAS contract carries on and only the ${E.TYPE_LABELS[ev.legs[0]].toLowerCase()} is booked.`;
        return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])} with the same terms, but a check needs your attention. Nothing is sent to IAS; approving confirms IAS's schedule is acceptable or that you will adjust it in IAS.`;
      case 'CONTRACT_CHANGE':
        if (ev.expired.length) return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])}${legText} with new terms: ${diffText(ev.rollTermChanges)}. IAS gets a new contract with the new terms and a 1:1 split onto it.`;
        return `Terms changed mid-period: ${ev.amended.map(a => `${c(a.cur)} ${diffText(a.diffs)}`).join('; ')}.`;
      case 'SPLIT':
        return `Contract ${c(ev.expired[0])} for ${money(ev.expired[0].amount)}${legText} split into ${ev.added.length} contracts: ${ev.added.map(x => `${c(x)} ${amt(x)}`).join(', ')}.`;
      case 'COMBINE':
        return `${ev.expired.length} contracts (${ev.expired.map(x => `${c(x)} ${amt(x)}`).join(', ')}) combined into ${c(ev.added[0])} for ${money(ev.added[0].amount)}${legText}.`;
      case 'COMPLEX':
        return `${ev.expired.length} contracts rolled into ${ev.added.length} contracts with different amounts or terms: ${ev.added.map(x => `${c(x)} ${amt(x)}`).join(', ')}.`;
      case 'PAYDOWN':
        return `${ev.amended.map(a => `Contract ${c(a.cur)} paid down by ${money(-a.amountDelta)}`).join('; ')} mid-period. The contract does not roll.`;
      case 'DRAW':
        if (ev.added.length) return `New draw of ${money(t.fundedDelta)} into ${ev.added.map(c).join(', ')}. Unfunded drops from ${money(t.unfundedBefore)} to ${money(t.unfundedAfter)}.`;
        return `Mid-period draw of ${money(t.fundedDelta)} on an existing contract.`;
      case 'REPAYMENT':
        return `${ev.expired.map(c).join(', ')} repaid in full (${money(-t.fundedDelta)}).`;
      case 'TRADE':
        return `Your position went from ${money(t.fundedBefore)} to ${money(t.fundedAfter)} while the facility's global amount stayed at ${money(t.globalAfter)}: a ${t.fundedDelta < 0 ? 'sale' : 'purchase'} of ${money(Math.abs(t.fundedDelta))}. The trade feed books it in IAS, so this app sends nothing.${ev.expired.length === 1 && ev.added.length === 1 ? ` Contract ${c(ev.expired[0])} also rolled into ${c(ev.added[0])} with the same terms, so the IAS contract carries on.` : ''}`;
      case 'NEW_POSITION':
        return `New position of ${money(t.fundedAfter)} in ${ev.added.map(x => `${c(x)} (${esc(x.startDate)} to ${esc(x.endDate)})`).join(', ')}. The trade feed books the purchase in IAS, so this app sends nothing; it checks the first contract's accrual period.`;
      case 'CAPITALIZE':
        return `${money(t.fundedDelta)} of interest capitalized mid-period on ${ev.amended.map(a => c(a.cur)).join(', ')}.`;
      default:
        return `Commitment changed from ${money(t.commitmentBefore)} to ${money(t.commitmentAfter)}.`;
    }
  }

  /**
   * The event's live Loan System contracts and the IAS contract each links to. A person types
   * the link where the app can't set it: a new purchase (the trade feed makes the IAS contract)
   * or an event handled outside the app.
   */
  function contractLinks(ev) {
    const live = [...ev.added, ...ev.amended.map(a => a.cur), ...ev.unchanged];
    if (!live.length) return '';
    const st = statusOf(ev);
    const setOnApproval = ['pending', 'ready'].includes(st);
    const rows = live.map(c => {
      const linked = state.lineage[c.contractId] || '';
      const proposed = (ev.lineageUpdates || []).find(u => u.loanContractId === c.contractId);
      // Editable unless the app sets this link itself: on approval, or already set by an approval.
      const editable = !proposed || ['manual', 'trade_feed'].includes(st) || (!linked && !setOnApproval);
      const current = linked ? `<span class="mono">${esc(linked)}</span>`
        : proposed && setOnApproval ? `<span class="muted">Set on approval: <span class="mono">${esc(proposed.iasContractId)}</span></span>`
          : '<span style="color:var(--bad)">Not linked</span>';
      const input = editable ? `<div class="row" style="gap:6px;flex-wrap:nowrap">
          <input type="text" class="mono" id="link-${esc(c.contractId)}" value="${esc(linked)}" placeholder="IAS contract ID" aria-label="IAS contract for ${esc(c.contractId)}" style="width:12em">
          <button class="btn" data-action="saveLink" data-key="${esc(ev.key)}" data-contract="${esc(c.contractId)}">${linked ? 'Update' : 'Link'}</button></div>` : '';
      return `<tr><td class="mono">${esc(c.contractId)}</td><td>${current}</td><td>${input}</td></tr>`;
    }).join('');
    const unlinked = live.filter(c => !state.lineage[c.contractId]
      && !(setOnApproval && (ev.lineageUpdates || []).some(u => u.loanContractId === c.contractId))).length;
    const hint = ev.isNew ? 'The trade feed creates the IAS contract for a new purchase. Once the trade has posted, type its IAS contract ID here.'
      : st === 'manual' ? 'Handled outside the app, so the app can\'t tell which IAS contracts were used. Type them here.'
        : 'Links are set when the event is approved or verified. Type one here only if the app can\'t set it.';
    return `<section><h3>Contract links${unlinked ? ` <span class="chip c-exception">${unlinked} not linked</span>` : ''}</h3>
      <div class="table-wrap"><table><thead><tr><th>Loan System contract</th><th>IAS contract</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">${hint} Tomorrow's run uses these links to find the IAS contract for each of today's contracts.</p></section>`;
  }

  function contractTable(ev) {
    const iasFor = id => state.lineage[id] || '';
    const ref = ev.expired[0];
    const rows = [];
    ev.expired.forEach(cn => rows.push({ side: 'Expiring', c: cn }));
    ev.added.forEach(cn => rows.push({ side: 'New', c: cn, cmp: ref }));
    ev.amended.forEach(a => { rows.push({ side: 'Before', c: a.prev }); rows.push({ side: 'After', c: a.cur, cmp: a.prev }); });
    ev.unchanged.forEach(cn => rows.push({ side: 'Unchanged', c: cn }));
    const fields = ['rateType', 'interestType', 'tenor', 'marginBps', 'floorPct', 'payFreq', 'resetFreq', 'dayCount'];
    const cell = (r, f, val, cls = '') => {
      const changed = r.cmp && String(r.cmp[f]) !== String(r.c[f]);
      return `<td class="${cls}${changed ? ' changed' : ''}">${esc(val)}</td>`;
    };
    return `<div class="table-wrap"><table>
      <thead><tr><th></th><th>Loan System contract</th><th>IAS contract</th><th>Period</th><th class="num">Days</th><th class="num">Amount</th><th class="num">Global</th><th>Rate</th><th>Interest</th><th>Tenor</th><th class="num">Margin</th><th class="num">Floor</th><th>Pay</th><th>Reset</th><th>Day count</th></tr></thead>
      <tbody>${rows.map(r => {
        const days = E.daysBetween(r.c.startDate, r.c.endDate);
        const range = E.TENOR_DAYS[r.c.tenor];
        const irregular = r.side === 'New' && range && (days < range[0] || days > range[1]);
        const pending = ev.lineageUpdates.find(u => u.loanContractId === r.c.contractId);
        const ias = iasFor(r.c.contractId) || (pending ? pending.iasContractId : '');
        return `<tr>
          <td class="small muted">${r.side}</td>
          <td class="mono">${esc(r.c.contractId)}</td>
          <td class="mono">${esc(ias) || '<span class="muted">none</span>'}</td>
          <td class="mono nowrap">${esc(r.c.startDate)} → ${esc(r.c.endDate)}</td>
          <td class="num${irregular ? ' changed' : ''}">${days}</td>
          ${cell(r, 'amount', money(r.c.amount), 'num')}
          <td class="num">${money(r.c.globalAmount)}</td>
          ${fields.map(f => cell(r, f, f === 'floorPct' ? Number(r.c[f]).toFixed(2) : r.c[f], f === 'marginBps' || f === 'floorPct' ? 'num' : '')).join('')}
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  /** Each Loan System portfolio's holding before and after, tied out to its IAS portfolios. */
  function holdingsTable(ev) {
    const hs = ev.holdings || [];
    const tie = h => (h.ties === null ? '<span class="muted">n/a</span>'
      : h.isNew ? '<span class="muted">New holding</span>'
        : h.ties ? '<span style="color:var(--ok)">Ties</span>'
          : `<span style="color:var(--bad)">Off by ${money((h.iasFunded + h.iasUnfunded) - (h.fundedBefore + h.unfundedBefore))}</span>`);
    return `<div class="table-wrap"><table>
      <thead><tr><th>Loan System portfolio</th><th class="num">Funded before</th><th class="num">Funded after</th><th class="num">Unfunded before</th><th>IAS portfolios</th><th class="num">IAS funded before</th><th>Tie-out</th></tr></thead>
      <tbody>${hs.map(h => `<tr>
        <td>${esc(h.portfolioName || h.loanPortfolio)}${h.portfolioName ? `<div class="muted small mono">${esc(h.loanPortfolio)}</div>` : ''}${h.tradeDelta ? `<div class="small" style="color:var(--teal)">Trade ${money(h.tradeDelta)}</div>` : ''}</td>
        <td class="num">${money(h.fundedBefore)}</td><td class="num">${money(h.fundedAfter)}</td><td class="num">${money(h.unfundedBefore)}</td>
        <td class="mono small">${(h.iasPortfolios || []).map(pp => `<span class="nowrap">${esc(pp)}</span>`).join(', ') || '<span class="muted">none</span>'}</td>
        <td class="num">${h.iasFunded === null ? '' : money(h.iasFunded)}</td><td class="small">${tie(h)}</td></tr>`).join('')}</tbody>
      ${hs.length > 1 ? `<tfoot><tr><td>Total</td><td class="num">${money(ev.totals.fundedBefore)}</td><td class="num">${money(ev.totals.fundedAfter)}</td><td class="num">${money(ev.totals.unfundedBefore)}</td><td></td><td class="num">${money(hs.reduce((t, h) => t + (h.iasFunded || 0), 0))}</td><td></td></tr></tfoot>` : ''}
    </table></div>
    <p class="small muted">IAS holdings are as of the Loan System prior snapshot. Any Loan System portfolio that doesn't tie blocks the whole event, because the global action is shared.</p>`;
  }

  /** For a paydown: the units each portfolio holds before and after, in both systems. */
  function paydownTieOutTable(ev) {
    const t = ev.paydownTieOut;
    const ok = v => (v ? '<span style="color:var(--ok)">Ties</span>' : '<span style="color:var(--bad)">Off</span>');
    return `<div class="table-wrap"><table>
      <thead><tr><th>Loan System portfolio</th><th class="num">Loan System before</th><th class="num">IAS before</th><th class="num">Redeemed in IAS</th><th class="num">IAS after</th><th class="num">Loan System after</th><th class="num">Share of global paydown</th><th>Result</th></tr></thead>
      <tbody>${t.rows.map(r => `<tr>
        <td>${esc(r.portfolioName || r.loanPortfolio)}</td>
        <td class="num">${money(r.loanBefore)}</td><td class="num">${money(r.iasBefore)}</td><td class="num">${money(r.redeemed)}</td>
        <td class="num">${money(r.iasAfter)}</td><td class="num">${money(r.loanAfter)}</td>
        <td class="num">${money(r.expectedShare)}${r.shareDiff ? `<div class="small muted">off ${money(Math.abs(r.shareDiff))}</div>` : ''}</td>
        <td class="small">${ok(r.ties)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="small ${t.ok ? '' : 'muted'}">${t.ok
      ? `Global paydown ${money(t.globalPaydown)} (${t.pct.toFixed(2)}% of the global amount), redeemed in full by the global action. Every portfolio ties, so this paydown qualifies for auto-approval.`
      : `Doesn't qualify for auto-approval: ${esc(t.reasons.join(' '))}`}</p>`;
  }

  /** One allocation table per Loan System portfolio that has IAS transactions. */
  function eventAllocations(ev) {
    if (ev.isNew) return '<p class="muted">No IAS holdings yet. The trade feed allocates the purchase to funds.</p>';
    const list = ev.allocations || [];
    if (!list.length) return '<p class="muted">No allocation: the asset or portfolio is not mapped to IAS, or nothing is sent.</p>';
    return list.map(a => `<div class="stack">${list.length > 1 ? `<div class="small"><b>${esc(a.portfolioName || a.loanPortfolio)}</b></div>` : ''}
      ${allocationTable({ allocationBasis: a.basis, lines: a.lines, iasTrancheId: ev.iasTrancheId })}</div>`).join('');
  }

  function allocationTable(ev, basisLabel = 'IAS position before event<br>(funded + unfunded)') {
    if (ev.isNew) return '<p class="muted">No IAS holdings yet. The trade feed allocates the purchase to funds.</p>';
    if (!ev.allocationBasis.length) return '<p class="muted">No allocation: the asset or portfolio is not mapped to IAS.</p>';
    const basis = ev.allocationBasis;
    const total = basis.reduce((s, b) => s + b.weight, 0);
    const head = basis.map(b => `<th class="num">${esc(b.iasPortfolio)}<div class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">${total ? (b.weight / total * 100).toFixed(2) : '0.00'}%</div></th>`).join('');
    const posRow = `<tr><td class="small muted">${basisLabel}</td>${basis.map(b => `<td class="num">${money(b.weight)}</td>`).join('')}<td class="num">${money(total)}</td><td></td></tr>`;
    const lineRows = ev.lines.map(l => {
      const parts = basis.map(b => (l.allocation ? l.allocation[b.iasPortfolio] ?? 0 : 0));
      const sum = parts.reduce((s, v) => s + v, 0);
      const ties = l.allocation && sum === l.amount;
      const route = l.fromId || l.toId ? `${esc(l.fromId || '')}${l.fromId && l.toId ? ' → ' : ''}${esc(l.toId || '')}` : '';
      return `<tr><td><span class="mono">${esc(l.messageType)}</span> <span class="mono small muted">${route}</span><div class="small muted">${esc(l.note)}</div></td>
        ${parts.map(p => `<td class="num">${money(p)}</td>`).join('')}
        <td class="num">${money(l.amount)}</td>
        <td class="small" style="color:${ties ? 'var(--ok)' : 'var(--bad)'}">${l.allocation ? (ties ? 'Ties to the Loan System' : `Off by ${money(sum - l.amount)}`) : 'Not allocated'}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table>
      <thead><tr><th>Line</th>${head}<th class="num">Loan System amount</th><th>Check</th></tr></thead>
      <tbody>${posRow}${lineRows || `<tr><td colspan="${basis.length + 3}" class="muted">Nothing to allocate: this event sends no IAS messages.</td></tr>`}</tbody>
    </table></div>
    <p class="small muted">Split pro rata on each IAS portfolio's ${ev.kind === 'fee' ? 'current unfunded position' : 'position'} in tranche <span class="mono">${esc(ev.iasTrancheId)}</span>, using largest-remainder rounding so every line adds back to the Loan System amount to the cent.</p>`;
  }

  function messageTable(ev) {
    if (!ev.messages.length) return '<p class="muted">No IAS messages for this event.</p>';
    const levelLabel = { SMF: 'Create contract', GLOBAL: 'Global action', PORTFOLIO: 'Portfolio transaction' };
    const typeLabel = { CONTRACT_SPLIT: 'contract split', CONTRACT_COMBINE: 'contract combine', PAYDOWN: 'contract redemption', DRAW: 'drawdown', CAPITALIZE: 'interest capitalization', CONTRACT_CREATE: '' };
    const before = ev.messages.filter(m => m.manual && m.level === 'SMF');
    const after = ev.messages.filter(m => m.manual && m.level !== 'SMF');
    const blocks = fileMsgs(ev).map(m => `<div class="stack">
        <div class="small"><b>Step ${m.step}</b> · ${levelLabel[m.level]}${typeLabel[m.type] ? `, ${typeLabel[m.type]}` : ''}${m.iasPortfolio ? ` · <span class="mono">${esc(m.iasPortfolio)}</span>` : ''}${m.level === 'GLOBAL' ? ` · type ${m.actionType}` : ''}</div>
        <pre class="file">${esc(E.iasMessageText(m, { ccid: 'TBD', pretty: true }))}</pre></div>`).join('');
    return `${checklist('Before loading: create these contracts in IAS', before.map(m => ({ text: E.manualStepText(m) })))}
      ${blocks || '<p class="muted">No messages go in the IAS file for this event.</p>'}
      ${checklist('After loading: book these in IAS', after.map(m => ({ text: E.manualStepText(m) })))}
      <p class="small muted">Load order: the contract create, then each step's global action and its portfolio transactions. Shown indented here; in the file each message is on its own single line. IAS assigns transaction numbers on load; CCIDs are assigned when the file is created. IAS closes emptied contracts itself.</p>`;
  }

  function actionsFor(ev) {
    const st = statusOf(ev);
    const info = statusInfo(ev);
    const by = info.by && info.at ? `${esc(info.by)}, ${fmtTime(info.at)}` : '';
    const note = info.note ? `<p class="small">“${esc(info.note)}”</p>` : '';
    const comment = placeholder => `<label class="field" for="comment">Comment<textarea id="comment" placeholder="${esc(placeholder)}"></textarea></label>`;
    switch (st) {
      case 'pending':
      case 'ready':
        return `${comment('Optional for approval, required to reject')}
          <div class="row">
            <button class="btn primary" data-action="approve" data-key="${esc(ev.key)}">${fileMsgs(ev).length ? `Approve, ${fileMsgs(ev).length} IAS messages` : 'Approve, nothing to send'}</button>
            <button class="btn danger" data-action="reject" data-key="${esc(ev.key)}">Reject</button>
          </div>`;
      case 'exception':
        return `<p class="small">This can't be approved until the problem above is fixed. Correct the data or setup, then ${ev.kind === 'fee' ? 're-check the fees' : 're-run detection'}. If you booked it in IAS yourself, record that here, then link the IAS contracts under Contract links.</p>
          ${comment('How was it handled?')}
          <div class="row"><button class="btn" data-action="manual" data-key="${esc(ev.key)}">Mark as handled outside the app</button></div>`;
      case 'failed':
        return `<p class="small"><b>IAS rejected this in file ${esc(info.batchId || '')}:</b> ${esc(info.error || '')}</p>
          ${comment('What did you fix?')}
          <div class="row">
            <button class="btn primary" data-action="reapprove" data-key="${esc(ev.key)}">Re-approve for the next IAS file</button>
            <button class="btn" data-action="manual" data-key="${esc(ev.key)}">Mark as handled outside the app</button>
          </div>`;
      case 'auto_approved':
        return `<p class="small">Auto-approved by detection: a paydown with nothing else changing, and the units tie in every portfolio before and after (see the tie-out above). It goes into the next IAS file.</p>
          <div class="row">
            <button class="btn primary" data-action="createBatch">Create IAS file now</button>
            <button class="btn" data-action="unapprove" data-key="${esc(ev.key)}">Hold for review</button>
          </div>`;
      case 'approved':
        return `<p class="small">Approved by ${by}. It goes into the next IAS file.</p>${note}
          <div class="row">
            <button class="btn primary" data-action="${ev.kind === 'fee' ? 'createFeeBatch' : 'createBatch'}">Create IAS file now</button>
            <button class="btn" data-action="unapprove" data-key="${esc(ev.key)}">Undo approval</button>
          </div>`;
      case 'in_batch':
        return `<p class="small">In IAS file <span class="mono">${esc(info.batchId)}</span>, waiting for the import result.</p>
          <div class="row"><button class="btn" data-action="openBatch" data-batch="${esc(info.batchId)}">Open IAS file</button></div>`;
      case 'trade_feed':
        return `<p class="small">Booked in IAS by the trade feed. Nothing to send from this app.</p>`;
      case 'verified':
        return `<p class="small">Verified automatically by detection. Amount, terms and period length match, so IAS needs no message. The new Loan System contract now links to the same IAS contract.</p>`;
      default:
        return `<p class="small">${chip(st)} ${by ? `by ${by}` : ''}</p>${note}`;
    }
  }

  function renderDrawer() {
    const root = document.getElementById('drawer-root');
    const item = state.selectedKey && itemByKey(state.selectedKey);
    if (!item) { root.innerHTML = ''; return; }
    if (item.kind === 'fee') { root.innerHTML = feeDrawer(item); return; }
    const ev = item;
    const t = ev.totals;
    const history = state.audit.filter(a => a.ref === ev.key);
    const flagLabel = { exception: 'Exception', review: 'Review', info: 'Note' };
    root.innerHTML = `
      <div class="backdrop" data-action="close"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(eventLabel(ev))}">
        <header class="drawer-head">
          <div class="title-row">
            <div><div class="eyebrow">${esc(ev.typeLabel)} · ${esc(ev.facilityType)} · held in ${(ev.holdings || []).length} Loan System ${(ev.holdings || []).length === 1 ? 'portfolio' : 'portfolios'}</div><h2>${esc(issuerOf(ev) || ev.assetName)}</h2>${issuerOf(ev) ? `<div class="small muted">${esc(instrumentOf(ev))} · <span class="mono">${esc(ev.assetId)}</span></div>` : ''}</div>
            <button class="btn" data-action="close" id="drawer-close">Close</button>
          </div>
          <div class="row">${chip(statusOf(ev))} ${ev.legs.map(l => `<span class="tag">+ ${esc(E.TYPE_LABELS[l].toLowerCase())}</span>`).join(' ')} <span class="small muted">Effective <span class="mono">${esc(ev.effectiveDate)}</span></span></div>
        </header>
        <div class="drawer-body">
          <section><p>${describe(ev)}</p></section>
          ${ev.flags.length ? `<section><h3>Checks</h3><ul class="flags">${ev.flags.map(f => `<li class="flag ${f.level}"><b>${flagLabel[f.level]}.</b>${esc(f.text)}</li>`).join('')}</ul></section>` : ''}
          <section><h3>Loan System contracts</h3>${contractTable(ev)}<p class="small muted">Highlighted cells differ from the expiring contract, or show an irregular period length.</p></section>
          <section><h3>Facility totals, all portfolios</h3>
            <dl class="kv">
              <div><dt>Funded</dt><dd class="figure">${money(t.fundedBefore)} → ${money(t.fundedAfter)}</dd><dd class="small">${deltaCell(t.fundedDelta)}</dd></div>
              <div><dt>Unfunded</dt><dd class="figure">${money(t.unfundedBefore)} → ${money(t.unfundedAfter)}</dd></div>
              <div><dt>Commitment</dt><dd class="figure">${money(t.commitmentBefore)} → ${money(t.commitmentAfter)}</dd></div>
              <div><dt>Global funded</dt><dd class="figure">${money(t.globalBefore)} → ${money(t.globalAfter)}</dd><dd class="small muted">${t.globalBefore ? `Your share ${(t.fundedBefore / t.globalBefore * 100).toFixed(4)}%` : ''}</dd></div>
              <div><dt>IAS tranche</dt><dd class="mono">${esc(ev.iasTrancheId) || 'Not mapped'}</dd></div>
            </dl></section>
          ${contractLinks(ev)}
          <section><h3>Holdings by portfolio</h3>${holdingsTable(ev)}</section>
          ${ev.paydownTieOut ? `<section><h3>Paydown tie-out</h3>${paydownTieOutTable(ev)}</section>` : ''}
          <section><h3>Allocation to IAS portfolios</h3>${eventAllocations(ev)}</section>
          <section><div class="section-head"><h3>IAS messages</h3>${fileMsgs(ev).length ? '<button class="btn ghost" data-action="copyMessages">Copy messages</button>' : ''}</div>${messageTable(ev)}</section>
          <section><h3>Event key</h3><p class="mono small" style="word-break:break-all">${esc(ev.key)}</p><p class="small muted">The same Loan System change always produces the same key, so re-running detection never creates a duplicate.</p></section>
          ${history.length ? `<section><h3>History</h3><ul class="flags">${history.map(h => `<li class="flag info"><b>${esc(h.action)}</b> by ${esc(h.user)}, ${fmtTime(h.at)}${h.note ? `. “${esc(h.note)}”` : ''}</li>`).join('')}</ul></section>` : ''}
        </div>
        <footer class="actions">${actionsFor(ev)}</footer>
      </aside>`;
  }

  // ---- fees

  function viewFees() {
    const counts = feeGroupCounts();
    const run = state.lastFeeRun;
    const ready = state.fees.filter(f => statusOf(f) === 'ready');
    const periods = [...new Set(state.fees.map(periodText))];
    const tiles = FEE_GROUPS.filter(g => g.id !== 'all').map(g => `
      <button class="tile ${g.cls}" data-action="feeFilter" data-group="${g.id}" aria-pressed="${state.feeFilter === g.id}">
        <span class="n">${counts[g.id]}</span><span class="l">${esc(g.label)}</span><span class="d">${esc(g.desc)}</span>
      </button>`).join('');
    const group = FEE_GROUPS.find(g => g.id === state.feeFilter) || FEE_GROUPS[0];
    const rows = state.fees.filter(f => state.feeFilter === 'all' || STATUS[statusOf(f)].group === state.feeFilter);
    const table = rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Status</th><th>Facility</th><th>Fee</th><th>Loan System portfolio</th><th>Period</th><th class="num">Rate (bps)</th><th class="num">Avg unfunded</th><th class="num">Amount</th><th class="num">Expected</th><th class="num">Difference</th><th>Checks</th></tr></thead>
      <tbody>${rows.map(f => {
        const st = statusOf(f);
        const info = statusInfo(f);
        return `<tr class="clickable${state.selectedKey === f.key ? ' selected' : ''}" data-key="${esc(f.key)}" tabindex="0">
          <td>${chip(st)}${st === 'failed' && info.error ? `<div class="small" style="color:var(--bad)">${esc(info.error)}</div>` : ''}</td>
          <td>${assetCell(f)}</td>
          <td>${esc(f.feeType)}</td>
          <td>${portfolioCell(f)}</td>
          <td class="mono nowrap">${esc(f.periodStart)} → ${esc(f.periodEnd)}</td>
          <td class="num">${esc(f.rateBps)}</td>
          <td class="num">${money(f.avgUnfunded)}</td>
          <td class="num">${money(f.amount)}</td>
          <td class="num">${money(f.expected)}</td>
          <td class="num">${f.amount < 0 ? '<span class="muted">n/a</span>' : deltaCell(f.diff)}</td>
          <td class="small">${f.flags.some(x => x.level === 'exception') ? `<span style="color:var(--bad)">${issueCount(f)}</span>` : issueCount(f) ? `<span style="color:var(--warn)">${issueCount(f)}</span>` : '<span class="muted">Passed</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`
      : `<div class="table-wrap"><div class="empty">${state.feeFilter === 'review' ? 'Nothing waiting for review.' : 'No fees in this group.'}</div></div>`;
    return `
      <section class="section">
        <div class="panel run">
          <dl>
            <div><dt>Fee export</dt><dd>${esc(state.feeLabel)}</dd></div>
            <div><dt>Period</dt><dd class="mono">${esc(periods.length === 1 ? periods[0] : `${periods.length} periods`)}</dd></div>
            <div><dt>Total</dt><dd class="figure">${run ? `${run.total} fees, ${money(run.amount)}` : 'Not checked yet'}</dd></div>
          </dl>
          <div class="row">
            <button class="btn primary" data-action="approveCleanFees" ${ready.length ? '' : 'disabled'}>Approve ${ready.length} clean ${ready.length === 1 ? 'fee' : 'fees'}</button>
            <button class="btn" data-action="recheckFees">Re-check fees</button>
            <label class="btn" for="file-fees-inline">Load fee export<input type="file" id="file-fees-inline" accept=".csv,text/csv" data-input="fees" hidden></label>
          </div>
        </div>
        <div class="tiles">${tiles}</div>
      </section>
      <section class="section">
        <div class="section-head">
          <div class="row"><h2>${esc(group.label)}</h2>${state.feeFilter !== 'all' ? '<button class="btn ghost" data-action="feeFilter" data-group="all">Show all fees</button>' : ''}</div>
          <span class="small muted">Expected = rate × average unfunded × days ÷ day-count basis</span>
        </div>
        ${table}
      </section>`;
  }

  function feeMessageTable(f) {
    if (!f.messages.length) return '<p class="muted">No IAS messages for this fee.</p>';
    return `<div class="table-wrap"><table>
      <thead><tr><th>Transaction</th><th>Fee type</th><th>IAS portfolio</th><th>IAS tranche</th><th>Period</th><th class="num">Amount</th><th>Loan System transaction</th></tr></thead>
      <tbody>${f.messages.map(m => `<tr>
        <td class="mono">${esc(m.TransactionType)}</td><td>${esc(m.FeeType)}</td><td class="mono">${esc(m.IASPortfolio)}</td><td class="mono">${esc(m.IASTrancheID)}</td>
        <td class="mono nowrap">${esc(m.PeriodStart)} → ${esc(m.PeriodEnd)}</td><td class="num">${money(E.toCents(m.Amount))}</td><td class="mono">${esc(m.LoanTransactionID)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function feeDrawer(f) {
    const history = state.audit.filter(a => a.ref === f.key);
    const flagLabel = { exception: 'Exception', review: 'Review', info: 'Note' };
    const basis = /365/.test(f.dayCount) ? 365 : 360;
    const summary = f.amount < 0
      ? `Correction of ${money(f.amount)} to the ${esc(f.feeType.toLowerCase())} for ${esc(periodText(f))}.`
      : `${esc(f.feeType)} of ${money(f.amount)} at ${esc(f.rateBps)} bps on average unfunded of ${money(f.avgUnfunded)} for ${f.days} days (${esc(periodText(f))}, ${esc(f.dayCount)}).`;
    return `
      <div class="backdrop" data-action="close"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(eventLabel(f))}">
        <header class="drawer-head">
          <div class="title-row">
            <div><div class="eyebrow">${esc(f.feeType)} · ${esc(f.facilityType)} · ${esc(portfolioName(f))}</div><h2>${esc(issuerOf(f) || f.assetName)}</h2>${issuerOf(f) ? `<div class="small muted">${esc(instrumentOf(f))} · <span class="mono">${esc(f.assetId)}</span></div>` : ''}</div>
            <button class="btn" data-action="close" id="drawer-close">Close</button>
          </div>
          <div class="row">${chip(statusOf(f))} <span class="small muted">Export row ${f.rowNo} · <span class="mono">${esc(f.transactionId)}</span></span></div>
        </header>
        <div class="drawer-body">
          <section><p>${summary}</p></section>
          ${f.flags.length ? `<section><h3>Checks</h3><ul class="flags">${f.flags.map(x => `<li class="flag ${x.level}"><b>${flagLabel[x.level]}.</b>${esc(x.text)}</li>`).join('')}</ul></section>` : ''}
          <section><h3>Fee calculation</h3>
            <dl class="kv">
              <div><dt>Rate</dt><dd class="figure">${esc(f.rateBps)} bps</dd></div>
              <div><dt>Average unfunded</dt><dd class="figure">${money(f.avgUnfunded)}</dd></div>
              <div><dt>Days / basis</dt><dd class="figure">${f.days} / ${basis}</dd></div>
              <div><dt>Expected</dt><dd class="figure">${money(f.expected)}</dd></div>
              <div><dt>Loan System amount</dt><dd class="figure">${money(f.amount)}</dd></div>
              <div><dt>Difference</dt><dd class="figure">${f.amount < 0 ? 'Not checked (correction)' : deltaCell(f.diff)}</dd></div>
              <div><dt>IAS unfunded today</dt><dd class="figure">${money(f.iasUnfunded)}</dd></div>
              <div><dt>IAS tranche</dt><dd class="mono">${esc(f.iasTrancheId) || 'Not mapped'}</dd></div>
            </dl></section>
          <section><h3>Allocation to IAS portfolios</h3>${allocationTable(f, 'IAS unfunded position today')}</section>
          <section><div class="section-head"><h3>IAS fee transactions</h3>${f.messages.length ? '<button class="btn ghost" data-action="copyMessages">Copy as CSV</button>' : ''}</div>${feeMessageTable(f)}</section>
          <section><h3>Fee key</h3><p class="mono small" style="word-break:break-all">${esc(f.key)}</p><p class="small muted">Facility, fee type and period identify the fee, so the same fee can't be approved twice, even from a reloaded export.</p></section>
          ${history.length ? `<section><h3>History</h3><ul class="flags">${history.map(h => `<li class="flag info"><b>${esc(h.action)}</b> by ${esc(h.user)}, ${fmtTime(h.at)}${h.note ? `. “${esc(h.note)}”` : ''}</li>`).join('')}</ul></section>` : ''}
        </div>
        <footer class="actions">${actionsFor(f)}</footer>
      </aside>`;
  }

  // ---- batches

  function readyPanel(kind) {
    const isFee = kind === 'fee';
    const ready = (isFee ? state.fees : state.events).filter(isApproved);
    const msgCount = ready.reduce((s, e) => s + e.messages.length, 0);
    const noun = isFee ? ['fee', 'fees'] : ['contract event', 'contract events'];
    const total = isFee ? ` totalling ${money(ready.reduce((s, f) => s + f.amount, 0))}` : '';
    return `<div class="panel run">
      <div class="stack">
        <h2>${ready.length ? `${ready.length} approved ${noun[ready.length === 1 ? 0 : 1]} ready for an IAS file` : `No approved ${noun[1]} waiting`}</h2>
        <p class="muted small">${ready.length ? `${msgCount} messages${total}. ` : ''}Create the file, import it through IAS's import browser, then record which messages loaded.</p>
      </div>
      <button class="btn primary" data-action="${isFee ? 'createFeeBatch' : 'createBatch'}" ${ready.length ? '' : 'disabled'}>Create ${isFee ? 'fee' : 'contract event'} file</button>
    </div>`;
  }

  /** End-of-day lineage file: today's links, ready to load as tomorrow's lineage. */
  function eodLineage() {
    let current = [];
    try { current = E.normalizeLoanSystem(state.inputs.current || []); } catch { /* no current snapshot loaded */ }
    const liveOnly = !state.eodAllLinks;
    const x = E.lineageExport({ lineage: state.lineage, current, liveOnly });
    const fileName = `LINEAGE_${String(state.asOfDate || '').replace(/-/g, '')}.csv`;
    return { ...x, liveOnly, fileName, csv: E.toCSV(x.rows, E.LAYOUTS.lineage) };
  }

  function eodPanel() {
    const x = eodLineage();
    const open = state.events.filter(ev => ['pending', 'exception', 'failed', 'approved', 'auto_approved', 'in_batch'].includes(statusOf(ev)));
    const byContract = new Map();
    state.events.forEach(ev => [...ev.added, ...ev.amended.map(a => a.cur), ...ev.unchanged].forEach(c => byContract.set(c.contractId, ev)));
    const unlinkedRows = x.unlinked.map(u => {
      const ev = byContract.get(u.contractId);
      const st = ev ? statusOf(ev) : '';
      return `<tr${ev ? ` data-key="${esc(ev.key)}"` : ''}><td class="mono">${esc(u.contractId)}</td><td>${esc([u.issuerName, u.assetName].filter(Boolean).join(' '))} <span class="mono small muted">${esc(u.assetId)}</span></td><td>${ev ? chip(st) : '<span class="muted small">No event today</span>'}</td></tr>`;
    }).join('');
    return `<div class="panel panel-pad stack">
      <div class="section-head"><h2>End of day: contract lineage</h2><span class="small muted">Business date <span class="mono">${esc(state.asOfDate)}</span></span></div>
      <p class="small">${x.rows.length} links to carry into tomorrow, for ${x.liveCount} live contracts in today's Loan System snapshot.${x.liveOnly && x.expired ? ` ${x.expired} links for contracts that have expired are left out.` : ''} Load this file as the contract lineage before tomorrow's run if you switch computers or clear this browser.</p>
      ${open.length ? `<ul class="flags"><li class="flag review"><b>Not finished.</b>${open.length} ${open.length === 1 ? 'event is' : 'events are'} still waiting on a decision or an import result. Their new contracts get links only when they are approved, verified or linked by hand.</li></ul>` : ''}
      ${x.unlinked.length ? `<div class="stack"><div class="small"><b>${x.unlinked.length} live ${x.unlinked.length === 1 ? 'contract has' : 'contracts have'} no IAS link.</b> Tomorrow they are exceptions if they roll, pay down or change. Open one to link it.</div>
        <div class="table-wrap"><table><thead><tr><th>Loan System contract</th><th>Facility</th><th>Event today</th></tr></thead><tbody>${unlinkedRows}</tbody></table></div></div>`
        : '<p class="small" style="color:var(--ok)">Every live contract has an IAS link.</p>'}
      <label class="row small" for="eod-all-links" style="gap:8px"><input type="checkbox" id="eod-all-links" ${state.eodAllLinks ? 'checked' : ''}> Include links for expired contracts too</label>
      <div class="row">
        <button class="btn primary" data-action="downloadLineage">Download ${esc(x.fileName)}</button>
        <button class="btn" data-action="copyLineage">Copy file contents</button>
      </div>
      <details><summary class="small">Preview</summary><pre class="file" id="lineage-file">${esc(x.csv)}</pre></details>
    </div>`;
  }

  function viewBatches() {
    const list = state.batches.map(b => batchPanel(b)).join('');
    return `
      <section class="section">${readyPanel('event')}${readyPanel('fee')}</section>
      <section class="section">${eodPanel()}</section>
      <section class="section">
        <div class="section-head"><h2>IAS files</h2><span class="muted small">Split, combine and global action messages follow IAS's samples. The fee file layout is still a placeholder.</span></div>
        ${list || '<div class="panel empty">No IAS files yet. Approve events or fees, then create a file here.</div>'}
      </section>`;
  }

  const batchContent = b => (b.format === 'ias' ? b.text : E.toCSV(b.rows, E.LAYOUTS[b.layout || 'iasFeeImport']));

  function checklist(title, items) {
    if (!items || !items.length) return '';
    return `<div class="stack"><h3>${esc(title)}</h3><ul class="flags">${items.map(x => `<li class="flag review">${esc(x.text)}</li>`).join('')}</ul></div>`;
  }

  function batchPanel(b) {
    const statusChip = b.status === 'awaiting' ? '<span class="chip c-batch">Waiting for import result</span>'
      : b.status === 'loaded' ? '<span class="chip c-loaded">All loaded</span>'
        : '<span class="chip c-exception">Some messages failed</span>';
    const open = state.selectedBatch === b.id || (!state.selectedBatch && b === state.batches[0]);
    const csv = batchContent(b);
    const msgCount = b.messageCount ?? b.rows.length;
    const noun = b.kind === 'fee' ? 'fees' : 'events';
    const resultRows = b.events.map((item, i) => {
      const r = b.results[item.key];
      if (b.status !== 'awaiting') {
        return `<tr><td>${esc(item.label)}</td><td class="num">${item.messages}</td><td>${r && r.result === 'failed' ? '<span class="chip c-exception">Failed</span>' : '<span class="chip c-loaded">Loaded</span>'}</td><td class="small">${esc(r ? r.error : '')}</td></tr>`;
      }
      return `<tr><td>${esc(item.label)}</td><td class="num">${item.messages}</td>
        <td><select id="result-${esc(b.id)}-${i}" aria-label="Import result"><option value="loaded">Loaded</option><option value="failed">Failed</option></select></td>
        <td><input type="text" id="error-${esc(b.id)}-${i}" placeholder="IAS error, if failed" aria-label="IAS error"></td></tr>`;
    }).join('');
    return `<details class="panel panel-pad batch" ${open ? 'open' : ''}>
      <summary><span class="batch-head" style="display:inline-flex;width:calc(100% - 20px)">
        <span><span class="mono" style="font-weight:600">${esc(b.id)}</span> <span class="muted small">${esc(b.fileName)}</span></span>
        <span class="row">${statusChip}<span class="small muted">${b.events.length} ${noun}, ${msgCount} messages · ${esc(b.createdBy)}, ${fmtTime(b.createdAt)}</span></span>
      </span></summary>
      <div class="stack">
        <div class="row">
          <button class="btn" data-action="copyBatch" data-batch="${esc(b.id)}">Copy file contents</button>
          <button class="btn" data-action="downloadBatch" data-batch="${esc(b.id)}">Download ${b.format === 'ias' ? '.txt' : '.csv'}</button>
          <span class="small muted">Download works when the app runs from your computer. In the hosted preview, use Copy.</span>
        </div>
        ${(b.warnings || []).length ? `<ul class="flags">${b.warnings.map(w => `<li class="flag review"><b>Check before loading.</b>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${checklist('Before loading: create these contracts in IAS', b.before)}
        <pre class="file" id="file-${esc(b.id)}">${esc(csv)}</pre>
        ${checklist('After loading: book these capitalized interest transactions in IAS', b.after)}
        <h3>Import result</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>${b.kind === 'fee' ? 'Fee' : 'Event'}</th><th class="num">Msgs</th><th>Result</th><th>IAS import browser error</th></tr></thead>
          <tbody>${resultRows}</tbody></table></div>
        ${b.status === 'awaiting'
          ? `<div class="row"><button class="btn primary" data-action="saveResults" data-batch="${esc(b.id)}">Save import result</button><span class="small muted">Failed ${noun} go back to Needs review.</span></div>`
          : `<p class="small muted">Recorded by ${esc(b.resultBy)}, ${fmtTime(b.resultAt)}.</p>`}
      </div>
    </details>`;
  }

  // ---- setup

  function viewSetup() {
    const cards = INPUTS.map(inp => {
      const rows = state.inputs[inp.key] || [];
      const layout = E.LAYOUTS[inp.layout];
      return `<div class="panel panel-pad upload">
        <div class="section-head"><h3>${esc(inp.title)}</h3><span class="small muted">${rows.length} rows loaded</span></div>
        <p class="small">${esc(inp.desc)}</p>
        <div class="cols">${inp.report ? `Loan System contracts report: ${E.REPORT_REQUIRED.map(esc).join(', ')} (optional: ${E.REPORT_OPTIONAL.map(esc).join(', ')}). Or the app's own layout: ${layout.map(esc).join(', ')}` : layout.map(esc).join(', ')}</div>
        ${inp.report ? `<label class="field" for="asof-${inp.key}">As-of date of the report (used when the file name has no date)<input type="date" id="asof-${inp.key}" value="${esc(inp.key === 'prior' ? state.priorAsOfDate : state.asOfDate)}" style="max-width:12rem"></label>` : ''}
        <label class="field" for="file-${inp.key}">Replace with a CSV file<input type="file" id="file-${inp.key}" accept=".csv,text/csv" data-input="${inp.key}"></label>
        <div class="row"><button class="btn ghost" data-action="copyInput" data-input="${inp.key}">Copy current data as CSV</button></div>
      </div>`;
    }).join('');
    const pm = E.normalizePortfolioMap(state.inputs.portfolioMap);
    const tenors = Object.entries(E.TENOR_DAYS).map(([t, [a, b]]) => `${t}: ${a}–${b} days`).join(', ');
    return `
      <section class="section">
        <div class="panel run">
          <dl>
            <div><dt>Data in use</dt><dd>${esc(state.sourceLabel)}</dd></div>
            <div><dt>Run date</dt><dd class="mono">${esc(state.asOfDate)}</dd></div>
            <div><dt>Compared with</dt><dd class="mono">${esc(state.priorAsOfDate)}</dd></div>
          </dl>
          <div class="row">
            <button class="btn primary" data-action="rerun">Run detection</button>
            <button class="btn" data-action="reset" id="reset-btn">Restore sample data</button>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="section-head"><h2>Load your own files</h2><span class="small muted">Files stay in this browser. Nothing is uploaded to a server.</span></div>
        <div class="uploads">${cards}</div>
      </section>
      <section class="section">
        <h2>Settings</h2>
        <div class="panel panel-pad stack">
          <label class="row" for="set-spread-adj" style="align-items:flex-start;gap:10px">
            <input type="checkbox" id="set-spread-adj" ${state.settings && state.settings.addSpreadAdjustment === false ? '' : 'checked'} style="margin-top:3px">
            <span><b>Add Loan System's spreadAdjustment to the IAS spread.</b><br><span class="small muted">IAS can't hold a base rate adjustment, so it is folded into the spread. A change in the adjustment from one period to the next then becomes a contract change. Re-run detection after changing this.</span></span>
          </label>
          <label class="row" for="set-auto-paydown" style="align-items:flex-start;gap:10px">
            <input type="checkbox" id="set-auto-paydown" ${autoApproveSettings().paydowns ? 'checked' : ''} style="margin-top:3px">
            <span><b>Auto-approve paydowns whose units tie out.</b><br><span class="small muted">A paydown with nothing else changing (on its own, or at a clean roll) is approved without a person when, in every portfolio, IAS ties to the Loan System before the event, the redemptions leave IAS tied after it, and the portfolio's paydown is within ${money(E.AUTO_PAYDOWN_SHARE_TOLERANCE)} of its share of the global paydown. Anything flagged for review or an exception is never auto-approved.</span></span>
          </label>
          <label class="row" for="set-auto-paydown-max" style="align-items:center;gap:10px">
            <span><b>Send paydowns larger than</b></span>
            <input type="number" id="set-auto-paydown-max" min="0" max="100" step="0.01" style="width:7em" placeholder="no limit" value="${autoApproveSettings().maxPct ?? ''}">
            <span><b>% of the global amount to review.</b> <span class="small muted">Leave blank for no limit.</span></span>
          </label>
        </div>
      </section>
      <section class="section">
        <h2>Rules in use</h2>
        <div class="panel panel-pad">
          <ul class="rules">
            <li>For each Loan System portfolio and asset, contracts in the prior snapshot that are gone today are <b>expiring</b>; contracts that are new today are <b>new</b>.</li>
            <li>1 expiring → 1 new with the same terms is a <b>rollover</b>. With a different rate type, interest type, base rate, margin, tenor, floor, pay or reset frequency, or day count it is a <b>contract change</b>.</li>
            <li>1 → many is a <b>split</b>, many → 1 is a <b>combine</b>, many → many is a <b>complex restructure</b>. New contracts with nothing expiring are a <b>draw</b>.</li>
            <li>A lower funded total is a <b>paydown</b>; a higher one is a <b>draw</b>, or <b>capitalized interest</b> when the contract's interest type is Capitalize or Partial. These are booked after any split or combine.</li>
            <li>A paydown with nothing else changing, on its own or at a clean roll, is <b>auto-approved</b> when the units tie in every portfolio: IAS ties to the Loan System before, the redemptions leave it tied after, and each portfolio's paydown is within $1.00 of its share of the global paydown. It goes in the next IAS file with no click. Turn this off or cap it by size in Settings; <b>Hold for review</b> takes one out.</li>
            <li>Splits, combines and rolls are dated on the new contracts' <b>start date</b>, and the global action and every portfolio transaction carry that date. New contracts that start on different days, or old contracts that don't end on that day, go to review.</li>
            <li>IAS message order for each event: <b>create</b> new contracts (security master), then for each step one <b>BANKLOANACTION</b> global action with signed global units per contract, then one <b>TaCONTRACTSPLIT</b> or <b>TaCONTRACTCOMBINE</b> per IAS portfolio. A terms change is a new contract plus a 1:1 split; many → many is a combine then a split. New contracts take the Loan System contract ID.</li>
            <li>New contracts are created with one <b>SMFBANKLOANTRANCHE</b> UPDATE per event (minimal contract add), validated before it goes in the file. Paydowns are <b>TaContractRedemption</b> (one per contract per portfolio) and draws are <b>TaDrawDown</b> (one per portfolio, allocated to the contracts drawn into). No fund may redeem more than its funded holding or draw more than its unfunded. Capitalized interest is a manual step until its IAS format is added.</li>
            <li><b>Loan System contracts report</b>: rates are decimals (0.05 = 500 bps), the facility key is <code>primaryIdentifier</code>, the contract is <code>referenceAccrualId</code>, pay frequency comes from <code>numPaymentsPerYear</code> and reset frequency from the SOFR tenor. Funded, Unfunded and Delayed Draw Unfunded rows are used; Letter of Credit rows count toward the commitment only; % of Funded rows are ignored.</li>
            <li><b>Dates</b>: IAS holdings must be as of the same date as the Loan System prior snapshot (end of the previous business day), and the Loan System current snapshot must be later. Otherwise detection stops.</li>
            <li><b>Trades</b> are booked in IAS by the trade feed. A position change with no change in the facility's global amount is a trade: nothing is sent. A new position (not in the prior snapshot) is a <b>new purchase</b>: nothing is sent, but an initial long or short first period goes to review. A trade on the same day as a split, combine or terms change goes to review.</li>
            <li>A change that isn't your share of the global change goes to review.</li>
            <li>A rollover is <b>clean</b> and needs no IAS message when amount and terms match and the new period is regular (${esc(tenors)}).</li>
            <li><b>Exceptions</b>: asset or portfolio not mapped, IAS positions not tying to the Loan System before the event, funded plus unfunded not equal to commitment, term loan draws, draws larger than unfunded, missing IAS contract lineage.</li>
            <li>Amounts are allocated to IAS portfolios pro rata on their current position (funded plus unfunded), with largest-remainder rounding.</li>
            <li><b>Fees</b>: each fee should equal rate × average unfunded × days ÷ 360 (or 365), within the larger of ${money(E.FEE_TOLERANCE.cents)} or ${(E.FEE_TOLERANCE.share * 100).toFixed(1)}%. Otherwise it goes to review.</li>
            <li>Fees go to review when negative or zero, or when IAS's unfunded position today differs from the Loan System's average unfunded by more than ${E.FEE_POSITION_DRIFT * 100}%. Fees on term loans, duplicate rows and unmapped facilities are exceptions.</li>
            <li>Fees are split across IAS portfolios on their current <b>unfunded</b> position in the tranche.</li>
          </ul>
        </div>
      </section>
      <section class="section">
        <h2>Mappings</h2>
        <div class="panel panel-pad stack">
          <details><summary>Portfolio map (${Object.keys(pm).length} Loan System portfolios)</summary>
            <div class="table-wrap"><table><thead><tr><th>Loan System portfolio</th><th>IAS portfolios</th></tr></thead>
            <tbody>${Object.entries(pm).map(([w, p]) => `<tr><td class="mono">${esc(w)}</td><td class="mono">${p.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table></div></details>
          <details><summary>Tranche map (${state.inputs.trancheMap.length} assets)</summary>
            ${simpleTable(state.inputs.trancheMap, E.LAYOUTS.trancheMap)}</details>
          <details><summary>IAS positions (${state.inputs.iasPositions.length} rows)</summary>
            ${simpleTable(state.inputs.iasPositions, E.LAYOUTS.iasPositions, ['Funded', 'Unfunded'])}</details>
          <details><summary>Contract lineage (${Object.keys(state.lineage).length} links, updated as events are approved)</summary>
            <div class="table-wrap"><table><thead><tr><th>Loan System contract</th><th>IAS contract</th></tr></thead>
            <tbody>${Object.entries(state.lineage).map(([w, p]) => `<tr><td class="mono">${esc(w)}</td><td class="mono">${esc(p)}</td></tr>`).join('')}</tbody></table></div></details>
        </div>
      </section>`;
  }

  function simpleTable(rows, cols, numeric = []) {
    return `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th${numeric.includes(c) ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => numeric.includes(c) ? `<td class="num">${money(E.toCents(r[c]))}</td>` : `<td class="mono">${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // ---- audit

  function viewAudit() {
    return `<section class="section">
      <div class="section-head"><h2>Audit log</h2><span class="small muted">Every detection run and decision, newest first.</span></div>
      ${state.audit.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Comment</th></tr></thead>
        <tbody>${state.audit.map(a => `<tr${a.ref && itemByKey(a.ref) ? ` class="clickable" data-key="${esc(a.ref)}" tabindex="0"` : ''}>
          <td class="mono small">${fmtTime(a.at)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.label)}</td><td class="small">${esc(a.note)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="panel empty">Nothing recorded yet.</div>'}
    </section>`;
  }

  // ------------------------------------------------------------------ render

  function render() {
    nameIndex = null;
    renderTabs();
    const main = document.getElementById('main');
    const views = { queue: viewQueue, fees: viewFees, batches: viewBatches, setup: viewSetup, audit: viewAudit };
    main.innerHTML = (views[state.view] || viewQueue)();
    renderDrawer();
    save();
  }

  let toastTimer;
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }

  function copyText(text, label, fallbackEl) {
    const done = () => toast(`Copied ${label}.`);
    const fallback = () => {
      if (fallbackEl) {
        const range = document.createRange();
        range.selectNodeContents(fallbackEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Copy is blocked here. The text is selected; press Ctrl+C or Cmd+C.');
      } else toast('Copy is blocked in this view.');
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
  }

  function download(fileName, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast('Download is blocked here. Use Copy file contents instead.'); }
  }

  // ------------------------------------------------------------------ events

  let resetArmed = false;

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    const row = e.target.closest('tr[data-key]');
    if (!el && row) { openEvent(row.dataset.key); return; }
    if (!el) return;
    const { action, key, batch } = el.dataset;
    switch (action) {
      case 'view': state.view = el.dataset.view; state.selectedKey = null; render(); window.scrollTo(0, 0); return;
      case 'filter': state.filter = el.dataset.group; render(); return;
      case 'feeFilter': state.feeFilter = el.dataset.group; render(); return;
      case 'recheckFees': runFeeCheck(); state.view = 'fees'; render(); return;
      case 'close': state.selectedKey = null; render(); return;
      case 'rerun': runDetection(); state.view = 'queue'; render(); return;
      case 'openBatch': state.view = 'batches'; state.selectedBatch = batch; state.selectedKey = null; render(); return;
      case 'copyMessages': {
        const ev = itemByKey(state.selectedKey);
        if (ev && ev.kind === 'fee') copyText(E.toCSV(ev.messages, E.LAYOUTS.iasFeeImport.slice(2)), `${ev.messages.length} messages`);
        else if (ev) copyText(fileMsgs(ev).map(m => `${E.iasMessageText(m, { ccid: 'TBD' })}\n`).join(''), `${fileMsgs(ev).length} messages`);
        return;
      }
      case 'copyBatch': {
        const b = state.batches.find(x => x.id === batch);
        if (b) copyText(batchContent(b), b.fileName, document.getElementById(`file-${b.id}`));
        return;
      }
      case 'downloadBatch': {
        const b = state.batches.find(x => x.id === batch);
        if (b) download(b.fileName, batchContent(b));
        return;
      }
      case 'saveLink': {
        const ev = itemByKey(key);
        const contract = el.dataset.contract;
        const value = (document.getElementById(`link-${contract}`)?.value || '').trim();
        if (!ev || !requireUser()) return;
        if (!value) { toast('Type the IAS contract ID first.'); return; }
        const before = state.lineage[contract];
        if (before === value) { toast('That link is already saved.'); return; }
        state.lineage[contract] = value;
        log(before ? 'Changed contract link' : 'Linked contract', ev.key, eventLabel(ev), `${contract} → ${value}${before ? ` (was ${before})` : ''}`);
        render();
        toast(`Linked ${contract} to IAS contract ${value}.`);
        return;
      }
      case 'downloadLineage': {
        const x = eodLineage();
        download(x.fileName, x.csv);
        log('Exported contract lineage', '', x.fileName, `${x.rows.length} links${x.unlinked.length ? `, ${x.unlinked.length} live contracts not linked` : ''}`);
        save();
        return;
      }
      case 'copyLineage': {
        const x = eodLineage();
        copyText(x.csv, x.fileName, document.getElementById('lineage-file'));
        return;
      }
      case 'copyInput': {
        const inp = INPUTS.find(i => i.key === el.dataset.input);
        copyText(E.toCSV(state.inputs[inp.key], E.LAYOUTS[inp.layout]), inp.title.toLowerCase());
        return;
      }
      case 'reset':
        if (!resetArmed) {
          resetArmed = true;
          el.textContent = 'Click again to clear all decisions and restore the sample';
          el.classList.add('danger');
          setTimeout(() => { resetArmed = false; if (el.isConnected) { el.textContent = 'Restore sample data'; el.classList.remove('danger'); } }, 5000);
          return;
        }
        resetArmed = false;
        state = freshState();
        state.view = 'queue';
        runDetection({ quiet: true });
        runFeeCheck({ quiet: true });
        render();
        toast('Sample data restored. All decisions were cleared.');
        return;
      case 'saveResults': actions.saveResults(batch); render(); return;
      default:
        if (actions[action]) { actions[action](key); render(); }
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.selectedKey) { state.selectedKey = null; render(); return; }
    if (e.key === 'Enter' && e.target.matches('tr[data-key]')) openEvent(e.target.dataset.key);
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'user-name') { state.user = e.target.value; save(); }
    if (e.target.id === 'queue-search') {
      state.search = e.target.value;
      document.getElementById('queue-table').innerHTML = queueTable();
      save();
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'eod-all-links') { state.eodAllLinks = e.target.checked; save(); render(); return; }
    if (e.target.id === 'set-auto-paydown' || e.target.id === 'set-auto-paydown-max') {
      const raw = document.getElementById('set-auto-paydown-max').value.trim();
      const maxPct = raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
      state.settings = { ...(state.settings || {}), autoApprovePaydowns: document.getElementById('set-auto-paydown').checked, autoPaydownMaxPct: maxPct };
      const s2 = autoApproveSettings();
      log('Changed setting', '', 'Paydown auto-approval', s2.paydowns ? `On${s2.maxPct !== null ? `, paydowns over ${s2.maxPct}% go to review` : ', no size limit'}` : 'Off');
      save();
      toast('Setting saved. Re-run detection to apply it.');
      return;
    }
    if (e.target.id === 'set-spread-adj') {
      state.settings = { ...(state.settings || {}), addSpreadAdjustment: e.target.checked };
      log('Changed setting', '', 'Spread adjustment', e.target.checked ? 'Added to the IAS spread' : 'Not added to the IAS spread');
      save();
      toast('Setting saved. Re-run detection to apply it.');
      return;
    }
    const key = e.target.dataset && e.target.dataset.input;
    if (!key || !e.target.files || !e.target.files[0]) return;
    const inp = INPUTS.find(i => i.key === key);
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      let rows = E.parseCSV(reader.result);
      if (inp.report && E.isLoanReport(rows.headers)) {
        const missingReport = E.missingReportColumns(rows.headers);
        if (missingReport.length) { toast(`${file.name} is missing report columns: ${missingReport.join(', ')}. Nothing was loaded.`); e.target.value = ''; return; }
        const m = file.name.match(/(20\d{2})-?(\d{2})-?(\d{2})/);
        const asOfDate = m ? `${m[1]}-${m[2]}-${m[3]}` : (document.getElementById(`asof-${key}`)?.value || '');
        if (!asOfDate) { toast('Set the as-of date of the report first, or put the date in the file name.'); e.target.value = ''; return; }
        const converted = E.fromLoanReport(rows, { asOfDate });
        if (converted.notes.length) toast(`Loaded with values the app doesn't recognise: ${converted.notes.join('; ')}.`);
        const headers = E.LAYOUTS.loanSystem;
        rows = converted.rows;
        rows.headers = headers;
      }
      const missing = E.missingColumns(rows.headers, E.LAYOUTS[inp.layout]);
      if (missing.length) { toast(`${file.name} is missing columns: ${missing.join(', ')}. Nothing was loaded.`); e.target.value = ''; return; }
      if (!rows.length) { toast(`${file.name} has headers but no rows. Nothing was loaded.`); e.target.value = ''; return; }
      state.inputs[key] = rows.map(r => ({ ...r }));
      if (key === 'fees') state.feeLabel = `Uploaded: ${file.name}`;
      else state.sourceLabel = 'Uploaded files';
      if (key === 'lineage') state.lineage = E.normalizeLineage(rows);
      if (key === 'current' || key === 'prior') {
        const dates = rows.map(r => E.normalizeDate(r.AsOfDate)).filter(Boolean).sort();
        if (dates.length) state[key === 'current' ? 'asOfDate' : 'priorAsOfDate'] = dates[dates.length - 1];
      }
      log('Loaded file', '', inp.title, `${file.name}, ${rows.length} rows`);
      render();
      if (key === 'fees') { runFeeCheck(); state.view = 'fees'; render(); return; }
      toast(`Loaded ${rows.length} rows from ${file.name}. Run detection to use it.`);
    };
    reader.onerror = () => toast(`Could not read ${file.name}.`);
    reader.readAsText(file);
  });

  function openEvent(key) {
    state.selectedKey = key;
    render();
    document.getElementById('drawer-close')?.focus();
  }

  render();
})();
