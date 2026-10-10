(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const DURATIONS = [
    { minutes: 10, label: '10 min' }, { minutes: 30, label: '30 min' }, { minutes: 60, label: '1 h' },
    { minutes: 180, label: '3 h' }, { minutes: 360, label: '6 h' }, { minutes: 720, label: '12 h' }
  ];
  const DEFAULT_MINUTES = 60;
  const MAX_BASE = 1000000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function create() {
    // Mise de départ conseillée : le prix moyen arrondi, au moins 1.
    function suggestBase(average) {
      const n = Number(average);
      return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
    }

    // Saisie -> corps de POST /api/marketplace, ou la raison du refus.
    function buildBody({ cardId, baseAmount, minutes }) {
      if (!UUID.test(String(cardId || ''))) return { ok: false, reason: 'card' };
      const text = String(baseAmount ?? '').trim();
      const base = Number(text);
      if (!text || !Number.isInteger(base) || base < 1 || base > MAX_BASE) return { ok: false, reason: 'amount' };
      if (!DURATIONS.some((d) => d.minutes === minutes)) return { ok: false, reason: 'duration' };
      return { ok: true, body: { card_id: cardId, base_amount: base, duration_minutes: minutes } };
    }

    // /api/marketplace/mine -> places restantes (null si inconnu : on laisse le serveur trancher).
    function slots(json) {
      const used = Number(json?.sellingCount);
      const max = Number(json?.maxConcurrentAuctions);
      if (!Number.isFinite(used) || !Number.isFinite(max)) return null;
      return { used, max, full: used >= max };
    }

    // Réponse de création : identifiant de la vente si on le trouve.
    function createdId(json) {
      const id = json?.auction?.id ?? json?.id;
      return UUID.test(String(id || '')) ? id : null;
    }

    return { DURATIONS, DEFAULT_MINUTES, MAX_BASE, suggestBase, buildBody, slots, createdId };
  }

  if (registry) registry.listAuctionLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
