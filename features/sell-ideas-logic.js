(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const DEFAULT_RARITIES = ['R', 'SR', 'UR', 'L'];
  const DEFAULT_MIN_PRICE = 10;
  const LIST_CAP = 200;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // `bulk` : logique de la défausse (lecture des lignes, protections favori/étiquette/shiny/échange/famille/pile).
  function create(bulk) {
    function validateParams(input = {}) {
      const allowed = bulk.RARITIES;
      const rarities = [...new Set((input.rarities || []).filter((code) => allowed.includes(code)))];
      if (!rarities.length) return { ok: false, reason: 'no-rarity' };
      const text = String(input.minPrice ?? '').trim().replace(',', '.');
      const minPrice = text === '' ? 0 : Number(text);
      if (!Number.isFinite(minPrice) || minPrice < 0) return { ok: false, reason: 'invalid-price' };
      return { ok: true, params: { rarities, minPrice, keepOne: input.keepOne !== false } };
    }

    // Identifiants de cartes déjà en vente : clé `selling` de /api/marketplace?mine=1.
    function sellingCardIds(json) {
      const ids = new Set();
      for (const sale of Array.isArray(json?.selling) ? json.selling : []) {
        const id = sale?.card_id || sale?.card?.id;
        if (typeof id === 'string' && UUID.test(id)) ids.add(id);
      }
      return ids;
    }

    // Classement des cartes à vendre. Les cartes protégées (favori, étiquette, shiny, famille, échange,
    // pile) sont exclues : le site choisit lui-même l'exemplaire vendu, on ne tente donc pas de deviner.
    // Les cartes sans prix connu sont comptées mais jamais classées.
    function rank(rows, context, params, priceOf, sellingIds = new Set()) {
      const { candidates, counts } = bulk.classify(rows, { ...context, rarities: params.rarities });
      const out = {
        items: [],
        counts: {
          inRarity: counts.inRarity,
          protected: counts.inRarity - candidates.length,
          unpriced: 0, belowMin: 0, singles: 0, listed: 0, shown: 0, hidden: 0
        },
        totalValue: 0
      };

      for (const card of candidates) {
        const sellable = params.keepOne ? card.copies.length - 1 : card.copies.length;
        if (sellable < 1) { out.counts.singles += 1; continue; }

        const price = priceOf(card.cardId, card.rarity);
        if (!(typeof price === 'number' && Number.isFinite(price) && price >= 0)) { out.counts.unpriced += 1; continue; }
        if (price < params.minPrice) { out.counts.belowMin += 1; continue; }

        const listed = sellingIds.has(card.cardId);
        if (listed) out.counts.listed += 1;
        out.items.push({
          cardId: card.cardId, title: card.title, rarity: card.rarity,
          price, copies: card.copies.length, sellable, total: price * sellable, listed
        });
      }

      out.items.sort((a, b) => b.price - a.price || b.sellable - a.sellable || a.title.localeCompare(b.title));
      out.totalValue = out.items.reduce((sum, item) => sum + (item.listed ? 0 : item.total), 0);
      out.counts.shown = Math.min(out.items.length, LIST_CAP);
      out.counts.hidden = Math.max(0, out.items.length - LIST_CAP);
      out.items = out.items.slice(0, LIST_CAP);
      return out;
    }

    return { DEFAULT_RARITIES, DEFAULT_MIN_PRICE, LIST_CAP, validateParams, sellingCardIds, rank };
  }

  if (registry) registry.sellIdeasLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
