const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../features/sale-queue-logic.js');

const Q = create();
const CARD = '11111111-2222-3333-4444-555555555555';
const input = (over = {}) => ({ catalogueCardId: CARD, title: 'Podcast', rarity: 'SR', average: 12, baseAmount: 10, durationMinutes: 180, ...over });

function filled(n) {
  let store = Q.emptyStore();
  for (let i = 0; i < n; i += 1) store = Q.enqueue(store, input(), { id: `q${i}`, now: i }).store;
  return store;
}

test('enqueue : valide prix entier ≥ 1, durée connue et identifiant carte', () => {
  assert.equal(filled(2).items.length, 2);
  for (const bad of [{ baseAmount: 0 }, { baseAmount: 2.5 }, { durationMinutes: 45 }, { catalogueCardId: 'x' }]) {
    assert.equal(Q.enqueue(Q.emptyStore(), input(bad), { id: 'a', now: 0 }).reason, 'invalid');
  }
});

test('normalizeStore : écarte les entrées invalides et les doublons', () => {
  const raw = { paused: true, items: [{ ...input(), id: 'a' }, { ...input(), id: 'a' }, { ...input({ baseAmount: -1 }), id: 'b' }, null] };
  const store = Q.normalizeStore(raw);
  assert.equal(store.paused, true);
  assert.deepEqual(store.items.map((i) => i.id), ['a']);
  for (const bad of [null, [], 'x']) assert.deepEqual(Q.normalizeStore(bad), Q.emptyStore());
});

test('move / remove / retry', () => {
  let store = filled(3);
  store = Q.move(store, 'q2', -1);
  assert.deepEqual(store.items.map((i) => i.id), ['q0', 'q2', 'q1']);
  assert.equal(Q.move(store, 'q0', -1), store);
  store = Q.remove(store, 'q2');
  assert.deepEqual(store.items.map((i) => i.id), ['q0', 'q1']);
  store = Q.update(store, 'q0', { error: 'x', attempts: 3 });
  assert.equal(Q.pending(store).length, 1);
  store = Q.retry(store, 'q0');
  assert.deepEqual([store.items[0].error, store.items[0].attempts], [null, 0]);
});

test('next : attend si pause, places pleines ou inconnues ; saute les éléments en erreur', () => {
  let store = filled(2);
  assert.equal(Q.next(store, { used: 5, max: 5 }).reason, 'full');
  assert.equal(Q.next(store, null).reason, 'unknown-slots');
  assert.equal(Q.next({ ...store, paused: true }, { used: 0, max: 5 }).reason, 'paused');
  store = Q.update(store, 'q0', { error: 'bloqué' });
  assert.equal(Q.next(store, { used: 4, max: 5 }).item.id, 'q1');
  assert.equal(Q.next(Q.emptyStore(), { used: 0, max: 5 }).action, 'idle');
});

test('outcome : succès, erreurs définitives, places pleines, nouvel essai puis abandon', () => {
  const item = filled(1).items[0];
  assert.equal(Q.outcome(item, { ok: true }).kind, 'done');
  assert.equal(Q.outcome(item, { ok: false, notOwned: true }).kind, 'error');
  assert.equal(Q.outcome(item, { ok: false, alreadyListed: true }).kind, 'error');
  assert.equal(Q.outcome(item, { ok: false, needsStarredConfirmation: true }).kind, 'error');
  assert.equal(Q.outcome(item, { ok: false, error: 'Nombre maximum d’enchères simultanées atteint' }).kind, 'slots-full');
  assert.deepEqual(Q.outcome(item, { ok: false, error: 'HTTP 500' }), { kind: 'retry', attempts: 1 });
  assert.equal(Q.outcome({ ...item, attempts: 2 }, { ok: false, error: 'HTTP 500' }).kind, 'error');
});

test('canHoldLock : libre, expiré ou déjà à soi', () => {
  assert.equal(Q.canHoldLock(null, 'a', 10), true);
  assert.equal(Q.canHoldLock({ owner: 'a', until: 100 }, 'a', 10), true);
  assert.equal(Q.canHoldLock({ owner: 'b', until: 100 }, 'a', 10), false);
  assert.equal(Q.canHoldLock({ owner: 'b', until: 5 }, 'a', 10), true);
});
