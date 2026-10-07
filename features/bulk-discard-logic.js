(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const RARITIES = ['C', 'PC', 'R', 'SR', 'UR', 'L'];
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Raisons de protection, par ordre de priorité d'affichage.
  const PROTECTION_REASONS = ['trade', 'starred', 'tagged', 'shiny', 'family'];

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

    // Plan complet. `priceOf(cardId, rarity)` renvoie la valeur de marché moyenne, ou null si
    // elle est inconnue : une carte sans prix n'est JAMAIS défaussée.
    function buildPlan(rows, context, params, priceOf) {
      const { candidates, counts } = classify(rows, { ...context, rarities: params.rarities });
      const plan = {
        counts: { ...counts, unpriced: 0, aboveMax: 0, keptOne: 0 },
        eligible: [],
        items: [],
        overLimit: 0
      };

      for (const card of candidates) {
        const price = priceOf(card.cardId, card.rarity);
        if (!(typeof price === 'number' && Number.isFinite(price) && price >= 0)) {
          plan.counts.unpriced += 1;
          continue;
        }
        if (price > params.maxPrice) {
          plan.counts.aboveMax += 1;
          continue;
        }

        const toDiscard = params.keepOne ? card.copies.slice(1) : card.copies;
        if (params.keepOne) plan.counts.keptOne += 1;

        for (const copy of toDiscard) {
          plan.eligible.push({
            userCardId: copy.userCardId,
            cardId: card.cardId,
            title: card.title,
            rarity: card.rarity,
            price
          });
        }
      }

      plan.eligible.sort((a, b) => a.title.localeCompare(b.title, 'fr') || a.userCardId.localeCompare(b.userCardId));
      plan.items = plan.eligible.slice(0, params.limit);
      plan.overLimit = plan.eligible.length - plan.items.length;
      return plan;
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

    return {
      RARITIES, DEFAULT_LIMIT, MAX_LIMIT, PROTECTION_REASONS,
      validateParams, normalizeRow, classify, buildPlan, reverify, discardUrl, familyCardIds
    };
  }

  if (registry) registry.bulkDiscardLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
