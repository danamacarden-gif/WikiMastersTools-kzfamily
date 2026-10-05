(() => {
  const registry = window.__wmBridgeFeatures ||= {};

  registry.bridgePacks = {
    create(runtime) {
      const { originalFetch, MAX_BULK_PACKS, mapPackCards } = runtime.core;
      const LOCK_NAME = 'wm-pack-opening';
      let activeBatch = null;

      const remainingCount = (value) => value != null && value !== '' &&
        Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

      function emit(type, detail) {
        window.dispatchEvent(new CustomEvent(`wm-average-open-all-packs-${type}`, { detail }));
      }

      // Même verrou pour le site et pour les lots de l’extension, dans tous les onglets.
      async function withOpeningLock(action) {
        if (!navigator.locks?.request) {
          throw new Error('Ce navigateur ne permet pas de sécuriser les ouvertures entre onglets.');
        }
        return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) throw new Error('Une ouverture est déjà en cours dans un autre onglet.');
          return action();
        });
      }

      function wait(ms, signal) {
        if (signal.aborted) return Promise.resolve();
        return new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          signal.addEventListener('abort', done, { once: true });
        });
      }

      function cancelOpenAllPacks(requestId) {
        if (activeBatch?.requestId === requestId) activeBatch.controller.abort();
      }

      async function openAllPacks(requestId) {
        if (activeBatch) {
          // Un événement dupliqué pour le même lot ne doit pas le terminer.
          if (activeBatch.requestId !== requestId) {
            emit('result', { requestId, ok: false, openedPacks: 0, cards: [], error: 'Une ouverture est déjà en cours.' });
          }
          return;
        }
        const batch = { requestId, controller: new AbortController() };
        activeBatch = batch;
        const signal = batch.controller.signal;
        const allCards = [];
        let openedPacks = 0;
        let packsRemaining = null;
        let error = null;

        const progress = (extra) => emit('progress', {
          requestId, openedPacks, cardsCount: allCards.length, packsRemaining, ...extra
        });

        try {
          await withOpeningLock(async () => {
            for (let index = 0; index < MAX_BULK_PACKS && !signal.aborted; index += 1) {
              let json;
              let rateLimitRetries = 0;
              while (!signal.aborted) {
                // Ne jamais relancer un POST après une erreur réseau : il peut avoir réussi côté serveur.
                // L'arrêt attend la réponse du paquet en cours pour conserver ses cartes.
                const requestController = new AbortController();
                const timeout = setTimeout(() => requestController.abort(), 30000);
                let response;
                try {
                  response = await originalFetch('/api/packs/open', {
                    method: 'POST', credentials: 'include', headers: { accept: '*/*' },
                    signal: requestController.signal
                  });
                  json = await response.json();
                } catch (_) {
                  throw new Error('Réponse d’ouverture perdue. Vérifiez votre collection avant de relancer : le paquet peut avoir été consommé.');
                } finally {
                  clearTimeout(timeout);
                }

                packsRemaining = remainingCount(json?.packs_remaining);
                const cards = mapPackCards(json);
                const retryAt = Date.parse(json?.retry_after || '');
                if (!cards.length && json?.rate_limited && !json?.rate_limit_daily && Number.isFinite(retryAt)) {
                  const waitMs = Math.max(250, retryAt - Date.now() + 200);
                  if (++rateLimitRetries > 5 || waitMs > 5 * 60 * 1000) {
                    throw new Error('Ouverture suspendue : délai ou nombre de tentatives du serveur dépassé.');
                  }
                  progress({ waiting: true, retryAfter: json.retry_after, waitMs });
                  await wait(waitMs, signal);
                  continue;
                }

                if (!response.ok || json?.rate_limit_daily) {
                  // Zéro paquet restant est une fin normale, sauf limitation quotidienne.
                  if (response.status === 400 && packsRemaining === 0 && !json?.rate_limit_daily) return;
                  throw new Error(json?.error || json?.message ||
                    (json?.rate_limit_daily ? 'Limite quotidienne atteinte.' : `HTTP ${response.status}`));
                }
                if (!cards.length) throw new Error('Le paquet ouvert ne contient aucune carte reconnue. Vérifiez votre collection.');

                openedPacks += 1;
                allCards.push(...cards);
                progress({ waiting: false, cards });
                break;
              }
              if (signal.aborted || packsRemaining === 0) break;
              const waitMs = Math.round(500 + Math.random() * 1500);
              progress({ waiting: true, extraDelay: true, waitMs });
              await wait(waitMs, signal);
            }
          });
        } catch (caught) {
          error = String(caught?.message || caught);
        } finally {
          activeBatch = null;
          emit('result', {
            requestId, ok: error == null, cancelled: signal.aborted,
            openedPacks, cards: allCards, packsRemaining, error
          });
        }
      }

      window.addEventListener('wm-average-cancel-open-all-packs', (event) => {
        cancelOpenAllPacks(event.detail?.requestId);
      });

      return { openAllPacks, cancelOpenAllPacks, withOpeningLock };
    }
  };
})();
