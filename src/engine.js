/*
 * Loan Event Bridge engine.
 *
 * Pure functions with no DOM access: CSV parsing, WSO event detection and
 * classification, PAM portfolio allocation, and PAM import file rows.
 * Loads in the browser as window.Engine and in Node via require().
 *
 * All money is held as integer cents to avoid floating point drift.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- constants

  const TERM_FIELDS = ['baseRate', 'tenor', 'marginBps', 'floorPct', 'payFreq', 'resetFreq', 'dayCount'];
  const TERM_LABELS = {
    baseRate: 'Base rate', tenor: 'Tenor', marginBps: 'Margin (bps)', floorPct: 'Floor (%)',
    payFreq: 'Pay frequency', resetFreq: 'Reset frequency', dayCount: 'Day count',
  };

  // Calendar-day range treated as a regular period for each tenor. A new
  // contract outside its range is a stub or broken period and goes to review,
  // because PAM accrues on the regular schedule from the SMF attributes.
  const TENOR_DAYS = { '1M': [27, 33], '3M': [88, 94], '6M': [179, 186], '12M': [362, 368] };

  const TYPE_LABELS = {
    ROLLOVER: 'Rollover', CONTRACT_CHANGE: 'Contract change', SPLIT: 'Contract split',
    COMBINE: 'Contract combine', COMPLEX: 'Complex restructure', PAYDOWN: 'Paydown',
    REPAYMENT: 'Repayment', DRAW: 'Draw', COMMITMENT_CHANGE: 'Commitment change',
  };

  // Input and output file layouts. The PAM layout is a placeholder until the
  // real import message formats are supplied.
  const LAYOUTS = {
    wso: ['AsOfDate', 'WSOPortfolio', 'AssetID', 'AssetName', 'FacilityType', 'ContractID', 'ContractType',
      'StartDate', 'EndDate', 'Amount', 'Commitment', 'BaseRate', 'Tenor', 'MarginBps', 'FloorPct',
      'PayFreq', 'ResetFreq', 'DayCount'],
    trancheMap: ['AssetID', 'PAMTrancheID', 'FacilityType'],
    portfolioMap: ['WSOPortfolio', 'PAMPortfolio'],
    pamPositions: ['PAMPortfolio', 'PAMTrancheID', 'Funded', 'Unfunded'],
    lineage: ['WSOContractID', 'PAMContractID'],
    pamImport: ['BatchID', 'Seq', 'EventKey', 'MessageType', 'PAMPortfolio', 'PAMTrancheID', 'PAMContractID',
      'TargetContractRef', 'EffectiveDate', 'Amount', 'BaseRate', 'Tenor', 'MarginBps', 'FloorPct',
      'PayFreq', 'ResetFreq', 'DayCount'],
  };

  // ---------------------------------------------------------------- CSV

  /** Parses CSV text into row objects keyed by header. The header list is on rows.headers. */
  function parseCSV(text) {
    const src = String(text ?? '').replace(/^﻿/, '');
    const table = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); table.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field !== '' || row.length) { row.push(field); table.push(row); }

    const lines = table.filter(r => r.some(v => v.trim() !== ''));
    const headers = lines.length ? lines[0].map(h => h.trim()) : [];
    const rows = lines.slice(1).map(r => Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? '').trim()])));
    rows.headers = headers;
    return rows;
  }

  function toCSV(rows, columns) {
    const esc = v => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
  }

  function missingColumns(headers, layout) {
    const have = new Set(headers || []);
    return layout.filter(c => !have.has(c));
  }

  // ---------------------------------------------------------------- values

  function toCents(value) {
    if (typeof value === 'number') return Math.round(value * 100);
    const s = String(value ?? '').replace(/[\s,$]/g, '');
    if (s === '') return 0;
    const negative = s.startsWith('-') || /^\(.*\)$/.test(s);
    const n = Number(s.replace(/[()-]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`"${value}" is not a number`);
    return (negative ? -1 : 1) * Math.round(n * 100);
  }

  function fromCents(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  }

  function formatMoney(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
  }

  /** Accepts ISO dates and US M/D/YYYY dates (common in WSO exports). */
  function normalizeDate(value) {
    const s = String(value ?? '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return s;
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }

  // ---------------------------------------------------------------- normalizing inputs

  function normalizeWso(rows) {
    return rows.map(r => {
      const contractType = String(r.ContractType || '').trim().toLowerCase();
      return {
        asOfDate: normalizeDate(r.AsOfDate),
        wsoPortfolio: String(r.WSOPortfolio || '').trim(),
        assetId: String(r.AssetID || '').trim(),
        assetName: String(r.AssetName || r.AssetID || '').trim(),
        facilityType: String(r.FacilityType || '').trim().toUpperCase(),
        contractId: String(r.ContractID || '').trim(),
        unfunded: contractType.startsWith('unfund'),
        startDate: normalizeDate(r.StartDate),
        endDate: normalizeDate(r.EndDate),
        amount: toCents(r.Amount),
        commitment: toCents(r.Commitment),
        baseRate: String(r.BaseRate || '').trim(),
        tenor: String(r.Tenor || '').trim().toUpperCase(),
        marginBps: Number(r.MarginBps || 0),
        floorPct: Number(r.FloorPct || 0),
        payFreq: String(r.PayFreq || '').trim(),
        resetFreq: String(r.ResetFreq || '').trim(),
        dayCount: String(r.DayCount || '').trim(),
      };
    });
  }

  function normalizeTrancheMap(rows) {
    const map = {};
    rows.forEach(r => {
      if (r.AssetID) map[r.AssetID.trim()] = { pamTrancheId: r.PAMTrancheID.trim(), facilityType: (r.FacilityType || '').trim().toUpperCase() };
    });
    return map;
  }

  function normalizePortfolioMap(rows) {
    const map = {};
    rows.forEach(r => {
      const wso = (r.WSOPortfolio || '').trim();
      if (!wso) return;
      (map[wso] = map[wso] || []).push(r.PAMPortfolio.trim());
    });
    return map;
  }

  function normalizePamPositions(rows) {
    return rows.map(r => ({
      pamPortfolio: r.PAMPortfolio.trim(),
      pamTrancheId: r.PAMTrancheID.trim(),
      funded: toCents(r.Funded),
      unfunded: toCents(r.Unfunded),
    }));
  }

  function normalizeLineage(rows) {
    const map = {};
    rows.forEach(r => { if (r.WSOContractID) map[r.WSOContractID.trim()] = r.PAMContractID.trim(); });
    return map;
  }

  // ---------------------------------------------------------------- allocation

  /**
   * Largest-remainder allocation. Splits amountCents across weights pro rata
   * so the parts always add back to the amount exactly. Weights must be
   * integers (cents). Returns { key: cents } or null when there is nothing to
   * allocate against.
   */
  function allocate(amountCents, weights) {
    const total = weights.reduce((s, w) => s + w.weight, 0);
    if (!weights.length || total <= 0) return null;
    const sign = amountCents < 0 ? -1 : 1;
    const A = BigInt(Math.abs(amountCents));
    const T = BigInt(total);
    const parts = weights.map((w, idx) => {
      const num = A * BigInt(w.weight);
      return { key: w.key, idx, base: num / T, rem: num % T };
    });
    let left = A - parts.reduce((s, p) => s + p.base, 0n);
    [...parts]
      .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.idx - b.idx))
      .forEach(p => { if (left > 0n) { p.base += 1n; left -= 1n; } });
    const out = {};
    parts.forEach(p => { out[p.key] = sign * Number(p.base); });
    return out;
  }

  // ---------------------------------------------------------------- classification

  const sum = rows => rows.reduce((s, r) => s + r.amount, 0);
  const termsOf = c => Object.fromEntries(TERM_FIELDS.map(f => [f, c[f]]));

  function termDiffs(a, b) {
    return TERM_FIELDS
      .filter(f => String(a[f]) !== String(b[f]))
      .map(f => ({ field: f, label: TERM_LABELS[f], from: a[f], to: b[f] }));
  }

  const ROUTE_ORDER = { exception: 0, review: 1, auto: 2 };

  /**
   * Compares the prior and current WSO contract snapshots for each WSO
   * portfolio and asset, and returns one classified event per change.
   */
  function detectEvents(input) {
    const ctx = {
      asOfDate: input.asOfDate,
      trancheMap: input.trancheMap || {},
      portfolioMap: input.portfolioMap || {},
      pamPositions: input.pamPositions || [],
      lineage: input.lineage || {},
    };
    const groups = new Map();
    const add = (rows, side) => rows.forEach(r => {
      const k = `${r.wsoPortfolio}|${r.assetId}`;
      if (!groups.has(k)) groups.set(k, { prior: [], current: [] });
      groups.get(k)[side].push(r);
    });
    add(input.prior, 'prior');
    add(input.current, 'current');

    const events = [];
    for (const g of groups.values()) {
      const ev = classifyGroup(g, ctx);
      if (ev) events.push(ev);
    }
    events.sort((a, b) => ROUTE_ORDER[a.route] - ROUTE_ORDER[b.route]
      || a.assetName.localeCompare(b.assetName) || a.wsoPortfolio.localeCompare(b.wsoPortfolio));
    return events;
  }

  function classifyGroup(g, ctx) {
    const head = g.current[0] || g.prior[0];
    const { wsoPortfolio, assetId, assetName, facilityType } = head;

    const priorFunded = g.prior.filter(r => !r.unfunded);
    const currentFunded = g.current.filter(r => !r.unfunded);
    const unfundedBefore = sum(g.prior.filter(r => r.unfunded));
    const unfundedAfter = sum(g.current.filter(r => r.unfunded));
    const commitmentBefore = g.prior.length ? g.prior[0].commitment : 0;
    const commitmentAfter = g.current.length ? g.current[0].commitment : 0;

    const priorById = new Map(priorFunded.map(r => [r.contractId, r]));
    const currentIds = new Set(currentFunded.map(r => r.contractId));
    const expired = priorFunded.filter(r => !currentIds.has(r.contractId));
    const added = currentFunded.filter(r => !priorById.has(r.contractId));
    const continuing = currentFunded.filter(r => priorById.has(r.contractId)).map(cur => {
      const prev = priorById.get(cur.contractId);
      return { prev, cur, amountDelta: cur.amount - prev.amount, diffs: termDiffs(prev, cur) };
    });
    const amended = continuing.filter(a => a.amountDelta !== 0 || a.diffs.length);
    const unchanged = continuing.filter(a => a.amountDelta === 0 && !a.diffs.length).map(a => a.cur);

    if (!expired.length && !added.length && !amended.length && commitmentBefore === commitmentAfter) return null;

    const fundedBefore = sum(priorFunded);
    const fundedAfter = sum(currentFunded);
    const fundedDelta = fundedAfter - fundedBefore;

    // ---- event type
    let type;
    let rollTermChanges = [];
    if (!expired.length && !added.length) {
      if (amended.some(a => a.diffs.length)) type = 'CONTRACT_CHANGE';
      else if (fundedDelta < 0) type = 'PAYDOWN';
      else if (fundedDelta > 0) type = 'DRAW';
      else type = 'COMMITMENT_CHANGE';
    } else if (expired.length === 1 && added.length === 1) {
      rollTermChanges = termDiffs(expired[0], added[0]);
      type = rollTermChanges.length ? 'CONTRACT_CHANGE' : 'ROLLOVER';
    } else if (expired.length === 1 && added.length > 1) type = 'SPLIT';
    else if (expired.length > 1 && added.length === 1) type = 'COMBINE';
    else if (!expired.length) type = 'DRAW';
    else if (!added.length) type = 'REPAYMENT';
    else type = 'COMPLEX';

    const rollsAtPeriodEnd = expired.length > 0 && added.length > 0;
    const legs = [];
    if (rollsAtPeriodEnd && fundedDelta < 0) legs.push('PAYDOWN');
    if (rollsAtPeriodEnd && fundedDelta > 0) legs.push('DRAW');

    const effectiveDate = added.length
      ? added.map(c => c.startDate).sort()[0]
      : ctx.asOfDate || head.asOfDate;

    // ---- checks
    const flags = [];
    const exception = text => flags.push({ level: 'exception', text });
    const review = text => flags.push({ level: 'review', text });
    const info = text => flags.push({ level: 'info', text });
    const money = formatMoney;

    const tranche = ctx.trancheMap[assetId];
    const pamPortfolios = ctx.portfolioMap[wsoPortfolio] || [];
    if (!tranche) exception(`Asset ${assetId} is not mapped to a PAM tranche. Set the tranche up in PAM and add it to the tranche map.`);
    if (!pamPortfolios.length) exception(`WSO portfolio ${wsoPortfolio} has no PAM portfolios in the portfolio map.`);

    if (g.current.length && fundedAfter + unfundedAfter !== commitmentAfter) {
      exception(`Funded ${money(fundedAfter)} plus unfunded ${money(unfundedAfter)} does not equal the commitment of ${money(commitmentAfter)} in the WSO export.`);
    }
    if (facilityType === 'TL' && unfundedAfter !== 0) {
      exception(`Term loan shows an unfunded amount of ${money(unfundedAfter)}. Term loans should be fully funded.`);
    }
    if (facilityType === 'TL' && fundedDelta > 0) {
      exception(`Term loan funded amount went up by ${money(fundedDelta)}. Term loans do not draw, so check for an add-on, an incremental or a trade.`);
    }
    if (facilityType !== 'TL' && fundedDelta > unfundedBefore) {
      exception(`Draw of ${money(fundedDelta)} is larger than the prior unfunded amount of ${money(unfundedBefore)}.`);
    }

    if (g.current.length && commitmentAfter !== commitmentBefore) {
      const reduction = commitmentBefore - commitmentAfter;
      const permanentPaydown = fundedDelta < 0 && reduction === -fundedDelta;
      if (facilityType === 'TL' && permanentPaydown) { /* term loan commitment moves with par */ }
      else if (facilityType === 'DDTL' && permanentPaydown) info('Commitment reduced by the paydown amount. Delayed draw repayments are permanent.');
      else if (facilityType === 'RC') review(`Revolver commitment changed from ${money(commitmentBefore)} to ${money(commitmentAfter)}. Confirm whether this is a permanent reduction or an upsize.`);
      else review(`Commitment changed from ${money(commitmentBefore)} to ${money(commitmentAfter)}.`);
    }
    if (type === 'COMMITMENT_CHANGE') {
      review('Commitment-only changes are not generated as PAM messages in this prototype. Book the change in PAM directly.');
    }

    added.forEach(c => {
      const days = daysBetween(c.startDate, c.endDate);
      const range = TENOR_DAYS[c.tenor];
      if (range && (days < range[0] || days > range[1])) {
        review(`New contract ${c.contractId} runs ${days} days (${c.startDate} to ${c.endDate}) on a ${c.tenor} tenor. PAM accrues on the regular schedule, so check for a stub or broken period.`);
      }
    });

    if (type === 'COMPLEX') {
      review(`${expired.length} contracts roll into ${added.length} with different amounts. This prototype writes close and open messages; confirm that is how PAM should book it.`);
    }
    if (type === 'REPAYMENT' && !g.current.length) {
      review('The position is no longer in the WSO export. Confirm this is a repayment and not a sale or transfer.');
    }
    if (rollsAtPeriodEnd && amended.length) {
      info('Other contracts on this tranche also changed and are included in this event.');
    }
    if (type === 'COMBINE' && fundedDelta !== 0) {
      info(`The ${fundedDelta < 0 ? 'paydown' : 'draw'} is booked against the first source contract before the combine.`);
    }

    const pamIdOf = c => ctx.lineage[c.contractId] || '';
    [...expired, ...amended.map(a => a.prev)].forEach(c => {
      if (!pamIdOf(c)) exception(`WSO contract ${c.contractId} has no linked PAM contract in the lineage table.`);
    });

    // ---- PAM positions: tie-out and allocation basis
    let allocationBasis = [];
    if (tranche && pamPortfolios.length) {
      allocationBasis = pamPortfolios.map(pp => {
        const pos = ctx.pamPositions.find(p => p.pamPortfolio === pp && p.pamTrancheId === tranche.pamTrancheId);
        const funded = pos ? pos.funded : 0;
        const unfunded = pos ? pos.unfunded : 0;
        return { pamPortfolio: pp, funded, unfunded, weight: funded + unfunded };
      });
      const pamFunded = allocationBasis.reduce((s, b) => s + b.funded, 0);
      const pamUnfunded = allocationBasis.reduce((s, b) => s + b.unfunded, 0);
      if (allocationBasis.every(b => b.weight === 0)) {
        exception(`No PAM positions found in tranche ${tranche.pamTrancheId} for ${pamPortfolios.join(', ')}. A new position needs its trade booked in PAM first.`);
      } else {
        if (pamFunded !== fundedBefore) {
          exception(`PAM funded position of ${money(pamFunded)} does not tie to WSO's ${money(fundedBefore)} before this event (difference ${money(pamFunded - fundedBefore)}). Clear the break before booking.`);
        }
        if (pamUnfunded !== unfundedBefore) {
          exception(`PAM unfunded position of ${money(pamUnfunded)} does not tie to WSO's ${money(unfundedBefore)} before this event.`);
        }
      }
    }

    const hasException = flags.some(f => f.level === 'exception');
    const hasReview = flags.some(f => f.level === 'review');
    const route = hasException ? 'exception'
      : type === 'ROLLOVER' && !legs.length && !amended.length && !hasReview ? 'auto'
        : 'review';

    // ---- PAM message lines (before allocation)
    const lines = buildLines({ type, expired, added, amended, fundedDelta, pamIdOf, effectiveDate });

    const key = [
      wsoPortfolio, assetId, effectiveDate,
      `${expired.map(c => c.contractId).sort().join('+') || '-'}>${added.map(c => c.contractId).sort().join('+') || '-'}`,
      amended.length ? '~' + amended.map(a => a.cur.contractId).sort().join('+') : '',
    ].join('|').replace(/\|$/, '');

    const messages = [];
    const weights = allocationBasis.filter(b => b.weight > 0).map(b => ({ key: b.pamPortfolio, weight: b.weight }));
    lines.forEach(line => {
      line.allocation = weights.length && tranche ? allocate(line.amount, weights) : null;
      if (!line.allocation) return;
      weights.forEach(w => {
        messages.push({
          EventKey: key,
          MessageType: line.messageType,
          PAMPortfolio: w.key,
          PAMTrancheID: tranche.pamTrancheId,
          PAMContractID: line.pamContractId,
          TargetContractRef: line.targetRef,
          EffectiveDate: effectiveDate,
          Amount: fromCents(line.allocation[w.key]),
          BaseRate: line.terms.baseRate,
          Tenor: line.terms.tenor,
          MarginBps: line.terms.marginBps,
          FloorPct: line.terms.floorPct,
          PayFreq: line.terms.payFreq,
          ResetFreq: line.terms.resetFreq,
          DayCount: line.terms.dayCount,
        });
      });
    });

    // ---- lineage: which PAM contract each new WSO contract represents
    const lineageUpdates = [];
    if ((type === 'ROLLOVER' || type === 'CONTRACT_CHANGE') && expired.length === 1 && added.length === 1) {
      lineageUpdates.push({ wsoContractId: added[0].contractId, pamContractId: pamIdOf(expired[0]) });
    } else {
      added.forEach(c => lineageUpdates.push({ wsoContractId: c.contractId, pamContractId: newRef(c) }));
    }

    return {
      key, wsoPortfolio, assetId, assetName, facilityType, effectiveDate,
      type, typeLabel: TYPE_LABELS[type], legs, route, flags,
      expired, added, amended, unchanged, rollTermChanges,
      totals: { fundedBefore, fundedAfter, fundedDelta, unfundedBefore, unfundedAfter, commitmentBefore, commitmentAfter },
      pamTrancheId: tranche ? tranche.pamTrancheId : '',
      allocationBasis, lines, messages, lineageUpdates,
    };
  }

  // New PAM contracts are referenced by their WSO contract ID until PAM assigns its own.
  const newRef = c => `WSO-${c.contractId}`;

  function buildLines({ type, expired, added, amended, fundedDelta, pamIdOf, effectiveDate }) {
    const lines = [];
    const line = (messageType, pamContractId, targetRef, amount, terms, note) =>
      lines.push({ messageType, pamContractId, targetRef, amount, terms: termsOf(terms), effectiveDate, note });

    // Amount legs are booked against the source contract before any restructure,
    // so the restructure messages carry the post-paydown or post-draw amounts.
    const amountLeg = source => {
      if (fundedDelta < 0) line('PAYDOWN', pamIdOf(source), '', -fundedDelta, source, 'Paydown at rollover');
      if (fundedDelta > 0) line('DRAW', pamIdOf(source), '', fundedDelta, source, 'Draw at rollover');
    };

    switch (type) {
      case 'ROLLOVER':
        // Same terms: PAM needs nothing for the roll itself, only any amount leg.
        if (expired.length && added.length) amountLeg(expired[0]);
        break;
      case 'CONTRACT_CHANGE':
        if (expired.length && added.length) {
          amountLeg(expired[0]);
          line('CONTRACT_CHANGE', pamIdOf(expired[0]), '', added[0].amount, added[0], 'New terms from rollover');
        }
        break;
      case 'SPLIT':
        amountLeg(expired[0]);
        added.forEach(c => line('CONTRACT_SPLIT', pamIdOf(expired[0]), newRef(c), c.amount, c, `Split into ${c.tenor} contract`));
        break;
      case 'COMBINE': {
        amountLeg(expired[0]);
        const target = added[0];
        expired.forEach((c, i) => {
          const amount = i === 0 ? c.amount + fundedDelta : c.amount;
          line('CONTRACT_COMBINE', pamIdOf(c), newRef(target), amount, target, 'Combine into one contract');
        });
        break;
      }
      case 'COMPLEX':
        expired.forEach(c => line('CONTRACT_CLOSE', pamIdOf(c), '', c.amount, c, 'Close expiring contract'));
        added.forEach(c => line('CONTRACT_OPEN', '', newRef(c), c.amount, c, 'Open new contract'));
        break;
      case 'DRAW':
        added.forEach(c => line('DRAW', '', newRef(c), c.amount, c, 'Draw into new contract'));
        break;
      case 'REPAYMENT':
        expired.forEach(c => line('PAYDOWN', pamIdOf(c), '', c.amount, c, 'Repaid in full'));
        break;
      default:
        break;
    }

    // Mid-period changes to contracts that did not roll.
    amended.forEach(a => {
      if (a.amountDelta < 0) line('PAYDOWN', pamIdOf(a.prev), '', -a.amountDelta, a.prev, 'Mid-period paydown');
      if (a.diffs.length) line('CONTRACT_CHANGE', pamIdOf(a.prev), '', a.cur.amount, a.cur, 'Mid-period term change');
      if (a.amountDelta > 0) line('DRAW', pamIdOf(a.prev), '', a.amountDelta, a.cur, 'Mid-period draw');
    });
    return lines;
  }

  /** Numbers each event's messages into one PAM import file. */
  function buildBatchRows(events, batchId) {
    let seq = 0;
    return events.flatMap(ev => ev.messages.map(m => ({ BatchID: batchId, Seq: ++seq, ...m })));
  }

  return {
    TERM_FIELDS, TERM_LABELS, TENOR_DAYS, TYPE_LABELS, LAYOUTS,
    parseCSV, toCSV, missingColumns,
    toCents, fromCents, formatMoney, normalizeDate, daysBetween,
    normalizeWso, normalizeTrancheMap, normalizePortfolioMap, normalizePamPositions, normalizeLineage,
    allocate, detectEvents, buildBatchRows,
  };
});
