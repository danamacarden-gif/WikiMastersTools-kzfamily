const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../features/sell-ideas-logic.js').create();

const card = (id, rarity, extra = {}) => ({ id: `c${id}`, title: `Carte ${id}`, rarity, count: 1, starred: false, tags: [], ...extra });
const priced = (cards, prices) => logic.buildRows(cards, (id) => (id in prices ? prices[id] : null));

// 6 communes autour de 5 W + une à 50 ; 6 ultra-rares autour de 400 W + une à 50.
function dataset() {
  const cards = []; const prices = {};
  for (let i = 0; i < 6; i++) { cards.push(card(`C${i}`, 'C', { count: 2 })); prices[`cC${i}`] = 5; }
  cards.push(card('Cbest', 'C', { count: 2 })); prices.cCbest = 50;
  for (let i = 0; i < 6; i++) { cards.push(card(`U${i}`, 'UR', { count: 2 })); prices[`cU${i}`] = 400; }
  cards.push(card('Ubad', 'UR', { count: 2 })); prices.cUbad = 50;
  return { cards, prices };
}

test('médiane par rareté et ratio : une commune à 50 W bat une ultra-rare à 50 W', () => {
  const { cards, prices } = dataset();
  const rows = logic.annotate(priced(cards, prices), logic.rarityStats(priced(cards, prices)));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.cCbest.ratio, 10);
  assert.ok(byId.cUbad.ratio < 0.2);
  const out = logic.select(rows, { duplicatesOnly: true });
  assert.equal(out.items[0].id, 'cCbest', 'classé par rentabilité');
  assert.equal(out.items.at(-1).id, 'cUbad');
  const byPrice = logic.select(rows, { duplicatesOnly: true, sort: 'price' });
  assert.equal(byPrice.items[0].rarity, 'UR');
});

test('échantillon trop petit : pas de ratio, classé après les autres', () => {
  const cards = [card(1, 'SR', { count: 2 }), card(2, 'SR', { count: 2 }), card(3, 'R', { count: 2 })];
  const rows = logic.annotate(priced(cards, { c1: 100, c2: 200, c3: 90 }), logic.rarityStats(priced(cards, { c1: 100, c2: 200, c3: 90 })));
  assert.equal(rows[0].ratio, null);
  assert.equal(logic.select(rows, { minRatio: 2 }).items.length, 0);
  assert.equal(logic.select(rows, {}).items.length, 3);
});

test('filtres : raretés, prix mini, ratio mini, doublons, protégées, déjà en vente', () => {
  const { cards, prices } = dataset();
  cards.push(card('fav', 'C', { count: 2, starred: true })); prices.cfav = 40;
  cards.push(card('solo', 'C', { count: 1 })); prices.csolo = 30;
  cards.push(card('nop', 'C', { count: 2 }));
  const rows = logic.annotate(priced(cards, prices), logic.rarityStats(priced(cards, prices)));
  const base = logic.select(rows, { rarities: new Set(['C']), duplicatesOnly: true });
  assert.equal(base.items.some((i) => i.id === 'cfav'), false);
  assert.equal(base.counts.protected, 1);
  assert.equal(base.counts.unpriced, 1);
  assert.equal(base.counts.singles, 1);
  assert.equal(logic.select(rows, { rarities: new Set(['C']), duplicatesOnly: true, hideProtected: false }).items[0].id, 'cCbest');
  assert.equal(logic.select(rows, { rarities: new Set(['C']), duplicatesOnly: false }).items.some((i) => i.id === 'csolo'), true);
  assert.equal(logic.select(rows, { minPrice: 100 }).items.every((i) => i.price >= 100), true);
  assert.deepEqual(logic.select(rows, { rarities: new Set(['C']), minRatio: 3, duplicatesOnly: true }).items.map((i) => i.id), ['cCbest']);
  const listed = logic.select(rows, { rarities: new Set(['C']), duplicatesOnly: true, hideListed: true }, new Set(['cCbest']));
  assert.equal(listed.items.some((i) => i.id === 'cCbest'), false);
  const flagged = logic.select(rows, { rarities: new Set(['C']), duplicatesOnly: true }, new Set(['cCbest']));
  assert.equal(flagged.items.find((i) => i.id === 'cCbest').listed, true);
  assert.equal(flagged.totalValue, flagged.items.filter((i) => !i.listed).reduce((s, i) => s + i.total, 0));
});

test('tris : rareté, exemplaires, gain, titre', () => {
  const { cards, prices } = dataset();
  const rows = logic.annotate(priced(cards, prices), logic.rarityStats(priced(cards, prices)));
  assert.equal(logic.select(rows, { sort: 'rarity' }).items[0].rarity, 'UR');
  assert.equal(logic.select(rows, { sort: 'excess' }).items[0].id, 'cCbest');
  assert.equal(logic.select(rows, { sort: 'title' }).items[0].title, 'Carte C0');
  assert.equal(logic.select(rows, { sort: 'copies' }).items[0].copies, 2);
});

test('buildRows : exemplaires = max(count, ownedCardIds) ; famille ; médiane', () => {
  const rows = logic.buildRows([card(1, 'R', { count: 1, ownedCardIds: ['a', 'b', 'c'] })], () => 10, new Set(['c1']));
  assert.equal(rows[0].copies, 3);
  assert.equal(rows[0].family, true);
  assert.equal(logic.median([1, 3, 2]), 2);
  assert.equal(logic.median([1, 2, 3, 4]), 2.5);
  assert.equal(logic.median([]), null);
});

test('sellingCardIds', () => {
  assert.deepEqual([...logic.sellingCardIds({ selling: [{ card_id: 'x' }, { card: { id: 'y' } }, null] })], ['x', 'y']);
});

test('les cartes déjà en vente passent en dernier', () => {
  const { cards, prices } = dataset();
  const rows = logic.annotate(priced(cards, prices), logic.rarityStats(priced(cards, prices)));
  const out = logic.select(rows, { duplicatesOnly: true }, new Set(['cCbest']));
  assert.equal(out.items.at(-1).id, 'cCbest');
});
