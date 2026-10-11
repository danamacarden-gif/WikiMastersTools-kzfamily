(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  // File de ventes à venir : quand les places d'enchères sont pleines, les ventes réglées
  // (prix + durée) attendent ici et partent dès qu'une place se libère. Logique pure.
  const MAX_ATTEMPTS = 3;
  const MAX_ITEMS = 100;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DURATIONS = [10, 30, 60, 180, 360, 720];

  function create() {
    const emptyStore = () => ({ paused: false, items: [] });

    function normalizeItem(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const baseAmount = Number(raw.baseAmount);
      const durationMinutes = Number(raw.durationMinutes);
      if (typeof raw.id !== 'string' || !raw.id) return null;
      if (!UUID.test(String(raw.catalogueCardId || ''))) return null;
      if (!Number.isInteger(baseAmount) || baseAmount < 1) return null;
      if (!DURATIONS.includes(durationMinutes)) return null;
      const average = Number(raw.average);
      return {
        id: raw.id,
        catalogueCardId: raw.catalogueCardId,
        title: String(raw.title || 'Carte'),
        rarity: raw.rarity ? String(raw.rarity) : null,
        average: Number.isFinite(average) ? average : null,
        baseAmount,
        durationMinutes,
        addedAt: Number(raw.addedAt) || 0,
        attempts: Math.max(0, Math.floor(Number(raw.attempts) || 0)),
        error: raw.error ? String(raw.error) : null
      };
    }

    function normalizeStore(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
      const seen = new Set();
      const items = [];
      for (const item of Array.isArray(raw.items) ? raw.items : []) {
        const clean = normalizeItem(item);
        if (!clean || seen.has(clean.id)) continue;
        seen.add(clean.id);
        items.push(clean);
      }
      return { paused: raw.paused === true, items: items.slice(0, MAX_ITEMS) };
    }

    // Ajoute en fin de file. Renvoie { ok, store } ou { ok:false, reason }.
    function enqueue(store, input, { id, now }) {
      const item = normalizeItem({ ...input, id, addedAt: now, attempts: 0, error: null });
      if (!item) return { ok: false, reason: 'invalid' };
      if (store.items.length >= MAX_ITEMS) return { ok: false, reason: 'full' };
      return { ok: true, store: { ...store, items: [...store.items, item] } };
    }

    function remove(store, id) {
      return { ...store, items: store.items.filter((item) => item.id !== id) };
    }

    // delta : -1 (monter) ou +1 (descendre).
    function move(store, id, delta) {
      const items = store.items.slice();
      const from = items.findIndex((item) => item.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return store;
      [items[from], items[to]] = [items[to], items[from]];
      return { ...store, items };
    }

    function update(store, id, patch) {
      return { ...store, items: store.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) };
    }

    // Remet en attente un élément en erreur (compteur d'essais remis à zéro).
    function retry(store, id) {
      return update(store, id, { error: null, attempts: 0 });
    }

    const pending = (store) => store.items.filter((item) => !item.error);

    // Prochaine vente à lancer, ou la raison d'attendre.
    function next(store, slots) {
      if (store.paused) return { action: 'wait', reason: 'paused' };
      const first = pending(store)[0];
      if (!first) return { action: 'idle' };
      if (!slots) return { action: 'wait', reason: 'unknown-slots' };
      if (slots.used >= slots.max) return { action: 'wait', reason: 'full' };
      return { action: 'list', item: first };
    }

    // Résultat du pont de mise en vente -> nouvel état de l'élément.
    // 'done' : vendu, à retirer ; 'error' : bloqué jusqu'à intervention ; 'retry' : réessayer plus tard ;
    // 'slots-full' : le serveur dit que les places sont prises, on attend sans compter d'essai.
    function outcome(item, result) {
      if (result?.ok) return { kind: 'done' };
      const message = String(result?.error || '').toLocaleLowerCase('fr');
      if (result?.needsStarredConfirmation) return { kind: 'error', error: 'Seul exemplaire disponible en favori : vends-le à la main.' };
      if (result?.alreadyListed) return { kind: 'error', error: 'Toutes tes copies de cette carte sont déjà en vente.' };
      if (result?.notOwned || result?.ownershipError) return { kind: 'error', error: 'Tu ne possèdes plus cette carte.' };
      if (/maximum|simultan|limite|limit/.test(message)) return { kind: 'slots-full' };
      if (/solde|insuffisant|balance/.test(message)) return { kind: 'error', error: String(result.error) };
      const attempts = (item.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) return { kind: 'error', error: `Échec après ${attempts} essais : ${result?.error || 'erreur inconnue'}`, attempts };
      return { kind: 'retry', attempts };
    }

    // Verrou partagé entre onglets : un seul onglet traite la file à la fois.
    function canHoldLock(lock, owner, now) {
      if (!lock || typeof lock !== 'object') return true;
      if (lock.owner === owner) return true;
      return !(Number(lock.until) > now);
    }

    const queuedCardIds = (store) => new Set(store.items.map((item) => item.catalogueCardId));

    return {
      MAX_ATTEMPTS, MAX_ITEMS, emptyStore, normalizeStore, enqueue, remove, move, update, retry,
      pending, next, outcome, canHoldLock, queuedCardIds
    };
  }

  if (registry) registry.saleQueueLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
