(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  // Auto-enchère (page « Mes enchères ») : à TRIGGER_MS de la fin, si on n'est pas en tête,
  // on mise le minimum requis, et on recommence après chaque surenchère — au plus `maxBids`
  // fois et jamais au-dessus du prix max. Tout est ici en logique pure (aucun réseau, aucun DOM).
  const TRIGGER_MS = 16 * 1000;
  const COOLDOWN_MS = 1500;
  const MAX_FAILURES = 3;
  const MAX_BIDS_CAP = 10;
  const DEFAULT_MAX_BIDS = 3;
  const CONFIG_TTL_MS = 7 * 24 * 3600 * 1000;

  const STOP_MESSAGES = {
    ended: 'Enchère terminée.',
    'max-reached': 'Prix max atteint : l’enchère a dépassé ton plafond.',
    'bids-exhausted': 'Nombre maximum de mises atteint.',
    'insufficient-balance': 'Solde insuffisant.',
    errors: 'Arrêtée après plusieurs échecs de mise.'
  };

  function create() {
    // Valide la saisie. `nextAmount` = mise minimale actuelle.
    function validateConfig(input, nextAmount) {
      const max = Number(String(input?.max ?? '').trim());
      const maxBids = Number(String(input?.maxBids ?? '').trim());

      if (!Number.isInteger(max) || max <= 0) return { ok: false, reason: 'invalid-max' };
      if (Number.isFinite(nextAmount) && max < nextAmount) return { ok: false, reason: 'max-too-low' };
      if (!Number.isInteger(maxBids) || maxBids < 1 || maxBids > MAX_BIDS_CAP) {
        return { ok: false, reason: 'invalid-bids' };
      }

      return {
        ok: true,
        config: { max, maxBids, armed: true, placed: 0, failures: 0, stopReason: null, updatedAt: 0 }
      };
    }

    // `remainingMs` : temps restant (horloge corrigée de la dérive serveur). `leading` : on mène.
    // `nextAmount` : mise minimale. `balance` : solde connu ou null.
    function decide({ config, remainingMs, leading, nextAmount, balance = null, now = 0, lastAttemptAt = 0 }) {
      if (!config || !config.armed) return { action: 'idle' };
      if (!(remainingMs > 0)) return { action: 'stop', reason: 'ended' };
      if (remainingMs > TRIGGER_MS) return { action: 'wait', reason: 'early' };
      if (leading) return { action: 'wait', reason: 'leading' };
      if ((config.placed || 0) >= config.maxBids) return { action: 'stop', reason: 'bids-exhausted' };
      if ((config.failures || 0) >= MAX_FAILURES) return { action: 'stop', reason: 'errors' };
      if (!Number.isFinite(nextAmount) || nextAmount <= 0) return { action: 'wait', reason: 'unknown-price' };
      if (nextAmount > config.max) return { action: 'stop', reason: 'max-reached' };
      if (Number.isFinite(balance) && nextAmount > balance) return { action: 'stop', reason: 'insufficient-balance' };
      if (lastAttemptAt && now - lastAttemptAt < COOLDOWN_MS) return { action: 'wait', reason: 'cooldown' };

      return { action: 'bid', amount: nextAmount };
    }

    const afterBidSuccess = (config) => ({ ...config, placed: (config.placed || 0) + 1, failures: 0 });
    const afterBidFailure = (config) => ({ ...config, failures: (config.failures || 0) + 1 });
    const disarm = (config, reason) => ({ ...config, armed: false, stopReason: reason || null });

    // Relit le stockage : écarte tout ce qui est invalide ou trop ancien.
    function normalizeStore(raw, now = Date.now()) {
      const out = {};
      if (!raw || typeof raw !== 'object') return out;

      for (const [id, value] of Object.entries(raw)) {
        const max = Number(value?.max);
        const maxBids = Number(value?.maxBids);
        if (!id || !Number.isInteger(max) || max <= 0) continue;
        if (!Number.isInteger(maxBids) || maxBids < 1 || maxBids > MAX_BIDS_CAP) continue;
        if (now - Number(value.updatedAt || 0) > CONFIG_TTL_MS) continue;

        out[id] = {
          max,
          maxBids,
          armed: value.armed === true,
          placed: Math.max(0, Math.floor(Number(value.placed) || 0)),
          failures: Math.max(0, Math.floor(Number(value.failures) || 0)),
          stopReason: typeof value.stopReason === 'string' ? value.stopReason : null,
          updatedAt: Number(value.updatedAt) || now
        };
      }

      return out;
    }

    return {
      TRIGGER_MS,
      COOLDOWN_MS,
      MAX_FAILURES,
      MAX_BIDS_CAP,
      DEFAULT_MAX_BIDS,
      STOP_MESSAGES,
      validateConfig,
      decide,
      afterBidSuccess,
      afterBidFailure,
      disarm,
      normalizeStore
    };
  }

  if (registry) registry.autoBidLogic = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
