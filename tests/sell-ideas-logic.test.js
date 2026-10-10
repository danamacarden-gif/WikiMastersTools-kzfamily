const test = require('node:test');
const assert = require('node:assert/strict');
const bulk = require('../features/bulk-discard-logic.js').create();
const logic = require('../features/sell-ideas-logic.js').create(bulk);

const H = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 5000;
const row = (cardN, rarity = 'R', extra = {}) => ({
  id: H(seq++), card_id: H(cardN), starred: false, is_shiny: false, tags: [], count: 1,
  obtained_at: '2026-01-10T00:00:00Z',
  card: { id: H(cardN), wikipedia_title: `Carte ${cardN}`, rarity }, ...extra
});
const prices = { [H(1)]: 50, [H(2)]: 200, [H(3)]: 5, [H(4)]: 80, [H(5)]: 120 };
const priceOf = (id) => (id in prices ? prices[id] : null);
const ctx = { familyCardIds: new Set(), pendingIds: new Set() };
const params = { rarities: ['R'], minPrice: 10, keepOne: true };

test('validateParams', () => {
  assert.equal(logic.validateParams({ rarities: [] }).ok, false);
  assert.equal(logic.validateParams({ rarities: ['R'], minPrice: '-1' }).ok, false);
  assert.deepEqual(logic.validateParams({ rarities: ['R', 'X'], minPrice: '' }).params, { rarities: ['R'], minPrice: 0, keepOne: true });
});

test('classe par prix décroissant, garde un exemplaire, écarte prix inconnu / trop bas / protégés', () => {
  const rows = [
    row(1), row(1), row(2), row(2), row(2), row(3), row(3), row(4), row(4, 'R', { starred: true }),
    row(5), row(5), row(6), row(6)
  ];
  const out = logic.rank(rows, ctx, params, priceOf);
  assert.deepEqual(out.items.map((i) => i.cardId), [H(2), H(5), H(1)]);
  assert.equal(out.items[0].sellable, 2);
  assert.equal(out.counts.belowMin, 1);
  assert.equal(out.counts.unpriced, 1);
  assert.equal(out.counts.protected, 1);
  assert.equal(out.totalValue, 200 * 2 + 120 + 50);
});

test('keepOne=false inclut les cartes en un seul exemplaire', () => {
  const out = logic.rank([row(1), row(2)], ctx, { ...params, keepOne: false }, priceOf);
  assert.deepEqual(out.items.map((i) => i.cardId), [H(2), H(1)]);
  assert.equal(logic.rank([row(1), row(2)], ctx, params, priceOf).counts.singles, 2);
});

test('cartes de famille, piles et déjà en vente', () => {
  const rows = [row(1), row(1), row(2), row(2), row(5, 'R', { count: 2 }), row(5, 'R', { count: 2 })];
  const out = logic.rank(rows, { ...ctx, familyCardIds: new Set([H(1)]) }, params, priceOf, new Set([H(2)]));
  assert.deepEqual(out.items.map((i) => [i.cardId, i.listed]), [[H(2), true]]);
  assert.equal(out.totalValue, 0);
  assert.equal(out.counts.listed, 1);
});

test('sellingCardIds lit card_id et ignore le reste', () => {
  const ids = logic.sellingCardIds({ selling: [{ card_id: H(1) }, { card: { id: H(2) } }, { card_id: 'x' }, null] });
  assert.deepEqual([...ids].sort(), [H(1), H(2)]);
  assert.equal(logic.sellingCardIds(null).size, 0);
});

test('liste plafonnée', () => {
  const rows = [];
  for (let i = 0; i < 230; i++) { rows.push(row(100 + i), row(100 + i)); }
  const out = logic.rank(rows, ctx, params, () => 20);
  assert.equal(out.items.length, logic.LIST_CAP);
  assert.equal(out.counts.hidden, 30);
});
