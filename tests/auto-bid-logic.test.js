const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../features/auto-bid-logic.js');

const logic = create();
const armed = (over = {}) => ({ max: 50, maxBids: 3, armed: true, placed: 0, failures: 0, ...over });
const base = (over = {}) => ({
  config: armed(), remainingMs: 10000, leading: false, nextAmount: 11, balance: 500, now: 100000, lastAttemptAt: 0, ...over
});

test('validateConfig : accepte un plafond entier ≥ mise minimale et 1..10 mises', () => {
  const ok = logic.validateConfig({ max: '50', maxBids: '3' }, 11);
  assert.equal(ok.ok, true);
  assert.deepEqual({ max: ok.config.max, maxBids: ok.config.maxBids, armed: ok.config.armed, placed: ok.config.placed }, { max: 50, maxBids: 3, armed: true, placed: 0 });

  assert.equal(logic.validateConfig({ max: '11', maxBids: 1 }, 11).ok, true);
  assert.equal(logic.validateConfig({ max: 10, maxBids: 1 }, 11).reason, 'max-too-low');
  assert.equal(logic.validateConfig({ max: '', maxBids: 1 }, 11).reason, 'invalid-max');
  assert.equal(logic.validateConfig({ max: 12.5, maxBids: 1 }, 11).reason, 'invalid-max');
  assert.equal(logic.validateConfig({ max: -4, maxBids: 1 }, 11).reason, 'invalid-max');
  assert.equal(logic.validateConfig({ max: 50, maxBids: 0 }, 11).reason, 'invalid-bids');
  assert.equal(logic.validateConfig({ max: 50, maxBids: 11 }, 11).ok, true, 'plus de plafond à 10');
  assert.equal(logic.validateConfig({ max: 50, maxBids: 500 }, 11).config.maxBids, 500);
  assert.equal(logic.validateConfig({ max: 50, maxBids: '' }, 11).config.maxBids, null, 'vide = illimité');
  assert.equal(logic.validateConfig({ max: 50, maxBids: 2.5 }, 11).reason, 'invalid-bids');
  assert.equal(logic.validateConfig({ max: 50, maxBids: 'x' }, 11).reason, 'invalid-bids');
});

test('decide : rien tant que la config n\'est pas armée', () => {
  assert.equal(logic.decide(base({ config: null })).action, 'idle');
  assert.equal(logic.decide(base({ config: armed({ armed: false }) })).action, 'idle');
});

test('decide : attend avant 16 s, mise à 16 s pile et en dessous', () => {
  assert.deepEqual(logic.decide(base({ remainingMs: 16001 })), { action: 'wait', reason: 'early' });
  assert.deepEqual(logic.decide(base({ remainingMs: 16000 })), { action: 'bid', amount: 11 });
  assert.deepEqual(logic.decide(base({ remainingMs: 1 })), { action: 'bid', amount: 11 });
});

test('decide : ne mise jamais quand on est déjà en tête', () => {
  assert.deepEqual(logic.decide(base({ leading: true })), { action: 'wait', reason: 'leading' });
});

test('decide : enchère terminée -> arrêt', () => {
  assert.deepEqual(logic.decide(base({ remainingMs: 0 })), { action: 'stop', reason: 'ended' });
  assert.deepEqual(logic.decide(base({ remainingMs: -5 })), { action: 'stop', reason: 'ended' });
});

test('decide : jamais au-dessus du prix max (égalité autorisée)', () => {
  assert.deepEqual(logic.decide(base({ nextAmount: 50 })), { action: 'bid', amount: 50 });
  assert.deepEqual(logic.decide(base({ nextAmount: 51 })), { action: 'stop', reason: 'max-reached' });
});

test('decide : respecte le nombre maximum de mises', () => {
  assert.deepEqual(logic.decide(base({ config: armed({ placed: 3 }) })), { action: 'stop', reason: 'bids-exhausted' });
  assert.deepEqual(logic.decide(base({ config: armed({ placed: 2 }) })), { action: 'bid', amount: 11 });
  // en tête avec toutes les mises utilisées : on attend, on ne s'arrête pas
  assert.deepEqual(logic.decide(base({ config: armed({ placed: 3 }), leading: true })), { action: 'wait', reason: 'leading' });
});

test('decide : solde insuffisant -> arrêt ; solde inconnu -> on tente', () => {
  assert.deepEqual(logic.decide(base({ balance: 10 })), { action: 'stop', reason: 'insufficient-balance' });
  assert.deepEqual(logic.decide(base({ balance: null })), { action: 'bid', amount: 11 });
});

test('decide : délai de 1,5 s entre deux tentatives', () => {
  assert.deepEqual(logic.decide(base({ lastAttemptAt: 99000 })), { action: 'wait', reason: 'cooldown' });
  assert.deepEqual(logic.decide(base({ lastAttemptAt: 98500 })), { action: 'bid', amount: 11 });
});

test('decide : 3 échecs -> arrêt ; prix inconnu -> on attend', () => {
  assert.deepEqual(logic.decide(base({ config: armed({ failures: 3 }) })), { action: 'stop', reason: 'errors' });
  assert.deepEqual(logic.decide(base({ nextAmount: NaN })), { action: 'wait', reason: 'unknown-price' });
  assert.deepEqual(logic.decide(base({ nextAmount: 0 })), { action: 'wait', reason: 'unknown-price' });
});

test('scénario : 3 surenchères successives, puis plafond atteint', () => {
  let config = armed({ max: 20, maxBids: 8 });
  const amounts = [];
  for (const nextAmount of [11, 13, 15, 17, 19, 21]) {
    const decision = logic.decide({ config, remainingMs: 8000, leading: false, nextAmount, balance: 100, now: 1e6, lastAttemptAt: 0 });
    if (decision.action !== 'bid') { assert.equal(nextAmount, 21); assert.equal(decision.reason, 'max-reached'); break; }
    amounts.push(decision.amount);
    config = logic.afterBidSuccess(config);
  }
  assert.deepEqual(amounts, [11, 13, 15, 17, 19]);
  assert.equal(config.placed, 5);
});

test('afterBidSuccess / afterBidFailure / disarm ne modifient pas l\'original', () => {
  const config = armed({ failures: 2 });
  assert.equal(logic.afterBidSuccess(config).failures, 0);
  assert.equal(logic.afterBidSuccess(config).placed, 1);
  assert.equal(logic.afterBidFailure(config).failures, 3);
  assert.deepEqual([logic.disarm(config, 'ended').armed, logic.disarm(config, 'ended').stopReason], [false, 'ended']);
  assert.deepEqual([config.placed, config.failures, config.armed], [0, 2, true]);
});

test('normalizeStore : écarte l\'invalide et l\'ancien, garde le reste', () => {
  const now = 1e12;
  const store = logic.normalizeStore({
    ok: { max: 40, maxBids: 2, armed: true, placed: 1, updatedAt: now - 1000 },
    old: { max: 40, maxBids: 2, armed: true, updatedAt: now - 8 * 24 * 3600 * 1000 },
    bad1: { max: 'x', maxBids: 2, updatedAt: now },
    bad2: { max: 40, maxBids: 0, updatedAt: now },
    big: { max: 40, maxBids: 99, updatedAt: now },
    free: { max: 40, maxBids: null, armed: true, updatedAt: now },
    bad3: null
  }, now);

  assert.deepEqual(Object.keys(store).sort(), ['big', 'free', 'ok']);
  assert.equal(store.free.maxBids, null);
  assert.equal(store.ok.armed, true);
  assert.equal(store.ok.placed, 1);
  assert.deepEqual(logic.normalizeStore(null, now), {});
  assert.deepEqual(logic.normalizeStore('x', now), {});
});

test('chaque raison d\'arrêt a un message', () => {
  for (const reason of ['ended', 'max-reached', 'bids-exhausted', 'insufficient-balance', 'errors']) {
    assert.ok(logic.STOP_MESSAGES[reason], reason);
  }
});

test('mises illimitées : jamais « bids-exhausted », seul le prix max arrête', () => {
  const cfg = armed({ max: 30, maxBids: null, placed: 500 });
  assert.equal(logic.decide({ config: cfg, remainingMs: 1000, leading: false, nextAmount: 20, now: 100000 }).action, 'bid');
  assert.deepEqual(logic.decide({ config: cfg, remainingMs: 1000, leading: false, nextAmount: 31, now: 100000 }), { action: 'stop', reason: 'max-reached' });
});
