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
// Events are per facility; the portfolio argument is ignored (kept so older calls still read naturally).
const byAsset = (events, id) => events.find(e => e.assetId === id);

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
  assert.equal(count('auto'), 11);
  assert.equal(count('review'), 12);
  assert.equal(count('exception'), 2);
  assert.equal(count('trade'), 1);
});

test('clean rollover is auto and sends nothing', () => {
  const ev = byAsset(detectSample(), 'A1001');
  assert.equal(ev.type, 'ROLLOVER');
  assert.equal(ev.route, 'auto');
  assert.equal(ev.messages.length, 0);
  assert.equal(ev.lineageUpdates[0].pamContractId.startsWith('PC-'), true);
});

test('margin change at roll: create, global split, then one split per PAM portfolio', () => {
  const ev = byAsset(detectSample(), 'A1005');
  assert.equal(ev.type, 'CONTRACT_CHANGE');
  assert.equal(ev.route, 'review');
  assert.deepEqual(ev.rollTermChanges.map(d => d.field), ['marginBps']);
  assert.deepEqual(ev.messages.map(m => `${m.step}:${m.level}:${m.type}${m.manual ? ':manual' : ''}`), [
    '1:SMF:CONTRACT_CREATE', '2:GLOBAL:CONTRACT_SPLIT',
    '2:PORTFOLIO:CONTRACT_SPLIT', '2:PORTFOLIO:CONTRACT_SPLIT', '2:PORTFOLIO:CONTRACT_SPLIT',
  ]);
  const newId = ev.added[0].contractId;
  assert.equal(ev.messages[0].contractId, newId, 'new PAM contract takes the AllVue contract ID');
  assert.equal(ev.messages[0].inputs[0].spread_bps, 350);
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
  const create = ev.messages.filter(m => m.level === 'SMF');
  assert.equal(create.length, 1, 'one tranche update');
  assert.equal(create[0].inputs.length, 2, 'carrying both new contracts');
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

test('paydown: global action with signed global units, then one redemption per contract per portfolio', () => {
  const ev = byAsset(detectSample(), 'A1009');
  const global = ev.messages.filter(m => m.level === 'GLOBAL');
  assert.equal(global.length, 1);
  assert.equal(global[0].actionType, 6);
  assert.equal(global[0].allocs[0].units, ev.totals.globalDelta);
  const redemptions = ev.messages.filter(m => m.level === 'PORTFOLIO');
  assert.ok(redemptions.every(m => m.type === 'PAYDOWN' && !m.manual));
  assert.equal(redemptions.length, 3);
  assert.equal(redemptions.reduce((s, m) => s + m.unitsExchanged, 0), -ev.totals.fundedDelta);
  const line = E.pamMessageText(redemptions[0]);
  assert.match(line, /^TaContractRedemption\(ADD,,SecID\(3,PT-1009\),CONTRACTSECID\(26,PC-\d+\),20261030,FUND-I,BNK\(BNK1,Agent Bank,\d+,CASHBANK\(CSH\)\),950000\.000000,950000\.000000,0\.000000\)$/);
});

test('draw into a new contract: create, global drawdown, one TaDrawDown per portfolio', () => {
  const ev = byAsset(detectSample(), 'A1011');
  assert.deepEqual([...new Set(ev.messages.map(m => `${m.step}:${m.level}:${m.type}`))], ['1:SMF:CONTRACT_CREATE', '2:GLOBAL:DRAW', '2:PORTFOLIO:DRAW']);
  const draws = ev.messages.filter(m => m.level === 'PORTFOLIO');
  assert.equal(draws.reduce((s, m) => s + m.unitsExchanged, 0), ev.totals.fundedDelta);
  draws.forEach(m => assert.equal(m.allocs.reduce((s, a) => s + a.units, 0), m.unitsExchanged));
  assert.match(E.pamMessageText(draws[0]), /^TaDrawDown\(ADD,,SecID\(3,PT-1011\),20261030,20261030,,BNK\(BNK1,Agent Bank,\d+,CASHBANK\(CSH\)\),FUND-I,(\d+\.\d{6}),\1,BLUNFUNDED\(UNFUNDEDUNITS\(\1\),BLUNFUNDEDTKDN\(F\)\),CONTRACTALLOC\(ADD,CONTRACTALLOCREC\(SecID\(26,418219\),\1\)\),DELAYEDDELIVERYDATE\(20261030\)\)$/);
});

test('a fund cannot redeem more than its funded holding', () => {
  const events = detectSample(d => {
    // Move most of FUND-I's funded Ironbark holding to FUND-II; the tranche still ties in total.
    const rows = d.pamPositions.filter(r => r.PAMTrancheID === 'PT-1009');
    const f1 = rows.find(r => r.PAMPortfolio === 'FUND-I');
    const f2 = rows.find(r => r.PAMPortfolio === 'FUND-II');
    const moved = E.toCents(f1.Funded) - 10000000;
    f1.Funded = '100000.00';
    f2.Funded = E.fromCents(E.toCents(f2.Funded) + moved);
  });
  const ev = byAsset(events, 'A1009');
  assert.equal(ev.route, 'exception');
  assert.ok(ev.flags.some(f => /FUND-I would redeem .* but holds 100,000\.00 funded/.test(f.text)));
});

test('future-dated redemptions and drawdowns are warned about when the file is built', () => {
  const ev = byAsset(detectSample(), 'A1009');
  assert.equal(E.buildPamFile([ev], { batchId: 'B', today: '2026-10-20' }).warnings.length, 1);
  assert.equal(E.buildPamFile([ev], { batchId: 'B', today: '2026-10-31' }).warnings.length, 0);
});

test('redemption and drawdown match the PAM minimum message spec examples', () => {
  const account = { bank: 'AG5', bankName: 'Agent Bank - Private BL', custodyAccount: '84716600', cashBank: 'CIT' };
  const base = { level: 'PORTFOLIO', facilityId: '037542A*8', effectiveDate: '2026-10-19', pamPortfolio: '1341', account };
  assert.equal(
    E.pamMessageText({ ...base, type: 'PAYDOWN', contractId: 'F00002046', unitsExchanged: 50000000, allocs: [] }),
    'TaContractRedemption(ADD,,SecID(3,037542A*8),CONTRACTSECID(26,F00002046),20261019,1341,BNK(AG5,Agent Bank - Private BL,84716600,CASHBANK(CIT)),500000.000000,500000.000000,0.000000)');
  // The spec's drawdown examples settle later than the trade date; this app uses the effective date for both.
  const draw = E.pamMessageText({ ...base, type: 'DRAW', unitsExchanged: 100000000, allocs: [
    { idType: 10007, contractId: '2089', units: 3324808 }, { contractId: 'F00002046', units: 58823529 }, { contractId: 'F00002087', units: 37851663 }] });
  assert.equal(draw, 'TaDrawDown(ADD,,SecID(3,037542A*8),20261019,20261019,,BNK(AG5,Agent Bank - Private BL,84716600,CASHBANK(CIT)),1341,1000000.000000,1000000.000000,BLUNFUNDED(UNFUNDEDUNITS(1000000.000000),BLUNFUNDEDTKDN(F)),CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(10007,2089),33248.080000),CONTRACTALLOCREC(SecID(26,F00002046),588235.290000),CONTRACTALLOCREC(SecID(26,F00002087),378516.630000)),DELAYEDDELIVERYDATE(20261019))');
});

test('PAM file has one single-line message per line, in load order', () => {
  const events = detectSample();
  const file = E.buildPamFile([byAsset(events, 'A1008')], { batchId: 'B1' });
  assert.ok(file.text.endsWith('\n'));
  const lines = file.text.trimEnd().split('\n');
  assert.equal(lines.length, file.messageCount);
  assert.deepEqual(lines.map(l => l.slice(0, l.indexOf('('))), ['SMFBANKLOANTRANCHE', 'BANKLOANACTION', 'TaCONTRACTCOMBINE', 'TaCONTRACTCOMBINE', 'TaCONTRACTCOMBINE']);
  lines.forEach(l => { assert.ok(!l.includes('\n')); E.assertBalanced(l); });
  assert.match(lines[0], /^SMFBANKLOANTRANCHE\(UPDATE,SecID\(3,PT-1008\),,2,\d{8},1,SMFBANKLOANCONTRACT\(REPLACE,SMFBANKLOANCONTRACTREC\(REPLACE,SecID\(26,418216\), ,B,/);
  assert.match(lines[1], /^BANKLOANACTION\(Add,,SecID\(3,PT-1008\),20261030,9,,BANKLOANACTIONCONTRACTALLOC\(BANKLOANACTIONCONTRACTALLOCREC\(ContractSecID\(26,PC-\d+\),-\d+\.\d{6}\),/);
  assert.match(lines[2], /^TaCONTRACTCOMBINE\(ADD,,SecID\(3,PT-1008\),CONTRACTSECID\(26,418216\),20261030,20261030,FUND-I,BNK\(BNK1,Agent Bank,\d+,CASHBANK\(CSH\)\),\d+\.\d{6},CONTRACTALLOC\(ADD,CONTRACTALLOCREC\(SecID\(26,PC-\d+\),\d+\.\d{6}\),CONTRACTALLOCREC\(SecID\(26,PC-\d+\),\d+\.\d{6}\)\),CCID\(B1-0003,20261030,0\)\)$/);
  assert.equal(file.before.length, 0);
  const split = E.buildPamFile([byAsset(events, 'A1007')], { batchId: 'B2' }).text.split('\n').find(l => l.startsWith('TaCONTRACTSPLIT'));
  assert.match(split, /^TaCONTRACTSPLIT\(ADD,,SecID\(3,PT-1007\),CONTRACTSECID\(26,PC-\d+\),20261030,20261030,FUND-I,BNK\(.*\),\d+\.\d{6},0\.000000,,CONTRACTALLOC\(ADD,.*\),SETMTHD\(11\),TRDR\(M,\d{8},100\.0000000,0\.000000000000000,,(0\.000000000000000,){6},\),CCID\(B2-\d{4},20261030,0\)\)$/);
});

test('portfolio without bank details is an exception', () => {
  const events = detectSample(d => { d.portfolioMap.find(r => r.PAMPortfolio === 'FUND-I').CustodyAccount = ''; });
  assert.equal(byAsset(events, 'A1005').route, 'exception');
});

test('position change with no global change is a trade for the trade feed', () => {
  const ev = byAsset(detectSample(), 'A1023', 'CLO-MASTER');
  assert.equal(ev.route, 'trade');
  assert.equal(ev.type, 'TRADE');
  assert.equal(ev.messages.length, 0, 'nothing sent: the trade feed books it');
  assert.deepEqual(ev.legs, []);
  assert.equal(ev.lineageUpdates.length, 1, 'the roll still carries the PAM contract forward');
  assert.ok(ev.lineageUpdates[0].pamContractId.startsWith('PC-'));
});

test('new purchase is left to the trade feed and its initial long is flagged', () => {
  const ev = byAsset(detectSample(), 'A1035');
  assert.equal(ev.type, 'NEW_POSITION');
  assert.equal(ev.route, 'review');
  assert.equal(ev.messages.length, 0);
  const flag = ev.flags.find(f => /Initial long/.test(f.text));
  assert.ok(flag);
  assert.match(flag.text, /46 days/);
  assert.match(flag.text, /first interest payment on 2026-11-15; AllVue's first payment is 2026-12-15/);
  assert.ok(!ev.flags.some(f => f.level === 'exception'));
});

test('new purchase with a regular first period goes straight to the trade feed', () => {
  const events = detectSample(d => {
    d.current.filter(r => r.AssetID === 'A1035').forEach(r => { r.EndDate = '2026-11-30'; });
  });
  assert.equal(byAsset(events, 'A1035').route, 'trade');
});

test('a trade on the same day as a restructure goes to review without a paydown', () => {
  const events = detectSample(d => {
    // Granite Peak splits 15,000,000 into 9,000,000 + 6,000,000; also sell 1,000,000 out of the 3M piece.
    const row = d.current.find(r => r.AssetID === 'A1007' && r.Tenor === '3M');
    row.Amount = '5000000.00';
    d.current.filter(r => r.AssetID === 'A1007').forEach(r => { r.Commitment = '14000000.00'; });
  });
  const ev = byAsset(events, 'A1007');
  assert.equal(ev.type, 'SPLIT');
  assert.equal(ev.route, 'review');
  assert.ok(ev.isTrade);
  assert.deepEqual(ev.legs, []);
  assert.ok(ev.flags.some(f => /same day as this restructure/.test(f.text)));
  assert.ok(!ev.messages.some(m => m.type === 'PAYDOWN'));
});

test('first scheduled pay date steps back one tenor at a time', () => {
  assert.equal(E.firstScheduledPayDate({ tenor: '1M', startDate: '2026-10-30', endDate: '2026-12-15' }), '2026-11-15');
  assert.equal(E.firstScheduledPayDate({ tenor: '1M', startDate: '2026-10-15', endDate: '2026-11-30' }), '2026-10-30');
  assert.equal(E.firstScheduledPayDate({ tenor: '3M', startDate: '2026-09-01', endDate: '2027-01-29' }), '2026-10-29');
  assert.equal(E.firstScheduledPayDate({ tenor: '1M', startDate: '2026-10-30', endDate: '2026-11-30' }), '2026-11-30');
});

test('run dates: PAM must match the AllVue prior date and current must be later', () => {
  const d = SampleData.build();
  const n = () => ({ prior: E.normalizeAllVue(d.prior), current: E.normalizeAllVue(d.current), pamPositions: E.normalizePamPositions(d.pamPositions) });
  assert.deepEqual(E.checkRunDates(n()).errors, []);
  d.pamPositions.forEach(r => { r.AsOfDate = '2026-10-30'; });
  assert.ok(E.checkRunDates(n()).errors.some(e => /must be the same date/.test(e)));
  d.pamPositions.forEach(r => { r.AsOfDate = '2026-10-29'; });
  d.current.forEach(r => { r.AsOfDate = '2026-10-29'; });
  assert.ok(E.checkRunDates(n()).errors.some(e => /must be later/.test(e)));
  d.current.forEach(r => { r.AsOfDate = '2026-11-05'; });
  assert.deepEqual(E.checkRunDates(n()).errors, []);
  assert.equal(E.checkRunDates(n()).warnings.length, 1);
  d.current[0].AsOfDate = '2026-11-06';
  assert.ok(E.checkRunDates(n()).errors.some(e => /more than one AsOfDate/.test(e)));
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

// ---------------------------------------------------------------- contract add (build spec)

const GOLDEN = 'SMFBANKLOANTRANCHE(UPDATE,SecID(3,DUMMYSEC001),,2,20310107,1,SMFBANKLOANCONTRACT(REPLACE,SMFBANKLOANCONTRACTREC(REPLACE,SecID(26,CNTR0005), ,B,20310107,,COUPONDATA(V,,C,Q,D,19,30,T,,,0,HOLIDAYS(US,3),FLOATDATA(SR3M,A,Q,19,30,COMPOUNDFACTORS(500.000000,1.000000),0.000000,1.000000,0,0,LOCKOUTINFORMATION(0,2),RESETDATECONV(3),RESETHOLIDAYSCHEDULE(US))),ISSUENAME(01/25 Revolver))))';
const goldenInput = () => ({
  ...E.PAM_CONTRACT_DEFAULTS,
  tranche_id: 'DUMMYSEC001', loan_type: 2, tranche_maturity: '20310107', currency: '1',
  contract_id: 'CNTR0005', contract_maturity: '20310107',
  coupon_type: 'V', coupon_rate: '', coupon_freq: 'Q', accrual_month: 19, accrual_day: 30,
  base_index: 'SR3M', reset_freq: 'Q', reset_month: 19, reset_day: 30, spread_bps: 500, min_rate: 1,
  issue_name: '01/25 Revolver',
});
const errorsFor = change => { const i = goldenInput(); change(i); return E.validateContractAdd(i).errors; };

test('contract add: golden string matches the build spec exactly', () => {
  assert.deepEqual(E.validateContractAdd(goldenInput()), { errors: [], warnings: [] });
  assert.equal(E.contractAddMessage([goldenInput()]), GOLDEN);
});

test('contract add: fixed rate has a coupon rate and no FLOATDATA', () => {
  const i = { ...goldenInput(), coupon_type: 'F', coupon_rate: 7.25 };
  assert.deepEqual(E.validateContractAdd(i).errors, []);
  const text = E.contractAddMessage([i]);
  assert.match(text, /COUPONDATA\(F,7\.250000,C,Q,/);
  assert.ok(!text.includes('FLOATDATA'));
});

test('contract add: excluded fields never appear', () => {
  const events = detectSample();
  const texts = [E.contractAddMessage([goldenInput()]),
    ...events.flatMap(ev => ev.messages.filter(m => m.level === 'SMF').map(m => E.pamMessageText(m)))];
  for (const t of texts) for (const f of E.EXCLUDED_CONTRACT_FIELDS) assert.ok(!t.toUpperCase().includes(`${f}(`) && !t.toUpperCase().includes(`,${f},`), f);
  assert.ok(texts.every(t => !t.includes('CCID')), 'CCID is off by default');
  assert.match(E.contractAddMessage([goldenInput()], { ccid: { user: 'USER', date: '20261017' } }), /,CCID\(USER,20261017,0\)\)$/);
});

test('contract add: each validation rule rejects bad input', () => {
  // 1 required fields
  for (const k of ['tranche_id', 'contract_id', 'tranche_maturity', 'contract_maturity', 'currency', 'coupon_type', 'coupon_freq', 'dated_type']) {
    assert.ok(errorsFor(i => { i[k] = ''; }).some(e => e.includes(k)), k);
  }
  // 2 dates
  assert.ok(errorsFor(i => { i.tranche_maturity = '20311399'; }).some(e => /valid YYYYMMDD/.test(e)));
  // 3 contract maturity after tranche maturity
  assert.ok(errorsFor(i => { i.contract_maturity = '20320101'; }).some(e => /after tranche_maturity/.test(e)));
  // 4 loan type
  assert.ok(errorsFor(i => { i.loan_type = 4; }).some(e => /loan_type/.test(e)));
  // 5 payment type, numeric codes convert with a warning
  assert.ok(errorsFor(i => { i.payment_type = 'X'; }).some(e => /payment_type/.test(e)));
  const coded = { ...goldenInput(), payment_type: '66' };
  const v5 = E.validateContractAdd(coded);
  assert.deepEqual(v5.errors, []);
  assert.equal(v5.warnings.length, 1);
  assert.equal(coded.payment_type, 'B');
  // 6 floating: no coupon rate, all float fields
  assert.ok(errorsFor(i => { i.coupon_rate = 5; }).some(e => /coupon_rate must be blank/.test(e)));
  assert.ok(errorsFor(i => { i.base_index = ''; }).some(e => /base_index/.test(e)));
  // 7 fixed: coupon rate required, >= 0
  assert.ok(errorsFor(i => { i.coupon_type = 'F'; i.coupon_rate = ''; }).some(e => /coupon_rate is required/.test(e)));
  assert.ok(errorsFor(i => { i.coupon_type = 'F'; i.coupon_rate = -1; }).some(e => /coupon_rate is required/.test(e)));
  // 8 accrual day
  assert.ok(errorsFor(i => { i.coupon_freq = 'B'; i.accrual_month = ''; }).some(e => /accrual_day must be blank/.test(e)));
  assert.ok(errorsFor(i => { i.accrual_day = 32; }).some(e => /1-31/.test(e)));
  // 9 accrual month vs frequency
  assert.ok(errorsFor(i => { i.accrual_month = 13; }).some(e => /19, 20 or 21/.test(e)));
  assert.ok(errorsFor(i => { i.coupon_freq = 'S'; i.accrual_month = 19; }).some(e => /13-18/.test(e)));
  assert.ok(errorsFor(i => { i.coupon_freq = 'A'; i.accrual_month = 13; }).some(e => /1-12/.test(e)));
  // 10 dated date blank for T or space
  assert.ok(errorsFor(i => { i.dated_date = '20261017'; }).some(e => /dated_date/.test(e)));
  // 11 non-negative
  for (const k of ['delay', 'spread_bps', 'min_rate', 'max_rate']) assert.ok(errorsFor(i => { i[k] = -1; }).some(e => e.includes(k)), k);
  // 12 duplicate contract IDs in one file
  const ev = byAsset(detectSample(), 'A1005');
  assert.equal(E.buildPamFile([ev, { ...ev, key: 'copy' }], { batchId: 'B' }).errors.length, 1);
  // 13 balanced parentheses
  assert.throws(() => E.assertBalanced('A(B(C)'));
  assert.throws(() => E.assertBalanced('A(B))('));
});

test('contract add from AllVue data maps codes and blocks bad input as an exception', () => {
  const ev = byAsset(detectSample(), 'A1006', 'LOANS-MASTER'); // 1M -> 3M tenor change
  const input = ev.messages.find(m => m.level === 'SMF').inputs[0];
  assert.equal(input.loan_type, 1);
  assert.equal(input.coupon_freq, 'Q');
  assert.equal(input.accrual_month, 19);
  assert.equal(input.base_index, 'SR3M');
  const bad = detectSample(d => { d.trancheMap.find(r => r.AssetID === 'A1006').MaturityDate = ''; });
  assert.equal(byAsset(bad, 'A1006').route, 'exception');
});

test('split, combine and global action match PAM samples (transaction number blank)', () => {
  const account = { bank: 'BNK1', bankName: 'Dummy Custody Account', custodyAccount: '12345678', cashBank: 'CSH' };
  const base = { level: 'PORTFOLIO', facilityId: 'DUMMYSEC001', effectiveDate: '2026-10-17', maturityDate: '2031-01-07', pamPortfolio: '9999', account };
  assert.equal(
    E.pamMessageText({ ...base, type: 'CONTRACT_COMBINE', contractId: 'CNTR0001', unitsExchanged: 20000000, allocs: [{ contractId: 'CNTR0002', units: 10000000 }, { contractId: 'CNTR0003', units: 10000000 }] }, { ccid: 'DUMMYCCID001' }),
    'TaCONTRACTCOMBINE(ADD,,SecID(3,DUMMYSEC001),CONTRACTSECID(26,CNTR0001),20261017,20261017,9999,BNK(BNK1,Dummy Custody Account,12345678,CASHBANK(CSH)),200000.000000,CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,CNTR0002),100000.000000),CONTRACTALLOCREC(SecID(26,CNTR0003),100000.000000)),CCID(DUMMYCCID001,20261017,0))');
  assert.equal(
    E.pamMessageText({ ...base, type: 'CONTRACT_SPLIT', contractId: 'CNTR0001', unitsExchanged: 10000000, allocs: [{ contractId: 'CNTR0002', units: 5000000 }, { contractId: 'CNTR0003', units: 5000000 }] }, { ccid: 'DUMMYCCID001' }),
    'TaCONTRACTSPLIT(ADD,,SecID(3,DUMMYSEC001),CONTRACTSECID(26,CNTR0001),20261017,20261017,9999,BNK(BNK1,Dummy Custody Account,12345678,CASHBANK(CSH)),100000.000000,0.000000,,CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,CNTR0002),50000.000000),CONTRACTALLOCREC(SecID(26,CNTR0003),50000.000000)),SETMTHD(11),TRDR(M,20310107,100.0000000,0.000000000000000,,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,,),CCID(DUMMYCCID001,20261017,0))');
  assert.equal(
    E.pamMessageText({ level: 'GLOBAL', facilityId: 'DUMMYSEC001', effectiveDate: '2026-10-17', actionType: 9, allocs: [{ contractId: 'CNTR0004', units: -100000000 }, { contractId: 'CNTR0002', units: 150000000 }, { contractId: 'CNTR0001', units: -50000000 }] }),
    'BANKLOANACTION(Add,,SecID(3,DUMMYSEC001),20261017,9,,BANKLOANACTIONCONTRACTALLOC(BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,CNTR0004),-1000000.000000),BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,CNTR0002),1500000.000000),BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,CNTR0001),-500000.000000)))');
});

// ---------------------------------------------------------------- AllVue contracts report

const fs = require('fs');
const path = require('path');
const reportRow = over => ({
  '[portfolioId]': 'PF0001', '[instrumentId]': 'IN0001', '[primaryIdentifier]': '9000001', '[referenceAccrualId]': 'AC0001',
  '[accrualType]': 'Funded', '[instrumentSubType]': 'Term Loan', '[baseRateIndexName]': '1M SOFR Term', '[rateType]': 'Float',
  '[interestPaymentType]': 'Cash', '[spread]': '0.05', '[spreadAdjustment]': '0.0025', '[rateFloor]': '0.01', '[rateCeiling]': '',
  '[allInRate]': '0.0907457', '[dayCount]': 'ACT/360', '[numPaymentsPerYear]': '4', '[beginDate]': '2026-10-16', '[endDate]': '2026-11-16',
  '[accrualAmount]': '1000000.00', '[globalAccrualAmount]': '50000000.00', ...over,
});

test('report: headers match without brackets or case; required columns are checked', () => {
  const headers = Object.keys(reportRow({}));
  assert.ok(E.isAllVueReport(headers));
  assert.deepEqual(E.missingReportColumns(headers), []);
  assert.deepEqual(E.missingReportColumns(headers.filter(h => h !== '[spread]')), ['spread']);
  const withTypeOnly = headers.map(h => (h === '[instrumentSubType]' ? '[instrumentType]' : h));
  assert.deepEqual(E.missingReportColumns(withTypeOnly), ['instrumentSubType'], 'instrumentType is not a stand-in for instrumentSubType');
  assert.ok(E.isAllVueReport(['portfolioID', 'referenceAccrualID']));
});

test('report: rates are decimals; pay frequency from payments per year, reset from the SOFR tenor', () => {
  const { rows, notes } = E.fromAllVueReport([reportRow({})], { asOfDate: '2026-10-16' });
  assert.deepEqual(notes, []);
  const r = rows[0];
  assert.equal(r.MarginBps, '500');
  assert.equal(r.SpreadAdjBps, '25');
  assert.equal(r.FloorPct, '1');
  assert.equal(r.PayFreq, 'Quarterly');
  assert.equal(r.ResetFreq, 'Monthly');
  assert.equal(r.BaseRate, 'SOFR');
  assert.equal(r.Tenor, '1M');
  assert.equal(r.FacilityType, 'TL');
  assert.equal(r.RateType, 'Floating');
  const [withAdj] = E.normalizeAllVue(rows);
  const [withoutAdj] = E.normalizeAllVue(rows, { addSpreadAdjustment: false });
  assert.equal(withAdj.marginBps, 525, 'spread adjustment folded into the PAM spread');
  assert.equal(withoutAdj.marginBps, 500);
});

test('report: accrual types, letters of credit in the commitment, % of Funded ignored', () => {
  const { rows } = E.fromAllVueReport([
    reportRow({ '[instrumentSubType]': 'Revolver', '[accrualAmount]': '400000.00' }),
    reportRow({ '[instrumentSubType]': 'Revolver', '[accrualType]': 'Unfunded', '[referenceAccrualId]': 'U1', '[accrualAmount]': '500000.00' }),
    reportRow({ '[instrumentSubType]': 'Revolver', '[accrualType]': 'Letter of Credit', '[referenceAccrualId]': 'L1', '[accrualAmount]': '100000.00' }),
    reportRow({ '[instrumentSubType]': 'Revolver', '[accrualType]': '% of Funded', '[referenceAccrualId]': 'F1', '[accrualAmount]': '1234.00' }),
    reportRow({ '[instrumentSubType]': 'Delayed Draw', '[primaryIdentifier]': '9000002', '[accrualType]': 'Delayed Draw Unfunded', '[referenceAccrualId]': 'U2' }),
  ], { asOfDate: '2026-10-16' });
  assert.deepEqual(rows.map(r => r.ContractType), ['Funded', 'Unfunded', 'LC', 'Other', 'Unfunded']);
  assert.ok(rows.slice(0, 4).every(r => r.Commitment === '1000000.00'));
  const kinds = E.normalizeAllVue(rows).map(r => r.kind);
  assert.deepEqual(kinds, ['funded', 'unfunded', 'lc', 'other', 'unfunded']);
});

test('report: unrecognised values are reported, and codes PAM lacks block the contract create', () => {
  const { notes } = E.fromAllVueReport([reportRow({ '[accrualType]': 'Mystery', '[instrumentSubType]': 'Bond' })], { asOfDate: '2026-10-16' });
  assert.equal(notes.length, 2);
  const base = { ...E.contractAddInput({ ...E.normalizeAllVue(E.fromAllVueReport([reportRow({})], { asOfDate: '2026-10-16' }).rows)[0], pamContractId: 'C1' },
    { pamTrancheId: 'T1', maturityDate: '2031-01-07', currency: '1' }) };
  assert.deepEqual(E.validateContractAdd(base).errors, []);
  const variant = over => {
    const [c] = E.normalizeAllVue(E.fromAllVueReport([reportRow(over)], { asOfDate: '2026-10-16' }).rows);
    return E.validateContractAdd(E.contractAddInput({ ...c, pamContractId: 'C1' }, { pamTrancheId: 'T1', maturityDate: '2031-01-07', currency: '1' })).errors;
  };
  assert.ok(variant({ '[numPaymentsPerYear]': '52' }).some(e => /pay frequency "Weekly"/.test(e)));
  assert.ok(variant({ '[dayCount]': 'ACT/ACT (ICMA)' }).some(e => /day count code for "ACT\/ACT \(ICMA\)"/.test(e)));
  assert.ok(variant({ '[baseRateIndexName]': 'Prime' }).some(e => /base index for base rate "PRIME"/.test(e)));
  assert.deepEqual(variant({ '[dayCount]': 'ACT/365 (Fixed)' }), []);
  assert.deepEqual(variant({ '[dayCount]': '30U/360' }), []);
});

test('report: a change in the spread adjustment between periods is a contract change', () => {
  const prior = E.fromAllVueReport([reportRow({})], { asOfDate: '2026-11-13' }).rows;
  const current = E.fromAllVueReport([reportRow({ '[referenceAccrualId]': 'AC0002', '[beginDate]': '2026-11-16', '[endDate]': '2026-12-16', '[spreadAdjustment]': '0.0026' })], { asOfDate: '2026-11-16' }).rows;
  const run = addSpreadAdjustment => E.detectEvents({
    asOfDate: '2026-11-16', prior: E.normalizeAllVue(prior, { addSpreadAdjustment }), current: E.normalizeAllVue(current, { addSpreadAdjustment }),
    trancheMap: {}, portfolioMap: {}, pamPositions: [], lineage: { AC0001: 'PC1' },
  })[0];
  assert.equal(run(true).type, 'CONTRACT_CHANGE');
  assert.deepEqual(run(true).rollTermChanges.map(d => d.field), ['marginBps']);
  assert.equal(run(false).type, 'ROLLOVER');
});

test('report: the sample report files give exactly the same events and PAM messages as the sample', () => {
  const d = SampleData.build();
  const read = f => E.parseCSV(fs.readFileSync(path.join(__dirname, '..', 'docs', 'samples', f), 'utf8'));
  const a = E.fromAllVueReport(read('allvue-contracts-report-2026-10-29.csv'), { asOfDate: '2026-10-29' });
  const b = E.fromAllVueReport(read('allvue-contracts-report-2026-10-30.csv'), { asOfDate: '2026-10-30' });
  const ctx = {
    asOfDate: SampleData.asOfDate, trancheMap: E.normalizeTrancheMap(d.trancheMap), portfolioMap: E.normalizePortfolioMap(d.portfolioMap),
    accounts: E.normalizePortfolioAccounts(d.portfolioMap), pamPositions: E.normalizePamPositions(d.pamPositions), lineage: E.normalizeLineage(d.lineage),
  };
  const sig = evs => evs.map(e => [e.key, e.route, e.type, e.messages.filter(m => !m.manual).map(m => E.pamMessageText(m)).join('')].join(' ')).sort();
  assert.deepEqual(
    sig(E.detectEvents({ ...ctx, prior: E.normalizeAllVue(a.rows), current: E.normalizeAllVue(b.rows) })),
    sig(detectSample()));
});

test('report: portfolio name, issuer (legalEntityName) and instrument name carry through to events', () => {
  const prior = E.fromAllVueReport([reportRow({ '[portfolioName]': 'Sample Fund I', '[legalEntityName]': 'Sample Issuer LLC', '[instrumentName]': 'Term Loan B' })], { asOfDate: '2026-11-13' }).rows;
  const current = E.fromAllVueReport([reportRow({ '[portfolioName]': 'Sample Fund I', '[legalEntityName]': 'Sample Issuer LLC', '[instrumentName]': 'Term Loan B',
    '[referenceAccrualId]': 'AC0002', '[beginDate]': '2026-11-16', '[endDate]': '2026-12-16' })], { asOfDate: '2026-11-16' }).rows;
  const [ev] = E.detectEvents({ asOfDate: '2026-11-16', prior: E.normalizeAllVue(prior), current: E.normalizeAllVue(current), trancheMap: {}, portfolioMap: {}, pamPositions: [], lineage: { AC0001: 'PC1' } });
  assert.equal(ev.holdings[0].portfolioName, 'Sample Fund I');
  assert.equal(ev.issuerName, 'Sample Issuer LLC');
  assert.equal(ev.assetName, 'Term Loan B');
  assert.equal(E.displayName(ev), 'Sample Issuer LLC Term Loan B');
});

// ---------------------------------------------------------------- facility-level events

test('a facility held in two AllVue portfolios is one event with one global action', () => {
  const ev = byAsset(detectSample(), 'A1003'); // Copperline: 10% paydown at the roll, held in both portfolios
  assert.equal(detectSample().filter(e => e.assetId === 'A1003').length, 1);
  assert.equal(ev.holdings.length, 2);
  assert.ok(ev.holdings.every(h => h.ties));
  assert.deepEqual(ev.legs, ['PAYDOWN']);
  const global = ev.messages.filter(m => m.level === 'GLOBAL');
  assert.equal(global.length, 1, 'one global action, not one per portfolio');
  assert.equal(global[0].allocs[0].units, ev.totals.globalDelta);
  const redemptions = ev.messages.filter(m => m.level === 'PORTFOLIO');
  assert.deepEqual(redemptions.map(m => m.pamPortfolio).sort(), ['CLO-2023-1', 'CLO-2024-1', 'FUND-I', 'FUND-II', 'SMA-ALPHA']);
  assert.equal(redemptions.reduce((t, m) => t + m.unitsExchanged, 0), -ev.totals.fundedDelta);
  // Each AllVue portfolio redeems its own share.
  const byPortfolio = p => redemptions.filter(m => m.allvuePortfolio === p).reduce((t, m) => t + m.unitsExchanged, 0);
  assert.equal(byPortfolio('LOANS-MASTER'), E.toCents(1200000));
  assert.equal(byPortfolio('CLO-MASTER'), E.toCents(800000));
});

test('a break in one AllVue portfolio blocks the whole facility event', () => {
  const events = detectSample(d => {
    const row = d.pamPositions.find(r => r.PAMTrancheID === 'PT-1003' && r.PAMPortfolio === 'CLO-2023-1');
    row.Funded = E.fromCents(E.toCents(row.Funded) + 10000);
  });
  const ev = byAsset(events, 'A1003');
  assert.equal(ev.route, 'exception');
  assert.ok(ev.flags.some(f => /^CLO Master Portfolio: PAM funded position/.test(f.text)));
  assert.equal(ev.holdings.find(h => h.allvuePortfolio === 'LOANS-MASTER').ties, true);
  assert.equal(ev.holdings.find(h => h.allvuePortfolio === 'CLO-MASTER').ties, false);
});

test('portfolios must agree on a contract\'s global amount', () => {
  const events = detectSample(d => {
    d.current.find(r => r.AssetID === 'A1003' && r.AllVuePortfolio === 'CLO-MASTER').GlobalAmount = '449000000.00';
  });
  const ev = byAsset(events, 'A1003');
  assert.equal(ev.route, 'exception');
  assert.ok(ev.flags.some(f => /disagree on the global amount of contract 418951/.test(f.text)));
});

test('a trade in one portfolio on a clean roll is left to the trade feed for the whole facility', () => {
  const events = detectSample(d => {
    // Copperline rolls with no paydown, but the CLO portfolio sells 2,000,000.
    d.current.filter(r => r.AssetID === 'A1003').forEach(r => { r.GlobalAmount = '500000000.00'; });
    const loans = d.current.find(r => r.AssetID === 'A1003' && r.AllVuePortfolio === 'LOANS-MASTER');
    loans.Amount = '12000000.00'; loans.Commitment = '12000000.00';
    const clo = d.current.find(r => r.AssetID === 'A1003' && r.AllVuePortfolio === 'CLO-MASTER');
    clo.Amount = '6000000.00'; clo.Commitment = '6000000.00';
  });
  const ev = byAsset(events, 'A1003');
  assert.equal(ev.type, 'TRADE');
  assert.equal(ev.route, 'trade');
  assert.equal(ev.messages.length, 0);
  assert.equal(ev.holdings.find(h => h.allvuePortfolio === 'CLO-MASTER').tradeDelta, E.toCents(-2000000));
  assert.equal(ev.holdings.find(h => h.allvuePortfolio === 'LOANS-MASTER').tradeDelta, 0);
  assert.ok(ev.flags.some(f => /^CLO Master Portfolio: a sale of 2,000,000.00/.test(f.text)));
});
