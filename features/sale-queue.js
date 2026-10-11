(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Moteur de la file de ventes. Tourne dans tout onglet WikiMasters ouvert (un seul à la fois,
  // grâce à un verrou partagé) : relit les places d'enchères et lance la vente suivante dès
  // qu'une place se libère, avec le prix et la durée choisis à la mise en file.
  registry.saleQueue = {
    create(runtime) {
      const STORE_KEY = 'wm_sale_queue_v1';
      const LOCK_KEY = 'wm_sale_queue_lock_v1';
      const SETTING_KEY = 'saleQueue';
      const LOCK_MS = 45 * 1000;
      const IDLE_MS = 20 * 1000;
      const AFTER_LIST_MS = 4 * 1000;
      const RETRY_MS = 60 * 1000;

      const logic = runtime.saleQueueLogic;
      const { readLocalValue, writeLocalValue } = runtime.core;
      const owner = `tab:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const listeners = new Set();

      let timer = null;
      let working = false;
      let retryAfter = 0;
      let lastSlots = null;
      let lastEvent = '';

      const read = () => logic.normalizeStore(readLocalValue(STORE_KEY));
      const enabled = () => true; // toujours actif : la pause se règle dans l’onglet File d’attente

      function write(store) {
        writeLocalValue(STORE_KEY, store);
        notify();
      }

      // Statut seul (places, dernier événement) : rafraîchit la page Mes ventes.
      function notifyStatus() {
        for (const cb of listeners) { try { cb(); } catch (_) { /* ignoré */ } }
      }

      // Contenu de la file modifié : prévient aussi les autres pages (À vendre).
      function notify() {
        notifyStatus();
        window.dispatchEvent(new CustomEvent('wm-sale-queue-change'));
      }

      function newId() {
        return `sq:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
      }

      // ---- API pour l'interface ------------------------------------------------------------------

      function add(input) {
        const result = logic.enqueue(read(), input, { id: newId(), now: Date.now() });
        if (!result.ok) return result;
        write(result.store);
        schedule(1000);
        return { ok: true };
      }

      const api = {
        enabled,
        list: () => read(),
        lastSlots: () => lastSlots,
        lastEvent: () => lastEvent,
        add,
        remove(id) { write(logic.remove(read(), id)); },
        move(id, delta) { write(logic.move(read(), id, delta)); },
        retry(id) { write(logic.retry(read(), id)); retryAfter = 0; schedule(500); },
        setPaused(paused) { write({ ...read(), paused: Boolean(paused) }); if (!paused) schedule(500); },
        clear() { write(logic.emptyStore()); },
        isQueued(catalogueCardId) { return logic.queuedCardIds(read()).has(catalogueCardId); },
        onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
      };

      // ---- Moteur --------------------------------------------------------------------------------

      function takeLock() {
        const now = Date.now();
        if (!logic.canHoldLock(readLocalValue(LOCK_KEY), owner, now)) return false;
        writeLocalValue(LOCK_KEY, { owner, until: now + LOCK_MS });
        // Relecture : si deux onglets ont écrit en même temps, un seul garde le verrou.
        return readLocalValue(LOCK_KEY)?.owner === owner;
      }

      function releaseLock() {
        if (readLocalValue(LOCK_KEY)?.owner === owner) writeLocalValue(LOCK_KEY, null);
      }

      async function fetchSlots() {
        const response = await fetch('/api/marketplace/mine', { credentials: 'include', headers: { accept: '*/*' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return runtime.listAuctionLogic.slots(await response.json());
      }

      function schedule(delay = IDLE_MS) {
        clearTimeout(timer);
        timer = setTimeout(step, delay);
      }

      async function step() {
        if (working) return;
        const store = read();
        if (!enabled() || store.paused || !logic.pending(store).length) {
          releaseLock();
          schedule(IDLE_MS);
          return;
        }
        if (Date.now() < retryAfter || !takeLock()) {
          schedule(IDLE_MS);
          return;
        }

        working = true;
        let delay = IDLE_MS;
        try {
          lastSlots = await fetchSlots().catch(() => null);
          // Relecture après le réseau : la file a pu changer dans un autre onglet.
          const decision = logic.next(read(), lastSlots);
          if (decision.action !== 'list') {
            notifyStatus();
            return;
          }

          const item = decision.item;
          lastEvent = `Mise en vente de « ${item.title} »…`;
          notifyStatus();

          const result = await runtime.listAuction.createListing({
            catalogueCardId: item.catalogueCardId,
            ownedCardId: null,
            title: item.title,
            baseAmount: item.baseAmount,
            durationMinutes: item.durationMinutes,
            allowStarred: false
          });

          const out = logic.outcome(item, result);
          const current = read();
          if (out.kind === 'done') {
            write(logic.remove(current, item.id));
            runtime.listAuction.markListed?.(item.catalogueCardId);
            lastEvent = `« ${item.title} » mise en vente à ${item.baseAmount} W.`;
            delay = AFTER_LIST_MS;
          } else if (out.kind === 'error') {
            write(logic.update(current, item.id, { error: out.error, attempts: out.attempts ?? item.attempts }));
            lastEvent = `« ${item.title} » bloquée : ${out.error}`;
            delay = AFTER_LIST_MS;
          } else if (out.kind === 'retry') {
            write(logic.update(current, item.id, { attempts: out.attempts }));
            retryAfter = Date.now() + RETRY_MS;
            lastEvent = `Échec temporaire pour « ${item.title} », nouvel essai dans 1 min.`;
          } else {
            lastEvent = 'Places d’enchères pleines, en attente.';
          }
          notifyStatus();
        } catch (error) {
          lastEvent = `File de ventes : ${String(error?.message || error)}`;
          notifyStatus();
        } finally {
          working = false;
          if (read().paused || !logic.pending(read()).length) releaseLock();
          else writeLocalValue(LOCK_KEY, { owner, until: Date.now() + LOCK_MS });
          schedule(delay);
        }
      }

      // Une modification de la file dans un autre onglet met l'interface à jour ici.
      window.addEventListener('storage', (event) => {
        if (event.key === STORE_KEY) notify();
      });
      window.addEventListener('pagehide', releaseLock);

      schedule(3000);
      return api;
    }
  };
})();
