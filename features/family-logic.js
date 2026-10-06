(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  function create() {
    function compareTitles(a, b) {
      return String(a?.title ?? '').localeCompare(String(b?.title ?? ''), 'fr');
    }

    // Cartes de `incoming` qui peuvent encore être ajoutées : un id, absentes de
    // `existing`, sans doublon dans le lot. L'ordre d'origine est conservé.
    function pickAddable(existing, incoming) {
      const known = new Set((existing || []).map((card) => card?.id));
      const picked = [];

      for (const card of incoming || []) {
        const id = card?.id;
        if (!id || known.has(id)) continue;
        known.add(id);
        picked.push(card);
      }

      return picked;
    }

    // Ne modifie ni `existing` ni `incoming` : renvoie la nouvelle liste triée
    // et les cartes réellement ajoutées.
    function mergeCards(existing, incoming) {
      const base = Array.isArray(existing) ? existing : [];
      const added = pickAddable(base, incoming);
      const cards = [...base, ...added.map((card) => ({ ...card }))].sort(compareTitles);
      return { cards, added };
    }

    return { pickAddable, mergeCards };
  }

  if (registry) registry.familyLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
