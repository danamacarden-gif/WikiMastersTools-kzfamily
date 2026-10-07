const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../features/bulk-discard-logic.js');

const logic = create();
const H = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 1000;
// Une ligne de collection « propre » (ni favori, ni étiquette, ni shiny).
const row = (cardN, extra = {}) => ({
  id: H(seq++), card_id: H(cardN), starred: false, is_shiny: false, tags: [], count: 1,
  obtained_at: `2026-01-${String(10 + (seq % 18)).padStart(2, '0')}T00:00:00Z`,
  card: { id: H(cardN), wikipedia_title: `Carte ${cardN}`, rarity: 'C' }, ...extra
});
const priceMap = (map) => (cardId) => (cardId in map ? map[cardId] : null);
const params = (extra = {}) => ({ rarities: ['C'], maxPrice: 5, limit: 50, keepOne: false, ...extra });
const ctx = (extra = {}) => ({ familyCardIds: new Set(), pendingIds: new Set(), ...extra });
const ids = (plan) => plan.eligible.map((x) => x.cardId);

test('validateParams : rareté obligatoire, prix >= 0, lot entre 1 et 200', () => {
  assert.equal(logic.validateParams({ rarities: [], maxPrice: 3 }).reason, 'no-rarity');
  assert.equal(logic.validateParams({ rarities: ['X'], maxPrice: 3 }).reason, 'no-rarity');
  assert.equal(logic.validateParams({ rarities: ['C'], maxPrice: '' }).reason, 'invalid-price');
  assert.equal(logic.validateParams({ rarities: ['C'], maxPrice: -1 }).reason, 'invalid-price');
  assert.equal(logic.validateParams({ rarities: ['C'], maxPrice: 'abc' }).reason, 'invalid-price');
  assert.equal(logic.validateParams({ rarities: ['C'], maxPrice: 3, limit: 0 }).reason, 'invalid-limit');
  assert.equal(logic.validateParams({ rarities: ['C'], maxPrice: 3, limit: 201 }).reason, 'invalid-limit');
  const ok = logic.validateParams({ rarities: ['C', 'C', 'PC'], maxPrice: '2,5', limit: '20' });
  assert.deepEqual(ok, { ok: true, params: { rarities: ['C', 'PC'], maxPrice: 2.5, limit: 20, keepOne: true } });
  assert.equal(logic.validateParams({ rarities: ['C'], maxPrice: 1, keepOne: false }).params.keepOne, false);
});

test('buildPlan : ne retient que la rareté choisie sous le prix max (inclus)', () => {
  const rows = [row(1), row(2), row(3), row(4, { card: { id: H(4), wikipedia_title: 'R', rarity: 'R' } })];
  const plan = logic.buildPlan(rows, ctx(), params(), priceMap({ [H(1)]: 1, [H(2)]: 5, [H(3)]: 5.01, [H(4)]: 1 }));
  assert.deepEqual(ids(plan).sort(), [H(1), H(2)].sort());
  assert.equal(plan.counts.aboveMax, 1);
});

test('une carte sans prix connu n’est jamais défaussée', () => {
  const plan = logic.buildPlan([row(1), row(2)], ctx(), params(), priceMap({ [H(1)]: 1 }));
  assert.deepEqual(ids(plan), [H(1)]);
  assert.equal(plan.counts.unpriced, 1);
  for (const bad of [NaN, undefined, 'x', -1, Infinity]) {
    assert.equal(logic.buildPlan([row(9)], ctx(), params(), () => bad).eligible.length, 0, String(bad));
  }
});

test('protections : favori, étiquette, shiny, famille, échange en cours', () => {
  const fav = row(1, { starred: true });
  const tagged = row(2, { tags: [{ id: 'x', name: 'X-Files' }] });
  const shiny = row(3, { is_shiny: true });
  const inFamily = row(4);
  const traded = row(5);
  const free = row(6);
  const plan = logic.buildPlan(
    [fav, tagged, shiny, inFamily, traded, free],
    ctx({ familyCardIds: new Set([H(4)]), pendingIds: new Set([traded.id]) }),
    params(),
    () => 1
  );
  assert.deepEqual(ids(plan), [H(6)]);
  assert.deepEqual(plan.counts.protectedBy, { trade: 1, starred: 1, tagged: 1, shiny: 1, family: 1 });
});

test('un échange en cours est reconnu par id d’exemplaire OU par id de carte', () => {
  const a = row(1); const b = row(2);
  const plan = logic.buildPlan([a, b], ctx({ pendingIds: new Set([a.id, H(2)]) }), params(), () => 1);
  assert.equal(plan.eligible.length, 0);
  assert.equal(plan.counts.protectedBy.trade, 2);
});

test('fail-safe : favori, étiquettes ou shiny absents/inattendus protègent la carte', () => {
  const noStar = row(1); delete noStar.starred;
  const noTags = row(2); delete noTags.tags;
  const badTags = row(3, { tags: 'oops' });
  const noShiny = row(4); delete noShiny.is_shiny;
  const nullStar = row(5, { starred: null });
  const plan = logic.buildPlan([noStar, noTags, badTags, noShiny, nullStar], ctx(), params(), () => 1);
  assert.equal(plan.eligible.length, 0);
  assert.equal(logic.buildPlan([row(6)], ctx(), params(), () => 1).eligible.length, 1);
});

test('une protection sur UN exemplaire protège toute la carte', () => {
  const rows = [row(1), row(1, { starred: true }), row(1)];
  const plan = logic.buildPlan(rows, ctx(), params(), () => 1);
  assert.equal(plan.eligible.length, 0);
  assert.equal(plan.counts.protectedBy.starred, 1);
});

test('keepOne : garde l’exemplaire le plus ancien et ne défausse que les doublons', () => {
  const old = row(1, { obtained_at: '2025-01-01T00:00:00Z' });
  const mid = row(1, { obtained_at: '2026-01-01T00:00:00Z' });
  const recent = row(1, { obtained_at: '2026-06-01T00:00:00Z' });
  const single = row(2);
  const keep = logic.buildPlan([recent, single, old, mid], ctx(), params({ keepOne: true }), () => 1);
  assert.deepEqual(keep.eligible.map((x) => x.userCardId).sort(), [mid.id, recent.id].sort());
  assert.equal(keep.counts.keptOne, 2);
  const all = logic.buildPlan([recent, single, old, mid], ctx(), params({ keepOne: false }), () => 1);
  assert.equal(all.eligible.length, 4);
});

test('plafond de lot : items limités, le reste est compté', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i + 1));
  const plan = logic.buildPlan(rows, ctx(), params({ limit: 3 }), () => 1);
  assert.equal(plan.eligible.length, 7);
  assert.equal(plan.items.length, 3);
  assert.equal(plan.overLimit, 4);
});

test('lignes invalides ou en double ignorées, entrées vides tolérées', () => {
  const good = row(1);
  const rows = [good, { ...good }, { id: 'x', card_id: H(2) }, { id: H(5000) }, null, undefined];
  assert.equal(logic.buildPlan(rows, ctx(), params(), () => 1).eligible.length, 1);
  assert.equal(logic.buildPlan(null, ctx(), params(), () => 1).eligible.length, 0);
});

test('reverify : retire ce qui a cessé d’être éligible depuis l’analyse', () => {
  const a = row(1); const b = row(2); const c = row(3);
  const before = logic.buildPlan([a, b, c], ctx(), params(), () => 1);
  assert.equal(before.eligible.length, 3);
  // entre-temps : b devient favorite, c entre dans une famille
  const b2 = { ...b, starred: true };
  const after = logic.buildPlan([a, b2, c], ctx({ familyCardIds: new Set([H(3)]) }), params({ limit: 200 }), () => 1);
  const result = logic.reverify(before.eligible.map((x) => x.userCardId), after);
  assert.deepEqual(result.keep, [a.id]);
  assert.deepEqual(result.dropped.sort(), [b.id, c.id].sort());
  // un id jamais éligible dans le plan frais n'est pas gardé
  assert.deepEqual(logic.reverify([H(9999)], after).keep, []);
  assert.deepEqual(logic.reverify(null, null), { keep: [], dropped: [] });
});

test('discardUrl : uuid seulement ; familyCardIds : toutes les familles', () => {
  assert.equal(logic.discardUrl(H(1)), `/api/user-cards/${H(1)}/discard`);
  assert.equal(logic.discardUrl('../x'), null);
  assert.equal(logic.discardUrl(null), null);
  const set = logic.familyCardIds([{ cards: [{ id: 'a' }, { id: 'b' }] }, { cards: [{ id: 'b' }, {}] }, null, { cards: null }]);
  assert.deepEqual([...set].sort(), ['a', 'b']);
  assert.equal(logic.familyCardIds(null).size, 0);
});
