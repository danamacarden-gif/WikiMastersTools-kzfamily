const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../features/family-logic.js');

const logic = create();

const card = (id, title, extra = {}) => ({ id, title, rarity: 'C', ...extra });

test('pickAddable écarte les cartes déjà dans la famille', () => {
  const existing = [card('a', 'Alpha')];
  const incoming = [card('a', 'Alpha'), card('b', 'Bravo')];

  assert.deepEqual(logic.pickAddable(existing, incoming).map((c) => c.id), ['b']);
});

test('pickAddable ignore les cartes sans id et les doublons du lot', () => {
  const incoming = [
    card('b', 'Bravo'),
    card('b', 'Bravo (doublon)'),
    { title: 'Sans id' },
    null,
    card('', 'Id vide'),
    card('c', 'Charlie')
  ];

  const picked = logic.pickAddable([], incoming);
  assert.deepEqual(picked.map((c) => c.id), ['b', 'c']);
  assert.equal(picked[0].title, 'Bravo', 'le premier exemplaire est conservé');
});

test('pickAddable gère des entrées absentes', () => {
  assert.deepEqual(logic.pickAddable(undefined, undefined), []);
  assert.deepEqual(logic.pickAddable(null, [card('a', 'Alpha')]).map((c) => c.id), ['a']);
});

test('mergeCards ajoute, trie en français et liste les cartes ajoutées', () => {
  const existing = [card('z', 'Zèbre'), card('e', 'Éclair')];
  const incoming = [card('b', 'Bravo'), card('z', 'Zèbre'), card('a', 'Alpha')];

  const { cards, added } = logic.mergeCards(existing, incoming);

  assert.deepEqual(cards.map((c) => c.title), ['Alpha', 'Bravo', 'Éclair', 'Zèbre']);
  assert.deepEqual(added.map((c) => c.id), ['b', 'a']);
});

test('mergeCards ne modifie ni la famille ni le lot reçu', () => {
  const existing = [card('a', 'Alpha')];
  const incoming = [card('b', 'Bravo')];
  const existingCopy = JSON.parse(JSON.stringify(existing));
  const incomingCopy = JSON.parse(JSON.stringify(incoming));

  const { cards } = logic.mergeCards(existing, incoming);

  assert.deepEqual(existing, existingCopy);
  assert.deepEqual(incoming, incomingCopy);
  assert.notEqual(cards, existing);
  const stored = cards.find((c) => c.id === 'b');
  assert.notEqual(stored, incoming[0], 'la carte stockée est une copie');
  assert.deepEqual(stored, incoming[0]);
});

test('mergeCards sans nouvelle carte renvoie added vide', () => {
  const existing = [card('a', 'Alpha')];
  const { cards, added } = logic.mergeCards(existing, [card('a', 'Alpha')]);

  assert.equal(added.length, 0);
  assert.deepEqual(cards.map((c) => c.id), ['a']);
});

test('mergeCards supporte un titre manquant sans lever d\'erreur', () => {
  const { cards } = logic.mergeCards([card('a', 'Alpha')], [{ id: 'x' }]);
  assert.equal(cards.length, 2);
});
