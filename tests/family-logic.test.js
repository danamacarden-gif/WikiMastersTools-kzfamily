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

// --- Marché : mises et annonces en cours -------------------------------------

const NOW = Date.parse('2026-10-06T18:00:00Z');
const future = new Date(NOW + 60 * 60 * 1000).toISOString();
const past = new Date(NOW - 60 * 1000).toISOString();

test('auctionBidInfo : aucune mise (current_bid null) avec prix de départ', () => {
  const info = logic.auctionBidInfo({
    current_bid: null, current_bidder_id: null, effective_bid: 40, base_amount: 40
  });

  assert.deepEqual(info, { known: true, hasBids: false, highest: null, start: 40 });
});

test('auctionBidInfo : mise en cours, enchère la plus haute et prix de départ', () => {
  const info = logic.auctionBidInfo({
    current_bid: 55, current_bidder_id: 'u1', effective_bid: 55, base_amount: 40
  });

  assert.deepEqual(info, { known: true, hasBids: true, highest: 55, start: 40 });
});

test('auctionBidInfo : listing_base_amount prime sur base_amount pour le départ', () => {
  const info = logic.auctionBidInfo({ current_bid: null, listing_base_amount: 30, base_amount: 40 });
  assert.equal(info.start, 30);
});

test('auctionBidInfo : montants reçus en texte', () => {
  const info = logic.auctionBidInfo({ current_bid: '55', base_amount: '40' });
  assert.equal(info.highest, 55);
  assert.equal(info.start, 40);
});

test('auctionBidInfo : meneur connu sans montant retombe sur effective_bid', () => {
  const info = logic.auctionBidInfo({ current_bid: null, current_bidder_id: 'u1', effective_bid: 48 });
  assert.equal(info.hasBids, true);
  assert.equal(info.highest, 48);
});

test('auctionBidInfo : meneur connu sans aucun montant -> misée mais montant inconnu', () => {
  const info = logic.auctionBidInfo({ current_bid: null, current_bidder_id: 'u1' });
  assert.equal(info.hasBids, true);
  assert.equal(info.highest, null);
});

test('auctionBidInfo : champs de mise absents -> inconnu, rien d\'affirmé', () => {
  const info = logic.auctionBidInfo({ id: 'a', base_amount: 40, effective_bid: 40 });

  assert.equal(info.known, false);
  assert.equal(info.hasBids, false);
  assert.equal(info.highest, null);
  assert.equal(info.start, 40);
});

test('auctionBidInfo : une mise à 0 ne compte pas comme une mise', () => {
  const info = logic.auctionBidInfo({ current_bid: 0, current_bidder_id: null, base_amount: 40 });
  assert.equal(info.hasBids, false);
});

test('auctionBidInfo : entrées invalides', () => {
  for (const value of [null, undefined, 'x', 42]) {
    const info = logic.auctionBidInfo(value);
    assert.equal(info.known, false);
    assert.equal(info.hasBids, false);
  }
});

test('isLiveAuction : active et non terminée', () => {
  assert.equal(logic.isLiveAuction({ status: 'active', end_at: future }, NOW), true);
  assert.equal(logic.isLiveAuction({ end_at: future }, NOW), true, 'sans status, on suppose active');
});

test('isLiveAuction : terminée, inactive ou invalide', () => {
  assert.equal(logic.isLiveAuction({ status: 'active', end_at: past }, NOW), false);
  assert.equal(logic.isLiveAuction({ status: 'ended', end_at: future }, NOW), false);
  assert.equal(logic.isLiveAuction({ status: 'cancelled' }, NOW), false);
  assert.equal(logic.isLiveAuction(null, NOW), false);
});

test('isLiveAuction : sans date de fin exploitable, considérée en cours', () => {
  assert.equal(logic.isLiveAuction({ status: 'active' }, NOW), true);
  assert.equal(logic.isLiveAuction({ status: 'active', end_at: 'n/a' }, NOW), true);
});

test('liveListings ne garde que les annonces en cours et gère les entrées absentes', () => {
  const list = [
    { id: 'a', end_at: future },
    { id: 'b', end_at: past },
    { id: 'c', status: 'ended', end_at: future },
    { id: 'd' }
  ];

  assert.deepEqual(logic.liveListings(list, NOW).map((a) => a.id), ['a', 'd']);
  assert.deepEqual(logic.liveListings(undefined, NOW), []);
  assert.equal(list.length, 4, 'la liste d\'origine n\'est pas modifiée');
});

// --- Mise : validation du montant saisi ---------------------------------------

test('validateBid accepte un entier au minimum ou au-dessus, solde suffisant', () => {
  assert.deepEqual(logic.validateBid('61', 61, 200), { ok: true, amount: 61 });
  assert.deepEqual(logic.validateBid(75, 61, 200), { ok: true, amount: 75 });
  assert.deepEqual(logic.validateBid(' 61 ', 61, 61), { ok: true, amount: 61 }, 'solde exactement égal');
});

test('validateBid refuse un montant invalide', () => {
  for (const value of ['', '   ', 'abc', '12.5', '-5', '0', null, undefined, '1e1x']) {
    assert.deepEqual(logic.validateBid(value, 10, 100), { ok: false, reason: 'invalid' }, String(value));
  }
});

test('validateBid refuse sous le minimum', () => {
  assert.deepEqual(logic.validateBid('60', 61, 500), { ok: false, reason: 'below-minimum' });
});

test('validateBid refuse au-dessus du solde connu', () => {
  assert.deepEqual(logic.validateBid('300', 61, 200), { ok: false, reason: 'insufficient-balance' });
});

test('validateBid ne bloque pas sur un solde ou un minimum inconnus', () => {
  assert.equal(logic.validateBid('50', null, null).ok, true);
  assert.equal(logic.validateBid('50', NaN, undefined).ok, true);
});

test('validateBid : le minimum prime sur le solde quand les deux sont violés', () => {
  assert.equal(logic.validateBid('5', 61, 3).reason, 'below-minimum');
});

test('filterCards combine propriété et rareté sans modifier la liste', () => {
  const logic = create();
  const cards = [
    { id: 'a', rarity: 'L', owned: true },
    { id: 'b', rarity: 'L', owned: false },
    { id: 'c', rarity: 'C', owned: true },
    { id: 'd', rarity: 'C' }
  ];
  const ids = (list) => list.map((card) => card.id);

  assert.deepEqual(ids(logic.filterCards(cards)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(logic.filterCards(cards, { ownership: 'owned' })), ['a', 'c']);
  assert.deepEqual(ids(logic.filterCards(cards, { ownership: 'missing' })), ['b']);
  assert.deepEqual(ids(logic.filterCards(cards, { ownership: 'unchecked' })), ['d']);
  assert.deepEqual(ids(logic.filterCards(cards, { rarity: 'L' })), ['a', 'b']);
  assert.deepEqual(ids(logic.filterCards(cards, { ownership: 'owned', rarity: 'C' })), ['c']);
  assert.deepEqual(ids(logic.filterCards(cards, { rarity: '' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(logic.filterCards(null), []);
  assert.equal(cards.length, 4);
});

test('rarityCounts compte par code et ignore les raretés inconnues', () => {
  const counts = create().rarityCounts([
    { rarity: 'L' }, { rarity: 'L' }, { rarity: 'PC' }, { rarity: 'X' }, { rarity: null }, null
  ]);

  assert.deepEqual(counts, { L: 2, UR: 0, SR: 0, R: 0, PC: 1, C: 0 });
});

const U = '025afa97-c709-46dd-9738-71f786162516';
const C = (n) => `6f071e62-1b53-45f9-af1d-8731d5b0b35${n}`;
const BASE = 'https://x.supabase.co/rest/v1/';

test('planWishlistSync ajoute les manquantes, retire les possédées, ignore le reste', () => {
  const plan = create().planWishlistSync([
    { id: C(1), owned: false },
    { id: C(2), owned: false },
    { id: C(3), owned: true },
    { id: C(4), owned: true },
    { id: C(5) },
    { id: C(1), owned: false },
    { id: 'pas-un-uuid', owned: false }
  ], new Set([C(2), C(3), C(9)]));

  assert.deepEqual(plan.toAdd.map((c) => c.id), [C(1)]);
  assert.deepEqual(plan.toRemove.map((c) => c.id), [C(3)]);
  assert.equal(plan.alreadyWished, 1);
  assert.equal(plan.unchecked, 1);
});

test('planWishlistSync ne touche jamais une carte absente de la famille', () => {
  const plan = create().planWishlistSync([{ id: C(1), owned: true }], [C(7), C(8)]);
  assert.deepEqual(plan.toRemove, []);
  assert.deepEqual(plan.toAdd, []);
});

test('chunk découpe sans modifier la liste', () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(create().chunk(list, 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(create().chunk([], 3), []);
  assert.equal(list.length, 5);
});

test('URLs et corps Supabase : format attendu, identifiants validés', () => {
  const logic = create();

  assert.equal(
    logic.wishlistDeleteUrl(BASE, U, [C(1), C(2), 'x;drop']),
    `${BASE}wishlist_items?user_id=eq.${U}&card_id=in.(${C(1)},${C(2)})`
  );
  assert.equal(logic.wishlistDeleteUrl(BASE, 'nope', [C(1)]), null);
  assert.equal(logic.wishlistDeleteUrl(BASE, U, ['x']), null);
  assert.deepEqual(logic.wishlistInsertBody(U, [C(1), C(1), 'x']), [{ user_id: U, card_id: C(1) }]);
  assert.equal(logic.wishlistInsertBody(U, []), null);
  assert.equal(
    logic.wishlistReadUrl(BASE, U, 1000),
    `${BASE}wishlist_items?select=card_id&user_id=eq.${U}&order=card_id.asc&limit=1000&offset=1000`
  );
  assert.equal(logic.wishlistReadUrl(BASE, 'nope'), null);
});

test('sortByNextEnd : fin la plus proche d\'abord, sans enchère en dernier, alphabétique à égalité', () => {
  const logic = create();
  const now = Date.parse('2026-10-06T12:00:00Z');
  const at = (hours) => new Date(now + hours * 3600000).toISOString();
  const live = (hours) => ({ status: 'active', end_at: at(hours) });
  const cards = [
    { id: 'z', title: 'Zèbre' },
    { id: 'a', title: 'Aigle' },
    { id: 'b', title: 'Bison' },
    { id: 'c', title: 'Chat' },
    { id: 'd', title: 'Dingo' }
  ];
  const listings = {
    z: [live(5)],
    a: [live(30), live(2)],            // sa plus proche fin : 2 h
    b: [{ status: 'active', end_at: at(-1) }],  // déjà terminée : ignorée
    c: [],                              // aucune annonce
    d: [live(5)]                        // égalité avec Zèbre -> alphabétique
  };
  const sorted = logic.sortByNextEnd(cards, (card) => listings[card.id], now);

  assert.deepEqual(sorted.map((c) => c.id), ['a', 'd', 'z', 'b', 'c']);
  assert.deepEqual(cards.map((c) => c.id), ['z', 'a', 'b', 'c', 'd']);
  assert.equal(logic.nextEndTime([live(3), live(1)], now), now + 3600000);
  assert.equal(logic.nextEndTime([], now), null);
  assert.deepEqual(logic.sortByNextEnd(null, () => [], now), []);
});

// ---- Étiquettes de famille -------------------------------------------------------
const TU = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('planTagSync : étiquette les exemplaires possédés qui ne l’ont pas', () => {
  const cards = [
    { id: TU(1), title: 'A', owned: true, ownedCardIds: [TU(101), TU(102)] },
    { id: TU(2), title: 'B', owned: true, ownedCardIds: [TU(103)] },
    { id: TU(3), title: 'C', owned: false },
    { id: TU(4), title: 'D', owned: null },
    { id: TU(5), title: 'E', owned: true }
  ];
  const plan = logic.planTagSync(cards, new Set([TU(103), TU(999)]));

  assert.deepEqual(plan.toAdd.map((x) => x.userCardId), [TU(101), TU(102)]);
  assert.equal(plan.alreadyTagged, 1);
  assert.equal(plan.notOwned, 1);
  assert.equal(plan.unchecked, 1);
  assert.equal(plan.needsReload, 1);
});

test('planTagSync : ignore ids invalides et doublons, tolère les entrées vides', () => {
  const cards = [
    { id: TU(1), owned: true, ownedCardIds: [TU(101), TU(101), 'pas-un-uuid'] },
    { id: TU(1), owned: true, ownedCardIds: [TU(102)] },
    null
  ];
  assert.deepEqual(logic.planTagSync(cards, []).toAdd.map((x) => x.userCardId), [TU(101)]);
  assert.equal(logic.planTagSync(null, null).toAdd.length, 0);
});

test('tagInsertBody : lignes {user_card_id, tag_id}, uuid seulement, sans doublon', () => {
  assert.deepEqual(logic.tagInsertBody(TU(9), [TU(1), TU(1), 'x', TU(2)]), [
    { user_card_id: TU(1), tag_id: TU(9) },
    { user_card_id: TU(2), tag_id: TU(9) }
  ]);
  assert.equal(logic.tagInsertBody('x', [TU(1)]), null);
  assert.equal(logic.tagInsertBody(TU(9), []), null);
});

test('shouldAutoTagSync : actif, étiquette choisie, au plus une fois par 6 h', () => {
  const now = 1_000_000_000_000;
  const H = 3600000;
  assert.equal(logic.shouldAutoTagSync(null, now), false);
  assert.equal(logic.shouldAutoTagSync({ auto: false, tagId: TU(1) }, now), false);
  assert.equal(logic.shouldAutoTagSync({ auto: true, tagId: 'x' }, now), false);
  assert.equal(logic.shouldAutoTagSync({ auto: true, tagId: TU(1) }, now), true);
  assert.equal(logic.shouldAutoTagSync({ auto: true, tagId: TU(1), lastAutoAt: now - 2 * H }, now), false);
  assert.equal(logic.shouldAutoTagSync({ auto: true, tagId: TU(1), lastAutoAt: now - 7 * H }, now), true);
  assert.equal(logic.shouldAutoTagSync({ auto: true, tagId: TU(1), lastAutoAt: now + H }, now), true);
});

test('extractMyBids : statut, enchères terminées écartées, doublons, identité inconnue', () => {
  const F = require('../features/family-logic.js').create();
  const now = Date.parse('2026-10-07T12:00:00Z');
  const A = (o) => ({ id: 'a', card_id: 'c', status: 'active', current_bidder_id: 'me', end_at: '2026-10-07T13:00:00Z', ...o });
  const json = { bidding: [A({}), A({ id: 'b', current_bidder_id: 'other' }), A({ id: 'c2', end_at: '2026-10-07T11:00:00Z' }),
    A({ id: 'd', status: 'ended' }), A({}), A({ id: 'e', card_id: undefined }), A({ id: 'f', current_bidder_id: null })] };
  const r = F.extractMyBids(json, 'me', now);
  assert.deepEqual(r.map((x) => [x.auctionId, x.status]), [['a', 'leading'], ['b', 'outbid'], ['f', 'unknown']]);
  assert.equal(F.extractMyBids(json, null, now)[0].status, 'unknown');
  assert.deepEqual(F.extractMyBids({}, 'me', now), []);
  assert.equal(F.myBidsSignature(r), F.myBidsSignature([...r].reverse()));
});
