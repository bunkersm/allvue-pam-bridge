/*
 * Loan Event Bridge UI. Plain DOM rendering over a single state object that
 * is saved to this browser's localStorage. All business rules live in engine.js.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const S = window.SampleData;
  const STORE_KEY = 'loan-event-bridge:v1';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = E.formatMoney;
  const now = () => new Date().toISOString();
  const fmtTime = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const STATUS = {
    verified: { label: 'Clean, no PAM action', chip: 'c-auto', group: 'auto' },
    pending: { label: 'Needs review', chip: 'c-review', group: 'review' },
    failed: { label: 'Import failed', chip: 'c-exception', group: 'review' },
    exception: { label: 'Exception', chip: 'c-exception', group: 'exception' },
    approved: { label: 'Approved', chip: 'c-approved', group: 'approved' },
    in_batch: { label: 'In PAM file', chip: 'c-batch', group: 'batch' },
    loaded: { label: 'Loaded in PAM', chip: 'c-loaded', group: 'done' },
    closed: { label: 'Approved, nothing to send', chip: 'c-done', group: 'done' },
    rejected: { label: 'Rejected', chip: 'c-done', group: 'done' },
    manual: { label: 'Handled outside the app', chip: 'c-done', group: 'done' },
  };
  // Statuses set by the system from the detection route; anything else is a person's decision and survives a re-run.
  const SYSTEM_STATUSES = new Set(['pending', 'exception']);

  const GROUPS = [
    { id: 'review', label: 'Needs review', desc: 'Approve or reject', cls: 't-review' },
    { id: 'exception', label: 'Exceptions', desc: 'Data or setup to fix', cls: 't-exception' },
    { id: 'auto', label: 'Clean rollovers', desc: 'Verified, nothing to send', cls: 't-auto' },
    { id: 'approved', label: 'Approved', desc: 'Waiting for a PAM file', cls: 't-approved' },
    { id: 'batch', label: 'Awaiting import', desc: 'In a PAM file', cls: 't-batch' },
    { id: 'done', label: 'Done', desc: 'Loaded, closed or rejected', cls: 't-done' },
    { id: 'all', label: 'All events', desc: 'Everything detected', cls: '' },
  ];

  const INPUTS = [
    { key: 'prior', title: 'WSO contracts, prior day', layout: 'wso', desc: 'Contract-level export from the previous business day. Detection compares it with the current day.' },
    { key: 'current', title: 'WSO contracts, current day', layout: 'wso', desc: 'Same export for the day you are processing. Its AsOfDate becomes the run date.' },
    { key: 'portfolioMap', title: 'Portfolio map', layout: 'portfolioMap', desc: 'One row per PAM portfolio fed by a WSO portfolio.' },
    { key: 'trancheMap', title: 'Tranche map', layout: 'trancheMap', desc: 'Links each WSO asset to its PAM facility tranche.' },
    { key: 'pamPositions', title: 'PAM positions', layout: 'pamPositions', desc: 'Funded and unfunded position per PAM portfolio and tranche. Used for tie-out and allocation.' },
    { key: 'lineage', title: 'Contract lineage', layout: 'lineage', desc: 'Which PAM contract each live WSO contract represents.' },
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
  if (!state) { state = freshState(); runDetection({ quiet: true }); }

  const statusOf = ev => (state.status[ev.key] || {}).status || 'pending';
  const statusInfo = ev => state.status[ev.key] || {};
  const eventByKey = key => state.events.find(e => e.key === key);
  const eventLabel = ev => `${ev.typeLabel}, ${ev.assetName} (${ev.wsoPortfolio})`;

  function log(action, ref, label, note) {
    state.audit.unshift({ at: now(), user: state.user || 'Unknown user', action, ref: ref || '', label: label || '', note: note || '' });
  }

  function setStatus(key, status, note, extra = {}) {
    state.status[key] = { ...state.status[key], status, note: note || '', at: now(), by: state.user, ...extra };
  }

  function applyLineage(ev) { ev.lineageUpdates.forEach(u => { state.lineage[u.wsoContractId] = u.pamContractId; }); }
  function removeLineage(ev) { ev.lineageUpdates.forEach(u => { delete state.lineage[u.wsoContractId]; }); }

  // ------------------------------------------------------------------ detection

  function runDetection({ quiet } = {}) {
    let events;
    try {
      const i = state.inputs;
      events = E.detectEvents({
        asOfDate: state.asOfDate,
        prior: E.normalizeWso(i.prior),
        current: E.normalizeWso(i.current),
        trancheMap: E.normalizeTrancheMap(i.trancheMap),
        portfolioMap: E.normalizePortfolioMap(i.portfolioMap),
        pamPositions: E.normalizePamPositions(i.pamPositions),
        lineage: state.lineage,
      });
    } catch (err) {
      toast(`Detection stopped: ${err.message}. Check the uploaded files on the Setup tab.`);
      return;
    }

    let kept = 0;
    events.forEach(ev => {
      const existing = state.status[ev.key];
      if (existing && !SYSTEM_STATUSES.has(existing.status)) { kept++; return; }
      const status = ev.route === 'auto' ? 'verified' : ev.route === 'exception' ? 'exception' : 'pending';
      state.status[ev.key] = { status, at: now(), by: 'Detection' };
      if (status === 'verified') applyLineage(ev);
    });
    state.events = events;

    const counts = { auto: 0, review: 0, exception: 0 };
    events.forEach(ev => { counts[ev.route]++; });
    state.lastRun = { at: now(), total: events.length, ...counts };
    const summary = `${events.length} events: ${counts.auto} clean rollovers, ${counts.review} for review, ${counts.exception} exceptions`;
    log('Ran detection', '', `${state.priorAsOfDate} to ${state.asOfDate}`, summary + (kept ? `. ${kept} already decided, kept as they were.` : ''));
    if (!quiet) toast(`Detection finished. ${summary}.`);
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
      const ev = eventByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      setStatus(key, ev.messages.length ? 'approved' : 'closed', note);
      applyLineage(ev);
      log('Approved', key, eventLabel(ev), note);
      toast(ev.messages.length ? `Approved. ${ev.messages.length} PAM messages will go in the next file.` : 'Approved. Nothing is sent to PAM for this event.');
    },
    reject(key) {
      const ev = eventByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      if (!note) { toast('Add a comment saying why before rejecting.'); document.getElementById('comment')?.focus(); return; }
      setStatus(key, 'rejected', note);
      log('Rejected', key, eventLabel(ev), note);
      toast('Rejected. Nothing will be sent to PAM.');
    },
    manual(key) {
      const ev = eventByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      if (!note) { toast('Add a comment saying how it was handled.'); document.getElementById('comment')?.focus(); return; }
      setStatus(key, 'manual', note);
      log('Marked handled outside the app', key, eventLabel(ev), note);
      toast('Recorded as handled outside the app.');
    },
    unapprove(key) {
      const ev = eventByKey(key);
      if (!ev) return;
      setStatus(key, 'pending', '');
      removeLineage(ev);
      log('Undid approval', key, eventLabel(ev));
      toast('Approval undone. The event is back in review.');
    },
    reapprove(key) {
      const ev = eventByKey(key);
      if (!ev || !requireUser()) return;
      const note = commentValue();
      setStatus(key, 'approved', note, { batchId: null, error: null });
      log('Re-approved after failed import', key, eventLabel(ev), note);
      toast('Re-approved. It will go in the next PAM file.');
    },
    createBatch() {
      const evs = state.events.filter(e => statusOf(e) === 'approved');
      if (!evs.length) { toast('No approved events are waiting for a file.'); return; }
      if (!requireUser()) return;
      const n = state.batches.filter(b => b.asOfDate === state.asOfDate).length + 1;
      const id = `B${state.asOfDate.replace(/-/g, '')}-${String(n).padStart(2, '0')}`;
      const rows = E.buildBatchRows(evs, id);
      state.batches.unshift({
        id,
        fileName: `PAM_IMPORT_${id}.csv`,
        asOfDate: state.asOfDate,
        createdAt: now(),
        createdBy: state.user,
        events: evs.map(e => ({ key: e.key, label: eventLabel(e), messages: e.messages.length })),
        rows,
        status: 'awaiting',
        results: {},
      });
      evs.forEach(e => setStatus(e.key, 'in_batch', '', { batchId: id }));
      log('Created PAM file', id, `PAM_IMPORT_${id}.csv`, `${evs.length} events, ${rows.length} messages`);
      state.selectedBatch = id;
      state.view = 'batches';
      state.selectedKey = null;
      toast(`Created ${id} with ${rows.length} messages. Import it through PAM's import browser, then record the result.`);
    },
    saveResults(batchId) {
      const batch = state.batches.find(b => b.id === batchId);
      if (!batch || !requireUser()) return;
      let failed = 0;
      for (const [i, item] of batch.events.entries()) {
        const result = document.getElementById(`result-${batchId}-${i}`)?.value || 'loaded';
        const error = (document.getElementById(`error-${batchId}-${i}`)?.value || '').trim();
        if (result === 'failed' && !error) {
          toast('Paste the PAM import browser error for each failed event.');
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
      toast(failed ? `${failed} ${failed === 1 ? 'event' : 'events'} marked failed. They are back in Needs review to fix and re-approve.` : 'All events marked loaded in PAM.');
    },
  };

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
    const tabCounts = { queue: counts.review + counts.exception, batches: open, setup: 0, audit: 0 };
    document.querySelectorAll('.tab').forEach(t => {
      const v = t.dataset.view;
      t.setAttribute('aria-selected', String(state.view === v));
      const c = t.querySelector('.count');
      if (c) { c.textContent = tabCounts[v]; c.hidden = !tabCounts[v]; }
    });
    const user = document.getElementById('user-name');
    if (user && document.activeElement !== user) user.value = state.user;
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
            <div><dt>WSO snapshots</dt><dd class="mono">${esc(state.priorAsOfDate)} → ${esc(state.asOfDate)}</dd></div>
            <div><dt>Source</dt><dd>${esc(state.sourceLabel)}</dd></div>
            <div><dt>Last detection</dt><dd>${run ? `${fmtTime(run.at)}, ${run.total} events` : 'Not run yet'}</dd></div>
          </dl>
          <div class="row">
            <button class="btn" data-action="rerun">Re-run detection</button>
            <button class="btn" data-action="view" data-view="setup">Load files</button>
          </div>
        </div>
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
      const hay = [ev.assetName, ev.assetId, ev.wsoPortfolio, ev.typeLabel, ...ev.expired.map(c => c.contractId), ...ev.added.map(c => c.contractId), ...ev.amended.map(a => a.cur.contractId)].join(' ').toLowerCase();
      return hay.includes(q);
    });
    if (!rows.length) {
      const msg = q ? 'No events match that search.' : state.filter === 'review' ? 'Nothing waiting for review.' : 'No events in this group.';
      return `<div class="table-wrap"><div class="empty">${msg}</div></div>`;
    }
    return `<div class="table-wrap"><table>
      <thead><tr><th>Status</th><th>Event</th><th>Asset</th><th>WSO portfolio</th><th>Effective</th><th>WSO contracts</th><th class="num">Funded change</th><th class="num">PAM msgs</th><th>Checks</th></tr></thead>
      <tbody>${rows.map(ev => {
        const st = statusOf(ev);
        const info = statusInfo(ev);
        return `<tr class="clickable${state.selectedKey === ev.key ? ' selected' : ''}" data-key="${esc(ev.key)}" tabindex="0">
          <td>${chip(st)}</td>
          <td><span class="type">${esc(ev.typeLabel)}</span> ${ev.legs.map(l => `<span class="tag">+ ${esc(E.TYPE_LABELS[l].toLowerCase())}</span>`).join(' ')}
            ${st === 'failed' && info.error ? `<div class="small" style="color:var(--bad)">${esc(info.error)}</div>` : ''}</td>
          <td>${esc(ev.assetName)}<div class="muted small"><span class="mono">${esc(ev.assetId)}</span> · ${esc(ev.facilityType)}</div></td>
          <td class="mono">${esc(ev.wsoPortfolio)}</td>
          <td class="mono">${esc(ev.effectiveDate)}</td>
          <td class="mono">${esc(contractsSummary(ev))}</td>
          <td class="num">${deltaCell(ev.totals.fundedDelta)}</td>
          <td class="num">${ev.messages.length || '<span class="muted">0</span>'}</td>
          <td class="small">${ev.flags.some(f => f.level === 'exception') ? `<span style="color:var(--bad)">${issueCount(ev)}</span>` : issueCount(ev) ? `<span style="color:var(--warn)">${issueCount(ev)}</span>` : '<span class="muted">Passed</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // ---- event detail

  function describe(ev) {
    const c = x => `<span class="mono">${esc(x.contractId)}</span>`;
    const t = ev.totals;
    const amt = x => `${money(x.amount)} (${esc(x.tenor)})`;
    const diffText = diffs => diffs.map(d => `${esc(d.label)} ${esc(d.from)} → ${esc(d.to)}`).join(', ');
    const legText = t.fundedDelta < 0 ? ` and was paid down by ${money(-t.fundedDelta)}` : t.fundedDelta > 0 ? ` with a draw of ${money(t.fundedDelta)}` : '';
    switch (ev.type) {
      case 'ROLLOVER':
        if (ev.route === 'auto') return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])} with the same amount and terms. PAM accrues from the contract attributes, so nothing is sent.`;
        if (ev.legs.length) return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])}${legText}. Terms are unchanged, so PAM only needs the ${ev.legs[0] === 'PAYDOWN' ? 'paydown' : 'draw'}.`;
        return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])} with the same terms, but a check needs your attention. Nothing is sent to PAM; approving confirms PAM's schedule is acceptable or that you will adjust it in PAM.`;
      case 'CONTRACT_CHANGE':
        if (ev.expired.length) return `Contract ${c(ev.expired[0])} rolled into ${c(ev.added[0])}${legText} with new terms: ${diffText(ev.rollTermChanges)}. PAM gets a contract change on the existing contract.`;
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
      default:
        return `Commitment changed from ${money(t.commitmentBefore)} to ${money(t.commitmentAfter)}.`;
    }
  }

  function contractTable(ev) {
    const pamFor = id => state.lineage[id] || '';
    const ref = ev.expired[0];
    const rows = [];
    ev.expired.forEach(cn => rows.push({ side: 'Expiring', c: cn }));
    ev.added.forEach(cn => rows.push({ side: 'New', c: cn, cmp: ref }));
    ev.amended.forEach(a => { rows.push({ side: 'Before', c: a.prev }); rows.push({ side: 'After', c: a.cur, cmp: a.prev }); });
    ev.unchanged.forEach(cn => rows.push({ side: 'Unchanged', c: cn }));
    const fields = ['tenor', 'marginBps', 'floorPct', 'payFreq', 'resetFreq', 'dayCount'];
    const cell = (r, f, val, cls = '') => {
      const changed = r.cmp && String(r.cmp[f]) !== String(r.c[f]);
      return `<td class="${cls}${changed ? ' changed' : ''}">${esc(val)}</td>`;
    };
    return `<div class="table-wrap"><table>
      <thead><tr><th></th><th>WSO contract</th><th>PAM contract</th><th>Period</th><th class="num">Days</th><th class="num">Amount</th><th>Tenor</th><th class="num">Margin</th><th class="num">Floor</th><th>Pay</th><th>Reset</th><th>Day count</th></tr></thead>
      <tbody>${rows.map(r => {
        const days = E.daysBetween(r.c.startDate, r.c.endDate);
        const range = E.TENOR_DAYS[r.c.tenor];
        const irregular = r.side === 'New' && range && (days < range[0] || days > range[1]);
        const pending = ev.lineageUpdates.find(u => u.wsoContractId === r.c.contractId);
        const pam = pamFor(r.c.contractId) || (pending ? pending.pamContractId : '');
        return `<tr>
          <td class="small muted">${r.side}</td>
          <td class="mono">${esc(r.c.contractId)}</td>
          <td class="mono">${esc(pam) || '<span class="muted">none</span>'}</td>
          <td class="mono nowrap">${esc(r.c.startDate)} → ${esc(r.c.endDate)}</td>
          <td class="num${irregular ? ' changed' : ''}">${days}</td>
          ${cell(r, 'amount', money(r.c.amount), 'num')}
          ${fields.map(f => cell(r, f, f === 'floorPct' ? Number(r.c[f]).toFixed(2) : r.c[f], f === 'marginBps' || f === 'floorPct' ? 'num' : '')).join('')}
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function allocationTable(ev) {
    if (!ev.allocationBasis.length) return '<p class="muted">No allocation: the asset or portfolio is not mapped to PAM.</p>';
    const basis = ev.allocationBasis;
    const total = basis.reduce((s, b) => s + b.weight, 0);
    const head = basis.map(b => `<th class="num">${esc(b.pamPortfolio)}<div class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">${total ? (b.weight / total * 100).toFixed(2) : '0.00'}%</div></th>`).join('');
    const posRow = `<tr><td class="small muted">PAM position before event<br>(funded + unfunded)</td>${basis.map(b => `<td class="num">${money(b.weight)}</td>`).join('')}<td class="num">${money(total)}</td><td></td></tr>`;
    const lineRows = ev.lines.map(l => {
      const parts = basis.map(b => (l.allocation ? l.allocation[b.pamPortfolio] ?? 0 : 0));
      const sum = parts.reduce((s, v) => s + v, 0);
      const ties = l.allocation && sum === l.amount;
      return `<tr><td><span class="mono">${esc(l.messageType)}</span><div class="small muted">${esc(l.note)}</div></td>
        ${parts.map(p => `<td class="num">${money(p)}</td>`).join('')}
        <td class="num">${money(l.amount)}</td>
        <td class="small" style="color:${ties ? 'var(--ok)' : 'var(--bad)'}">${l.allocation ? (ties ? 'Ties to WSO' : `Off by ${money(sum - l.amount)}`) : 'Not allocated'}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table>
      <thead><tr><th>Line</th>${head}<th class="num">WSO amount</th><th>Check</th></tr></thead>
      <tbody>${posRow}${lineRows || `<tr><td colspan="${basis.length + 3}" class="muted">Nothing to allocate: this event sends no PAM messages.</td></tr>`}</tbody>
    </table></div>
    <p class="small muted">Split pro rata on each PAM portfolio's position in tranche <span class="mono">${esc(ev.pamTrancheId)}</span>, using largest-remainder rounding so every line adds back to the WSO amount to the cent.</p>`;
  }

  function messageTable(ev) {
    if (!ev.messages.length) return '<p class="muted">No PAM messages for this event.</p>';
    return `<div class="table-wrap"><table>
      <thead><tr><th>Message</th><th>PAM portfolio</th><th>PAM contract</th><th>Target ref</th><th class="num">Amount</th><th>Tenor</th><th class="num">Margin</th><th>Pay</th><th>Reset</th></tr></thead>
      <tbody>${ev.messages.map(m => `<tr>
        <td class="mono">${esc(m.MessageType)}</td><td class="mono">${esc(m.PAMPortfolio)}</td><td class="mono">${esc(m.PAMContractID) || '<span class="muted">new</span>'}</td>
        <td class="mono">${esc(m.TargetContractRef)}</td><td class="num">${money(E.toCents(m.Amount))}</td><td>${esc(m.Tenor)}</td>
        <td class="num">${esc(m.MarginBps)}</td><td>${esc(m.PayFreq)}</td><td>${esc(m.ResetFreq)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function actionsFor(ev) {
    const st = statusOf(ev);
    const info = statusInfo(ev);
    const by = info.by && info.at ? `${esc(info.by)}, ${fmtTime(info.at)}` : '';
    const note = info.note ? `<p class="small">“${esc(info.note)}”</p>` : '';
    const comment = placeholder => `<label class="field" for="comment">Comment<textarea id="comment" placeholder="${esc(placeholder)}"></textarea></label>`;
    switch (st) {
      case 'pending':
        return `${comment('Optional for approval, required to reject')}
          <div class="row">
            <button class="btn primary" data-action="approve" data-key="${esc(ev.key)}">${ev.messages.length ? `Approve, ${ev.messages.length} PAM messages` : 'Approve, nothing to send'}</button>
            <button class="btn danger" data-action="reject" data-key="${esc(ev.key)}">Reject</button>
          </div>`;
      case 'exception':
        return `<p class="small">This event can't be approved until the problem above is fixed. Correct the data or setup, then re-run detection. If you booked it in PAM yourself, record that here.</p>
          ${comment('How was it handled?')}
          <div class="row"><button class="btn" data-action="manual" data-key="${esc(ev.key)}">Mark as handled outside the app</button></div>`;
      case 'failed':
        return `<p class="small"><b>PAM rejected this in file ${esc(info.batchId || '')}:</b> ${esc(info.error || '')}</p>
          ${comment('What did you fix?')}
          <div class="row">
            <button class="btn primary" data-action="reapprove" data-key="${esc(ev.key)}">Re-approve for the next PAM file</button>
            <button class="btn" data-action="manual" data-key="${esc(ev.key)}">Mark as handled outside the app</button>
          </div>`;
      case 'approved':
        return `<p class="small">Approved by ${by}. It goes into the next PAM file.</p>${note}
          <div class="row">
            <button class="btn primary" data-action="createBatch">Create PAM file now</button>
            <button class="btn" data-action="unapprove" data-key="${esc(ev.key)}">Undo approval</button>
          </div>`;
      case 'in_batch':
        return `<p class="small">In PAM file <span class="mono">${esc(info.batchId)}</span>, waiting for the import result.</p>
          <div class="row"><button class="btn" data-action="openBatch" data-batch="${esc(info.batchId)}">Open PAM file</button></div>`;
      case 'verified':
        return `<p class="small">Verified automatically by detection. Amount, terms and period length match, so PAM needs no message. The new WSO contract now links to the same PAM contract.</p>`;
      default:
        return `<p class="small">${chip(st)} ${by ? `by ${by}` : ''}</p>${note}`;
    }
  }

  function renderDrawer() {
    const root = document.getElementById('drawer-root');
    const ev = state.selectedKey && eventByKey(state.selectedKey);
    if (!ev) { root.innerHTML = ''; return; }
    const t = ev.totals;
    const history = state.audit.filter(a => a.ref === ev.key);
    const flagLabel = { exception: 'Exception', review: 'Review', info: 'Note' };
    root.innerHTML = `
      <div class="backdrop" data-action="close"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(eventLabel(ev))}">
        <header class="drawer-head">
          <div class="title-row">
            <div><div class="eyebrow">${esc(ev.typeLabel)} · ${esc(ev.facilityType)} · ${esc(ev.wsoPortfolio)}</div><h2>${esc(ev.assetName)}</h2></div>
            <button class="btn" data-action="close" id="drawer-close">Close</button>
          </div>
          <div class="row">${chip(statusOf(ev))} ${ev.legs.map(l => `<span class="tag">+ ${esc(E.TYPE_LABELS[l].toLowerCase())}</span>`).join(' ')} <span class="small muted">Effective <span class="mono">${esc(ev.effectiveDate)}</span></span></div>
        </header>
        <div class="drawer-body">
          <section><p>${describe(ev)}</p></section>
          ${ev.flags.length ? `<section><h3>Checks</h3><ul class="flags">${ev.flags.map(f => `<li class="flag ${f.level}"><b>${flagLabel[f.level]}.</b>${esc(f.text)}</li>`).join('')}</ul></section>` : ''}
          <section><h3>WSO contracts</h3>${contractTable(ev)}<p class="small muted">Highlighted cells differ from the expiring contract, or show an irregular period length.</p></section>
          <section><h3>Tranche totals in ${esc(ev.wsoPortfolio)}</h3>
            <dl class="kv">
              <div><dt>Funded</dt><dd class="figure">${money(t.fundedBefore)} → ${money(t.fundedAfter)}</dd><dd class="small">${deltaCell(t.fundedDelta)}</dd></div>
              <div><dt>Unfunded</dt><dd class="figure">${money(t.unfundedBefore)} → ${money(t.unfundedAfter)}</dd></div>
              <div><dt>Commitment</dt><dd class="figure">${money(t.commitmentBefore)} → ${money(t.commitmentAfter)}</dd></div>
              <div><dt>PAM tranche</dt><dd class="mono">${esc(ev.pamTrancheId) || 'Not mapped'}</dd></div>
            </dl></section>
          <section><h3>Allocation to PAM portfolios</h3>${allocationTable(ev)}</section>
          <section><div class="section-head"><h3>PAM messages</h3>${ev.messages.length ? '<button class="btn ghost" data-action="copyMessages">Copy as CSV</button>' : ''}</div>${messageTable(ev)}</section>
          <section><h3>Event key</h3><p class="mono small" style="word-break:break-all">${esc(ev.key)}</p><p class="small muted">The same WSO change always produces the same key, so re-running detection never creates a duplicate.</p></section>
          ${history.length ? `<section><h3>History</h3><ul class="flags">${history.map(h => `<li class="flag info"><b>${esc(h.action)}</b> by ${esc(h.user)}, ${fmtTime(h.at)}${h.note ? `. “${esc(h.note)}”` : ''}</li>`).join('')}</ul></section>` : ''}
        </div>
        <footer class="actions">${actionsFor(ev)}</footer>
      </aside>`;
  }

  // ---- batches

  function viewBatches() {
    const ready = state.events.filter(e => statusOf(e) === 'approved');
    const msgCount = ready.reduce((s, e) => s + e.messages.length, 0);
    const list = state.batches.map(b => batchPanel(b)).join('');
    return `
      <section class="section">
        <div class="panel run">
          <div class="stack">
            <h2>${ready.length ? `${ready.length} approved ${ready.length === 1 ? 'event' : 'events'} ready for a PAM file` : 'No approved events waiting'}</h2>
            <p class="muted small">${ready.length ? `${msgCount} messages. ` : ''}Create the file, import it through PAM's import browser, then record which messages loaded.</p>
          </div>
          <button class="btn primary" data-action="createBatch" ${ready.length ? '' : 'disabled'}>Create PAM import file</button>
        </div>
      </section>
      <section class="section">
        <div class="section-head"><h2>PAM files</h2><span class="muted small">Layout is a placeholder until the real PAM import formats are added.</span></div>
        ${list || '<div class="panel empty">No PAM files yet. Approve events in the queue, then create a file here.</div>'}
      </section>`;
  }

  function batchPanel(b) {
    const statusChip = b.status === 'awaiting' ? '<span class="chip c-batch">Waiting for import result</span>'
      : b.status === 'loaded' ? '<span class="chip c-loaded">All loaded</span>'
        : '<span class="chip c-exception">Some messages failed</span>';
    const open = state.selectedBatch === b.id || (!state.selectedBatch && b === state.batches[0]);
    const csv = E.toCSV(b.rows, E.LAYOUTS.pamImport);
    const resultRows = b.events.map((item, i) => {
      const r = b.results[item.key];
      if (b.status !== 'awaiting') {
        return `<tr><td>${esc(item.label)}</td><td class="num">${item.messages}</td><td>${r && r.result === 'failed' ? '<span class="chip c-exception">Failed</span>' : '<span class="chip c-loaded">Loaded</span>'}</td><td class="small">${esc(r ? r.error : '')}</td></tr>`;
      }
      return `<tr><td>${esc(item.label)}</td><td class="num">${item.messages}</td>
        <td><select id="result-${esc(b.id)}-${i}" aria-label="Import result"><option value="loaded">Loaded</option><option value="failed">Failed</option></select></td>
        <td><input type="text" id="error-${esc(b.id)}-${i}" placeholder="PAM error, if failed" aria-label="PAM error"></td></tr>`;
    }).join('');
    return `<details class="panel panel-pad batch" ${open ? 'open' : ''}>
      <summary><span class="batch-head" style="display:inline-flex;width:calc(100% - 20px)">
        <span><span class="mono" style="font-weight:600">${esc(b.id)}</span> <span class="muted small">${esc(b.fileName)}</span></span>
        <span class="row">${statusChip}<span class="small muted">${b.events.length} events, ${b.rows.length} messages · ${esc(b.createdBy)}, ${fmtTime(b.createdAt)}</span></span>
      </span></summary>
      <div class="stack">
        <div class="row">
          <button class="btn" data-action="copyBatch" data-batch="${esc(b.id)}">Copy file contents</button>
          <button class="btn" data-action="downloadBatch" data-batch="${esc(b.id)}">Download .csv</button>
          <span class="small muted">Download works when the app runs from your computer. In the hosted preview, use Copy.</span>
        </div>
        <pre class="file" id="file-${esc(b.id)}">${esc(csv)}</pre>
        <h3>Import result</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Event</th><th class="num">Msgs</th><th>Result</th><th>PAM import browser error</th></tr></thead>
          <tbody>${resultRows}</tbody></table></div>
        ${b.status === 'awaiting'
          ? `<div class="row"><button class="btn primary" data-action="saveResults" data-batch="${esc(b.id)}">Save import result</button><span class="small muted">Failed events go back to Needs review.</span></div>`
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
        <div class="cols">${layout.map(esc).join(', ')}</div>
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
            <button class="btn" data-action="reset" id="reset-btn">Restore sample month-end</button>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="section-head"><h2>Load your own files</h2><span class="small muted">Files stay in this browser. Nothing is uploaded to a server.</span></div>
        <div class="uploads">${cards}</div>
      </section>
      <section class="section">
        <h2>Rules in use</h2>
        <div class="panel panel-pad">
          <ul class="rules">
            <li>For each WSO portfolio and asset, contracts in the prior snapshot that are gone today are <b>expiring</b>; contracts that are new today are <b>new</b>.</li>
            <li>1 expiring → 1 new with the same terms is a <b>rollover</b>. With different margin, tenor, floor, pay or reset frequency, or day count it is a <b>contract change</b>.</li>
            <li>1 → many is a <b>split</b>, many → 1 is a <b>combine</b>, many → many is a <b>complex restructure</b>. New contracts with nothing expiring are a <b>draw</b>.</li>
            <li>A lower funded total is a <b>paydown</b>; a higher one is a <b>draw</b>. These are booked before any restructure message.</li>
            <li>A rollover is <b>clean</b> and needs no PAM message when amount and terms match and the new period is regular (${esc(tenors)}).</li>
            <li><b>Exceptions</b>: asset or portfolio not mapped, PAM positions not tying to WSO before the event, funded plus unfunded not equal to commitment, term loan draws, draws larger than unfunded, missing PAM contract lineage.</li>
            <li>Amounts are allocated to PAM portfolios pro rata on their current position (funded plus unfunded), with largest-remainder rounding.</li>
          </ul>
        </div>
      </section>
      <section class="section">
        <h2>Mappings</h2>
        <div class="panel panel-pad stack">
          <details><summary>Portfolio map (${Object.keys(pm).length} WSO portfolios)</summary>
            <div class="table-wrap"><table><thead><tr><th>WSO portfolio</th><th>PAM portfolios</th></tr></thead>
            <tbody>${Object.entries(pm).map(([w, p]) => `<tr><td class="mono">${esc(w)}</td><td class="mono">${p.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table></div></details>
          <details><summary>Tranche map (${state.inputs.trancheMap.length} assets)</summary>
            ${simpleTable(state.inputs.trancheMap, E.LAYOUTS.trancheMap)}</details>
          <details><summary>PAM positions (${state.inputs.pamPositions.length} rows)</summary>
            ${simpleTable(state.inputs.pamPositions, E.LAYOUTS.pamPositions, ['Funded', 'Unfunded'])}</details>
          <details><summary>Contract lineage (${Object.keys(state.lineage).length} links, updated as events are approved)</summary>
            <div class="table-wrap"><table><thead><tr><th>WSO contract</th><th>PAM contract</th></tr></thead>
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
        <tbody>${state.audit.map(a => `<tr${a.ref && eventByKey(a.ref) ? ` class="clickable" data-key="${esc(a.ref)}" tabindex="0"` : ''}>
          <td class="mono small">${fmtTime(a.at)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.label)}</td><td class="small">${esc(a.note)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="panel empty">Nothing recorded yet.</div>'}
    </section>`;
  }

  // ------------------------------------------------------------------ render

  function render() {
    renderTabs();
    const main = document.getElementById('main');
    const views = { queue: viewQueue, batches: viewBatches, setup: viewSetup, audit: viewAudit };
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
      case 'close': state.selectedKey = null; render(); return;
      case 'rerun': runDetection(); state.view = 'queue'; render(); return;
      case 'openBatch': state.view = 'batches'; state.selectedBatch = batch; state.selectedKey = null; render(); return;
      case 'copyMessages': {
        const ev = eventByKey(state.selectedKey);
        if (ev) copyText(E.toCSV(ev.messages, E.LAYOUTS.pamImport.slice(2)), `${ev.messages.length} messages`);
        return;
      }
      case 'copyBatch': {
        const b = state.batches.find(x => x.id === batch);
        if (b) copyText(E.toCSV(b.rows, E.LAYOUTS.pamImport), b.fileName, document.getElementById(`file-${b.id}`));
        return;
      }
      case 'downloadBatch': {
        const b = state.batches.find(x => x.id === batch);
        if (b) download(b.fileName, E.toCSV(b.rows, E.LAYOUTS.pamImport));
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
          setTimeout(() => { resetArmed = false; if (el.isConnected) { el.textContent = 'Restore sample month-end'; el.classList.remove('danger'); } }, 5000);
          return;
        }
        resetArmed = false;
        state = freshState();
        state.view = 'queue';
        runDetection({ quiet: true });
        render();
        toast('Sample month-end restored. All decisions were cleared.');
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
    const key = e.target.dataset && e.target.dataset.input;
    if (!key || !e.target.files || !e.target.files[0]) return;
    const inp = INPUTS.find(i => i.key === key);
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const rows = E.parseCSV(reader.result);
      const missing = E.missingColumns(rows.headers, E.LAYOUTS[inp.layout]);
      if (missing.length) { toast(`${file.name} is missing columns: ${missing.join(', ')}. Nothing was loaded.`); e.target.value = ''; return; }
      if (!rows.length) { toast(`${file.name} has headers but no rows. Nothing was loaded.`); e.target.value = ''; return; }
      state.inputs[key] = rows.map(r => ({ ...r }));
      state.sourceLabel = 'Uploaded files';
      if (key === 'lineage') state.lineage = E.normalizeLineage(rows);
      if (key === 'current' || key === 'prior') {
        const dates = rows.map(r => E.normalizeDate(r.AsOfDate)).filter(Boolean).sort();
        if (dates.length) state[key === 'current' ? 'asOfDate' : 'priorAsOfDate'] = dates[dates.length - 1];
      }
      log('Loaded file', '', inp.title, `${file.name}, ${rows.length} rows`);
      render();
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
