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

    // ---- Historique des ventes terminées ---------------------------------------------------------

    // Statut final d'une vente : 'sold', 'unsold', 'cancelled', ou null si elle est encore active.
    function historyStatus(sale) {
      const status = String(sale?.status ?? '').toLowerCase();
      if (!status || status === 'active' || status === 'pending') return null;
      if (/cancel|annul|withdraw|retir/.test(status)) return 'cancelled';
      if (/unsold|no_?bid|expired|invendu|not_sold/.test(status)) return 'unsold';
      if (/sold|vendu/.test(status)) return 'sold';
      // Statut terminé inconnu : vendue seulement si un acheteur et un prix sont connus.
      return hasBids(sale) ? 'sold' : 'unsold';
    }

    function soldPrice(sale) {
      return positive(sale?.final_amount) ?? positive(sale?.sold_amount) ?? positive(sale?.final_price) ??
        positive(sale?.winning_bid) ?? positive(sale?.effective_bid) ?? positive(sale?.current_bid);
    }

    function endedAt(sale) {
      for (const key of ['settled_at', 'ended_at', 'cancelled_at', 'end_at', 'updated_at', 'created_at']) {
        const at = Date.parse(sale?.[key]);
        if (Number.isFinite(at)) return at;
      }
      return null;
    }

    function cardKey(sale) {
      return String(sale?.user_card_id ?? sale?.owned_card_id ?? sale?.card_id ?? sale?.card?.id ?? sale?.id ?? '');
    }

    function rarityOf(sale) {
      return String(sale?.snapshot_rarity || sale?.card?.rarity || '');
    }

    const looksLikeListing = (item) =>
      item && typeof item === 'object' && item.id != null &&
      (item.card || item.card_id || item.end_at || item.base_amount != null || item.listing_base_amount != null);

    // Ventes terminées : toutes les listes de la réponse /api/marketplace?mine=1 sauf `bidding`
    // (les enchères où l'on est acheteur). Le nom exact de la clé d'historique n'est pas figé,
    // d'où la recherche : on garde les annonces au statut terminé, sans doublon.
    function extractHistory(json) {
      const items = [];
      const sources = [];
      const seen = new Set();
      if (!json || typeof json !== 'object' || Array.isArray(json)) return { items, sources };

      const sellerIds = new Set(
        (Array.isArray(json.selling) ? json.selling : []).map((s) => s?.seller_id).filter(Boolean)
      );

      for (const [key, value] of Object.entries(json)) {
        if (key === 'bidding' || !Array.isArray(value)) continue;
        let used = false;
        for (const item of value) {
          if (!looksLikeListing(item) || seen.has(item.id)) continue;
          const status = historyStatus(item);
          if (!status) continue;
          if (sellerIds.size && item.seller_id && !sellerIds.has(item.seller_id)) continue;
          seen.add(item.id);
          items.push({ ...item, _status: status, _endedAt: endedAt(item) });
          used = true;
        }
        if (used) sources.push(key);
      }

      return { items, sources };
    }

    // Nombre de mises en vente par carte possédée : repère les cartes remises en vente.
    function relistCounts(items) {
      const counts = new Map();
      for (const item of Array.isArray(items) ? items : []) {
        const key = cardKey(item);
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
      return counts;
    }

    function historyStats(items) {
      const list = Array.isArray(items) ? items : [];
      const sold = list.filter((item) => item._status === 'sold');
      const earned = sold.reduce((sum, item) => sum + (soldPrice(item) || 0), 0);
      const counts = { all: list.length, sold: sold.length, unsold: 0, cancelled: 0 };
      for (const item of list) if (item._status === 'unsold' || item._status === 'cancelled') counts[item._status] += 1;
      const closed = counts.sold + counts.unsold; // les annulations ne comptent pas dans le taux
      return {
        counts,
        earned,
        average: sold.length ? Math.round(earned / sold.length) : null,
        rate: closed ? counts.sold / closed : null
      };
    }

    const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
    const rarityRank = (code) => {
      const index = RARITY_ORDER.indexOf(code);
      return index === -1 ? RARITY_ORDER.length : index;
    };

    function filterHistory(items, filter) {
      const list = Array.isArray(items) ? items : [];
      return !filter || filter === 'all' ? list.slice() : list.filter((item) => item._status === filter);
    }

    // sort : 'date' (récent d'abord), 'price' (plus cher d'abord), 'rarity' (plus rare d'abord).
    function sortHistory(items, sort = 'date') {
      const price = (item) => (item._status === 'sold' ? soldPrice(item) : startPrice(item)) || 0;
      const date = (item) => item._endedAt || 0;
      const compare = {
        price: (a, b) => price(b) - price(a) || date(b) - date(a),
        rarity: (a, b) => rarityRank(rarityOf(a)) - rarityRank(rarityOf(b)) || date(b) - date(a),
        date: (a, b) => date(b) - date(a)
      }[sort] || ((a, b) => date(b) - date(a));
      return (Array.isArray(items) ? items : []).slice().sort(compare);
    }

    return {
      SOON_MS, extractSales, hasBids, startPrice, currentPrice, signature, signatures,
      normalizeBids, detectNewBids, summary, pollDelay, formatBidAge,
      historyStatus, soldPrice, endedAt, cardKey, rarityOf, extractHistory, relistCounts,
      historyStats, filterHistory, sortHistory
    };
  }

  if (registry) registry.mySalesLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
