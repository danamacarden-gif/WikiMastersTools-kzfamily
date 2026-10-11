(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
  // En dessous, la médiane d'une rareté n'est pas assez représentative pour juger d'une « bonne affaire ».
  const MIN_SAMPLE = 5;
  const SORTS = [
    { id: 'profit', label: 'Rentabilité (écart à la normale de la rareté)' },
    { id: 'excess', label: 'Gain au-dessus de la normale (W)' },
    { id: 'price', label: 'Prix moyen' },
    { id: 'total', label: 'Valeur totale des exemplaires vendables' },
    { id: 'rarity', label: 'Rareté' },
    { id: 'copies', label: 'Nombre d’exemplaires' },
    { id: 'title', label: 'Titre' }
  ];

  function create() {
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

    function median(values) {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Cartes de la collection (format de l'extension) + prix -> lignes. `priceOf(id, rarity)` -> nombre | null.
    function buildRows(cards, priceOf, familyCardIds = new Set()) {
      const families = familyCardIds instanceof Set ? familyCardIds : new Set(familyCardIds || []);
      const rows = [];
      for (const card of Array.isArray(cards) ? cards : []) {
        if (!card?.id || !card?.title) continue;
        const ids = Array.isArray(card.ownedCardIds) ? card.ownedCardIds.length : 0;
        const price = priceOf(card.id, card.rarity || null);
        rows.push({
          id: card.id,
          title: String(card.title),
          rarity: card.rarity || null,
          imageUrl: card.imageUrl || null,
          // Un exemplaire non favori : le site vend l'exemplaire désigné ; sinon le pont en cherche un.
          ownedCardId: card.starred === true ? null : (card.ownedCardId || (ids ? card.ownedCardIds[0] : null) || null),
          copies: Math.max(1, Number(card.count) || 1, ids),
          starred: card.starred === true,
          tagCount: Array.isArray(card.tags) ? card.tags.length : 0,
          family: families.has(card.id),
          price: finite(price) ? price : null
        });
      }
      return rows;
    }

    // Prix « normal » d'une rareté : médiane de TOUTES les cartes chiffrées de cette rareté (avant tout filtre).
    function rarityStats(rows) {
      const byRarity = new Map();
      for (const row of rows) {
        if (row.price == null || !row.rarity) continue;
        if (!byRarity.has(row.rarity)) byRarity.set(row.rarity, []);
        byRarity.get(row.rarity).push(row.price);
      }
      const stats = {};
      for (const [rarity, prices] of byRarity) {
        stats[rarity] = { n: prices.length, median: median(prices), reliable: prices.length >= MIN_SAMPLE };
      }
      return stats;
    }

    // Ajoute `ratio` (prix / médiane de la rareté) et `excess` (prix - médiane) quand la rareté est fiable.
    function annotate(rows, stats) {
      return rows.map((row) => {
        const ref = row.rarity ? stats[row.rarity] : null;
        const usable = row.price != null && ref?.reliable && ref.median > 0;
        return {
          ...row,
          reference: usable ? ref.median : null,
          ratio: usable ? row.price / ref.median : null,
          excess: usable ? row.price - ref.median : null
        };
      });
    }

    const rarityIndex = (rarity) => {
      const i = RARITY_ORDER.indexOf(rarity);
      return i < 0 ? RARITY_ORDER.length : i;
    };
    const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

    function comparator(sort) {
      const title = (a, b) => a.title.localeCompare(b.title, 'fr');
      switch (sort) {
        case 'price': return (a, b) => num(b.price, -1) - num(a.price, -1) || title(a, b);
        case 'excess': return (a, b) => num(b.excess, -Infinity) - num(a.excess, -Infinity) || title(a, b);
        case 'total': return (a, b) => num(b.total, -1) - num(a.total, -1) || title(a, b);
        case 'rarity': return (a, b) => rarityIndex(a.rarity) - rarityIndex(b.rarity) || num(b.price, -1) - num(a.price, -1) || title(a, b);
        case 'copies': return (a, b) => b.copies - a.copies || num(b.price, -1) - num(a.price, -1) || title(a, b);
        case 'title': return title;
        default: return (a, b) => num(b.ratio, -Infinity) - num(a.ratio, -Infinity) || num(b.price, -1) - num(a.price, -1) || title(a, b);
      }
    }

    // Filtre + tri. Les cartes sans prix ne sont jamais proposées.
    // opts : { rarities:Set (vide = toutes), minPrice, minRatio, duplicatesOnly, hideProtected, hideListed, sort }
    function select(annotated, opts = {}, sellingIds = new Set()) {
      const rarities = opts.rarities instanceof Set ? opts.rarities : new Set(opts.rarities || []);
      const minPrice = Number(opts.minPrice) > 0 ? Number(opts.minPrice) : 0;
      const minRatio = Number(opts.minRatio) > 0 ? Number(opts.minRatio) : 0;
      const counts = { unpriced: 0, protected: 0, listed: 0, belowPrice: 0, belowRatio: 0, singles: 0 };
      const items = [];

      for (const row of annotated) {
        if (rarities.size && !rarities.has(row.rarity)) continue;
        if (row.price == null) { counts.unpriced += 1; continue; }

        const isProtected = row.starred || row.tagCount > 0 || row.family;
        if (opts.hideProtected !== false && isProtected) { counts.protected += 1; continue; }

        const listed = sellingIds.has(row.id);
        if (opts.hideListed && listed) { counts.listed += 1; continue; }

        const sellable = opts.duplicatesOnly ? row.copies - 1 : row.copies;
        if (sellable < 1) { counts.singles += 1; continue; }
        if (row.price < minPrice) { counts.belowPrice += 1; continue; }
        if (minRatio && !(row.ratio != null && row.ratio >= minRatio)) { counts.belowRatio += 1; continue; }

        items.push({ ...row, listed, protected: isProtected, sellable, total: row.price * sellable });
      }

      // Les cartes déjà en vente restent visibles mais passent après les autres, quel que soit le tri.
      const order = comparator(opts.sort);
      items.sort((a, b) => Number(a.listed) - Number(b.listed) || order(a, b));
      return { items, counts, totalValue: items.reduce((sum, item) => sum + (item.listed ? 0 : item.total), 0) };
    }

    // Identifiants de cartes déjà en vente : clé `selling` de /api/marketplace?mine=1.
    function sellingCardIds(json) {
      const ids = new Set();
      for (const sale of Array.isArray(json?.selling) ? json.selling : []) {
        const id = sale?.card_id || sale?.card?.id;
        if (typeof id === 'string' && id) ids.add(id);
      }
      return ids;
    }

    return { RARITY_ORDER, MIN_SAMPLE, SORTS, median, buildRows, rarityStats, annotate, select, sellingCardIds };
  }

  if (registry) registry.sellIdeasLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
