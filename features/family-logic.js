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

    function positiveNumber(value) {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : null;
    }

    // Lit les mises d'une annonce du Marketplace. `current_bid` vaut null tant que
    // personne n'a misé (même convention que la logique « Mes enchères »).
    // `known` est faux quand l'API n'a renvoyé aucun champ de mise : dans ce cas
    // on n'affirme rien (ni « misée », ni « aucune mise »).
    function auctionBidInfo(auction) {
      const known = Boolean(auction) && typeof auction === 'object'
        && ('current_bid' in auction || 'current_bidder_id' in auction);
      const currentBid = positiveNumber(auction?.current_bid);
      const hasBids = known && (currentBid != null || Boolean(auction?.current_bidder_id));

      return {
        known,
        hasBids,
        highest: hasBids ? (currentBid ?? positiveNumber(auction?.effective_bid)) : null,
        start: positiveNumber(auction?.listing_base_amount) ?? positiveNumber(auction?.base_amount)
      };
    }

    // Une annonce est « en cours » si elle est active et n'a pas atteint sa fin.
    // Sans date de fin exploitable, on la considère en cours.
    function isLiveAuction(auction, now = Date.now()) {
      if (!auction || typeof auction !== 'object') return false;
      if (auction.status && auction.status !== 'active') return false;

      const end = Date.parse(auction.end_at);
      return !Number.isFinite(end) || end > now;
    }

    function liveListings(listings, now = Date.now()) {
      return (Array.isArray(listings) ? listings : []).filter((auction) => isLiveAuction(auction, now));
    }

    // Valide le montant saisi avant d'envoyer une mise. `reason` : 'invalid' (pas un
    // entier positif), 'below-minimum' ou 'insufficient-balance' (solde connu seulement).
    function validateBid(input, minimum, balance) {
      const text = String(input ?? '').trim();
      const amount = Number(text);

      if (!text || !Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'invalid' };
      if (Number.isFinite(minimum) && amount < minimum) return { ok: false, reason: 'below-minimum' };
      if (Number.isFinite(balance) && amount > balance) return { ok: false, reason: 'insufficient-balance' };

      return { ok: true, amount };
    }

    return { pickAddable, mergeCards, auctionBidInfo, isLiveAuction, liveListings, validateBid };
  }

  if (registry) registry.familyLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
