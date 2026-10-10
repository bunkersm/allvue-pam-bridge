const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const SampleData = require('../src/sample-data.js');

function detectSample(mutate) {
  const d = SampleData.build();
  if (mutate) mutate(d);
  return E.detectEvents({
    asOfDate: SampleData.asOfDate,
    prior: E.normalizeWso(d.prior),
    current: E.normalizeWso(d.current),
    trancheMap: E.normalizeTrancheMap(d.trancheMap),
    portfolioMap: E.normalizePortfolioMap(d.portfolioMap),
    pamPositions: E.normalizePamPositions(d.pamPositions),
    lineage: E.normalizeLineage(d.lineage),
  });
}
const byAsset = (events, id, port = 'LOANS-MASTER') => events.find(e => e.assetId === id && e.wsoPortfolio === port);

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
  assert.equal(events.length, 25);
  assert.equal(count('auto'), 14);
  assert.equal(count('review'), 9);
  assert.equal(count('exception'), 2);
});

test('clean rollover is auto and sends nothing', () => {
  const ev = byAsset(detectSample(), 'A1001');
  assert.equal(ev.type, 'ROLLOVER');
  assert.equal(ev.route, 'auto');
  assert.equal(ev.messages.length, 0);
  assert.equal(ev.lineageUpdates[0].pamContractId.startsWith('PC-'), true);
});

test('margin change at roll is a contract change for review', () => {
  const ev = byAsset(detectSample(), 'A1005');
  assert.equal(ev.type, 'CONTRACT_CHANGE');
  assert.equal(ev.route, 'review');
  assert.deepEqual(ev.rollTermChanges.map(d => d.field), ['marginBps']);
  assert.ok(ev.messages.every(m => m.MessageType === 'CONTRACT_CHANGE' && m.MarginBps === 350));
});

test('split allocates each new contract across PAM portfolios exactly', () => {
  const ev = byAsset(detectSample(), 'A1007');
  assert.equal(ev.type, 'SPLIT');
  assert.equal(ev.lines.length, 2);
  for (const line of ev.lines) {
    assert.equal(Object.values(line.allocation).reduce((s, v) => s + v, 0), line.amount);
  }
  assert.equal(ev.messages.length, 6);
});

test('revolver rollover with a paydown sends only the paydown', () => {
  const ev = byAsset(detectSample(), 'A1009');
  assert.equal(ev.type, 'ROLLOVER');
  assert.deepEqual(ev.legs, ['PAYDOWN']);
  assert.ok(ev.messages.every(m => m.MessageType === 'PAYDOWN'));
  const total = ev.messages.reduce((s, m) => s + E.toCents(m.Amount), 0);
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
  assert.equal(byAsset(events, 'A1024', 'CLO-WSO').route, 'exception');
});

test('term loan draw is an exception', () => {
  const events = detectSample(d => {
    const row = d.current.find(r => r.AssetID === 'A1001');
    row.Amount = '15962500.00';
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
