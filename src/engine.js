/*
 * Loan Event Bridge engine.
 *
 * Pure functions with no DOM access: CSV parsing, AllVue event detection and
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

  const TERM_FIELDS = ['rateType', 'interestType', 'baseRate', 'tenor', 'marginBps', 'floorPct', 'payFreq', 'resetFreq', 'dayCount'];
  const TERM_LABELS = {
    rateType: 'Rate type', interestType: 'Interest type', baseRate: 'Base rate', tenor: 'Tenor', marginBps: 'Margin (bps)', floorPct: 'Floor (%)',
    payFreq: 'Pay frequency', resetFreq: 'Reset frequency', dayCount: 'Day count',
  };

  // Calendar-day range treated as a regular period for each tenor. A new
  // contract outside its range is a stub or broken period and goes to review,
  // because PAM accrues on the regular schedule from the SMF attributes.
  const TENOR_DAYS = { '1M': [27, 33], '3M': [88, 94], '6M': [179, 186], '12M': [362, 368] };

  const TYPE_LABELS = {
    ROLLOVER: 'Rollover', CONTRACT_CHANGE: 'Contract change', SPLIT: 'Contract split',
    COMBINE: 'Contract combine', COMPLEX: 'Complex restructure', PAYDOWN: 'Paydown',
    REPAYMENT: 'Repayment', DRAW: 'Draw', COMMITMENT_CHANGE: 'Commitment change', CAPITALIZE: 'Capitalized interest',
  };

  // Interest types whose interest is added to principal (PIK) rather than paid in cash.
  const CAPITALIZING = new Set(['CAPITALIZE', 'CAPITALIZED', 'PIK', 'PARTIAL', 'PARTIAL PIK']);

  // Input and output file layouts. The PAM layout is a placeholder until the
  // real import message formats are supplied.
  const LAYOUTS = {
    allvue: ['AsOfDate', 'AllVuePortfolio', 'AssetID', 'AssetName', 'FacilityType', 'ContractID', 'ContractType',
      'StartDate', 'EndDate', 'Amount', 'GlobalAmount', 'Commitment', 'RateType', 'InterestType', 'BaseRate', 'Tenor', 'MarginBps', 'FloorPct',
      'PayFreq', 'ResetFreq', 'DayCount'],
    trancheMap: ['AssetID', 'PAMTrancheID', 'FacilityType'],
    portfolioMap: ['AllVuePortfolio', 'PAMPortfolio'],
    pamPositions: ['PAMPortfolio', 'PAMTrancheID', 'Funded', 'Unfunded'],
    lineage: ['AllVueContractID', 'PAMContractID'],
    pamImport: ['BatchID', 'Seq', 'EventKey', 'Step', 'Level', 'MessageType', 'PAMPortfolio', 'PAMTrancheID',
      'FromContractID', 'ToContractID', 'EffectiveDate', 'EndDate', 'Units', 'BaseRate', 'Tenor', 'MarginBps',
      'FloorPct', 'PayFreq', 'ResetFreq', 'DayCount'],
    fees: ['AllVuePortfolio', 'AssetID', 'AssetName', 'FacilityType', 'FeeType', 'PeriodStart', 'PeriodEnd',
      'FeeRateBps', 'AverageUnfunded', 'DayCount', 'Amount', 'AllVueTransactionID'],
    pamFeeImport: ['BatchID', 'Seq', 'FeeKey', 'TransactionType', 'FeeType', 'PAMPortfolio', 'PAMTrancheID',
      'PeriodStart', 'PeriodEnd', 'Amount', 'AllVueTransactionID'],
  };

  // A fee may differ from rate x average unfunded x days / basis by the larger of
  // these before it goes to review: $1.00 or 0.1% of the expected amount.
  const FEE_TOLERANCE = { cents: 100, share: 0.001 };
  // PAM's current unfunded position may differ from AllVue's average unfunded for the
  // period by this share before the split by fund is flagged as possibly stale.
  const FEE_POSITION_DRIFT = 0.10;

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

  /** Accepts ISO dates and US M/D/YYYY dates (common in AllVue exports). */
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

  function normalizeAllVue(rows) {
    return rows.map(r => {
      const contractType = String(r.ContractType || '').trim().toLowerCase();
      return {
        asOfDate: normalizeDate(r.AsOfDate),
        allvuePortfolio: String(r.AllVuePortfolio || '').trim(),
        assetId: String(r.AssetID || '').trim(),
        assetName: String(r.AssetName || r.AssetID || '').trim(),
        facilityType: String(r.FacilityType || '').trim().toUpperCase(),
        contractId: String(r.ContractID || '').trim(),
        unfunded: contractType.startsWith('unfund'),
        startDate: normalizeDate(r.StartDate),
        endDate: normalizeDate(r.EndDate),
        amount: toCents(r.Amount),
        globalAmount: toCents(r.GlobalAmount),
        commitment: toCents(r.Commitment),
        rateType: String(r.RateType || '').trim(),
        interestType: String(r.InterestType || '').trim(),
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
      const av = (r.AllVuePortfolio || '').trim();
      if (!av) return;
      (map[av] = map[av] || []).push(r.PAMPortfolio.trim());
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
    rows.forEach(r => { if (r.AllVueContractID) map[r.AllVueContractID.trim()] = r.PAMContractID.trim(); });
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
   * Compares the prior and current AllVue contract snapshots for each AllVue
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
      const k = `${r.allvuePortfolio}|${r.assetId}`;
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
      || a.assetName.localeCompare(b.assetName) || a.allvuePortfolio.localeCompare(b.allvuePortfolio));
    return events;
  }

  function classifyGroup(g, ctx) {
    const head = g.current[0] || g.prior[0];
    const { allvuePortfolio, assetId, assetName, facilityType } = head;

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
    // An increase on a contract that capitalizes interest is PIK, not a draw.
    const capitalizing = fundedDelta > 0
      && [...expired, ...amended.map(a => a.prev)].some(c => CAPITALIZING.has(c.interestType.toUpperCase()));
    if (capitalizing && type === 'DRAW' && !added.length) type = 'CAPITALIZE';
    const legs = [];
    if (rollsAtPeriodEnd && fundedDelta < 0) legs.push('PAYDOWN');
    if (rollsAtPeriodEnd && fundedDelta > 0) legs.push(capitalizing ? 'CAPITALIZE' : 'DRAW');

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
    const pamPortfolios = ctx.portfolioMap[allvuePortfolio] || [];
    if (!tranche) exception(`Asset ${assetId} is not mapped to a PAM tranche. Set the tranche up in PAM and add it to the tranche map.`);
    if (!pamPortfolios.length) exception(`AllVue portfolio ${allvuePortfolio} has no PAM portfolios in the portfolio map.`);

    if (g.current.length && fundedAfter + unfundedAfter !== commitmentAfter) {
      exception(`Funded ${money(fundedAfter)} plus unfunded ${money(unfundedAfter)} does not equal the commitment of ${money(commitmentAfter)} in the AllVue export.`);
    }
    if (facilityType === 'TL' && unfundedAfter !== 0) {
      exception(`Term loan shows an unfunded amount of ${money(unfundedAfter)}. Term loans should be fully funded.`);
    }
    if (capitalizing) {
      review(`Funded amount went up by ${money(fundedDelta)} on a contract that capitalizes interest. Booked as capitalized (PIK) interest; check it against the agent notice.`);
    } else if (facilityType === 'TL' && fundedDelta > 0) {
      exception(`Term loan funded amount went up by ${money(fundedDelta)}. Term loans do not draw, so check for an add-on, an incremental or a trade.`);
    }
    if (!capitalizing && facilityType !== 'TL' && fundedDelta > unfundedBefore) {
      exception(`Draw of ${money(fundedDelta)} is larger than the prior unfunded amount of ${money(unfundedBefore)}.`);
    }

    if (g.current.length && commitmentAfter !== commitmentBefore) {
      const reduction = commitmentBefore - commitmentAfter;
      const permanentPaydown = fundedDelta < 0 && reduction === -fundedDelta;
      if (facilityType === 'TL' && (permanentPaydown || (capitalizing && -reduction === fundedDelta))) { /* term loan commitment moves with par */ }
      else if (facilityType === 'DDTL' && permanentPaydown) info('Commitment reduced by the paydown amount. Delayed draw repayments are permanent.');
      else if (facilityType === 'RC') review(`Revolver commitment changed from ${money(commitmentBefore)} to ${money(commitmentAfter)}. Confirm whether this is a permanent reduction or an upsize.`);
      else review(`Commitment changed from ${money(commitmentBefore)} to ${money(commitmentAfter)}.`);
    }
    if (type === 'COMMITMENT_CHANGE') {
      review('Commitment-only changes are not generated as PAM messages in this prototype. Book the change in PAM directly.');
    }

    added.forEach(c => {
      const rt = c.rateType.toUpperCase();
      if (rt && rt !== 'FIXED' && rt !== 'FLOATING') review(`Contract ${c.contractId} has rate type "${c.rateType}". Expected Fixed or Floating.`);
      if (rt === 'FLOATING' && !c.baseRate) review(`Floating contract ${c.contractId} has no base rate.`);
      const it = c.interestType.toUpperCase();
      if (it && it !== 'CASH' && !CAPITALIZING.has(it)) review(`Contract ${c.contractId} has interest type "${c.interestType}". Expected Cash, Capitalize or Partial.`);
    });
    added.forEach(c => {
      const days = daysBetween(c.startDate, c.endDate);
      const range = TENOR_DAYS[c.tenor];
      if (range && (days < range[0] || days > range[1])) {
        review(`New contract ${c.contractId} runs ${days} days (${c.startDate} to ${c.endDate}) on a ${c.tenor} tenor. PAM accrues on the regular schedule, so check for a stub or broken period.`);
      }
    });

    if (type === 'COMPLEX') {
      review(`${expired.length} contracts roll into ${added.length}. Booked as a combine into contract ${added[0].contractId}, then a split out to the others. Check the amounts against the agent notice.`);
    }
    if (type === 'REPAYMENT' && !g.current.length) {
      review('The position is no longer in the AllVue export. Confirm this is a repayment and not a sale or transfer.');
    }
    if (rollsAtPeriodEnd && amended.length) {
      info('Other contracts on this tranche also changed and are included in this event.');
    }
    if ((type === 'SPLIT' || type === 'COMPLEX') && fundedDelta !== 0) {
      info(`The ${fundedDelta < 0 ? 'paydown' : 'draw'} is booked after the restructure, spread across the new contracts in proportion to their size.`);
    }

    // ---- global amounts: needed for PAM's global actions, and they separate real
    // paydowns and draws from your own trades.
    const gsum = rows => rows.reduce((t, r) => t + r.globalAmount, 0);
    const globalBefore = gsum(priorFunded);
    const globalAfter = gsum(currentFunded);
    const globalDelta = globalAfter - globalBefore;
    const missingGlobal = [...priorFunded, ...currentFunded].filter(c => c.amount !== 0 && c.globalAmount <= 0);
    if (missingGlobal.length) {
      exception(`No global amount for contract ${[...new Set(missingGlobal.map(c => c.contractId))].join(', ')}. PAM's global action needs it.`);
    } else if (globalBefore > 0 && g.current.length) {
      if (fundedDelta !== 0 && globalDelta === 0) {
        exception(`Your funded position changed by ${money(fundedDelta)} but the global amount did not. That looks like a ${fundedDelta < 0 ? 'sale' : 'purchase'}, not a ${fundedDelta < 0 ? 'paydown' : 'draw'}. Book the trade in PAM instead.`);
      } else if (globalDelta !== 0) {
        const expectedDelta = Math.round(globalDelta * fundedBefore / globalBefore);
        if (Math.abs(fundedDelta - expectedDelta) > Math.max(500, Math.abs(expectedDelta) * 0.0001)) {
          review(`Your change of ${money(fundedDelta)} is not your ${(fundedBefore / globalBefore * 100).toFixed(4)}% share of the global change of ${money(globalDelta)} (expected ${money(expectedDelta)}). There may be a trade on the same day; check before booking.`);
        }
      }
    }

    const pamIdOf = c => ctx.lineage[c.contractId] || '';
    [...expired, ...amended.map(a => a.prev)].forEach(c => {
      if (!pamIdOf(c)) exception(`AllVue contract ${c.contractId} has no linked PAM contract in the lineage table.`);
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
          exception(`PAM funded position of ${money(pamFunded)} does not tie to AllVue's ${money(fundedBefore)} before this event (difference ${money(pamFunded - fundedBefore)}). Clear the break before booking.`);
        }
        if (pamUnfunded !== unfundedBefore) {
          exception(`PAM unfunded position of ${money(pamUnfunded)} does not tie to AllVue's ${money(unfundedBefore)} before this event.`);
        }
      }
    }

    const hasException = flags.some(f => f.level === 'exception');
    const hasReview = flags.some(f => f.level === 'review');
    const route = hasException ? 'exception'
      : type === 'ROLLOVER' && !legs.length && !amended.length && !hasReview ? 'auto'
        : 'review';

    // ---- PAM messages
    const newIdOf = c => {
      // New PAM contracts take the AllVue contract ID, unless PAM already uses that ID for the old contract.
      const pamId = pamIdOf(c);
      return pamId === c.contractId ? `${c.contractId}-${effectiveDate.replace(/-/g, '')}` : c.contractId;
    };
    const plan = buildPlan({ type, expired, added, amended, fundedDelta, globalDelta, capitalizing, pamIdOf, newIdOf });

    const key = [
      allvuePortfolio, assetId, effectiveDate,
      `${expired.map(c => c.contractId).sort().join('+') || '-'}>${added.map(c => c.contractId).sort().join('+') || '-'}`,
      amended.length ? '~' + amended.map(a => a.cur.contractId).sort().join('+') : '',
    ].join('|').replace(/\|$/, '');

    const weights = allocationBasis.filter(b => b.weight > 0).map(b => ({ key: b.pamPortfolio, weight: b.weight }));
    const canBuild = Boolean(tranche && weights.length);
    if (canBuild) plan.steps.forEach(step => allocateStep(step, weights));
    const messages = canBuild ? planMessages(plan, { key, effectiveDate, pamTrancheId: tranche.pamTrancheId, weights }) : [];
    const lines = plan.steps.flatMap(step => step.lines);

    // ---- lineage: which PAM contract each new AllVue contract represents
    const lineageUpdates = plan.lineage;

    return {
      key, allvuePortfolio, assetId, assetName, facilityType, effectiveDate,
      type, typeLabel: TYPE_LABELS[type], legs, route, flags,
      expired, added, amended, unchanged, rollTermChanges,
      totals: { fundedBefore, fundedAfter, fundedDelta, unfundedBefore, unfundedAfter, commitmentBefore, commitmentAfter, globalBefore, globalAfter, globalDelta },
      pamTrancheId: tranche ? tranche.pamTrancheId : '',
      allocationBasis, creates: plan.creates, steps: plan.steps, lines, messages, lineageUpdates,
    };
  }

  /**
   * Works out what PAM has to do for an event, in PAM's order:
   *   1. create each new contract in the security master,
   *   2. move units: a combine and/or a split (many → many is a combine into the
   *      first new contract, then a split out to the others),
   *   3. paydown or draw on the resulting contracts.
   * Each step in 2 and 3 becomes one global action per line plus portfolio
   * transactions. PAM closes emptied contracts itself, so there are no closes.
   */
  function buildPlan({ type, expired, added, amended, fundedDelta, globalDelta, capitalizing, pamIdOf, newIdOf }) {
    const creates = [];
    const steps = [];
    const lineage = [];
    const step = (action, lines) => { if (lines.length) steps.push({ action, lines }); };
    const line = (messageType, fromId, toId, amount, globalAmount, note) => ({ messageType, fromId, toId, amount, globalAmount, note });
    const create = c => { const id = newIdOf(c); creates.push({ ...c, pamContractId: id }); lineage.push({ allvueContractId: c.contractId, pamContractId: id }); return id; };

    // Amount change after the restructure, spread over the target contracts by size.
    const legs = (targets, note) => {
      if (!fundedDelta) return;
      const pos = allocate(fundedDelta, targets.map((t, i) => ({ key: i, weight: Math.max(t.amount, 1) })));
      const glob = allocate(globalDelta, targets.map((t, i) => ({ key: i, weight: Math.max(t.globalAmount, 1) })));
      const kind = fundedDelta < 0 ? 'PAYDOWN' : capitalizing ? 'CAPITALIZE' : 'DRAW';
      const text = kind === 'CAPITALIZE' ? note.replace(/^(Paydown|Draw)/, 'Capitalized interest') : note;
      step(kind, targets.map((t, i) => kind === 'PAYDOWN'
        ? line('PAYDOWN', t.id, '', -pos[i], -glob[i], text)
        : line(kind, '', t.id, pos[i], glob[i], text)).filter(l => l.amount !== 0));
      return { pos, glob };
    };
    const spread = (targets) => {
      // What each new contract holds before the paydown or draw is applied.
      if (!fundedDelta) return targets.map(t => ({ amount: t.amount, globalAmount: t.globalAmount }));
      const pos = allocate(fundedDelta, targets.map((t, i) => ({ key: i, weight: Math.max(t.amount, 1) })));
      const glob = allocate(globalDelta, targets.map((t, i) => ({ key: i, weight: Math.max(t.globalAmount, 1) })));
      return targets.map((t, i) => ({ amount: t.amount - pos[i], globalAmount: t.globalAmount - glob[i] }));
    };

    switch (type) {
      case 'ROLLOVER': {
        // Same terms: the PAM contract carries on, so only an amount change is booked.
        const pamId = pamIdOf(expired[0]);
        lineage.push({ allvueContractId: added[0].contractId, pamContractId: pamId });
        legs([{ id: pamId, amount: added[0].amount, globalAmount: added[0].globalAmount }], fundedDelta < 0 ? 'Paydown at rollover' : 'Draw at rollover');
        break;
      }
      case 'CONTRACT_CHANGE':
        if (expired.length && added.length) {
          const id = create(added[0]);
          step('CONTRACT_SPLIT', [line('CONTRACT_SPLIT', pamIdOf(expired[0]), id, expired[0].amount, expired[0].globalAmount, 'New terms: 1:1 split to the new contract')]);
          legs([{ id, amount: added[0].amount, globalAmount: added[0].globalAmount }], fundedDelta < 0 ? 'Paydown after the split' : 'Draw after the split');
        }
        break;
      case 'SPLIT': {
        const ids = added.map(create);
        const pre = spread(added);
        step('CONTRACT_SPLIT', added.map((c, i) => line('CONTRACT_SPLIT', pamIdOf(expired[0]), ids[i], pre[i].amount, pre[i].globalAmount, `Split into ${c.tenor} contract ${c.contractId}`)));
        legs(added.map((c, i) => ({ id: ids[i], amount: c.amount, globalAmount: c.globalAmount })), fundedDelta < 0 ? 'Paydown after the split' : 'Draw after the split');
        break;
      }
      case 'COMBINE': {
        const id = create(added[0]);
        step('CONTRACT_COMBINE', expired.map(c => line('CONTRACT_COMBINE', pamIdOf(c), id, c.amount, c.globalAmount, `Combine ${c.contractId} into ${added[0].contractId}`)));
        legs([{ id, amount: added[0].amount, globalAmount: added[0].globalAmount }], fundedDelta < 0 ? 'Paydown after the combine' : 'Draw after the combine');
        break;
      }
      case 'COMPLEX': {
        const ids = added.map(create);
        const pre = spread(added);
        step('CONTRACT_COMBINE', expired.map(c => line('CONTRACT_COMBINE', pamIdOf(c), ids[0], c.amount, c.globalAmount, `Combine ${c.contractId} into ${added[0].contractId}`)));
        step('CONTRACT_SPLIT', added.slice(1).map((c, j) => line('CONTRACT_SPLIT', ids[0], ids[j + 1], pre[j + 1].amount, pre[j + 1].globalAmount, `Split from ${added[0].contractId} into ${c.contractId}`)));
        legs(added.map((c, i) => ({ id: ids[i], amount: c.amount, globalAmount: c.globalAmount })), fundedDelta < 0 ? 'Paydown after the restructure' : 'Draw after the restructure');
        break;
      }
      case 'DRAW': {
        added.forEach(create);
        step('DRAW', added.map(c => line('DRAW', '', newIdOf(c), c.amount, c.globalAmount, `Draw into new contract ${c.contractId}`)));
        break;
      }
      case 'REPAYMENT':
        step('PAYDOWN', expired.map(c => line('PAYDOWN', pamIdOf(c), '', c.amount, c.globalAmount, 'Repaid in full')));
        break;
      default:
        break;
    }

    // Mid-period changes to contracts that did not roll.
    amended.forEach(a => {
      const gDelta = a.cur.globalAmount - a.prev.globalAmount;
      let id = pamIdOf(a.prev);
      if (a.diffs.length) {
        id = create(a.cur);
        step('CONTRACT_SPLIT', [line('CONTRACT_SPLIT', pamIdOf(a.prev), id, a.prev.amount, a.prev.globalAmount, 'Mid-period term change: 1:1 split to a new contract')]);
      }
      if (a.amountDelta < 0) step('PAYDOWN', [line('PAYDOWN', id, '', -a.amountDelta, -gDelta, 'Mid-period paydown')]);
      if (a.amountDelta > 0) {
        const kind = capitalizing ? 'CAPITALIZE' : 'DRAW';
        step(kind, [line(kind, '', id, a.amountDelta, gDelta, capitalizing ? 'Capitalized interest' : 'Mid-period draw')]);
      }
    });
    return { creates, steps, lineage };
  }

  /**
   * Splits each line of a step across PAM portfolios. Lines that split one
   * source contract into several are allocated together so that each
   * portfolio's pieces add back to its holding of the source and each target
   * contract adds back to its AllVue amount.
   */
  function allocateStep(step, weights) {
    const bySource = new Map();
    step.lines.forEach(l => {
      const k = step.action === 'CONTRACT_SPLIT' ? l.fromId : Symbol('own');
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k).push(l);
    });
    for (const group of bySource.values()) {
      if (group.length === 1) { group[0].allocation = allocate(group[0].amount, weights); continue; }
      const holding = allocate(group.reduce((t, l) => t + l.amount, 0), weights);
      const used = Object.fromEntries(weights.map(w => [w.key, 0]));
      group.forEach((l, i) => {
        if (i < group.length - 1) {
          l.allocation = allocate(l.amount, weights);
          weights.forEach(w => { used[w.key] += l.allocation[w.key]; });
        } else {
          l.allocation = Object.fromEntries(weights.map(w => [w.key, holding[w.key] - used[w.key]]));
        }
      });
    }
  }

  /** Message rows in load order: contract creates, then per step one global action per line, then portfolio transactions. */
  function planMessages(plan, { key, effectiveDate, pamTrancheId, weights }) {
    const rows = [];
    const blankTerms = { BaseRate: '', Tenor: '', MarginBps: '', FloorPct: '', PayFreq: '', ResetFreq: '', DayCount: '' };
    let stepNo = 0;
    if (plan.creates.length) {
      stepNo++;
      plan.creates.forEach(c => rows.push({
        EventKey: key, Step: stepNo, Level: 'SMF', MessageType: 'CONTRACT_CREATE', PAMPortfolio: '', PAMTrancheID: pamTrancheId,
        FromContractID: '', ToContractID: c.pamContractId, EffectiveDate: c.startDate, EndDate: c.endDate, Units: '',
        BaseRate: c.baseRate, Tenor: c.tenor, MarginBps: c.marginBps, FloorPct: c.floorPct, PayFreq: c.payFreq, ResetFreq: c.resetFreq, DayCount: c.dayCount,
      }));
    }
    plan.steps.forEach(step => {
      stepNo++;
      const base = l => ({ EventKey: key, Step: stepNo, MessageType: l.messageType, PAMTrancheID: pamTrancheId, FromContractID: l.fromId, ToContractID: l.toId, EffectiveDate: effectiveDate, EndDate: '', ...blankTerms });
      step.lines.forEach(l => { if (l.globalAmount !== 0) rows.push({ ...base(l), Level: 'GLOBAL', PAMPortfolio: '', Units: fromCents(l.globalAmount) }); });
      step.lines.forEach(l => weights.forEach(w => {
        if (l.allocation[w.key] !== 0) rows.push({ ...base(l), Level: 'PORTFOLIO', PAMPortfolio: w.key, Units: fromCents(l.allocation[w.key]) });
      }));
    });
    return rows;
  }

  // ---------------------------------------------------------------- unfunded fees

  function normalizeFees(rows) {
    return rows.map((r, i) => ({
      rowNo: i + 2, // header is line 1
      allvuePortfolio: String(r.AllVuePortfolio || '').trim(),
      assetId: String(r.AssetID || '').trim(),
      assetName: String(r.AssetName || r.AssetID || '').trim(),
      facilityType: String(r.FacilityType || '').trim().toUpperCase(),
      feeType: String(r.FeeType || '').trim(),
      periodStart: normalizeDate(r.PeriodStart),
      periodEnd: normalizeDate(r.PeriodEnd),
      rateBps: Number(r.FeeRateBps || 0),
      avgUnfunded: toCents(r.AverageUnfunded),
      dayCount: String(r.DayCount || '').trim().toUpperCase(),
      amount: toCents(r.Amount),
      transactionId: String(r.AllVueTransactionID || '').trim(),
    }));
  }

  const yearBasis = dayCount => (/365/.test(dayCount) ? 365 : 360);

  /** Fee the export should show: rate x average unfunded x days / basis, in cents. PeriodEnd is inclusive. */
  function expectedFee(f) {
    const days = daysBetween(f.periodStart, f.periodEnd) + 1;
    return { days, expected: Math.round(f.avgUnfunded * (f.rateBps / 10000) * days / yearBasis(f.dayCount)) };
  }

  /**
   * Checks each row of an AllVue unfunded fee export and splits it across the PAM
   * portfolios on their current unfunded position in the tranche.
   */
  function checkFees(input) {
    const trancheMap = input.trancheMap || {};
    const portfolioMap = input.portfolioMap || {};
    const pamPositions = input.pamPositions || [];
    const firstRowByKey = new Map();
    const money = formatMoney;

    const items = input.fees.map(f => {
      const flags = [];
      const exception = text => flags.push({ level: 'exception', text });
      const review = text => flags.push({ level: 'review', text });

      let key = ['FEE', f.allvuePortfolio, f.assetId, f.feeType.toUpperCase(), f.periodStart, f.periodEnd].join('|');
      if (firstRowByKey.has(key)) {
        exception(`Same facility, fee type and period as row ${firstRowByKey.get(key)} of the export. Load only one of them.`);
        key += `|row${f.rowNo}`;
      } else firstRowByKey.set(key, f.rowNo);

      const { days, expected } = expectedFee(f);
      const diff = f.amount - expected;
      const tranche = trancheMap[f.assetId];
      const pamPortfolios = portfolioMap[f.allvuePortfolio] || [];

      if (!tranche) exception(`Asset ${f.assetId} is not mapped to a PAM tranche. Set the tranche up in PAM and add it to the tranche map.`);
      if (!pamPortfolios.length) exception(`AllVue portfolio ${f.allvuePortfolio} has no PAM portfolios in the portfolio map.`);
      if (f.facilityType === 'TL') exception('Unfunded fee on a term loan. Term loans have no unfunded commitment, so check the asset or the fee type.');
      if (days <= 0) exception(`Period end ${f.periodEnd} is before period start ${f.periodStart}.`);

      if (f.amount < 0) {
        review(`Negative amount of ${money(f.amount)}. Confirm this reverses or corrects an earlier fee before loading it.`);
      } else if (f.amount === 0) {
        review('Zero amount. There is nothing to load; reject it unless PAM needs a zero entry.');
      } else if (Math.abs(diff) > Math.max(FEE_TOLERANCE.cents, Math.abs(expected) * FEE_TOLERANCE.share)) {
        review(`Amount differs from rate × average unfunded × days by ${money(diff)} (expected ${money(expected)}). Check the rate, the average unfunded or the period against the agent notice.`);
      }

      let allocationBasis = [];
      let pamUnfunded = 0;
      if (tranche && pamPortfolios.length) {
        allocationBasis = pamPortfolios.map(pp => {
          const pos = pamPositions.find(p => p.pamPortfolio === pp && p.pamTrancheId === tranche.pamTrancheId);
          return { pamPortfolio: pp, weight: pos ? pos.unfunded : 0 };
        });
        pamUnfunded = allocationBasis.reduce((s, b) => s + b.weight, 0);
        if (pamUnfunded <= 0) {
          exception(`No unfunded position in PAM for tranche ${tranche.pamTrancheId} in ${pamPortfolios.join(', ')}, so there is nothing to split the fee on.`);
        } else if (f.avgUnfunded > 0 && Math.abs(pamUnfunded - f.avgUnfunded) / f.avgUnfunded > FEE_POSITION_DRIFT) {
          const pct = Math.round(Math.abs(pamUnfunded - f.avgUnfunded) / f.avgUnfunded * 100);
          review(`PAM unfunded today (${money(pamUnfunded)}) differs from AllVue's average unfunded for the period (${money(f.avgUnfunded)}) by ${pct}%. Unfunded changed during the period, so check the split by fund.`);
        }
      }

      const weights = allocationBasis.filter(b => b.weight > 0).map(b => ({ key: b.pamPortfolio, weight: b.weight }));
      const allocation = tranche && weights.length ? allocate(f.amount, weights) : null;
      const line = { messageType: 'UNFUNDED_FEE', note: f.feeType, amount: f.amount, allocation };
      const messages = allocation ? weights.map(w => ({
        FeeKey: key,
        TransactionType: 'UNFUNDED_FEE',
        FeeType: f.feeType,
        PAMPortfolio: w.key,
        PAMTrancheID: tranche.pamTrancheId,
        PeriodStart: f.periodStart,
        PeriodEnd: f.periodEnd,
        Amount: fromCents(allocation[w.key]),
        AllVueTransactionID: f.transactionId,
      })) : [];

      const route = flags.some(x => x.level === 'exception') ? 'exception' : flags.length ? 'review' : 'clean';
      return {
        kind: 'fee', key, ...f, days, expected, diff, flags, route,
        pamTrancheId: tranche ? tranche.pamTrancheId : '',
        pamUnfunded, allocationBasis, lines: [line], messages,
      };
    });

    const order = { exception: 0, review: 1, clean: 2 };
    return items.sort((a, b) => order[a.route] - order[b.route] || a.assetName.localeCompare(b.assetName) || a.rowNo - b.rowNo);
  }

  /** Numbers each event's (or fee's) messages into one PAM import file. */
  function buildBatchRows(events, batchId) {
    let seq = 0;
    return events.flatMap(ev => ev.messages.map(m => ({ BatchID: batchId, Seq: ++seq, ...m })));
  }

  return {
    TERM_FIELDS, TERM_LABELS, TENOR_DAYS, TYPE_LABELS, LAYOUTS,
    parseCSV, toCSV, missingColumns,
    toCents, fromCents, formatMoney, normalizeDate, daysBetween,
    normalizeAllVue, normalizeTrancheMap, normalizePortfolioMap, normalizePamPositions, normalizeLineage,
    allocate, detectEvents, buildBatchRows,
    FEE_TOLERANCE, FEE_POSITION_DRIFT, normalizeFees, expectedFee, checkFees,
  };
});
