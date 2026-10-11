const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../features/my-sales-logic.js');

const logic = create();
const sale = (id, extra = {}) => ({ id, status: 'active', base_amount: 10, listing_base_amount: 10, current_bid: null, current_bidder_id: null, effective_bid: 10, end_at: '2026-10-07T17:48:11Z', ...extra });

test('extractSales : ventes actives de la clé selling, le reste ignoré', () => {
  const json = { selling: [sale('a'), sale('b', { status: 'settled_sold' }), null, { status: 'active' }, sale('c', { status: undefined })], bidding: [sale('x')] };
  assert.deepEqual(logic.extractSales(json).map((s) => s.id), ['a', 'c']);
  for (const bad of [null, undefined, {}, { selling: 'x' }, []]) assert.deepEqual(logic.extractSales(bad), []);
});

test('hasBids / currentPrice : prix de départ sans mise, mise en cours sinon', () => {
  const none = sale('a');
  assert.equal(logic.hasBids(none), false);
  assert.equal(logic.currentPrice(none), 10);
  const bid = sale('b', { current_bid: 14, effective_bid: 14, current_bidder_id: 'u1' });
  assert.equal(logic.hasBids(bid), true);
  assert.equal(logic.currentPrice(bid), 14);
  // prix de départ réévalué : on prend le listing_base_amount, pas l'ancien base_amount
  assert.equal(logic.startPrice(sale('c', { base_amount: 10, listing_base_amount: 8 })), 8);
  // mise sans effective_bid : retombe sur current_bid
  assert.equal(logic.currentPrice(sale('d', { current_bid: 12, effective_bid: null, current_bidder_id: 'u' })), 12);
  assert.equal(logic.currentPrice(null), null);
});

test('normalizeBids : plus récent d’abord, montants/dates invalides écartés, pseudo par défaut', () => {
  const json = { bids: [
    { id: 'b1', amount: 10, placed_at: '2026-10-07T14:54:22.434Z', bidder: { username: 'Sarassou' } },
    { id: 'b3', amount: 15, placed_at: '2026-10-07T16:00:00.000Z', bidder: { username: ' Vero ' } },
    { id: 'b2', amount: 12, placed_at: '2026-10-07T15:00:00.000Z', bidder: null },
    { id: 'bad1', amount: 'x', placed_at: '2026-10-07T15:00:00.000Z' },
    { id: 'bad2', amount: 5, placed_at: 'pas une date' },
    null
  ] };
  const bids = logic.normalizeBids(json);
  assert.deepEqual(bids.map((b) => [b.id, b.amount, b.bidder]), [['b3', 15, 'Vero'], ['b2', 12, 'Anonyme'], ['b1', 10, 'Sarassou']]);
  for (const bad of [null, {}, { bids: 'x' }]) assert.deepEqual(logic.normalizeBids(bad), []);
});

test('detectNewBids : seule une mise apparue après le premier relevé est « nouvelle »', () => {
  const first = [sale('a'), sale('b', { current_bid: 10, current_bidder_id: 'u1' })];
  const known = logic.signatures(first);
  assert.deepEqual(logic.detectNewBids(new Map(), first), [], 'premier relevé : rien de nouveau');
  const next = [
    sale('a', { current_bid: 10, current_bidder_id: 'u2' }),            // première mise
    sale('b', { current_bid: 12, current_bidder_id: 'u3' }),            // surenchère
    sale('c', { current_bid: 10, current_bidder_id: 'u4' })             // vente inconnue : pas « nouvelle »
  ];
  assert.deepEqual(logic.detectNewBids(known, next), ['a', 'b']);
  assert.deepEqual(logic.detectNewBids(logic.signatures(next), next), [], 'rien de changé');
  assert.deepEqual(logic.detectNewBids(null, null), []);
});

test('summary : total et ventes avec mises', () => {
  assert.deepEqual(logic.summary([sale('a'), sale('b', { current_bid: 11, current_bidder_id: 'u' })]), { total: 2, withBids: 1 });
  assert.deepEqual(logic.summary(null), { total: 0, withBids: 0 });
});

test('pollDelay : rapide à l’approche d’une fin, lent en onglet masqué', () => {
  const now = Date.parse('2026-10-07T17:00:00Z');
  const far = sale('a', { end_at: '2026-10-07T20:00:00Z' });
  const near = sale('b', { end_at: '2026-10-07T17:01:30Z' });
  const over = sale('c', { end_at: '2026-10-07T16:59:00Z' });
  assert.equal(logic.pollDelay({ sales: [far], now }), 10000);
  assert.equal(logic.pollDelay({ sales: [far, near], now }), 4000);
  assert.equal(logic.pollDelay({ sales: [over], now }), 10000, 'une vente déjà terminée n’accélère pas');
  assert.equal(logic.pollDelay({ sales: [near], now, hidden: true }), 30000);
  assert.equal(logic.pollDelay({ sales: null, now }), 10000);
});

test('formatBidAge : relatif lisible', () => {
  const now = Date.parse('2026-10-07T17:00:00Z');
  const at = (ms) => now - ms;
  assert.equal(logic.formatBidAge(at(20 * 1000), now), 'à l’instant');
  assert.equal(logic.formatBidAge(at(5 * 60 * 1000), now), 'il y a 5 min');
  assert.equal(logic.formatBidAge(at(3 * 3600 * 1000), now), 'il y a 3 h');
  assert.equal(logic.formatBidAge(at(50 * 3600 * 1000), now), 'il y a 2 j');
  assert.equal(logic.formatBidAge(now + 5000, now), 'à l’instant');
});

test('historyStatus : vendue / non vendue / annulée, null si active', () => {
  assert.equal(logic.historyStatus(sale('a')), null);
  assert.equal(logic.historyStatus(sale('a', { status: 'settled_sold' })), 'sold');
  assert.equal(logic.historyStatus(sale('a', { status: 'settled_unsold' })), 'unsold');
  assert.equal(logic.historyStatus(sale('a', { status: 'expired' })), 'unsold');
  assert.equal(logic.historyStatus(sale('a', { status: 'cancelled' })), 'cancelled');
  // statut terminé inconnu : vendue seulement avec une mise
  assert.equal(logic.historyStatus(sale('a', { status: 'settled' })), 'unsold');
  assert.equal(logic.historyStatus(sale('a', { status: 'settled', current_bid: 20, current_bidder_id: 'u' })), 'sold');
});

test('extractHistory : ventes terminées hors bidding, sans doublon ni annonce d’un autre vendeur', () => {
  const json = {
    selling: [sale('a', { seller_id: 'me' }), sale('s1', { status: 'settled_sold', seller_id: 'me' })],
    history: [sale('s1', { status: 'settled_sold', seller_id: 'me' }), sale('s2', { status: 'cancelled', seller_id: 'me' }), sale('o', { status: 'settled_sold', seller_id: 'other' }), 'x'],
    bidding: [sale('b', { status: 'settled_sold' })],
    maxConcurrentAuctions: 5
  };
  const { items, sources } = logic.extractHistory(json);
  assert.deepEqual(items.map((i) => [i.id, i._status]), [['s1', 'sold'], ['s2', 'cancelled']]);
  assert.deepEqual(sources, ['selling', 'history']);
  for (const bad of [null, undefined, [], 'x']) assert.deepEqual(logic.extractHistory(bad).items, []);
});

test('historyStats / relistCounts / tri et filtre', () => {
  const { items } = logic.extractHistory({ history: [
    sale('1', { status: 'settled_sold', current_bid: 30, effective_bid: 30, current_bidder_id: 'u', card_id: 'c1', end_at: '2026-10-01T10:00:00Z', snapshot_rarity: 'C' }),
    sale('2', { status: 'settled_unsold', card_id: 'c1', end_at: '2026-10-03T10:00:00Z', snapshot_rarity: 'C' }),
    sale('3', { status: 'settled_sold', current_bid: 10, effective_bid: 10, current_bidder_id: 'u', card_id: 'c2', end_at: '2026-10-02T10:00:00Z', snapshot_rarity: 'SR' }),
    sale('4', { status: 'cancelled', card_id: 'c3', end_at: '2026-10-04T10:00:00Z' })
  ] });
  const stats = logic.historyStats(items);
  assert.deepEqual(stats.counts, { all: 4, sold: 2, unsold: 1, cancelled: 1 });
  assert.equal(stats.earned, 40);
  assert.equal(stats.average, 20);
  assert.equal(stats.rate, 2 / 3);
  assert.equal(logic.relistCounts(items).get('c1'), 2);
  assert.deepEqual(logic.sortHistory(items, 'date').map((i) => i.id), ['4', '2', '3', '1']);
  assert.deepEqual(logic.sortHistory(items, 'price').map((i) => i.id), ['1', '4', '2', '3']);
  assert.deepEqual(logic.sortHistory(items, 'rarity').map((i) => i.id)[0], '3');
  assert.deepEqual(logic.filterHistory(items, 'sold').map((i) => i.id), ['1', '3']);
  assert.equal(logic.historyStats([]).rate, null);
});
