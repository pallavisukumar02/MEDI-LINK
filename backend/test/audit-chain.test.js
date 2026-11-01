const { nextEntry, verifyChain, canonical } = require('../srv/lib/audit-chain');
function chain(n) { const out = []; let last = null; for (let i = 0; i < n; i++) { last = nextEntry(last, 'u' + i, 'ACT', { i, nested: { b: 1, a: 2 } }); out.push(last); } return out; }

test('canonical JSON is key-order independent', () => {
  expect(canonical({ b: 1, a: { d: 1, c: 2 } })).toBe(canonical({ a: { c: 2, d: 1 }, b: 1 }));
});
test('valid chain verifies', () => {
  expect(verifyChain(chain(5))).toMatchObject({ ok: true, count: 5 });
});
test('tampered payload is detected at its sequence number', () => {
  const c = chain(5); c[2] = { ...c[2], payload: '{"i":999}' };
  expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3, reason: 'HASH_MISMATCH' });
});
test('recomputed hash on a tampered entry breaks the next link', () => {
  const { computeHash } = require('../srv/lib/audit-chain');
  const c = chain(4); c[1] = { ...c[1], actor: 'mallory' }; c[1].hash = computeHash(c[1]);
  expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3, reason: 'PREV_HASH_MISMATCH' });
});
test('deleted entry is detected as a sequence gap', () => {
  const c = chain(4); c.splice(1, 1);
  expect(verifyChain(c)).toMatchObject({ ok: false, brokenAt: 3, reason: 'SEQUENCE_GAP' });
});
