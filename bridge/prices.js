(() => {
  const registry = window.__wmBridgeFeatures ||= {};

  registry.bridgePrices = {
    create(runtime) {
      const { originalFetch } = runtime.core;

      window.addEventListener('wm-average-request', async (event) => {
        const { id, requestId } = event.detail || {};
        if (!id || !requestId) return;

        let lastError = null;
        let lastRetryAfterMs = 60000;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            const response = await originalFetch(
              `/api/marketplace/cards/${encodeURIComponent(id)}/sales?scope=summary`,
              {
                signal: controller.signal,
                method: 'GET',
                credentials: 'include',
                headers: { accept: '*/*' }
              }
            );

            if (!response.ok) {
              const retryable = response.status === 429 || response.status >= 500;
              const header = response.headers.get('Retry-After');
              const seconds = Number(header);
              const delay = header == null ? 0 : (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now());
              lastRetryAfterMs = Math.max(60000, Math.min(300000, delay || 0));
              lastError = new Error(`HTTP ${response.status}`);

              if (!retryable || attempt >= 3) {
                throw lastError;
              }
            } else {
              const json = await response.json();
              if (!json?.summary || typeof json.summary !== 'object' || Array.isArray(json.summary)) {
                throw new Error('Résumé des ventes invalide');
              }
              const averages = {};

              if (json?.summary && typeof json.summary === 'object') {
                for (const [rarity, value] of Object.entries(json.summary)) {
                  if (value && ['L', 'UR', 'SR', 'R', 'PC', 'C'].includes(rarity) &&
                      (typeof value.average === 'number' || (typeof value.average === 'string' && value.average.trim() !== '')) &&
                      Number.isFinite(Number(value.average)) && Number(value.average) >= 0) {
                    averages[rarity] = Number(value.average);
                  }
                }
              }

              window.dispatchEvent(new CustomEvent('wm-average-response', {
                detail: {
                  requestId,
                  id,
                  ok: true,
                  title: json?.wikipedia_title || null,
                  averages
                }
              }));
              return;
            }
          } catch (error) {
            lastError = error;

            const statusMatch = String(error?.message || '').match(/HTTP\s+(\d+)/);
            const status = statusMatch ? Number(statusMatch[1]) : null;
            const retryable = status == null || (status >= 500 && status <= 599);

            if (!retryable || attempt >= 3) {
              break;
            }
          } finally {
            clearTimeout(timeout);
          }

          // Une limitation du serveur est mise en cache, sans rafale de nouvelles requêtes.
          if (String(lastError?.message).includes('HTTP 429')) break;
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }

        window.dispatchEvent(new CustomEvent('wm-average-response', {
          detail: {
            requestId,
            id,
            ok: false,
            retryAfterMs: lastRetryAfterMs,
            rateLimited: String(lastError?.message).includes('HTTP 429'),
            error: String(lastError?.message || lastError || 'Erreur réseau')
          }
        }));
      });


      return {};
    }
  };
})();
