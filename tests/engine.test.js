const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const SampleData = require('../src/sample-data.js');

function detectSample(mutate) {
  const d = SampleData.build();
  if (mutate) mutate(d);
  return E.detectEvents({
    asOfDate: SampleData.asOfDate,
    prior: E.normalizeAllVue(d.prior),
    current: E.normalizeAllVue(d.current),
    trancheMap: E.normalizeTrancheMap(d.trancheMap),
    portfolioMap: E.normalizePortfolioMap(d.portfolioMap),
    accounts: E.normalizePortfolioAccounts(d.portfolioMap),
    pamPositions: E.normalizePamPositions(d.pamPositions),
    lineage: E.normalizeLineage(d.lineage),
  });
}
const byAsset = (events, id, port = 'LOANS-MASTER') => events.find(e => e.assetId === id && e.allvuePortfolio === port);

test('allocation always adds back to the amount to the cent', () => {
  const weights = [{ key: 'A', weight: 500 }, { key: 'B', weight: 300 }, { key: 'C', weight: 200 }];
  for (const amount of [1, 2, 133333333, 100000001, -999999999, 0]) {
    const parts = E.allocate(amount, weights);
    assert.equal(Object.values(parts).reduce((s, v) => s + v, 0), amount);
  }
  assert.deepEqual(E.allocate(100, [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }]), { A: 34, B: 33, C: 33 });
  assert.equal(E.allocate(100, []), null);
});

test('sample month-end produces the expected routes', () => {
  const events = detectSample();
  const count = r => events.filter(e => e.route === r).length;
  assert.equal(events.length, 26);
  assert.equal(count('auto'), 13);
  assert.equal(count('review'), 10);
  assert.equal(count('exception'), 3);
});

test('clean rollover is auto and sends nothing', () => {
  const ev = byAsset(detectSample(), 'A1001');
  assert.equal(ev.type, 'ROLLOVER');
  assert.equal(ev.route, 'auto');
  assert.equal(ev.messages.length, 0);
  assert.equal(ev.lineageUpdates[0].pamContractId.startsWith('PC-'), true);
});

test('margin change at roll: create (manual), global split, then one split per PAM portfolio', () => {
  const ev = byAsset(detectSample(), 'A1005');
  assert.equal(ev.type, 'CONTRACT_CHANGE');
  assert.equal(ev.route, 'review');
  assert.deepEqual(ev.rollTermChanges.map(d => d.field), ['marginBps']);
  assert.deepEqual(ev.messages.map(m => `${m.step}:${m.level}:${m.type}${m.manual ? ':manual' : ''}`), [
    '1:SMF:CONTRACT_CREATE:manual', '2:GLOBAL:CONTRACT_SPLIT',
    '2:PORTFOLIO:CONTRACT_SPLIT', '2:PORTFOLIO:CONTRACT_SPLIT', '2:PORTFOLIO:CONTRACT_SPLIT',
  ]);
  const newId = ev.added[0].contractId;
  assert.equal(ev.messages[0].contractId, newId, 'new PAM contract takes the AllVue contract ID');
  assert.equal(ev.messages[0].contract.marginBps, 350);
  const global = ev.messages[1];
  assert.equal(global.actionType, 8);
  assert.equal(global.allocs.reduce((s, a) => s + a.units, 0), 0, 'global split nets to zero');
  const portfolio = ev.messages.filter(m => m.level === 'PORTFOLIO');
  assert.ok(portfolio.every(m => m.contractId !== newId && m.allocs.length === 1 && m.allocs[0].contractId === newId));
  assert.equal(portfolio.reduce((s, m) => s + m.unitsExchanged, 0), ev.expired[0].amount);
});

test('split ties by new contract and by portfolio', () => {
  const ev = byAsset(detectSample(), 'A1007');
  assert.equal(ev.type, 'SPLIT');
  assert.equal(ev.lines.length, 2);
  for (const line of ev.lines) {
    assert.equal(Object.values(line.allocation).reduce((s, v) => s + v, 0), line.amount);
  }
  // Each portfolio's split message moves exactly its share of the old contract.
  const holding = E.allocate(ev.expired[0].amount, ev.allocationBasis.map(b => ({ key: b.pamPortfolio, weight: b.weight })));
  const portfolio = ev.messages.filter(m => m.level === 'PORTFOLIO');
  assert.equal(portfolio.length, 3);
  for (const m of portfolio) {
    assert.equal(m.unitsExchanged, holding[m.pamPortfolio]);
    assert.equal(m.allocs.reduce((s, a) => s + a.units, 0), m.unitsExchanged);
    assert.equal(m.allocs.length, 2);
  }
  assert.equal(ev.messages.filter(m => m.level === 'SMF').length, 2);
  assert.equal(ev.messages.filter(m => m.level === 'GLOBAL').length, 1);
});

test('many to many is a combine into the first new contract, then a split', () => {
  const ev = byAsset(detectSample(), 'A1022', 'CLO-MASTER');
  const order = [...new Set(ev.messages.map(m => `${m.step}:${m.type}`))];
  assert.deepEqual(order, ['1:CONTRACT_CREATE', '2:CONTRACT_COMBINE', '3:CONTRACT_SPLIT']);
  const combine = ev.messages.find(m => m.level === 'PORTFOLIO' && m.type === 'CONTRACT_COMBINE');
  assert.equal(combine.contractId, ev.added[0].contractId, 'combine names the target contract');
  assert.equal(combine.allocs.length, 2, 'and allocates from both sources');
  const split = ev.messages.find(m => m.level === 'PORTFOLIO' && m.type === 'CONTRACT_SPLIT');
  assert.equal(split.contractId, ev.added[0].contractId, 'split names the source contract');
});

test('global action carries signed global units; portfolio paydowns are manual for now', () => {
  const ev = byAsset(detectSample(), 'A1009');
  const global = ev.messages.filter(m => m.level === 'GLOBAL');
  assert.equal(global.length, 1);
  assert.equal(global[0].actionType, 6);
  assert.equal(global[0].allocs[0].units, ev.totals.globalDelta);
  const manual = ev.messages.filter(m => m.manual);
  assert.equal(manual.reduce((s, m) => s + m.unitsExchanged, 0), -ev.totals.fundedDelta);
});

test('PAM file text follows PAM syntax and numbers transactions', () => {
  const events = detectSample();
  const file = E.buildPamFile([byAsset(events, 'A1008')], { batchId: 'B1' });
  assert.match(file.text, /^BANKLOANACTION\(\nAdd,\n,\nSecID\(3,PT-1008\),\n20261030,\n9,\n,\nBANKLOANACTIONCONTRACTALLOC\(/);
  assert.match(file.text, /TaCONTRACTCOMBINE\(\nADD,\n,\nSecID\(3,PT-1008\),\nCONTRACTSECID\(26,418216\),\n20261030,\n20261030,\nFUND-I,\nBNK\(BNK1,FUND-I Custody,\d+,CASHBANK\(CSH\)\),\n\d+\.\d{6},\nCONTRACTALLOC\(\nADD,\nCONTRACTALLOCREC\(SecID\(26,PC-\d+\),\d+\.\d{6}\),/);
  assert.ok(!/ADD,\n\d/.test(file.text), 'no transaction numbers: PAM assigns them');
  assert.equal(file.before.length, 1);
  const split = E.buildPamFile([byAsset(events, 'A1007')], { batchId: 'B2' }).text;
  assert.match(split, /SETMTHD\(11\),\nTRDR\(\nM,\n\d{8},\n100\.0000000,/);
});

test('portfolio without bank details is an exception', () => {
  const events = detectSample(d => { d.portfolioMap.find(r => r.PAMPortfolio === 'FUND-I').CustodyAccount = ''; });
  assert.equal(byAsset(events, 'A1005').route, 'exception');
});

test('position change with no global change is a trade, not a paydown', () => {
  const ev = byAsset(detectSample(), 'A1023', 'CLO-MASTER');
  assert.equal(ev.route, 'exception');
  assert.ok(ev.flags.some(f => /looks like a sale/.test(f.text)));
});

test('increase on a capitalizing contract is PIK interest, not a term loan draw', () => {
  const ev = byAsset(detectSample(), 'A1034');
  assert.equal(ev.route, 'review');
  assert.deepEqual(ev.legs, ['CAPITALIZE']);
  assert.ok(ev.messages.every(m => m.type === 'CAPITALIZE'));
  assert.equal(ev.messages.find(m => m.level === 'GLOBAL').actionType, 10);
  assert.ok(!ev.flags.some(f => /do not draw/.test(f.text)));
});

test('missing global amounts are an exception', () => {
  const events = detectSample(d => { d.current.find(r => r.AssetID === 'A1001').GlobalAmount = ''; });
  assert.equal(byAsset(events, 'A1001').route, 'exception');
});

test('revolver rollover with a paydown sends only the paydown', () => {
  const ev = byAsset(detectSample(), 'A1009');
  assert.equal(ev.type, 'ROLLOVER');
  assert.deepEqual(ev.legs, ['PAYDOWN']);
  assert.ok(ev.messages.every(m => m.type === 'PAYDOWN'));
  const total = ev.messages.filter(m => m.level === 'PORTFOLIO').reduce((s, m) => s + m.unitsExchanged, 0);
  assert.equal(total, E.toCents(2000000));
});

test('stub period on an otherwise clean roll goes to review', () => {
  const ev = byAsset(detectSample(), 'A1012');
  assert.equal(ev.route, 'review');
  assert.match(ev.flags[0].text, /17 days/);
});

test('PAM position break and missing tranche map are exceptions', () => {
  const events = detectSample();
  assert.equal(byAsset(events, 'A1015').route, 'exception');
  assert.equal(byAsset(events, 'A1024', 'CLO-MASTER').route, 'exception');
});

test('term loan draw is an exception', () => {
  const events = detectSample(d => {
    const row = d.current.find(r => r.AssetID === 'A1001');
    row.Amount = '15962500.00';
    row.GlobalAmount = '399062500.00';
    row.Commitment = '15962500.00';
  });
  const ev = byAsset(events, 'A1001');
  assert.equal(ev.route, 'exception');
  assert.ok(ev.flags.some(f => /Term loan funded amount went up/.test(f.text)));
});

test('event keys are stable across runs', () => {
  const a = detectSample().map(e => e.key).sort();
  const b = detectSample().map(e => e.key).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test('CSV round trip keeps quoted values', () => {
  const rows = [{ A: 'x, y', B: 'say "hi"' }];
  const parsed = E.parseCSV(E.toCSV(rows, ['A', 'B']));
  assert.deepEqual(parsed.headers, ['A', 'B']);
  assert.deepEqual({ ...parsed[0] }, rows[0]);
  assert.deepEqual(E.missingColumns(['A'], ['A', 'B']), ['B']);
});

test('money parsing handles separators and negatives', () => {
  assert.equal(E.toCents('1,234.56'), 123456);
  assert.equal(E.toCents('(1,000.00)'), -100000);
  assert.equal(E.fromCents(-5), '-0.05');
  assert.equal(E.formatMoney(1333333333), '13,333,333.33');
  assert.equal(E.normalizeDate('10/30/2026'), '2026-10-30');
});

function checkSampleFees(mutate) {
  const d = SampleData.build();
  if (mutate) mutate(d);
  return E.checkFees({
    fees: E.normalizeFees(d.fees),
    trancheMap: E.normalizeTrancheMap(d.trancheMap),
    portfolioMap: E.normalizePortfolioMap(d.portfolioMap),
    pamPositions: E.normalizePamPositions(d.pamPositions),
  });
}
const feeFor = (fees, assetId, pred = () => true) => fees.find(f => f.assetId === assetId && pred(f));

test('sample fee export produces the expected routes', () => {
  const fees = checkSampleFees();
  const count = r => fees.filter(f => f.route === r).length;
  assert.equal(fees.length, 13);
  assert.equal(count('clean'), 7);
  assert.equal(count('review'), 3);
  assert.equal(count('exception'), 3);
});

test('expected fee uses rate, average unfunded, inclusive days and day-count basis', () => {
  const f = { periodStart: '2026-10-01', periodEnd: '2026-10-31', avgUnfunded: 500000000, rateBps: 50, dayCount: 'ACT/360' };
  assert.deepEqual(E.expectedFee(f), { days: 31, expected: 215278 });
  assert.equal(E.expectedFee({ ...f, dayCount: 'ACT/365' }).expected, 212329);
});

test('clean fee splits on PAM unfunded and ties to the cent', () => {
  const f = feeFor(checkSampleFees(), 'A1028');
  assert.equal(f.route, 'clean');
  assert.equal(f.messages.reduce((s, m) => s + E.toCents(m.Amount), 0), f.amount);
  assert.ok(f.messages.every(m => m.TransactionType === 'UNFUNDED_FEE'));
});

test('fee checks route mismatches, corrections, duplicates, term loans and unmapped facilities', () => {
  const fees = checkSampleFees();
  assert.equal(feeFor(fees, 'A1031').route, 'review');
  assert.match(feeFor(fees, 'A1031').flags[0].text, /differs from rate/);
  assert.equal(feeFor(fees, 'A1033').route, 'review');
  const correction = feeFor(fees, 'A1008', f => f.amount < 0);
  assert.equal(correction.route, 'review');
  assert.equal(correction.messages.reduce((s, m) => s + E.toCents(m.Amount), 0), correction.amount);
  assert.equal(fees.filter(f => f.assetId === 'A1018' && f.route === 'exception').length, 1);
  assert.equal(feeFor(fees, 'A1003').route, 'exception');
  assert.equal(feeFor(fees, 'A1032').route, 'exception');
});

test('fee keys are unique even with duplicate rows', () => {
  const keys = checkSampleFees().map(f => f.key);
  assert.equal(new Set(keys).size, keys.length);
});
