(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const RARITIES = ['C', 'PC', 'R', 'SR', 'UR', 'L'];
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;
  // Au-delà, la liste affichée est tronquée (le reste est compté, jamais défaussé).
  const LIST_CAP = 1500;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Raisons de protection, par ordre de priorité d'affichage.
  const PROTECTION_REASONS = ['trade', 'starred', 'tagged', 'shiny', 'family'];

  // Mémoire locale des prix, propre à la défausse : un prix connu reste valable 7 jours (les
  // communes et peu communes bougent peu) ; « pas de prix » seulement 24 h.
  const PRICE_TTL_MS = 7 * 24 * 3600 * 1000;
  const NO_PRICE_TTL_MS = 24 * 3600 * 1000;
  const PRICE_STORE_MAX = 30000;

  function create() {
    const isUuid = (value) => typeof value === 'string' && UUID.test(value);

    // Paramètres saisis par l'utilisateur -> paramètres sûrs, ou la raison du refus.
    function validateParams(input = {}) {
      const rarities = [...new Set((input.rarities || []).filter((code) => RARITIES.includes(code)))];
      if (!rarities.length) return { ok: false, reason: 'no-rarity' };

      const maxText = String(input.maxPrice ?? '').trim().replace(',', '.');
      const maxPrice = Number(maxText);
      if (!maxText || !Number.isFinite(maxPrice) || maxPrice < 0) return { ok: false, reason: 'invalid-price' };

      const limitText = String(input.limit ?? DEFAULT_LIMIT).trim();
      const limit = Number(limitText);
      if (!limitText || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return { ok: false, reason: 'invalid-limit' };
      }

      return { ok: true, params: { rarities, maxPrice, limit, keepOne: input.keepOne !== false } };
    }

    // Une ligne de /api/my-collection. Sans les deux identifiants, la ligne est écartée : on ne
    // défausse jamais ce qu'on ne sait pas décrire.
    function normalizeRow(row) {
      const userCardId = row?.id;
      const cardId = row?.card_id || row?.card?.id;
      if (!isUuid(userCardId) || !isUuid(cardId)) return null;

      return {
        userCardId,
        cardId,
        title: String(row?.card?.wikipedia_title || row?.title || ''),
        rarity: row?.card?.rarity || row?.rarity || null,
        // Fail-safe : un champ absent ou inattendu n'est jamais pris pour « non ».
        // Seuls `starred: false`, `is_shiny: false` et un tableau `tags` vide autorisent la défausse.
        starred: row?.starred !== false,
        tagCount: Array.isArray(row?.tags) ? row.tags.length : 1,
        shiny: row?.is_shiny !== false,
        obtainedAt: String(row?.obtained_at || '')
      };
    }

    // Regroupe les exemplaires par carte et pose les protections. Une protection d'un seul
    // exemplaire (favori, étiquette, shiny, échange) protège TOUTE la carte.
    function classify(rows, { familyCardIds, pendingIds, rarities } = {}) {
      const families = familyCardIds instanceof Set ? familyCardIds : new Set(familyCardIds || []);
      const pending = pendingIds instanceof Set ? pendingIds : new Set(pendingIds || []);
      const wanted = new Set(rarities || []);
      const seenCopies = new Set();
      const cards = new Map();

      for (const raw of Array.isArray(rows) ? rows : []) {
        const row = normalizeRow(raw);
        if (!row || seenCopies.has(row.userCardId)) continue;
        seenCopies.add(row.userCardId);

        let card = cards.get(row.cardId);
        if (!card) {
          card = { cardId: row.cardId, title: row.title, rarity: row.rarity, copies: [], reasons: new Set() };
          cards.set(row.cardId, card);
        }

        card.copies.push(row);
        if (pending.has(row.userCardId) || pending.has(row.cardId)) card.reasons.add('trade');
        if (row.starred) card.reasons.add('starred');
        if (row.tagCount > 0) card.reasons.add('tagged');
        if (row.shiny) card.reasons.add('shiny');
      }

      const counts = { total: cards.size, inRarity: 0, protectedBy: Object.fromEntries(PROTECTION_REASONS.map((r) => [r, 0])) };
      const candidates = [];

      for (const card of cards.values()) {
        if (!wanted.has(card.rarity)) continue;
        counts.inRarity += 1;

        if (families.has(card.cardId)) card.reasons.add('family');

        const reason = PROTECTION_REASONS.find((r) => card.reasons.has(r));
        if (reason) {
          counts.protectedBy[reason] += 1;
          continue;
        }

        card.copies.sort((a, b) => a.obtainedAt.localeCompare(b.obtainedAt) || a.userCardId.localeCompare(b.userCardId));
        candidates.push(card);
      }

      return { candidates, counts };
    }

    // Plan complet. `priceOf(cardId, rarity)` renvoie la valeur de marché moyenne, ou null si elle est
    // inconnue. Les cartes sans prix sont LISTÉES (`unpriced: true`, `price: null`) mais ne sont jamais
    // sélectionnées d'office : seul un choix explicite de l'utilisateur les inclut.
    function buildPlan(rows, context, params, priceOf) {
      const { candidates, counts } = classify(rows, { ...context, rarities: params.rarities });
      const plan = {
        counts: { ...counts, unpriced: 0, aboveMax: 0, keptOne: 0 },
        eligible: [],
        items: [],
        overList: 0
      };

      for (const card of candidates) {
        const price = priceOf(card.cardId, card.rarity);
        const priced = typeof price === 'number' && Number.isFinite(price) && price >= 0;

        if (priced && price > params.maxPrice) {
          plan.counts.aboveMax += 1;
          continue;
        }
        if (!priced) plan.counts.unpriced += 1;

        const toDiscard = params.keepOne ? card.copies.slice(1) : card.copies;
        if (params.keepOne) plan.counts.keptOne += 1;

        for (const copy of toDiscard) {
          plan.eligible.push({
            userCardId: copy.userCardId,
            cardId: card.cardId,
            title: card.title,
            rarity: card.rarity,
            price: priced ? price : null,
            unpriced: !priced
          });
        }
      }

      // Les cartes avec prix d'abord, puis celles sans prix ; alphabétique dans chaque groupe.
      plan.eligible.sort((a, b) => Number(a.unpriced) - Number(b.unpriced)
        || a.title.localeCompare(b.title, 'fr') || a.userCardId.localeCompare(b.userCardId));
      plan.items = plan.eligible.slice(0, LIST_CAP);
      plan.overList = plan.eligible.length - plan.items.length;
      return plan;
    }

    // Sélection initiale : les cartes avec prix, dans la limite du lot. Jamais une carte sans prix.
    function defaultSelection(items, limit) {
      return (items || []).filter((item) => !item.unpriced).slice(0, Math.max(0, limit)).map((item) => item.userCardId);
    }

    // Sélection d'une salve : les cartes avec prix d'abord, puis (si demandé) celles sans prix, dans la limite du lot.
    function nextSelection(items, limit, includeUnpriced) {
      const max = Math.max(0, limit);
      const list = Array.isArray(items) ? items : [];
      const ordered = [...list.filter((item) => !item.unpriced), ...(includeUnpriced ? list.filter((item) => item.unpriced) : [])];
      return ordered.slice(0, max).map((item) => item.userCardId);
    }

    // Exemplaires restant à traiter (file d'attente) : avec prix, plus sans prix si l'utilisateur les inclut.
    function queueSize(plan, includeUnpriced) {
      const eligible = Array.isArray(plan?.eligible) ? plan.eligible : [];
      return eligible.filter((item) => includeUnpriced || !item.unpriced).length;
    }

    // Collection relue moins les exemplaires déjà défaussés : base de la salve suivante, sans nouvelle analyse.
    function withoutRows(rows, doneIds) {
      const done = doneIds instanceof Set ? doneIds : new Set(doneIds || []);
      return (Array.isArray(rows) ? rows : []).filter((row) => !done.has(row?.id));
    }

    // Cartes sans prix qu'on peut cocher en plus sans dépasser le lot, vu la sélection actuelle.
    function unpricedToAdd(items, selected, limit) {
      const chosen = selected instanceof Set ? selected : new Set(selected || []);
      const room = Math.max(0, limit - chosen.size);
      return (items || []).filter((item) => item.unpriced && !chosen.has(item.userCardId)).slice(0, room).map((item) => item.userCardId);
    }

    // Avant d'exécuter : on ne garde que ce qui est encore éligible dans un plan recalculé à
    // partir d'une collection relue. Une carte devenue favorite, étiquetée, ajoutée à une
    // famille ou engagée dans un échange depuis l'analyse est donc retirée.
    function reverify(selectedIds, freshPlan) {
      const selected = [...new Set(selectedIds || [])];
      const stillEligible = new Set((freshPlan?.eligible || []).map((item) => item.userCardId));
      return {
        keep: selected.filter((id) => stillEligible.has(id)),
        dropped: selected.filter((id) => !stillEligible.has(id))
      };
    }

    function discardUrl(userCardId) {
      return isUuid(userCardId) ? `/api/user-cards/${userCardId}/discard` : null;
    }

    function familyCardIds(families) {
      const ids = new Set();
      for (const family of Array.isArray(families) ? families : []) {
        for (const card of Array.isArray(family?.cards) ? family.cards : []) {
          if (card?.id) ids.add(card.id);
        }
      }
      return ids;
    }

    // ---- Mémoire des prix --------------------------------------------------------------------
    // Forme stockée : { [cardId]: [prix | null, horodatage] }. Tout ce qui n'a pas cette forme est
    // ignoré, et un horodatage dans le futur est traité comme périmé.
    function normalizePriceStore(raw) {
      const store = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;

      for (const [cardId, entry] of Object.entries(raw)) {
        if (!isUuid(cardId) || !Array.isArray(entry)) continue;
        const [price, at] = entry;
        const validPrice = price === null || (typeof price === 'number' && Number.isFinite(price) && price >= 0);
        if (validPrice && Number.isFinite(at) && at > 0) store[cardId] = [price, at];
      }

      return store;
    }

    // { hit: true, price } si un prix (ou « pas de prix ») encore valable est mémorisé.
    function lookupPrice(store, cardId, now = Date.now()) {
      const entry = store?.[cardId];
      if (!Array.isArray(entry)) return { hit: false };

      const [price, at] = entry;
      const age = now - at;
      const ttl = price === null ? NO_PRICE_TTL_MS : PRICE_TTL_MS;
      if (!Number.isFinite(age) || age < 0 || age > ttl) return { hit: false };

      return { hit: true, price };
    }

    function rememberPrice(store, cardId, price, now = Date.now()) {
      if (!isUuid(cardId)) return;
      const valid = price === null || (typeof price === 'number' && Number.isFinite(price) && price >= 0);
      if (valid) store[cardId] = [price, now];
    }

    // Supprime les entrées périmées, puis les plus anciennes au-delà du plafond.
    function prunePriceStore(store, now = Date.now(), max = PRICE_STORE_MAX) {
      for (const cardId of Object.keys(store)) {
        if (!lookupPrice(store, cardId, now).hit) delete store[cardId];
      }

      const ids = Object.keys(store);
      if (ids.length > max) {
        ids.sort((a, b) => store[a][1] - store[b][1]);
        for (const cardId of ids.slice(0, ids.length - max)) delete store[cardId];
      }

      return store;
    }

    return {
      PRICE_TTL_MS, NO_PRICE_TTL_MS, normalizePriceStore, lookupPrice, rememberPrice, prunePriceStore,
      RARITIES, DEFAULT_LIMIT, MAX_LIMIT, LIST_CAP, PROTECTION_REASONS,
      validateParams, normalizeRow, classify, buildPlan, defaultSelection, nextSelection, queueSize, withoutRows, unpricedToAdd, reverify, discardUrl, familyCardIds
    };
  }

  if (registry) registry.bulkDiscardLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
