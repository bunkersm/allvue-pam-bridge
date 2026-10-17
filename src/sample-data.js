/*
 * Sample month-end for the prototype. All issuers, portfolios and amounts are
 * fictional. Produces the same row layouts as the CSV uploads, so the sample
 * runs through exactly the same path as real files.
 *
 * Scenario: AllVue snapshot on 2026-10-29 vs 2026-10-30 (a month-end roll date).
 */
(function (root) {
  'use strict';
  const E = root.Engine || (typeof require === 'function' ? require('./engine.js') : null);

  const PRIOR_AS_OF = '2026-10-29';
  const AS_OF = '2026-10-30';

  const PERIODS = {
    '1M': { prior: ['2026-09-30', '2026-10-30'], next: ['2026-10-30', '2026-11-30'] },
    '3M': { prior: ['2026-07-30', '2026-10-30'], next: ['2026-10-30', '2027-01-29'] },
  };
  const FREQ = { '1M': 'Monthly', '3M': 'Quarterly' };

  const PAM_PORTFOLIOS = {
    'LOANS-MASTER': ['FUND-I', 'FUND-II', 'SMA-ALPHA'],
    'CLO-MASTER': ['CLO-2023-1', 'CLO-2024-1'],
  };
  // Each tranche's split across PAM portfolios differs, as it would after trading.
  const SHARE_PATTERNS = {
    'LOANS-MASTER': [[500, 300, 200], [450, 350, 200], [400, 400, 200], [550, 250, 200], [475, 325, 200]],
    'CLO-MASTER': [[600, 400], [500, 500], [650, 350]],
  };

  let nextId = 418200;
  const id = () => String(++nextId);

  /** A funded contract. period is [start, end]; opts can pin an id or override margin. */
  const k = (tenor, amount, period, opts = {}) => ({ id: opts.id || id(), tenor, amount, period, margin: opts.margin, global: opts.global });
  const prior = (tenor, amount, opts) => k(tenor, amount, PERIODS[tenor].prior, opts);
  const next = (tenor, amount, opts) => k(tenor, amount, PERIODS[tenor].next, opts);
  const roll = (tenor, amount) => ({ prior: [prior(tenor, amount)], current: [next(tenor, amount)] });

  const ASSETS = [
    // ---- LOANS-MASTER
    { id: 'A1001', name: 'Alder Ridge Foods TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 325, floor: 0.5, ...roll('1M', 14962500) },
    { id: 'A1002', name: 'Bluestem Logistics TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 400, floor: 0.75, ...roll('3M', 22343750) },
    { id: 'A1003', name: 'Copperline Software TL', port: 'LOANS-MASTER', fac: 'TL', margin: 350, floor: 0.5, share: 0.024,
      prior: [prior('1M', 12000000, { id: '418901' })], current: [next('1M', 12000000, { id: '418951' })] },
    { id: 'A1004', name: 'Driftwood Health TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 475, floor: 0.5, ...roll('3M', 9875000) },
    { id: 'A1005', name: 'Elmhurst Packaging TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 375, floor: 0.5,
      prior: [prior('1M', 17456250)], current: [next('1M', 17456250, { margin: 350 })] },
    { id: 'A1006', name: 'Fernvale Industrial TL', port: 'LOANS-MASTER', fac: 'TL', margin: 425, floor: 0,
      prior: [prior('1M', 11250000)], current: [next('3M', 11250000)] },
    { id: 'A1007', name: 'Granite Peak Services TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 400, floor: 0.5,
      prior: [prior('3M', 15000000)], current: [next('1M', 9000000), next('3M', 6000000)] },
    { id: 'A1008', name: 'Hollis Medical RCF', port: 'LOANS-MASTER', fac: 'RC', margin: 300, floor: 0, commitment: 10000000,
      unfunded: [5000000, 5000000],
      prior: [prior('1M', 3000000), prior('3M', 2000000)], current: [next('1M', 5000000)] },
    { id: 'A1009', name: 'Ironbark Chemicals RCF', port: 'LOANS-MASTER', fac: 'RC', margin: 325, floor: 0, commitment: 10000000,
      unfunded: [4000000, 6000000],
      prior: [prior('1M', 6000000)], current: [next('1M', 4000000)] },
    { id: 'A1010', name: 'Juniper Data TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 350, floor: 0.5,
      prior: [k('1M', 19950000, ['2026-10-15', '2026-11-16'], { id: '418701' })],
      current: [k('1M', 19900125, ['2026-10-15', '2026-11-16'], { id: '418701' })] },
    { id: 'A1011', name: 'Kestrel Aero DDTL', port: 'LOANS-MASTER', fac: 'DDTL', margin: 450, floor: 0.75, commitment: 15000000,
      unfunded: [7000000, 5000000],
      prior: [k('1M', 8000000, ['2026-10-16', '2026-11-16'], { id: '418702' })],
      current: [k('1M', 8000000, ['2026-10-16', '2026-11-16'], { id: '418702' }), next('1M', 2000000)] },
    { id: 'A1012', name: 'Lakemont Media TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 500, floor: 1,
      prior: [prior('1M', 7500000)], current: [k('1M', 7500000, ['2026-10-30', '2026-11-16'])] },
    { id: 'A1013', name: 'Maple Grove Dental TL', port: 'LOANS-MASTER', fac: 'TL', margin: 425, floor: 0.75, ...roll('1M', 6234375) },
    { id: 'A1014', name: 'Northfield Insurance Services TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 300, floor: 0.5, ...roll('1M', 25000000) },
    { id: 'A1015', name: 'Oakmoss Retail TL', port: 'LOANS-MASTER', fac: 'TL', margin: 475, floor: 0.5, pamBreak: 250000, ...roll('3M', 8800000) },
    { id: 'A1016', name: 'Pinecrest Education TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 375, floor: 0.5, ...roll('3M', 13333333.33) },
    { id: 'A1017', name: 'Zephyr Holdings TLB', port: 'LOANS-MASTER', fac: 'TL', margin: 350, floor: 0.5,
      prior: [k('1M', 10000000, ['2026-10-15', '2026-11-16'], { id: '418703' })],
      current: [k('1M', 10000000, ['2026-10-15', '2026-11-16'], { id: '418703' })] },
    { id: 'A1018', name: 'Aspen Grove Labs RCF', port: 'LOANS-MASTER', fac: 'RC', margin: 325, floor: 0, commitment: 5000000,
      unfunded: [3000000, 3000000],
      prior: [k('1M', 2000000, ['2026-10-20', '2026-11-20'], { id: '418704' })],
      current: [k('1M', 2000000, ['2026-10-20', '2026-11-20'], { id: '418704' })] },

    // ---- CLO-MASTER
    { id: 'A1003', name: 'Copperline Software TL', port: 'CLO-MASTER', fac: 'TL', margin: 350, floor: 0.5, share: 0.016,
      prior: [prior('1M', 8000000, { id: '418901' })], current: [next('1M', 8000000, { id: '418951' })] },
    { id: 'A1019', name: 'Quarry Lane Materials TLB', port: 'CLO-MASTER', fac: 'TL', margin: 350, floor: 0.5, ...roll('1M', 4987500) },
    { id: 'A1020', name: 'Redfern Telecom TL', port: 'CLO-MASTER', fac: 'TL', margin: 450, floor: 0.75, ...roll('1M', 6650000) },
    { id: 'A1021', name: 'Saltmarsh Energy TLB', port: 'CLO-MASTER', fac: 'TL', margin: 400, floor: 0.5, ...roll('3M', 5500000) },
    { id: 'A1022', name: 'Tidewater Marine TLB', port: 'CLO-MASTER', fac: 'TL', margin: 425, floor: 0.5,
      prior: [prior('1M', 7000000), prior('1M', 5000000)], current: [next('1M', 4500000), next('3M', 7500000)] },
    // Sold 1,000,000 on the roll date: your position drops but the global amount does not.
    { id: 'A1023', name: 'Umber Analytics TL', port: 'CLO-MASTER', fac: 'TL', margin: 375, floor: 0.5,
      prior: [prior('1M', 3990000)], current: [next('1M', 2990000, { global: 199500000 })] },
    { id: 'A1024', name: 'Vantage Clinical TLB', port: 'CLO-MASTER', fac: 'TL', margin: 400, floor: 0.5, unmapped: true, ...roll('1M', 4000000) },
    { id: 'A1025', name: 'Willowbrook Pet TLB', port: 'CLO-MASTER', fac: 'TL', margin: 475, floor: 0.75, ...roll('1M', 7231812.5) },
    { id: 'A1026', name: 'Yarrow Brands TL', port: 'CLO-MASTER', fac: 'TL', margin: 350, floor: 0.5, ...roll('3M', 9000000) },
    { id: 'A1027', name: 'Bramble Foods TLB', port: 'CLO-MASTER', fac: 'TL', margin: 400, floor: 0.5,
      prior: [k('3M', 6000000, ['2026-09-15', '2026-12-15'], { id: '418705' })],
      current: [k('3M', 6000000, ['2026-09-15', '2026-12-15'], { id: '418705' })] },

    // ---- Revolvers and delayed draws with no contract activity today; they carry unfunded fees.
    { id: 'A1028', name: 'Harbor Point Clinics RCF', port: 'LOANS-MASTER', fac: 'RC', margin: 350, floor: 0, commitment: 7500000,
      unfunded: [7500000, 7500000], prior: [], current: [] },
    { id: 'A1031', name: 'Summit Lane Dental RCF', port: 'LOANS-MASTER', fac: 'RC', margin: 325, floor: 0, commitment: 12000000,
      unfunded: [8000000, 8000000],
      prior: [k('1M', 4000000, ['2026-10-20', '2026-11-20'], { id: '418707' })],
      current: [k('1M', 4000000, ['2026-10-20', '2026-11-20'], { id: '418707' })] },
    { id: 'A1033', name: 'Ridgeback Freight RCF', port: 'LOANS-MASTER', fac: 'RC', margin: 375, floor: 0, commitment: 10000000,
      unfunded: [6000000, 6000000],
      prior: [k('1M', 4000000, ['2026-10-16', '2026-11-16'], { id: '418708' })],
      current: [k('1M', 4000000, ['2026-10-16', '2026-11-16'], { id: '418708' })] },
    { id: 'A1029', name: 'Cobalt Ridge Software RCF', port: 'CLO-MASTER', fac: 'RC', margin: 350, floor: 0, commitment: 4000000,
      unfunded: [2500000, 2500000],
      prior: [k('1M', 1500000, ['2026-10-09', '2026-11-09'], { id: '418709' })],
      current: [k('1M', 1500000, ['2026-10-09', '2026-11-09'], { id: '418709' })] },
    { id: 'A1030', name: 'Meridian Vet Partners DDTL', port: 'CLO-MASTER', fac: 'DDTL', margin: 475, floor: 0.75, commitment: 6000000,
      unfunded: [6000000, 6000000], prior: [], current: [] },
    { id: 'A1032', name: 'Brightwater Labs RCF', port: 'CLO-MASTER', fac: 'RC', margin: 400, floor: 0, commitment: 5000000, unmapped: true,
      unfunded: [5000000, 5000000], prior: [], current: [] },

    // PIK term loan: a month of interest at 10.50% is added to principal at the roll.
    { id: 'A1034', name: 'Northgate Software PIK TL', port: 'LOANS-MASTER', fac: 'TL', margin: 600, floor: 1, interest: 'Capitalize',
      prior: [prior('1M', 10000000)], current: [next('1M', 10087500)] },
  ];

  // ---- October 2026 unfunded fee export (ACT/360, period end inclusive).
  const FEE_PERIOD = ['2026-10-01', '2026-10-31'];
  const feeAmount = (avg, bps) => Math.round(avg * 100 * (bps / 10000) * 31 / 360) / 100;
  const FEES = [
    { asset: 'A1008', type: 'Commitment fee', bps: 50, avg: 5000000 },
    { asset: 'A1009', type: 'Commitment fee', bps: 37.5, avg: 4129032.26 }, // paid down on 10/30, so unfunded rose for 2 days
    { asset: 'A1011', type: 'Ticking fee', bps: 100, avg: 6870967.74 },     // drew 2,000,000 on 10/30
    { asset: 'A1018', type: 'Commitment fee', bps: 50, avg: 3000000 },
    { asset: 'A1018', type: 'Commitment fee', bps: 50, avg: 3000000 },      // duplicate row in the export
    { asset: 'A1028', type: 'Commitment fee', bps: 50, avg: 7500000 },
    { asset: 'A1031', type: 'Commitment fee', bps: 50, avg: 8000000, amount: 3555.56 }, // does not match rate x balance
    { asset: 'A1033', type: 'Commitment fee', bps: 50, avg: 7935483.87 },   // drew 4,000,000 on 10/16
    { asset: 'A1008', type: 'Commitment fee', bps: 50, avg: 5000000, period: ['2026-09-01', '2026-09-30'], amount: -215.28 }, // correction to September
    { asset: 'A1003', type: 'Commitment fee', bps: 50, avg: 0, amount: 500, port: 'LOANS-MASTER' }, // fee booked against a term loan
    { asset: 'A1029', type: 'Commitment fee', bps: 37.5, avg: 2500000 },
    { asset: 'A1030', type: 'Ticking fee', bps: 75, avg: 6000000 },
    { asset: 'A1032', type: 'Commitment fee', bps: 50, avg: 5000000 },      // facility not set up in PAM
  ];

  const money = n => n.toFixed(2);

  function allvueRows(side) {
    const asOf = side === 'prior' ? PRIOR_AS_OF : AS_OF;
    const rows = [];
    ASSETS.forEach(a => {
      const contracts = a[side];
      const funded = contracts.reduce((s, c) => s + c.amount, 0);
      const unfunded = a.unfunded ? a.unfunded[side === 'prior' ? 0 : 1] : 0;
      const commitment = a.fac === 'TL' ? funded : a.commitment;
      // Your share of the facility; the global amount is your amount grossed up by it.
      const share = a.share || (a.port === 'CLO-MASTER' ? 0.02 : 0.04);
      const global = amount => Math.round(amount * 100 / share) / 100;
      const base = { AsOfDate: asOf, AllVuePortfolio: a.port, AssetID: a.id, AssetName: a.name, FacilityType: a.fac, Commitment: money(commitment) };
      contracts.forEach(c => rows.push({
        ...base, ContractID: c.id, ContractType: 'Funded', StartDate: c.period[0], EndDate: c.period[1],
        Amount: money(c.amount), GlobalAmount: money(c.global ?? global(c.amount)),
        RateType: 'Floating', InterestType: a.interest || 'Cash', BaseRate: 'SOFR', Tenor: c.tenor, MarginBps: String(c.margin ?? a.margin),
        FloorPct: a.floor.toFixed(2), PayFreq: FREQ[c.tenor], ResetFreq: FREQ[c.tenor], DayCount: 'ACT/360',
      }));
      if (a.fac !== 'TL') {
        rows.push({
          ...base, ContractID: `U${a.id.slice(1)}`, ContractType: 'Unfunded', StartDate: '2025-06-30', EndDate: '2030-06-30',
          Amount: money(unfunded), GlobalAmount: money(global(unfunded)), RateType: '', InterestType: '', BaseRate: '', Tenor: '', MarginBps: '50', FloorPct: '0.00',
          PayFreq: 'Quarterly', ResetFreq: '', DayCount: 'ACT/360',
        });
      }
    });
    return rows;
  }

  function trancheMapRows() {
    const seen = new Set();
    return ASSETS.filter(a => !a.unmapped && !seen.has(a.id) && seen.add(a.id))
      .map((a, i) => ({
        AssetID: a.id, PAMTrancheID: `PT-${a.id.slice(1)}`, FacilityType: a.fac,
        // Fictional maturities spread over 2029-2032.
        MaturityDate: `${2029 + (i % 4)}-${String((i * 5) % 12 + 1).padStart(2, '0')}-15`,
        PAMCurrency: '1',
      }));
  }

  function portfolioMapRows() {
    let acct = 12345670;
    return Object.entries(PAM_PORTFOLIOS).flatMap(([av, pams]) => pams.map(p => ({
      AllVuePortfolio: av, PAMPortfolio: p,
      Bank: 'BNK1', CustodyAccount: `${p} Custody`, CashAccount: String(++acct), CashBank: 'CSH',
    })));
  }

  function pamPositionRows() {
    const rows = [];
    const counters = {};
    ASSETS.forEach(a => {
      if (a.unmapped) return;
      const pams = PAM_PORTFOLIOS[a.port];
      const patterns = SHARE_PATTERNS[a.port];
      const n = counters[a.port] = (counters[a.port] || 0) + 1;
      const weights = patterns[n % patterns.length].map((w, i) => ({ key: pams[i], weight: w }));
      const funded = E.allocate(E.toCents(a.prior.reduce((s, c) => s + c.amount, 0)), weights);
      const unfunded = E.allocate(E.toCents(a.unfunded ? a.unfunded[0] : 0), weights);
      if (a.pamBreak) funded[pams[0]] += E.toCents(a.pamBreak);
      pams.forEach(p => rows.push({
        PAMPortfolio: p, PAMTrancheID: `PT-${a.id.slice(1)}`,
        Funded: E.fromCents(funded[p]), Unfunded: E.fromCents(unfunded[p]),
      }));
    });
    return rows;
  }

  function feeRows() {
    let txn = 77000;
    return FEES.map(f => {
      const a = ASSETS.find(x => x.id === f.asset && (!f.port || x.port === f.port));
      const period = f.period || FEE_PERIOD;
      return {
        AllVuePortfolio: a.port, AssetID: a.id, AssetName: a.name, FacilityType: a.fac, FeeType: f.type,
        PeriodStart: period[0], PeriodEnd: period[1], FeeRateBps: String(f.bps), AverageUnfunded: money(f.avg),
        DayCount: 'ACT/360', Amount: money(f.amount ?? feeAmount(f.avg, f.bps)), AllVueTransactionID: `FT-${++txn}`,
      };
    });
  }

  function lineageRows() {
    const seen = new Set();
    let pc = 20400;
    const rows = [];
    ASSETS.forEach(a => a.prior.forEach(c => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      rows.push({ AllVueContractID: c.id, PAMContractID: `PC-${++pc}` });
    }));
    return rows;
  }

  const SampleData = {
    label: 'Sample month-end (fictional data)',
    feeLabel: 'October 2026 fee export (fictional data)',
    asOfDate: AS_OF,
    priorAsOfDate: PRIOR_AS_OF,
    build() {
      return {
        prior: allvueRows('prior'),
        current: allvueRows('current'),
        trancheMap: trancheMapRows(),
        portfolioMap: portfolioMapRows(),
        pamPositions: pamPositionRows(),
        lineage: lineageRows(),
        fees: feeRows(),
      };
    },
  };

  if (typeof module === 'object' && module.exports) module.exports = SampleData;
  else root.SampleData = SampleData;
})(typeof globalThis !== 'undefined' ? globalThis : this);
