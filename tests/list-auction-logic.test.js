const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../features/list-auction-logic.js').create();
const ID = '517c0f5c-3fe5-4312-9e21-5db368bbe5ba';

test('suggestBase : moyenne arrondie, minimum 1', () => {
  assert.equal(L.suggestBase(14.4), 14); assert.equal(L.suggestBase(0.2), 1);
  assert.equal(L.suggestBase(null), 1); assert.equal(L.suggestBase(NaN), 1);
});
test('buildBody : corps exact attendu par le site', () => {
  assert.deepEqual(L.buildBody({ cardId: ID, baseAmount: '10', minutes: 10 }),
    { ok: true, body: { card_id: ID, base_amount: 10, duration_minutes: 10 } });
});
test('buildBody : refuse carte, montant et durée invalides', () => {
  assert.equal(L.buildBody({ cardId: 'x', baseAmount: 5, minutes: 10 }).reason, 'card');
  for (const bad of ['', '0', '-3', '2.5', 'abc', 1e7]) assert.equal(L.buildBody({ cardId: ID, baseAmount: bad, minutes: 10 }).reason, 'amount', String(bad));
  assert.equal(L.buildBody({ cardId: ID, baseAmount: 5, minutes: 15 }).reason, 'duration');
});
test('slots / createdId', () => {
  assert.deepEqual(L.slots({ sellingCount: 5, maxConcurrentAuctions: 5 }), { used: 5, max: 5, full: true });
  assert.equal(L.slots({}), null);
  assert.equal(L.createdId({ auction: { id: ID } }), ID); assert.equal(L.createdId({ ok: 1 }), null);
});
