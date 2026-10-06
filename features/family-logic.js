(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

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

    // Prochaine fin d'enchère parmi les annonces en cours (timestamp ms), ou null.
    function nextEndTime(listings, now = Date.now()) {
      const ends = liveListings(listings, now)
        .map((auction) => Date.parse(auction?.end_at))
        .filter(Number.isFinite);
      return ends.length ? Math.min(...ends) : null;
    }

    // Trie des cartes de l'enchère qui se termine le plus tôt à celle qui finit le plus loin.
    // `getListings(card)` donne les annonces de la carte ; sans enchère en cours, la carte passe
    // en dernier. À égalité, ordre alphabétique. Ne modifie pas la liste d'entrée.
    function sortByNextEnd(cards, getListings, now = Date.now()) {
      return (Array.isArray(cards) ? cards : [])
        .map((card) => ({ card, end: nextEndTime(getListings(card), now) }))
        .sort((a, b) => {
          if (a.end !== b.end) {
            if (a.end == null) return 1;
            if (b.end == null) return -1;
            return a.end - b.end;
          }
          return compareTitles(a.card, b.card);
        })
        .map(({ card }) => card);
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

    // Filtre d'une famille : `ownership` ('all' | 'owned' | 'missing' | 'unchecked') combiné
    // à `rarity` (null/'' = toutes, sinon un code de RARITIES). Renvoie une nouvelle liste.
    function filterCards(cards, { ownership = 'all', rarity = null } = {}) {
      let list = Array.isArray(cards) ? [...cards] : [];

      if (ownership === 'owned') list = list.filter((card) => card?.owned === true);
      if (ownership === 'missing') list = list.filter((card) => card?.owned === false);
      if (ownership === 'unchecked') list = list.filter((card) => card?.owned == null);
      if (rarity) list = list.filter((card) => card?.rarity === rarity);

      return list;
    }

    // Nombre de cartes par rareté (sur la liste donnée), pour afficher les puces utiles.
    function rarityCounts(cards) {
      const counts = Object.fromEntries(RARITIES.map((code) => [code, 0]));
      for (const card of Array.isArray(cards) ? cards : []) {
        if (card && Object.prototype.hasOwnProperty.call(counts, card.rarity)) counts[card.rarity] += 1;
      }
      return counts;
    }

    // ---- Liste de souhaits -------------------------------------------------------------
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = (value) => typeof value === 'string' && UUID.test(value);

    // Synchronise la liste de souhaits avec une famille : on y met les cartes manquantes
    // qui n'y sont pas, on en retire les cartes de la famille désormais possédées. Les cartes
    // « à vérifier » (propriété inconnue) et celles d'autres familles ne sont jamais touchées.
    function planWishlistSync(cards, wishlistIds) {
      const wished = wishlistIds instanceof Set ? wishlistIds : new Set(wishlistIds || []);
      const seen = new Set();
      const plan = { toAdd: [], toRemove: [], alreadyWished: 0, unchecked: 0 };

      for (const card of Array.isArray(cards) ? cards : []) {
        if (!card || !isUuid(card.id) || seen.has(card.id)) continue;
        seen.add(card.id);

        if (card.owned == null) plan.unchecked += 1;
        else if (card.owned === false && wished.has(card.id)) plan.alreadyWished += 1;
        else if (card.owned === false) plan.toAdd.push(card);
        else if (card.owned === true && wished.has(card.id)) plan.toRemove.push(card);
      }

      return plan;
    }

    function chunk(list, size) {
      const out = [];
      const step = Math.max(1, Math.floor(size) || 1);
      for (let i = 0; i < (list || []).length; i += step) out.push(list.slice(i, i + step));
      return out;
    }

    // Requêtes PostgREST (Supabase) de la table wishlist_items. Les identifiants non-UUID
    // sont écartés pour ne jamais injecter autre chose dans l'URL.
    function wishlistDeleteUrl(baseUrl, userId, cardIds) {
      const ids = (cardIds || []).filter(isUuid);
      if (!isUuid(userId) || !ids.length) return null;
      return `${baseUrl}wishlist_items?user_id=eq.${userId}&card_id=in.(${ids.join(',')})`;
    }

    function wishlistInsertBody(userId, cardIds) {
      if (!isUuid(userId)) return null;
      const ids = [...new Set((cardIds || []).filter(isUuid))];
      return ids.length ? ids.map((cardId) => ({ user_id: userId, card_id: cardId })) : null;
    }

    function wishlistReadUrl(baseUrl, userId, offset = 0, limit = 1000) {
      if (!isUuid(userId)) return null;
      return `${baseUrl}wishlist_items?select=card_id&user_id=eq.${userId}&order=card_id.asc&limit=${limit}&offset=${offset}`;
    }

    return {
      planWishlistSync, chunk, wishlistDeleteUrl, wishlistInsertBody, wishlistReadUrl,
      RARITIES, nextEndTime, sortByNextEnd, pickAddable, mergeCards, auctionBidInfo, isLiveAuction, liveListings,
      validateBid, filterCards, rarityCounts
    };
  }

  if (registry) registry.familyLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
