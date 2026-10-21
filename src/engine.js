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
    TRADE: 'Trade', NEW_POSITION: 'New purchase',
  };
  const TENOR_MONTHS = { '1M': 1, '3M': 3, '6M': 6, '12M': 12 };

  // Interest types whose interest is added to principal (PIK) rather than paid in cash.
  const CAPITALIZING = new Set(['CAPITALIZE', 'CAPITALIZED', 'PIK', 'PARTIAL', 'PARTIAL PIK']);

  // Input and output file layouts. The PAM layout is a placeholder until the
  // real import message formats are supplied.
  const LAYOUTS = {
    allvue: ['AsOfDate', 'AllVuePortfolio', 'AssetID', 'AssetName', 'FacilityType', 'ContractID', 'ContractType',
      'StartDate', 'EndDate', 'Amount', 'GlobalAmount', 'Commitment', 'RateType', 'InterestType', 'BaseRate', 'Tenor', 'MarginBps', 'FloorPct',
      'PayFreq', 'ResetFreq', 'DayCount'],
    trancheMap: ['AssetID', 'PAMTrancheID', 'FacilityType', 'MaturityDate', 'PAMCurrency'],
    portfolioMap: ['AllVuePortfolio', 'PAMPortfolio', 'Bank', 'BankName', 'CustodyAccount', 'CashBank'],
    pamPositions: ['AsOfDate', 'PAMPortfolio', 'PAMTrancheID', 'Funded', 'Unfunded'],
    lineage: ['AllVueContractID', 'PAMContractID'],

    fees: ['AllVuePortfolio', 'AssetID', 'AssetName', 'FacilityType', 'FeeType', 'PeriodStart', 'PeriodEnd',
      'FeeRateBps', 'AverageUnfunded', 'DayCount', 'Amount', 'AllVueTransactionID'],
    pamFeeImport: ['BatchID', 'Seq', 'FeeKey', 'TransactionType', 'FeeType', 'PAMPortfolio', 'PAMTrancheID',
      'PeriodStart', 'PeriodEnd', 'Amount', 'AllVueTransactionID'],
  };

  // PAM message settings taken from PAM's samples. Security ID type 3 is the
  // facility (tranche) and 26 a contract.
  const PAM = {
    facilityIdType: 3,
    contractIdType: 26,
    settlementMethod: 11,
    tradePrice: '100.0000000',
    // BANKLOANACTION types. Split and combine are from PAM's samples; the
    // paydown, draw and capitalization codes are from PAM's type list and
    // still need confirming.
    // Drawdowns take unfunded lots in this order (F, assumed FIFO, from PAM's export).
    unfundedTakedown: 'F',
    actionType: { CONTRACT_SPLIT: 8, CONTRACT_COMBINE: 9, PAYDOWN: 6, DRAW: 4, CAPITALIZE: 10 },
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

  /**
   * Internal contract rows. Optional columns: SpreadAdjBps (added to the margin
   * when addSpreadAdjustment is on, since PAM can't hold a base rate adjustment),
   * CapPct, AllInRate.
   */
  function normalizeAllVue(rows, { addSpreadAdjustment = true } = {}) {
    return rows.map(r => {
      const contractType = String(r.ContractType || '').trim().toLowerCase();
      const kind = contractType.startsWith('unfund') ? 'unfunded' : contractType === 'lc' ? 'lc' : contractType === 'other' ? 'other' : 'funded';
      const spreadAdjBps = Number(r.SpreadAdjBps || 0);
      return {
        kind,
        asOfDate: normalizeDate(r.AsOfDate),
        allvuePortfolio: String(r.AllVuePortfolio || '').trim(),
        assetId: String(r.AssetID || '').trim(),
        assetName: String(r.AssetName || r.AssetID || '').trim(),
        // Display names (optional): AllVue portfolioName and legalEntityName.
        portfolioName: String(r.PortfolioName || '').trim(),
        issuerName: String(r.IssuerName || '').trim(),
        facilityType: String(r.FacilityType || '').trim().toUpperCase(),
        contractId: String(r.ContractID || '').trim(),
        unfunded: kind === 'unfunded',
        startDate: normalizeDate(r.StartDate),
        endDate: normalizeDate(r.EndDate),
        amount: toCents(r.Amount),
        globalAmount: toCents(r.GlobalAmount),
        commitment: toCents(r.Commitment),
        rateType: String(r.RateType || '').trim(),
        interestType: String(r.InterestType || '').trim(),
        baseRate: String(r.BaseRate || '').trim(),
        tenor: String(r.Tenor || '').trim().toUpperCase(),
        marginBps: round3(Number(r.MarginBps || 0) + (addSpreadAdjustment ? spreadAdjBps : 0)),
        spreadAdjBps,
        floorPct: Number(r.FloorPct || 0),
        capPct: Number(r.CapPct || 0),
        allInRate: r.AllInRate === undefined || r.AllInRate === '' ? null : Number(r.AllInRate),
        payFreq: String(r.PayFreq || '').trim(),
        resetFreq: String(r.ResetFreq || '').trim(),
        dayCount: String(r.DayCount || '').trim(),
      };
    });
  }

  const round3 = n => Math.round(n * 1000) / 1000;

  // ---------------------------------------------------------------- AllVue contracts report

  // The AllVue contracts report, one row per portfolio, facility and accrual (contract).
  // Headers are matched without brackets or case.
  const REPORT_REQUIRED = ['portfolioId', 'instrumentId', 'primaryIdentifier', 'referenceAccrualId', 'accrualType', 'instrumentSubType',
    'baseRateIndexName', 'rateType', 'interestPaymentType', 'spread', 'spreadAdjustment', 'rateFloor', 'dayCount',
    'numPaymentsPerYear', 'beginDate', 'endDate', 'accrualAmount', 'globalAccrualAmount'];
  const REPORT_OPTIONAL = ['portfolioName', 'legalEntityId', 'legalEntityName', 'instrumentName', 'positionId', 'baseRate',
    'rateCeiling', 'allInRate', 'instrumentOriginalGlobalAmount'];
  const REPORT_ACCRUAL_TYPE = { FUNDED: 'Funded', UNFUNDED: 'Unfunded', 'DELAYED DRAW UNFUNDED': 'Unfunded', 'LETTER OF CREDIT': 'LC', '% OF FUNDED': 'Other' };
  const REPORT_INSTRUMENT_SUBTYPE = { 'TERM LOAN': 'TL', REVOLVER: 'RC', 'DELAYED DRAW': 'DDTL' };
  const REPORT_RATE_TYPE = { FLOAT: 'Floating', FLOATING: 'Floating', FIXED: 'Fixed' };
  const REPORT_PAYMENTS = { 1: 'Annual', 2: 'Semi-Annual', 4: 'Quarterly', 12: 'Monthly', 52: 'Weekly' };
  const REPORT_DAY_COUNT = { 'ACT/360': 'ACT/360', 'ACT/365 (FIXED)': 'ACT/365', 'ACT/365': 'ACT/365', '30U/360': '30/360', '30/360': '30/360' };
  const TENOR_RESET = { '1M': 'Monthly', '3M': 'Quarterly', '6M': 'Semi-Annual', '12M': 'Annual' };

  const headerKey = h => String(h).replace(/[[\]\s]/g, '').toLowerCase();

  function isAllVueReport(headers) {
    return (headers || []).some(h => headerKey(h) === 'referenceaccrualid');
  }

  function missingReportColumns(headers) {
    const have = new Set((headers || []).map(headerKey));
    return REPORT_REQUIRED.filter(c => !have.has(c.toLowerCase()));
  }

  /** "1M SOFR Term" -> SOFR / 1M; "Prime" -> PRIME with no tenor. */
  function parseBaseRateIndex(name) {
    const s = String(name || '').trim();
    const t = s.match(/(\d+)\s*M\b/i);
    const base = /SOFR/i.test(s) ? 'SOFR' : s.replace(/(\d+)\s*M\b/i, '').replace(/\bTERM\b/i, '').trim().toUpperCase();
    return { baseRate: base, tenor: t ? `${t[1]}M` : '' };
  }

  const pct = v => (v === undefined || String(v).trim() === '' ? 0 : Number(v));

  /**
   * Converts the AllVue contracts report into the app's contract rows. Rates in
   * the report are decimals (0.05 = 5%). Returns { rows, notes }; notes list
   * values that were not recognised.
   */
  function fromAllVueReport(reportRows, { asOfDate }) {
    const notes = new Set();
    const get = (r, k) => {
      const key = Object.keys(r).find(x => headerKey(x) === k.toLowerCase());
      return key === undefined ? '' : String(r[key] ?? '').trim();
    };
    const rows = reportRows.map(r => {
      const accrualType = get(r, 'accrualType');
      const instrumentSubType = get(r, 'instrumentSubType');
      const rateType = get(r, 'rateType');
      const dayCount = get(r, 'dayCount');
      const payments = get(r, 'numPaymentsPerYear');
      const contractType = REPORT_ACCRUAL_TYPE[accrualType.toUpperCase()];
      if (!contractType) notes.add(`accrual type "${accrualType}" (row ignored)`);
      const facilityType = REPORT_INSTRUMENT_SUBTYPE[instrumentSubType.toUpperCase()] || instrumentSubType;
      if (!REPORT_INSTRUMENT_SUBTYPE[instrumentSubType.toUpperCase()]) notes.add(`instrument sub type "${instrumentSubType}"`);
      const { baseRate, tenor } = parseBaseRateIndex(get(r, 'baseRateIndexName'));
      const funded = contractType === 'Funded';
      const payFreq = funded ? (REPORT_PAYMENTS[Number(payments)] || (payments ? `${payments} per year` : '')) : '';
      return {
        AsOfDate: asOfDate,
        AllVuePortfolio: get(r, 'portfolioId'),
        AssetID: get(r, 'primaryIdentifier'),
        AssetName: get(r, 'instrumentName') || get(r, 'primaryIdentifier'),
        IssuerName: get(r, 'legalEntityName'),
        PortfolioName: get(r, 'portfolioName'),
        FacilityType: facilityType,
        ContractID: get(r, 'referenceAccrualId'),
        ContractType: contractType || 'Other',
        StartDate: get(r, 'beginDate'),
        EndDate: get(r, 'endDate'),
        Amount: get(r, 'accrualAmount') || '0',
        GlobalAmount: get(r, 'globalAccrualAmount') || '0',
        Commitment: '', // filled in below from the funded, unfunded and LC rows
        RateType: funded ? (REPORT_RATE_TYPE[rateType.toUpperCase()] || rateType) : '',
        InterestType: funded ? get(r, 'interestPaymentType') : '',
        BaseRate: funded && REPORT_RATE_TYPE[rateType.toUpperCase()] !== 'Fixed' ? baseRate : '',
        Tenor: funded ? tenor : '',
        MarginBps: funded ? String(round3(pct(get(r, 'spread')) * 10000)) : '',
        SpreadAdjBps: funded ? String(round3(pct(get(r, 'spreadAdjustment')) * 10000)) : '',
        FloorPct: funded ? String(round3(pct(get(r, 'rateFloor')) * 100)) : '',
        CapPct: funded ? String(round3(pct(get(r, 'rateCeiling')) * 100)) : '',
        AllInRate: get(r, 'allInRate'),
        PayFreq: payFreq,
        ResetFreq: funded ? (TENOR_RESET[tenor] || payFreq) : '',
        DayCount: funded ? (REPORT_DAY_COUNT[dayCount.toUpperCase()] || dayCount) : '',
      };
    });
    // Commitment per portfolio and facility = funded + unfunded + letters of credit.
    const totals = new Map();
    rows.forEach(r => {
      if (!['Funded', 'Unfunded', 'LC'].includes(r.ContractType)) return;
      const k = `${r.AllVuePortfolio}|${r.AssetID}`;
      totals.set(k, (totals.get(k) || 0) + toCents(r.Amount));
    });
    rows.forEach(r => { r.Commitment = fromCents(totals.get(`${r.AllVuePortfolio}|${r.AssetID}`) || 0); });
    return { rows, notes: [...notes] };
  }

  function normalizeTrancheMap(rows) {
    const map = {};
    rows.forEach(r => {
      if (r.AssetID) {
        map[r.AssetID.trim()] = {
          pamTrancheId: r.PAMTrancheID.trim(),
          facilityType: (r.FacilityType || '').trim().toUpperCase(),
          maturityDate: normalizeDate(r.MaturityDate),
          currency: (r.PAMCurrency || '').trim(),
        };
      }
    });
    return map;
  }

  /** Bank and custody details per PAM portfolio, used in each portfolio message's BNK(). */
  function normalizePortfolioAccounts(rows) {
    const map = {};
    rows.forEach(r => {
      const pam = (r.PAMPortfolio || '').trim();
      if (pam) map[pam] = { bank: (r.Bank || '').trim(), bankName: (r.BankName || '').trim(), custodyAccount: (r.CustodyAccount || '').trim(), cashBank: (r.CashBank || '').trim() };
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
      asOfDate: normalizeDate(r.AsOfDate),
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

  const ROUTE_ORDER = { exception: 0, review: 1, auto: 2, trade: 3 };

  /**
   * Checks the run's dates. The PAM holdings must be as of the same date as the
   * AllVue prior snapshot (both end of the previous business day), and the
   * AllVue current snapshot must be later. Errors stop the run.
   */
  function checkRunDates({ prior, current, pamPositions }) {
    const errors = [];
    const warnings = [];
    const one = (rows, name) => {
      const dates = [...new Set(rows.map(r => r.asOfDate).filter(Boolean))].sort();
      if (rows.length && !dates.length) errors.push(`The ${name} has no AsOfDate.`);
      if (dates.length > 1) errors.push(`The ${name} has more than one AsOfDate (${dates.join(', ')}).`);
      return dates[dates.length - 1] || '';
    };
    const priorDate = one(prior, 'AllVue prior snapshot');
    const currentDate = one(current, 'AllVue current snapshot');
    const pamDate = one(pamPositions, 'PAM holdings file');
    if (priorDate && currentDate && currentDate <= priorDate) {
      errors.push(`The AllVue current snapshot (${currentDate}) must be later than the prior snapshot (${priorDate}).`);
    }
    if (pamDate && priorDate && pamDate !== priorDate) {
      errors.push(`PAM holdings are as of ${pamDate} but the AllVue prior snapshot is as of ${priorDate}. They must be the same date.`);
    }
    if (priorDate && currentDate && daysBetween(priorDate, currentDate) > 4) {
      warnings.push(`${daysBetween(priorDate, currentDate)} days between the AllVue snapshots. Check that no business day was skipped.`);
    }
    return { priorDate, currentDate, pamDate, errors, warnings };
  }

  /** Same day of month (clamped to month end) a number of months away. */
  function shiftMonths(isoDate, months, day) {
    const y = Number(isoDate.slice(0, 4));
    const m = Number(isoDate.slice(5, 7)) - 1 + months;
    const year = y + Math.floor(m / 12);
    const month = ((m % 12) + 12) % 12;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  }

  /**
   * The first payment date a regular schedule would give after the start date:
   * step back from the contract's end date one tenor at a time while still after
   * the start. Equal to the end date for a regular or short first period.
   */
  function firstScheduledPayDate(c) {
    const months = TENOR_MONTHS[c.tenor];
    if (!months) return c.endDate;
    const day = Number(c.endDate.slice(8, 10));
    let pay = c.endDate;
    for (let back = shiftMonths(pay, -months, day); back > c.startDate; back = shiftMonths(back, -months, day)) pay = back;
    return pay;
  }

  /**
   * Compares the prior and current AllVue contract snapshots for each AllVue
   * portfolio and asset, and returns one classified event per change.
   */
  function detectEvents(input) {
    const ctx = {
      asOfDate: input.asOfDate,
      trancheMap: input.trancheMap || {},
      portfolioMap: input.portfolioMap || {},
      accounts: input.accounts || {},
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
      || displayName(a).localeCompare(displayName(b)) || a.allvuePortfolio.localeCompare(b.allvuePortfolio));
    return events;
  }

  /** Issuer and instrument, e.g. "Granite Peak Services Term Loan B". */
  const displayName = ev => [ev.issuerName, ev.assetName].filter(Boolean).join(' ');

  function classifyGroup(g, ctx) {
    const head = g.current[0] || g.prior[0];
    const { allvuePortfolio, assetId, assetName, facilityType } = head;
    const named = k => (g.current.find(r => r[k]) || g.prior.find(r => r[k]) || {})[k] || '';
    const portfolioName = named('portfolioName');
    const issuerName = named('issuerName');

    const priorFunded = g.prior.filter(r => r.kind === 'funded');
    const currentFunded = g.current.filter(r => r.kind === 'funded');
    const lcAfter = sum(g.current.filter(r => r.kind === 'lc'));
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

    // ---- trades vs loan events. Trades (buys, sells, new purchases) are booked in
    // PAM by the trade feed. A position change with no change in the facility's
    // global amount is a trade; this app only books what the loan itself did.
    const gsum = rows => rows.reduce((t, r) => t + r.globalAmount, 0);
    const globalBefore = gsum(priorFunded);
    const globalAfter = gsum(currentFunded);
    const globalDelta = globalAfter - globalBefore;
    const missingGlobal = [...priorFunded, ...currentFunded].filter(c => c.amount !== 0 && c.globalAmount <= 0);
    const isNew = !g.prior.length && g.current.length > 0;
    const isTrade = !isNew && !missingGlobal.length && globalBefore > 0 && g.current.length > 0 && fundedDelta !== 0 && globalDelta === 0;
    // The change this app books: none of a trade's change.
    const bookedDelta = isTrade ? 0 : fundedDelta;
    const planAmended = isTrade ? amended.map(a => ({ ...a, amountDelta: 0 })) : amended;

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
    if (isNew) type = 'NEW_POSITION';
    // A trade with no restructure: nothing for this app to book.
    const restructured = ['CONTRACT_CHANGE', 'SPLIT', 'COMBINE', 'COMPLEX'].includes(type);
    if (isTrade && !restructured) type = 'TRADE';

    const rollsAtPeriodEnd = expired.length > 0 && added.length > 0;
    // An increase on a contract that capitalizes interest is PIK, not a draw.
    const capitalizing = bookedDelta > 0
      && [...expired, ...amended.map(a => a.prev)].some(c => CAPITALIZING.has(c.interestType.toUpperCase()));
    if (capitalizing && type === 'DRAW' && !added.length) type = 'CAPITALIZE';
    const legs = [];
    if (rollsAtPeriodEnd && !isNew && bookedDelta < 0) legs.push('PAYDOWN');
    if (rollsAtPeriodEnd && !isNew && bookedDelta > 0) legs.push(capitalizing ? 'CAPITALIZE' : 'DRAW');

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

    if (g.current.length && fundedAfter + unfundedAfter + lcAfter !== commitmentAfter) {
      exception(`Funded ${money(fundedAfter)} plus unfunded ${money(unfundedAfter)}${lcAfter ? ` plus letters of credit ${money(lcAfter)}` : ''} does not equal the commitment of ${money(commitmentAfter)} in the AllVue export.`);
    }
    if (!['TL', 'RC', 'DDTL'].includes(facilityType)) {
      exception(`Unknown facility type "${facilityType}". Expected Term Loan, Revolver or Delayed Draw.`);
    }
    if (facilityType === 'TL' && unfundedAfter !== 0) {
      exception(`Term loan shows an unfunded amount of ${money(unfundedAfter)}. Term loans should be fully funded.`);
    }
    if (capitalizing) {
      review(`Funded amount went up by ${money(fundedDelta)} on a contract that capitalizes interest. Booked as capitalized (PIK) interest; check it against the agent notice.`);
    } else if (facilityType === 'TL' && bookedDelta > 0 && !isNew) {
      exception(`Term loan funded amount went up by ${money(fundedDelta)}. Term loans do not draw, so check for an add-on, an incremental or a trade.`);
    }
    if (!capitalizing && !isNew && facilityType !== 'TL' && bookedDelta > unfundedBefore) {
      exception(`Draw of ${money(fundedDelta)} is larger than the prior unfunded amount of ${money(unfundedBefore)}.`);
    }

    if (g.current.length && !isNew && !isTrade && commitmentAfter !== commitmentBefore) {
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
      if (!range || (days >= range[0] && days <= range[1])) return;
      const freq = (c.payFreq || '').toLowerCase();
      if (isNew && days > range[1]) {
        review(`Initial long: the first contract ${c.contractId} runs ${days} days (${c.startDate} to ${c.endDate}) on a ${c.tenor} tenor. On its ${freq} schedule PAM will expect the first interest payment on ${firstScheduledPayDate(c)}; AllVue's first payment is ${c.endDate}. Apply the PAM fix for initial long periods.`);
      } else if (isNew) {
        review(`Initial short: the first contract ${c.contractId} runs only ${days} days (${c.startDate} to ${c.endDate}) on a ${c.tenor} tenor. Check that PAM accrues the short first period to ${c.endDate}.`);
      } else {
        review(`New contract ${c.contractId} runs ${days} days (${c.startDate} to ${c.endDate}) on a ${c.tenor} tenor. PAM accrues on the regular schedule, so check for a stub or broken period.`);
      }
    });
    if (isNew) {
      info(`New position of ${money(fundedAfter)}. The trade feed books the purchase in PAM; this app sends nothing for it. Link the PAM contract it lands in once the trade has posted.`);
    }
    if (isTrade && !restructured) {
      info(`Your position changed by ${money(fundedDelta)} while the facility's global amount didn't: a ${fundedDelta < 0 ? 'sale' : 'purchase'}. The trade feed books it in PAM; this app sends nothing for it.`);
    }
    if (isTrade && restructured) {
      review(`A ${fundedDelta < 0 ? 'sale' : 'purchase'} of ${money(Math.abs(fundedDelta))} happened on the same day as this restructure. The messages below move the holdings as they were before the trade; the trade feed books the trade separately. Check the amounts once the trade has posted in PAM.`);
    }

    if (type === 'COMPLEX') {
      review(`${expired.length} contracts roll into ${added.length}. Booked as a combine into contract ${added[0].contractId}, then a split out to the others. Check the amounts against the agent notice.`);
    }
    if (type === 'REPAYMENT' && !g.current.length) {
      review('The position is no longer in the AllVue export. If it was repaid, approve. If it was sold or transferred, the trade feed books it: reject.');
    }
    if (rollsAtPeriodEnd && amended.length) {
      info('Other contracts on this tranche also changed and are included in this event.');
    }
    if ((type === 'SPLIT' || type === 'COMPLEX') && bookedDelta !== 0) {
      info(`The ${bookedDelta < 0 ? 'paydown' : 'draw'} is booked after the restructure, spread across the new contracts in proportion to their size.`);
    }

    // ---- global amounts: needed for PAM's global actions.
    if (missingGlobal.length) {
      exception(`No global amount for contract ${[...new Set(missingGlobal.map(c => c.contractId))].join(', ')}. PAM's global action needs it.`);
    } else if (globalBefore > 0 && g.current.length && !isTrade) {
      if (globalDelta !== 0) {
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
      if (allocationBasis.every(b => b.weight === 0) && !isNew) {
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


    // ---- PAM messages
    const newIdOf = c => {
      // New PAM contracts take the AllVue contract ID, unless PAM already uses that ID for the old contract.
      const pamId = pamIdOf(c);
      return pamId === c.contractId ? `${c.contractId}-${effectiveDate.replace(/-/g, '')}` : c.contractId;
    };
    // Trades and new purchases are the trade feed's: only the loan's own change is planned.
    const planType = isNew ? 'NEW_POSITION' : type === 'TRADE' ? (expired.length === 1 && added.length === 1 ? 'ROLLOVER' : 'NONE') : type;
    const plan = buildPlan({ type: planType, expired, added, amended: planAmended, fundedDelta: bookedDelta, globalDelta: isTrade ? 0 : globalDelta, capitalizing, pamIdOf, newIdOf });

    const key = [
      allvuePortfolio, assetId, effectiveDate,
      `${expired.map(c => c.contractId).sort().join('+') || '-'}>${added.map(c => c.contractId).sort().join('+') || '-'}`,
      amended.length ? '~' + amended.map(a => a.cur.contractId).sort().join('+') : '',
    ].join('|').replace(/\|$/, '');

    const weights = allocationBasis.filter(b => b.weight > 0).map(b => ({ key: b.pamPortfolio, weight: b.weight }));
    const canBuild = Boolean(tranche && weights.length);
    if (canBuild) plan.steps.forEach(step => allocateStep(step, weights));
    const messages = canBuild ? planMessages(plan, { effectiveDate, tranche, weights, accounts: ctx.accounts }) : [];
    if (canBuild) {
      const per = (type, key) => {
        const totals = {};
        messages.filter(m => m.level === 'PORTFOLIO' && m.type === type).forEach(m => { totals[m.pamPortfolio] = (totals[m.pamPortfolio] || 0) + m.unitsExchanged; });
        Object.entries(totals).forEach(([p, units]) => {
          const b = allocationBasis.find(x => x.pamPortfolio === p);
          if (b && units > b[key]) exception(`${p} would ${type === 'PAYDOWN' ? 'redeem' : 'draw'} ${money(units)} but holds ${money(b[key])} ${key} in PAM.`);
        });
      };
      per('PAYDOWN', 'funded');
      per('DRAW', 'unfunded');
    }
    if (canBuild && messages.some(m => m.level === 'PORTFOLIO' && !m.manual)) {
      const noBank = weights.map(w => w.key).filter(p => !(ctx.accounts[p] && ctx.accounts[p].bank && ctx.accounts[p].custodyAccount));
      if (noBank.length) exception(`No bank or custody account for ${noBank.join(', ')} in the portfolio map. PAM's portfolio messages need them.`);
    }
    messages.filter(m => m.level === 'SMF').forEach(m => m.inputs.forEach(input => {
      const v = validateContractAdd(input);
      v.errors.forEach(e => exception(`Contract create for ${input.contract_id}: ${e}`));
      v.warnings.forEach(w => info(`Contract create for ${input.contract_id}: ${w}`));
    }));
    if (messages.some(m => m.manual && m.level === 'PORTFOLIO')) {
      info('Book the portfolio capitalized interest transactions in PAM after loading the file. Their message format hasn\'t been added yet.');
    }
    const lines = plan.steps.flatMap(step => step.lines);

    const hasException = flags.some(f => f.level === 'exception');
    const hasReview = flags.some(f => f.level === 'review');
    const route = hasException ? 'exception'
      : hasReview ? 'review'
        : (type === 'TRADE' || type === 'NEW_POSITION') ? 'trade'
          : type === 'ROLLOVER' && !legs.length && !amended.length ? 'auto'
            : 'review';

    // ---- lineage: which PAM contract each new AllVue contract represents
    const lineageUpdates = plan.lineage;

    return {
      key, allvuePortfolio, portfolioName, assetId, assetName, issuerName, facilityType, effectiveDate,
      type, typeLabel: TYPE_LABELS[type], legs, route, flags,
      expired, added, amended, unchanged, rollTermChanges,
      totals: { fundedBefore, fundedAfter, fundedDelta, bookedDelta, unfundedBefore, unfundedAfter, commitmentBefore, commitmentAfter, globalBefore, globalAfter, globalDelta },
      isTrade, isNew,
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

  /**
   * PAM messages in load order:
   *   - contract creates (security master),
   *   - per step, one BANKLOANACTION global action with signed global units per
   *     contract (sources negative, targets positive),
   *   - then one portfolio message per PAM portfolio: TaCONTRACTSPLIT names the
   *     source contract and allocates to the targets; TaCONTRACTCOMBINE names
   *     the target and allocates from the sources.
   * Messages whose PAM format hasn't been supplied yet are marked manual and
   * left out of the file.
   */
  function planMessages(plan, { effectiveDate, tranche, weights, accounts }) {
    const out = [];
    let stepNo = 0;
    const common = { facilityId: tranche.pamTrancheId, effectiveDate, maturityDate: tranche.maturityDate };
    if (plan.creates.length) {
      stepNo++;
      // One SMFBANKLOANTRANCHE UPDATE per event carrying every new contract on the tranche.
      out.push({
        ...common, step: stepNo, level: 'SMF', type: 'CONTRACT_CREATE',
        contractId: plan.creates.map(c => c.pamContractId).join(', '),
        contractIds: plan.creates.map(c => c.pamContractId),
        inputs: plan.creates.map(c => contractAddInput(c, tranche)),
      });
    }
    plan.steps.forEach(step => {
      stepNo++;
      const base = { ...common, step: stepNo, type: step.action };
      // Global action: net signed units per contract.
      const net = new Map();
      const add = (id, units) => { if (id) net.set(id, (net.get(id) || 0) + units); };
      step.lines.forEach(l => {
        if (l.messageType === 'PAYDOWN') add(l.fromId, -l.globalAmount);
        else if (l.messageType === 'DRAW' || l.messageType === 'CAPITALIZE') add(l.toId, l.globalAmount);
        else { add(l.fromId, -l.globalAmount); add(l.toId, l.globalAmount); }
      });
      const recs = [...net.entries()].filter(([, u]) => u !== 0).map(([contractId, units]) => ({ contractId, units }));
      if (recs.length) out.push({ ...base, level: 'GLOBAL', actionType: PAM.actionType[step.action], allocs: recs });

      if (step.action === 'CONTRACT_SPLIT' || step.action === 'CONTRACT_COMBINE') {
        const isSplit = step.action === 'CONTRACT_SPLIT';
        const groups = new Map();
        step.lines.forEach(l => {
          const k = isSplit ? l.fromId : l.toId;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(l);
        });
        for (const [contractId, group] of groups) {
          weights.forEach(w => {
            const allocs = group.map(l => ({ contractId: isSplit ? l.toId : l.fromId, units: l.allocation[w.key] })).filter(a => a.units !== 0);
            const units = allocs.reduce((t, a) => t + a.units, 0);
            if (units) out.push({ ...base, level: 'PORTFOLIO', pamPortfolio: w.key, account: accounts[w.key] || {}, contractId, unitsExchanged: units, allocs });
          });
        }
      } else if (step.action === 'PAYDOWN') {
        // TaContractRedemption redeems one contract per message.
        step.lines.forEach(l => weights.forEach(w => {
          const units = l.allocation[w.key];
          if (units) out.push({ ...base, level: 'PORTFOLIO', pamPortfolio: w.key, account: accounts[w.key] || {}, contractId: l.fromId, unitsExchanged: units, allocs: [] });
        }));
      } else if (step.action === 'DRAW') {
        // TaDrawDown: one message per portfolio, allocated to the contracts drawn into.
        weights.forEach(w => {
          const allocs = step.lines.map(l => ({ contractId: l.toId, units: l.allocation[w.key] })).filter(a => a.units !== 0);
          const units = allocs.reduce((t, a) => t + a.units, 0);
          if (units) out.push({ ...base, level: 'PORTFOLIO', pamPortfolio: w.key, account: accounts[w.key] || {}, contractId: '', unitsExchanged: units, allocs });
        });
      } else {
        // Capitalized interest: no PAM message format yet, so it stays a manual step.
        step.lines.forEach(l => weights.forEach(w => {
          const units = l.allocation[w.key];
          if (units) out.push({ ...base, level: 'PORTFOLIO', manual: true, pamPortfolio: w.key, contractId: l.fromId || l.toId, unitsExchanged: units, allocs: [] });
        }));
      }
    });
    return out;
  }

  const pamDate = d => String(d || '').replace(/-/g, '');

  // ---------------------------------------------------------------- PAM contract add (SMFBANKLOANTRANCHE)
  //
  // Minimal message that adds new funded contracts to an existing tranche, per
  // the PAM bank loan contract add build spec. Built as a tree of messages and
  // serialized recursively, never by string templating.

  /** A PAM message node: KEYWORD(arg, arg, ...). Args are strings, numbers, null (blank) or nodes. */
  const node = (keyword, ...args) => ({ keyword, args });

  function serialize(n) {
    if (n === null || n === undefined) return '';
    if (typeof n === 'object') return `${n.keyword}(${n.args.map(serialize).join(',')})`;
    return String(n);
  }

  /** Indented version for human review. */
  function prettyPrint(n, depth = 0) {
    const pad = '  '.repeat(depth);
    if (n === null || n === undefined || typeof n !== 'object') return pad + (n === ' ' ? "' '" : serialize(n));
    if (!n.args.some(a => a && typeof a === 'object')) return pad + serialize(n);
    return `${pad}${n.keyword}(\n${n.args.map(a => prettyPrint(a, depth + 1)).join(',\n')}\n${pad})`;
  }

  function assertBalanced(text) {
    let depth = 0;
    for (const ch of text) {
      if (ch === '(') depth++;
      if (ch === ')' && --depth < 0) break;
    }
    if (depth !== 0) throw new Error('Unbalanced parentheses in PAM message');
    return text;
  }

  // Values PAM needs that AllVue doesn't carry. From the build spec's sample defaults.
  const PAM_CONTRACT_DEFAULTS = {
    strip: ' ', payment_type: 'B', coupon_form: 'C', day_count: 'D', dated_type: 'T', delay: 0,
    holiday_schedule: 'US', pay_date_conv: 3, float_method: 'A', multiplier: 1, max_rate: 0,
    lockout_days: 0, lookback_days: 2, reset_date_conv: 3, reset_holiday_schedule: 'US',
  };
  const LOAN_TYPE_CODE = { TL: 1, RC: 2, DDTL: 3 };
  const FREQ_CODE = { MONTHLY: 'M', QUARTERLY: 'Q', 'SEMI-ANNUAL': 'S', SEMIANNUAL: 'S', 'SEMI ANNUAL': 'S', ANNUAL: 'A', 'AT MATURITY': 'B' };
  const DAY_COUNT_CODE = { 'ACT/360': 'D', 'ACT/365': 'C', '30/360': 'A' };
  const COUPON_FORM_CODE = { CASH: 'C', CAPITALIZE: 'P', CAPITALIZED: 'P', PIK: 'P', PARTIAL: 'P', 'PARTIAL PIK': 'P' };
  const BASE_INDEX_PREFIX = { SOFR: 'SR' };
  const EXCLUDED_CONTRACT_FIELDS = ['ACCTDATA', 'OPERDATA', 'CALLDATA', 'CONTRACTSIZE', 'ISSUESYMBOL', 'OIDDATE', 'OIDPRICE',
    'SINKFUNDDATA', 'MANDCONV', 'ACCRUALLAG', 'BORROWERID', 'OPTIONTODEFER', 'NONADMITTEDINCOMEIND', 'UNCOLLECTABLEINCOMEIND',
    'BALLOONPAYMENTPERCENTATORIGINATION', 'OPTIONALNONCASHINCOMEIND', 'SERBNDTREATMENT', 'PIKDATA', 'ACCRUALDATA', 'SCHDINTDATA',
    'PIKFIXEDRATEDATA', 'VARACCRUALDATA', 'COMPOUNDFREQ', 'COMPOUNDMETHOD', 'COMPOUNDMONTH', 'COMPOUNDDAY', 'INTERPOLATEINITIALRATE',
    'VRROUNDING', 'ALTRATECALCMETHOD', 'DAYLAGWEIGHTMETHOD', 'ADJUSTACCRUALFORMATURITY'];

  /** Accrual month code: Q → 19 (J-A-J-O), 20 (F-M-A-N), 21 (M-J-S-D); S → 13-18; A → 1-12. */
  function accrualMonthCode(freq, month) {
    if (freq === 'Q') return 19 + ((month - 1) % 3);
    if (freq === 'S') return 13 + ((month - 1) % 6);
    if (freq === 'A') return month;
    return null;
  }

  /** Maps an AllVue contract on a mapped tranche to the build spec's input keys. */
  function contractAddInput(c, tranche) {
    const coupon_type = c.rateType.toUpperCase() === 'FIXED' ? 'F' : c.rateType.toUpperCase() === 'FLOATING' ? 'V' : c.rateType;
    const coupon_freq = FREQ_CODE[c.payFreq.toUpperCase()] || c.payFreq;
    const reset_freq = FREQ_CODE[c.resetFreq.toUpperCase()] || c.resetFreq;
    // The pay date is the contract end date; business-day rolls can pull it a day or two early,
    // so take the later of the start and end day of month as the scheduled pay day.
    const payMonth = Number(c.endDate.slice(5, 7));
    const payDay = Math.max(Number(c.startDate.slice(8, 10)), Number(c.endDate.slice(8, 10)));
    const noDay = coupon_freq === 'B' || coupon_freq === 'T';
    const prefix = BASE_INDEX_PREFIX[c.baseRate.toUpperCase()];
    return {
      ...PAM_CONTRACT_DEFAULTS,
      tranche_id: tranche.pamTrancheId,
      loan_type: LOAN_TYPE_CODE[c.facilityType] ?? '',
      tranche_maturity: pamDate(tranche.maturityDate),
      currency: tranche.currency,
      contract_id: c.pamContractId,
      contract_maturity: pamDate(tranche.maturityDate),
      coupon_type,
      coupon_rate: coupon_type === 'F' ? c.marginBps / 100 : '',
      coupon_form: COUPON_FORM_CODE[c.interestType.toUpperCase()] || PAM_CONTRACT_DEFAULTS.coupon_form,
      coupon_freq,
      day_count: DAY_COUNT_CODE[c.dayCount.toUpperCase()] || c.dayCount,
      accrual_month: accrualMonthCode(coupon_freq, payMonth) ?? '',
      accrual_day: noDay ? '' : payDay,
      base_index: coupon_type === 'V' ? (prefix ? `${prefix}${c.tenor}` : '') : '',
      reset_freq: coupon_type === 'V' ? reset_freq : '',
      reset_month: coupon_type === 'V' ? (accrualMonthCode(reset_freq, payMonth) ?? '') : '',
      reset_day: coupon_type === 'V' && !noDay ? payDay : '',
      spread_bps: coupon_type === 'V' ? c.marginBps : '',
      min_rate: coupon_type === 'V' ? c.floorPct : '',
      max_rate: coupon_type === 'V' ? (c.capPct || PAM_CONTRACT_DEFAULTS.max_rate) : PAM_CONTRACT_DEFAULTS.max_rate,
      pay_freq_name: c.payFreq,
      day_count_name: c.dayCount,
      interest_type: c.interestType,
      base_rate: c.baseRate,
    };
  }

  const blank = v => v === undefined || v === null || String(v) === '';
  const isDate = v => /^\d{8}$/.test(String(v)) && !Number.isNaN(Date.parse(`${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}T00:00:00Z`))
    && new Date(`${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}T00:00:00Z`).toISOString().slice(0, 10).replace(/-/g, '') === String(v);

  /** The build spec's validation rules (section 5). Returns errors (block the message) and warnings. */
  function validateContractAdd(input) {
    const errors = [];
    const warnings = [];
    const i = { ...input };
    ['tranche_id', 'contract_id', 'tranche_maturity', 'contract_maturity', 'currency', 'coupon_type', 'coupon_freq', 'dated_type']
      .forEach(k => { if (blank(i[k]) && !(k === 'dated_type' && i[k] === ' ')) errors.push(`${k} is required.`); });
    ['tranche_maturity', 'contract_maturity'].forEach(k => { if (!blank(i[k]) && !isDate(i[k])) errors.push(`${k} "${i[k]}" is not a valid YYYYMMDD date.`); });
    if (!blank(i.coupon_freq) && !['M', 'Q', 'S', 'A', 'B'].includes(i.coupon_freq)) errors.push(`No PAM coupon frequency code for pay frequency "${i.pay_freq_name || i.coupon_freq}".`);
    if (!blank(i.day_count) && !['D', 'C', 'A'].includes(i.day_count)) errors.push(`No PAM day count code for "${i.day_count_name || i.day_count}".`);
    if (i.coupon_type === 'V' && !blank(i.reset_freq) && !['M', 'Q', 'S', 'A'].includes(i.reset_freq)) errors.push(`No PAM reset frequency code for "${i.reset_freq}".`);
    if (isDate(i.tranche_maturity) && isDate(i.contract_maturity) && Number(i.contract_maturity) > Number(i.tranche_maturity)) errors.push('contract_maturity is after tranche_maturity.');
    if (![1, 2, 3].includes(Number(i.loan_type)) || blank(i.loan_type)) errors.push(`loan_type "${i.loan_type}" must be 1, 2 or 3.`);
    if (String(i.payment_type) === '66' || String(i.payment_type) === '83') {
      warnings.push(`payment_type ${i.payment_type} converted to ${String(i.payment_type) === '66' ? 'B' : 'S'}.`);
      input.payment_type = String(i.payment_type) === '66' ? 'B' : 'S';
    } else if (!['B', 'S'].includes(i.payment_type)) errors.push(`payment_type "${i.payment_type}" must be B or S.`);
    if (i.coupon_type === 'V') {
      if (!blank(i.coupon_rate)) errors.push('coupon_rate must be blank for a floating contract.');
      ['base_index', 'float_method', 'reset_freq', 'spread_bps', 'multiplier', 'max_rate', 'min_rate', 'lockout_days', 'lookback_days', 'reset_date_conv', 'reset_holiday_schedule']
        .forEach(k => { if (blank(i[k])) errors.push(k === 'base_index' && !blank(i.base_rate) ? `No PAM base index for base rate "${i.base_rate}".` : `${k} is required for a floating contract.`); });
    } else if (i.coupon_type === 'F') {
      if (blank(i.coupon_rate) || Number(i.coupon_rate) < 0) errors.push('coupon_rate is required and must be 0 or more for a fixed contract.');
    } else if (!blank(i.coupon_type)) errors.push(`coupon_type "${i.coupon_type}" must be V or F.`);
    if (['B', 'T'].includes(i.coupon_freq)) {
      if (!blank(i.accrual_day)) errors.push('accrual_day must be blank when coupon_freq is B or T.');
    } else if (!blank(i.coupon_freq) && (blank(i.accrual_day) || !(Number(i.accrual_day) >= 1 && Number(i.accrual_day) <= 31))) {
      errors.push(`accrual_day "${i.accrual_day}" must be 1-31.`);
    }
    const m = Number(i.accrual_month);
    if (i.coupon_freq === 'Q' && ![19, 20, 21].includes(m)) errors.push(`accrual_month "${i.accrual_month}" must be 19, 20 or 21 for quarterly.`);
    if (i.coupon_freq === 'S' && !(m >= 13 && m <= 18)) errors.push(`accrual_month "${i.accrual_month}" must be 13-18 for semi-annual.`);
    if (i.coupon_freq === 'A' && !(m >= 1 && m <= 12)) errors.push(`accrual_month "${i.accrual_month}" must be 1-12 for annual.`);
    if (!['T', ' ', 'N'].includes(i.dated_type) && !blank(i.dated_type)) errors.push(`dated_type "${i.dated_type}" must be T, N or a space.`);
    if (['T', ' '].includes(i.dated_type) && !blank(i.dated_date)) errors.push('dated_date must be blank when dated_type is T or blank.');
    ['delay', 'spread_bps', 'min_rate', 'max_rate'].forEach(k => { if (!blank(i[k]) && Number(i[k]) < 0) errors.push(`${k} must not be negative.`); });
    if (String(i.interest_type || '').toUpperCase().startsWith('PARTIAL')) warnings.push('Partial PIK is sent as coupon form P; the PIK split is not part of the minimal message.');
    return { errors, warnings };
  }

  const dec6 = v => Number(v).toFixed(6);

  function contractRecNode(i) {
    const floating = i.coupon_type === 'V';
    const coupon = node('COUPONDATA',
      i.coupon_type, floating ? null : dec6(i.coupon_rate), i.coupon_form, i.coupon_freq, i.day_count,
      blank(i.accrual_month) ? null : i.accrual_month, blank(i.accrual_day) ? null : i.accrual_day,
      i.dated_type, null, null, i.delay,
      node('HOLIDAYS', i.holiday_schedule, i.pay_date_conv),
      ...(floating ? [node('FLOATDATA',
        i.base_index, i.float_method, i.reset_freq, blank(i.reset_month) ? null : i.reset_month, blank(i.reset_day) ? null : i.reset_day,
        node('COMPOUNDFACTORS', dec6(i.spread_bps), dec6(i.multiplier)),
        dec6(i.max_rate), dec6(i.min_rate), 0, 0,
        node('LOCKOUTINFORMATION', i.lockout_days, i.lookback_days),
        node('RESETDATECONV', i.reset_date_conv),
        node('RESETHOLIDAYSCHEDULE', i.reset_holiday_schedule))] : []));
    return node('SMFBANKLOANCONTRACTREC', 'REPLACE', node('SecID', PAM.contractIdType, i.contract_id),
      i.strip, i.payment_type, i.contract_maturity, null, coupon,
      ...(blank(i.issue_name) ? [] : [node('ISSUENAME', i.issue_name)]));
  }

  /**
   * SMFBANKLOANTRANCHE UPDATE adding one or more contracts to one tranche.
   * Tranche fields come from the first input. ccid ({ user, date, time }) is optional and off by default.
   */
  function contractAddNode(inputs, { ccid } = {}) {
    const t = inputs[0];
    return node('SMFBANKLOANTRANCHE', 'UPDATE', node('SecID', PAM.facilityIdType, t.tranche_id), null,
      t.loan_type, t.tranche_maturity, t.currency,
      node('SMFBANKLOANCONTRACT', 'REPLACE', ...inputs.map(contractRecNode)),
      ...(ccid ? [node('CCID', ccid.user, ccid.date, ccid.time ?? 0)] : []));
  }

  function contractAddMessage(inputs, opts) {
    return assertBalanced(serialize(contractAddNode(inputs, opts)));
  }

  const pamUnits = cents => `${fromCents(cents)}0000`;

  /** Builds one PAM message as a tree (see node()) so every message serializes the same way. */
  function pamMessageNode(m, { ccid = '' } = {}) {
    if (m.level === 'SMF') return contractAddNode(m.inputs);
    const fac = node('SecID', PAM.facilityIdType, m.facilityId);
    const date = pamDate(m.effectiveDate);
    if (m.level === 'GLOBAL') {
      return node('BANKLOANACTION', 'Add', null, fac, date, m.actionType, null,
        node('BANKLOANACTIONCONTRACTALLOC', ...m.allocs.map(a =>
          node('BANKLOANACTIONCONTRACTALLOCREC', node('ContractSecID', PAM.contractIdType, a.contractId), pamUnits(a.units)))));
    }
    const bnk = node('BNK', m.account.bank, m.account.bankName, m.account.custodyAccount, node('CASHBANK', m.account.cashBank));
    const alloc = node('CONTRACTALLOC', 'ADD', ...m.allocs.map(a =>
      node('CONTRACTALLOCREC', node('SecID', a.idType || PAM.contractIdType, a.contractId), pamUnits(a.units))));
    const units = pamUnits(m.unitsExchanged);
    if (m.type === 'PAYDOWN') {
      // Per the TACONTRACTREDEMPTION minimum message spec: Portfolio comes before BNK(); accrued interest 0.
      return node('TaContractRedemption', 'ADD', null, fac, node('CONTRACTSECID', PAM.contractIdType, m.contractId),
        date, m.pamPortfolio, bnk, units, units, '0.000000');
    }
    if (m.type === 'DRAW') {
      // Per the TADRAWDOWN minimum message spec: trade and settle date both the effective date,
      // blank broker, BNK() before Portfolio, the unfunded taken down equals the draw.
      return node('TaDrawDown', 'ADD', null, fac, date, date, null, bnk, m.pamPortfolio, units, units,
        node('BLUNFUNDED', node('UNFUNDEDUNITS', units), node('BLUNFUNDEDTKDN', PAM.unfundedTakedown)),
        alloc, node('DELAYEDDELIVERYDATE', date));
    }
    const ccidNode = node('CCID', ccid, date, 0);
    // The transaction number (third argument) is blank: PAM assigns it on ADD.
    if (m.type === 'CONTRACT_COMBINE') {
      return node('TaCONTRACTCOMBINE', 'ADD', null, fac, node('CONTRACTSECID', PAM.contractIdType, m.contractId),
        date, date, m.pamPortfolio, bnk, pamUnits(m.unitsExchanged), alloc, ccidNode);
    }
    const zero = '0.000000000000000';
    return node('TaCONTRACTSPLIT', 'ADD', null, fac, node('CONTRACTSECID', PAM.contractIdType, m.contractId),
      date, date, m.pamPortfolio, bnk, pamUnits(m.unitsExchanged), '0.000000', null, alloc,
      node('SETMTHD', PAM.settlementMethod),
      node('TRDR', 'M', pamDate(m.maturityDate), PAM.tradePrice, zero, null, zero, zero, zero, zero, zero, zero, null, null),
      ccidNode);
  }

  /** One PAM message on a single line, or indented for review with pretty. */
  function pamMessageText(m, { ccid = '', pretty = false } = {}) {
    const n = pamMessageNode(m, { ccid });
    return pretty ? prettyPrint(n) : assertBalanced(serialize(n));
  }

  /** A short description of a message that has to be done by hand. */
  function manualStepText(m) {
    if (m.level === 'SMF') {
      const c = m.contract;
      return `Create contract ${m.contractId} on ${m.facilityId}: ${c.rateType} ${c.baseRate} ${c.tenor} + ${c.marginBps} bps, floor ${c.floorPct}, ${c.interestType}, ${c.payFreq} pay, ${c.resetFreq} reset, ${c.dayCount}, ${c.startDate} to ${c.endDate}.`;
    }
    const verb = { CAPITALIZE: 'Capitalized interest of' }[m.type] || m.type;
    return `${verb} ${formatMoney(m.unitsExchanged)} on contract ${m.contractId} for ${m.pamPortfolio} (${m.facilityId}), effective ${m.effectiveDate}.`;
  }

  /**
   * Builds one PAM import file from approved events. The transaction number is
   * left blank because PAM assigns it on ADD; each portfolio message gets a
   * CCID of batch-sequence.
   */
  function buildPamFile(events, { batchId, today = '' }) {
    const seen = new Map();
    const errors = [];
    const warnings = [];
    if (today) {
      events.forEach(ev => ev.messages.filter(m => m.level === 'PORTFOLIO' && (m.type === 'PAYDOWN' || m.type === 'DRAW') && m.effectiveDate > today)
        .slice(0, 1).forEach(m => warnings.push(`${displayName(ev)}: ${m.type === 'PAYDOWN' ? 'redemption' : 'drawdown'} dated ${m.effectiveDate} is after today (${today}); PAM rejects future-dated ${m.type === 'PAYDOWN' ? 'redemptions' : 'drawdowns'}.`)));
    }
    events.forEach(ev => ev.messages.filter(m => m.level === 'SMF').forEach(m => m.contractIds.forEach(id => {
      if (seen.has(id)) errors.push(`Contract ${id} is created by both ${seen.get(id)} and ${ev.key}.`);
      else seen.set(id, ev.key);
    })));
    if (errors.length) return { text: '', messageCount: 0, before: [], after: [], errors, warnings };
    let seq = 0;
    const blocks = [];
    const before = [];
    const after = [];
    events.forEach(ev => ev.messages.forEach(m => {
      if (m.manual) { (m.level === 'SMF' ? before : after).push({ eventKey: ev.key, text: manualStepText(m) }); return; }
      seq++;
      const opts = m.level === 'PORTFOLIO' ? { ccid: `${batchId}-${String(seq).padStart(4, '0')}` } : {};
      blocks.push(pamMessageText(m, opts));
    }));
    // One message per line, newline-terminated.
    return { text: blocks.map(b => `${b}\n`).join(''), messageCount: blocks.length, before, after, errors, warnings };
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
    allocate, detectEvents, buildBatchRows, checkRunDates, firstScheduledPayDate, displayName,
    FEE_TOLERANCE, FEE_POSITION_DRIFT, normalizeFees, expectedFee, checkFees,
    REPORT_REQUIRED, REPORT_OPTIONAL, isAllVueReport, missingReportColumns, parseBaseRateIndex, fromAllVueReport,
    PAM, normalizePortfolioAccounts, pamMessageNode, pamMessageText, manualStepText, buildPamFile,
    node, serialize, prettyPrint, assertBalanced, PAM_CONTRACT_DEFAULTS, EXCLUDED_CONTRACT_FIELDS,
    contractAddInput, validateContractAdd, contractAddNode, contractAddMessage,
  };
});
