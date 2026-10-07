(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const SOON_MS = 2 * 60 * 1000;

  function create() {
    const positive = (value) => {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : null;
    };

    // Ventes en cours de l'utilisateur : clé `selling` de /api/marketplace?mine=1.
    function extractSales(json) {
      if (!Array.isArray(json?.selling)) return [];

      return json.selling.filter((sale) =>
        sale &&
        typeof sale === 'object' &&
        sale.id &&
        (!sale.status || sale.status === 'active')
      );
    }

    // Une mise existe dès qu'un montant ou un enchérisseur est renseigné.
    function hasBids(sale) {
      return positive(sale?.current_bid) != null || Boolean(sale?.current_bidder_id);
    }

    function startPrice(sale) {
      return positive(sale?.listing_base_amount) ?? positive(sale?.base_amount);
    }

    // Prix auquel la vente se joue actuellement : la mise en cours, sinon la mise de départ.
    function currentPrice(sale) {
      if (hasBids(sale)) {
        return positive(sale?.effective_bid) ?? positive(sale?.current_bid) ?? startPrice(sale);
      }
      return startPrice(sale);
    }

    function bidderName(bidder) {
      const name = String(bidder?.username ?? '').trim();
      return name || null;
    }

    // Empreinte de l'état des mises : sert à savoir quand relire le détail d'une annonce.
    function signature(sale) {
      return `${positive(sale?.current_bid) ?? ''}|${sale?.current_bidder_id ?? ''}`;
    }

    // Historique d'une annonce (`bids` de /api/marketplace/{id}), du plus récent au plus ancien.
    function normalizeBids(json) {
      if (!Array.isArray(json?.bids)) return [];

      return json.bids
        .map((bid) => {
          const amount = positive(bid?.amount);
          const at = Date.parse(bid?.placed_at);
          if (amount == null || !Number.isFinite(at)) return null;
          return {
            id: String(bid?.id ?? `${bid?.bidder_id ?? ''}:${at}`),
            amount,
            at,
            bidder: bidderName(bid?.bidder) || 'Anonyme'
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.at - a.at || b.amount - a.amount);
    }

    // Ventes dont l'état des mises a changé depuis le dernier relevé. Une vente vue pour la
    // première fois n'est jamais « nouvelle » : seul un changement observé l'est.
    function detectNewBids(previous, sales) {
      const fresh = [];

      for (const sale of Array.isArray(sales) ? sales : []) {
        const before = previous?.get?.(sale.id);
        if (before == null) continue;
        if (hasBids(sale) && before !== signature(sale)) fresh.push(sale.id);
      }

      return fresh;
    }

    function signatures(sales) {
      return new Map((Array.isArray(sales) ? sales : []).map((sale) => [sale.id, signature(sale)]));
    }

    function summary(sales) {
      const list = Array.isArray(sales) ? sales : [];
      return { total: list.length, withBids: list.filter(hasBids).length };
    }

    // Délai avant la prochaine lecture : plus rapproché à l'approche d'une fin de vente.
    function pollDelay({ sales, now, hidden = false, visibleMs = 10000, hiddenMs = 30000, fastMs = 4000 }) {
      if (hidden) return hiddenMs;
      const soon = (Array.isArray(sales) ? sales : []).some((sale) => {
        const end = Date.parse(sale?.end_at);
        return Number.isFinite(end) && end > now && end - now <= SOON_MS;
      });
      return soon ? fastMs : visibleMs;
    }

    function formatBidAge(at, now) {
      const diff = now - at;
      if (!(diff >= 0)) return 'à l’instant';
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return 'à l’instant';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `il y a ${minutes} min`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `il y a ${hours} h`;
      return `il y a ${Math.floor(hours / 24)} j`;
    }

    return {
      SOON_MS, extractSales, hasBids, startPrice, currentPrice, signature, signatures,
      normalizeBids, detectNewBids, summary, pollDelay, formatBidAge
    };
  }

  if (registry) registry.mySalesLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
