(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Page « Défausser en masse » : choisit une rareté et une valeur de marché maximale, relit la
  // collection depuis le site, écarte automatiquement tout ce qui est protégé (favori, étiquette,
  // famille, échange en cours, shiny), montre la liste exacte, puis défausse après confirmation.
  registry.bulkDiscard = {
    create(runtime) {
      const PAGE_ID = 'wm-bulk-discard-page';
      const NAV_ID = 'wm-bulk-discard-nav';
      const ROUTE_CLASS = 'wm-discard-route';
      const SETTING_KEY = 'bulkDiscard';
      const FAMILIES_KEY = 'wm_families_v1';
      const PRICE_STORE_KEY = 'wm_discard_prices_v1';

      // Une défausse rapporte 1 W par carte.
      const GAIN_PER_DISCARD = 1;
      const MAX_COLLECTION_PAGES = 800;
      const PAGE_DELAY_MS = 100;
      const READ_CONCURRENCY = 3;
      const DISCARD_DELAY_MS = 600;
      const BULK_DELAY_MS = 500;
      // Collection lue depuis moins de 5 min : on ne la relit pas avant d'agir (la sélection vient d'être validée à l'écran).
      const FRESH_READ_MS = 5 * 60 * 1000;
      const PRICE_POLL_MS = 500;
      const PRICE_TIMEOUT_MS = 10 * 60 * 1000;

      const { readLocalValue, writeLocalValue, cacheMemory } = runtime.core;
      const logic = runtime.bulkDiscardLogic;
      const kit = runtime.uiKit;
      const numberFormat = new Intl.NumberFormat('fr-FR');
      const fmt = (value) => numberFormat.format(value);
      const plural = (n, one, many) => `${fmt(n)} ${n > 1 ? many : one}`;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Prix retenus pour cette session (cardId -> prix | null), alimentés par la mémoire locale et les chargements.
      const priceMemo = new Map();

      const state = {
        view: 'form', // form | analysing | preview | confirm | running | done | error
        form: { rarities: new Set(), maxPrice: '', limit: String(logic.DEFAULT_LIMIT), keepOne: true },
        params: null,
        plan: null,
        context: null,
        selected: new Set(),
        ack: false,
        includeUnpriced: false,
        doneIds: new Set(),
        nextPlan: null,
        progress: '',
        priceStats: { remembered: 0, fetched: 0 },
        run: { done: 0, total: 0, stop: false, dropped: 0, error: '', stopped: false },
        message: ''
      };

      const CSS = `
html.${ROUTE_CLASS} main > :not(#${PAGE_ID}) { display: none !important; }
.wm-discard-page { width: 100%; min-width: 0; color: var(--color-foreground, #fafafa); }
.wm-discard-shell { width: min(920px, 100%); margin: 0 auto; padding: 24px clamp(14px, 3vw, 28px) 48px; box-sizing: border-box; display: grid; gap: 14px; }
.wm-discard-shell h1 { margin: 0; font-size: 1.5rem; font-weight: 700; }
.wm-discard-sub { margin: 2px 0 0; font-size: 0.85rem; opacity: 0.7; }
.wm-discard-warning { padding: 10px 12px; border: 1px solid rgba(248, 113, 113, 0.5); border-radius: 10px; background: rgba(248, 113, 113, 0.08); font-size: 0.85rem; line-height: 1.45; }
.wm-discard-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; background: var(--color-surface, #111114); }
.wm-discard-field { display: grid; gap: 6px; font-size: 0.85rem; }
.wm-discard-field > span:first-child { font-weight: 600; }
.wm-discard-hint { font-size: 0.78rem; opacity: 0.65; line-height: 1.4; }
.wm-discard-rarities { display: flex; flex-wrap: wrap; gap: 8px; }
.wm-discard-rarity { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 8px; cursor: pointer; }
.wm-discard-rarity input { margin: 0; }
.wm-discard-input { box-sizing: border-box; width: 160px; min-height: 38px; padding: 0 10px; border: 1px solid var(--color-border, rgba(255,255,255,.14)); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
.wm-discard-check { display: flex; align-items: flex-start; gap: 8px; font-size: 0.85rem; line-height: 1.4; }
.wm-discard-check input { margin-top: 3px; }
.wm-discard-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.wm-discard-btn { padding: 9px 16px; border: 1px solid var(--color-border, rgba(255,255,255,.18)); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.wm-discard-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.wm-discard-btn.is-primary { border-color: transparent; background: #7c3aed; color: #fff; }
.wm-discard-btn.is-danger { border-color: transparent; background: #dc2626; color: #fff; }
.wm-discard-lines { display: grid; gap: 6px; }
.wm-discard-lines > div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--color-border, rgba(255,255,255,.1)); border-radius: 8px; font-size: 0.85rem; }
.wm-discard-lines strong { font-variant-numeric: tabular-nums; }
.wm-discard-list { display: grid; gap: 6px; max-height: 420px; overflow: auto; }
.wm-discard-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--color-border, rgba(255,255,255,.1)); border-radius: 8px; font-size: 0.85rem; }
.wm-discard-item .wm-discard-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-discard-item.is-unpriced { border-style: dashed; }
.wm-discard-unknown { font-size: 0.8rem; opacity: 0.65; white-space: nowrap; }
.wm-discard-hint[data-kind="error"] { color: #f87171; opacity: 1; }
.wm-discard-note { margin: 0; font-size: 0.85rem; line-height: 1.45; }
.wm-discard-note[data-kind="error"] { color: #f87171; }
.wm-discard-note[data-kind="success"] { color: #34d399; }
.wm-discard-bar { height: 8px; border-radius: 999px; background: rgba(255,255,255,.1); overflow: hidden; }
.wm-discard-bar > div { height: 100%; width: 0; background: #7c3aed; transition: width 0.2s; }
`;

      // ---- Données ---------------------------------------------------------------------------

      async function fetchJson(url, init = {}) {
        const response = await fetch(url, { credentials: 'include', headers: { accept: '*/*' }, ...init });
        let body = null;
        try { body = await response.json(); } catch (_) {}
        if (!response.ok) {
          const error = new Error(String(body?.error || body?.message || `HTTP ${response.status}`));
          error.status = response.status;
          throw error;
        }
        return body;
      }

      // Lecture d'UNE rareté (filtre `rarity=` du site) : la page 0 d'abord (taille de page), puis des
      // vagues de pages en parallèle. Au moindre échec on abandonne : jamais de plan sur une lecture partielle.
      async function readRarity(rarity, onCount) {
        const rows = [];
        const pending = new Set();
        const seen = new Set();
        let firstSize = 0;
        let done = false;

        const absorb = (json) => {
          const list = Array.isArray(json?.collection) ? json.collection : null;
          if (!list) throw new Error('Réponse inattendue du site pour la collection.');
          for (const id of Array.isArray(json?.pendingTradeCardIds) ? json.pendingTradeCardIds : []) pending.add(id);
          for (const row of list) {
            if (row?.id && !seen.has(row.id)) {
              seen.add(row.id);
              rows.push(row);
            }
          }
          onCount?.(rows.length);
          return list.length;
        };
        const url = (page) => `/api/my-collection?sort=rarity&rarity=${encodeURIComponent(rarity)}&page=${page}&stats=0`;

        firstSize = absorb(await fetchJson(url(0)));
        if (firstSize === 0) done = true;

        for (let page = 1; !done && page < MAX_COLLECTION_PAGES; page += READ_CONCURRENCY) {
          const pages = Array.from({ length: Math.min(READ_CONCURRENCY, MAX_COLLECTION_PAGES - page) }, (_, i) => page + i);
          const jsons = await Promise.all(pages.map((p) => fetchJson(url(p))));
          for (const json of jsons) {
            const size = absorb(json);
            if (size === 0 || size < firstSize) done = true;
          }
          if (!done) await wait(PAGE_DELAY_MS);
          if (!done && page + READ_CONCURRENCY >= MAX_COLLECTION_PAGES) throw new Error('Collection trop volumineuse pour être relue en entier.');
        }

        return { rows, pending };
      }

      // Lecture des raretés demandées, avec cache de 5 min par rareté : changer les critères ou lancer
      // une salve ne relit rien de ce qui est déjà frais. `force` (Actualiser) relit tout.
      const readCache = new Map(); // rareté -> { rows, pending, at }

      // Retire du cache de lecture les exemplaires qui ne sont plus dans la collection (défaussés, ou
      // signalés absents par le site) : sinon une analyse suivante les croirait encore là.
      function forgetRows(ids) {
        const gone = ids instanceof Set ? ids : new Set(ids);
        if (!gone.size) return;
        for (const entry of readCache.values()) entry.rows = entry.rows.filter((row) => !gone.has(row?.id));
      }

      async function loadCollection(rarities, onProgress, force = false) {
        const rows = [];
        const pending = new Set();
        const seen = new Set();
        let oldest = Date.now();
        let loaded = 0;

        for (const rarity of rarities) {
          let entry = readCache.get(rarity);
          if (force || !entry || Date.now() - entry.at >= FRESH_READ_MS) {
            const base = loaded;
            const fresh = await readRarity(rarity, (n) => onProgress?.(`Lecture de ta collection (${rarity})… ${fmt(base + n)} exemplaires`));
            entry = { ...fresh, at: Date.now() };
            readCache.set(rarity, entry);
          }
          oldest = Math.min(oldest, entry.at);
          for (const row of entry.rows) {
            if (!seen.has(row.id)) {
              seen.add(row.id);
              rows.push(row);
            }
          }
          for (const id of entry.pending) pending.add(id);
          loaded = rows.length;
        }

        return { rows, pending, at: oldest };
      }

      function readFamilyContext() {
        const stored = readLocalValue(FAMILIES_KEY);
        const families = Array.isArray(stored) ? stored.filter((item) => item?.id && Array.isArray(item.cards)) : [];
        return { familyCount: families.length, familyCardIds: logic.familyCardIds(families) };
      }

      function priceOf(cardId, rarity) {
        if (priceMemo.has(cardId)) return priceMemo.get(cardId);

        const entry = cacheMemory.get(cardId);
        if (!entry || entry.ok === false) return null;
        const value = runtime.priceUi.chooseAverage(entry, null, rarity || null);
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      }

      // Prix des cartes candidates : d'abord la mémoire locale (valable 7 jours), puis le cache de prix
      // de l'extension, puis le site pour le reste seulement. `refresh` ignore la mémoire et recharge.
      async function ensurePrices(candidates, onProgress, refresh = false) {
        const now = Date.now();
        const store = logic.normalizePriceStore(readLocalValue(PRICE_STORE_KEY));
        const todo = [];

        for (const card of candidates) {
          const known = refresh ? { hit: false } : logic.lookupPrice(store, card.cardId, now);
          if (known.hit) priceMemo.set(card.cardId, known.price);
          else {
            priceMemo.delete(card.cardId);
            todo.push(card);
          }
        }

        state.priceStats = { remembered: candidates.length - todo.length, fetched: 0 };
        if (!todo.length) return;

        const forced = refresh ? new Set(todo.map((card) => card.rarity)) : null;
        runtime.priceLoader.loadCacheForCards(
          todo.map((card) => ({ id: card.cardId, title: card.title, rarity: card.rarity })),
          forced ? { forceRarities: forced } : {}
        );
        const startedAt = Date.now();

        for (;;) {
          const left = todo.filter((card) => runtime.priceLoader.isPending(card.cardId) || !cacheMemory.has(card.cardId));
          onProgress?.(`Chargement des prix… ${fmt(todo.length - left.length)} / ${fmt(todo.length)}`, (todo.length - left.length) / todo.length);
          if (!left.length) break;
          if (Date.now() - startedAt > PRICE_TIMEOUT_MS) break; // les cartes sans prix resteront exclues
          await wait(PRICE_POLL_MS);
        }

        // On mémorise ce que le site a réellement répondu ; une erreur de chargement n'est jamais retenue.
        for (const card of todo) {
          const entry = cacheMemory.get(card.cardId);
          if (!entry || entry.ok === false || runtime.priceLoader.isPending(card.cardId)) continue;
          const value = runtime.priceUi.chooseAverage(entry, null, card.rarity || null);
          const price = typeof value === 'number' && Number.isFinite(value) ? value : null;
          priceMemo.set(card.cardId, price);
          logic.rememberPrice(store, card.cardId, price, now);
          state.priceStats.fetched += 1;
        }

        try {
          writeLocalValue(PRICE_STORE_KEY, logic.prunePriceStore(store, Date.now()));
        } catch (_) { /* quota : la mémoire locale est un confort, jamais une nécessité */ }
      }

      async function analyse(refresh = false) {
        const checked = logic.validateParams({
          rarities: [...state.form.rarities],
          maxPrice: state.form.maxPrice,
          limit: state.form.limit,
          keepOne: state.form.keepOne
        });
        if (!checked.ok) return;

        state.params = checked.params;
        state.view = 'analysing';
        state.progress = 'Lecture de ta collection…';
        state.message = '';
        render();

        try {
          const { rows, pending, at } = await loadCollection(state.params.rarities, (text) => setProgress(text), refresh === true);
          const family = readFamilyContext();
          const context = { familyCardIds: family.familyCardIds, pendingIds: pending };
          const { candidates } = logic.classify(rows, { ...context, rarities: state.params.rarities });
          await ensurePrices(candidates, (text, ratio) => setProgress(text, ratio), refresh === true);

          state.context = { ...context, familyCount: family.familyCount, rows };
          state.rowsAt = at;
          state.plan = logic.buildPlan(rows, context, state.params, priceOf);
          state.includeUnpriced = false;
          state.freshRows = null;
          state.freshContext = null;
          state.doneIds = new Set();
          state.nextPlan = null;
          state.selected = new Set(logic.nextSelection(state.plan.items, state.params.limit, false));
          state.ack = false;
          state.view = 'preview';
        } catch (error) {
          state.view = 'error';
          state.message = String(error?.message || error);
        }
        render();
      }

      async function execute() {
        state.view = 'running';
        state.run = { done: 0, total: 0, stop: false, dropped: 0, error: '', stopped: false };
        state.progress = 'Relecture de ta collection avant la défausse…';
        render();

        try {
          // Lecture récente : on réutilise ce qui vient d'être validé à l'écran (aucun rechargement).
          // Sinon la collection est relue entièrement. Dans les deux cas, les familles sont relues
          // (locales, instantanées) et le plan est recalculé et revérifié avant d'agir.
          const reuse = state.freshRows
            ? { rows: logic.withoutRows(state.freshRows, state.doneIds), pending: state.freshContext.pendingIds, at: state.freshAt }
            : state.context?.rows ? { rows: logic.withoutRows(state.context.rows, state.doneIds), pending: state.context.pendingIds, at: state.rowsAt } : null;
          const useCache = reuse && Date.now() - (reuse.at || 0) < FRESH_READ_MS;
          const loaded = useCache ? reuse : await loadCollection(state.params.rarities, (text) => setProgress(text), true);
          const { rows, pending } = loaded;
          const readAt = useCache ? reuse.at : loaded.at;
          const family = readFamilyContext();
          const context = { familyCardIds: family.familyCardIds, pendingIds: pending };
          const fresh = logic.buildPlan(rows, context, { ...state.params, limit: Number.MAX_SAFE_INTEGER }, priceOf);
          const { keep, dropped } = logic.reverify([...state.selected], fresh);

          if (keep.length > state.params.limit) throw new Error(`La sélection dépasse le lot maximum (${fmt(state.params.limit)}).`);
          state.run.dropped = dropped.length;
          state.run.total = keep.length;
          const byId = new Map(fresh.eligible.map((item) => [item.userCardId, item]));
          state.freshRows = rows;
          state.freshContext = context;
          state.freshAt = readAt;

          // 1) Cartes à exemplaire unique : appel groupé du site (bulk-discard), par lots.
          const bulkIds = keep.filter((id) => byId.get(id)?.bulk);
          const singleIds = keep.filter((id) => !byId.get(id)?.bulk);
          state.run.balance = null;

          let emptyChunks = 0;
          for (let i = 0; i < bulkIds.length && !state.run.error; i += logic.BULK_CHUNK) {
            if (state.run.stop) { state.run.stopped = true; break; }
            const chunk = bulkIds.slice(i, i + logic.BULK_CHUNK);
            const body = logic.bulkBody(chunk);
            if (!body) continue;
            setProgress(`Défausse… ${fmt(state.run.done)} / ${fmt(keep.length)}`, state.run.done / Math.max(1, keep.length));

            try {
              const result = logic.parseBulkResult(await fetchJson(logic.BULK_URL, {
                method: 'POST',
                headers: { accept: '*/*', 'content-type': 'application/json' },
                body: JSON.stringify(body)
              }), body.card_ids.length);
              state.run.done += result.discarded;
              state.run.gone = (state.run.gone || 0) + result.gone;
              if (result.balance != null) state.run.balance = result.balance;
              if (result.ok) {
                // Parties ou déjà absentes : dans les deux cas elles ne sont plus à traiter ni à garder en cache.
                for (const id of chunk) state.doneIds.add(id);
                forgetRows(chunk);
                emptyChunks = result.discarded === 0 ? emptyChunks + 1 : 0;
                if (emptyChunks >= 2) {
                  state.freshRows = null;
                  state.run.error = 'Le site n\'a défaussé aucune carte sur deux lots de suite : arrêt. Relance une analyse.';
                }
              } else {
                // Réponse incohérente : on ne sait pas lesquelles sont parties. Arrêt immédiat ;
                // la collection sera relue à la prochaine analyse.
                state.freshRows = null;
                readCache.clear();
                const refused = result.failed.map(logic.failureCode).filter((c) => c && c !== 'card_not_owned').slice(0, 3).join(' ; ');
                state.run.error = `Le site a défaussé ${fmt(result.discarded)} carte(s) sur ${fmt(body.card_ids.length)} envoyée(s)${refused ? ` (refus : ${refused})` : ''}. Arrêt : relance une analyse.`;
              }
            } catch (error) {
              state.freshRows = null;
              readCache.clear();
              state.run.error = error.status === 401 || error.status === 403
                ? 'Session expirée ou refusée : recharge la page wiki-masters puis réessaie.'
                : error.status === 429
                  ? 'Le site limite les requêtes (429) : arrêt, réessaie plus tard.'
                  : `Erreur du site : ${error.message}`;
              state.run.error += ' Relance une analyse pour savoir ce qui est parti.';
            }
            if (!state.run.error) await wait(BULK_DELAY_MS);
          }

          // 2) Exemplaires supplémentaires d'une même carte (lignes distinctes) : appel unitaire, comme avant.
          for (const id of singleIds) {
            if (state.run.error) break;
            if (state.run.stop) {
              state.run.stopped = true;
              break;
            }
            setProgress(`Défausse… ${fmt(state.run.done)} / ${fmt(keep.length)} (${byId.get(id)?.title || ''})`, state.run.done / Math.max(1, keep.length));
            const url = logic.discardUrl(id);
            if (!url) continue;

            try {
              await fetchJson(url, { method: 'POST' });
              state.run.done += 1;
              state.doneIds.add(id);
              forgetRows([id]);
            } catch (error) {
              state.run.error = error.status === 401 || error.status === 403
                ? 'Session expirée ou refusée : recharge la page wiki-masters puis réessaie.'
                : error.status === 429
                  ? 'Le site limite les requêtes (429) : arrêt, réessaie plus tard.'
                  : `Erreur du site : ${error.message}`;
              state.run.error += ` « ${byId.get(id)?.title || id} » n'a pas été défaussée.`;
              break;
            }
            await wait(DISCARD_DELAY_MS);
          }
          state.view = 'done';
        } catch (error) {
          state.view = 'error';
          state.message = String(error?.message || error);
        }
        render();
      }

      // ---- Interface -------------------------------------------------------------------------

      let progressText = null;
      let progressBar = null;

      function setProgress(text, ratio = null) {
        state.progress = text;
        if (progressText) progressText.textContent = text;
        if (progressBar && ratio != null) progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
      }

      function el(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      }

      function button(label, className, onClick, disabled = false, role = '') {
        const node = el('button', `wm-discard-btn ${className}`.trim(), label);
        node.type = 'button';
        node.disabled = disabled;
        if (role) node.dataset.role = role;
        node.addEventListener('click', onClick);
        return node;
      }

      function line(label, value, role = '') {
        const row = el('div');
        row.append(el('span', '', label), el('strong', '', fmt(value)));
        if (role) row.dataset.role = role;
        return row;
      }

      function title(text, sub) {
        const head = el('div');
        head.append(el('h1', '', text));
        if (sub) head.append(el('p', 'wm-discard-sub', sub));
        return head;
      }

      function buildForm() {
        const panel = el('div', 'wm-discard-panel');
        panel.dataset.role = 'discard-form';

        const rarityField = el('div', 'wm-discard-field');
        rarityField.append(el('span', '', 'Rareté à défausser'));
        const group = el('div', 'wm-discard-rarities');
        for (const code of logic.RARITIES) {
          const label = el('label', 'wm-discard-rarity');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.role = `rarity-${code}`;
          box.checked = state.form.rarities.has(code);
          box.addEventListener('change', () => {
            if (box.checked) state.form.rarities.add(code);
            else state.form.rarities.delete(code);
            refreshForm();
          });
          label.append(box, kit.createRarityBadge(code));
          group.append(label);
        }
        rarityField.append(group);

        const priceField = el('label', 'wm-discard-field');
        priceField.append(el('span', '', 'Valeur de revente maximale (W)'));
        const price = document.createElement('input');
        price.type = 'text';
        price.inputMode = 'decimal';
        price.className = 'wm-discard-input';
        price.dataset.role = 'max-price';
        price.value = state.form.maxPrice;
        price.addEventListener('input', () => { state.form.maxPrice = price.value; refreshForm(); });
        priceField.append(price, el('span', 'wm-discard-hint', 'Cartes dont la valeur moyenne de marché est inférieure ou égale à ce montant (inclus). Une carte sans prix connu n’est jamais défaussée.'));

        const limitField = el('label', 'wm-discard-field');
        limitField.append(el('span', '', 'Lot maximum (cartes par lancement)'));
        const limit = document.createElement('input');
        limit.type = 'text';
        limit.inputMode = 'numeric';
        limit.className = 'wm-discard-input';
        limit.dataset.role = 'limit';
        limit.value = state.form.limit;
        limit.addEventListener('input', () => { state.form.limit = limit.value; refreshForm(); });
        limitField.append(limit, el('span', 'wm-discard-hint', `De 1 à ${logic.MAX_LIMIT}. Pour un premier essai, mets 3.`));

        const keepLabel = el('label', 'wm-discard-check');
        const keep = document.createElement('input');
        keep.type = 'checkbox';
        keep.dataset.role = 'keep-one';
        keep.checked = state.form.keepOne;
        keep.addEventListener('change', () => { state.form.keepOne = keep.checked; });
        keepLabel.append(keep, el('span', '', 'Garder un exemplaire de chaque carte (ne défausser que les doublons)'));

        const go = button('Analyser', 'is-primary', () => analyse(false), true, 'analyse');
        const hint = el('p', 'wm-discard-hint', 'Ne sont jamais défaussées, automatiquement : les cartes en favori, étiquetées, présentes dans une de tes familles, engagées dans un échange, shiny ou empilées en plusieurs exemplaires.');

        const actions = el('div', 'wm-discard-actions');
        actions.append(go);
        panel.append(rarityField, priceField, limitField, keepLabel, hint, actions);
        return panel;
      }

      function refreshForm() {
        const go = document.querySelector(`#${PAGE_ID} [data-role="analyse"]`);
        if (!go) return;
        go.disabled = !logic.validateParams({
          rarities: [...state.form.rarities], maxPrice: state.form.maxPrice, limit: state.form.limit
        }).ok;
      }

      function buildPreview() {
        const { plan, context } = state;
        const wrap = el('div', 'wm-discard-panel');
        wrap.dataset.role = 'discard-preview';

        const lines = el('div', 'wm-discard-lines');
        lines.append(
          line('Exemplaires lus (raretés choisies)', context.rows.length),
          line(`Familles prises en compte (${fmt(context.familyCardIds.size)} cartes protégées)`, context.familyCount, 'families'),
          line('Cartes de cette rareté protégées : favori', plan.counts.protectedBy.starred),
          line('… étiquetées', plan.counts.protectedBy.tagged),
          line('… dans une famille', plan.counts.protectedBy.family),
          line('… dans un échange en cours', plan.counts.protectedBy.trade),
          line('… shiny', plan.counts.protectedBy.shiny),
          line('… en plusieurs exemplaires empilés (non traitées)', plan.counts.protectedBy.stack),
          line('Écartées : valeur supérieure au maximum', plan.counts.aboveMax),
          line('Sans prix connu (listées plus bas, non cochées)', plan.counts.unpriced, 'unpriced'),
          line('Prix repris de la mémoire locale / chargés à l’instant', state.priceStats.remembered, 'price-source')
        );
        lines.lastChild.lastChild.textContent = `${fmt(state.priceStats.remembered)} / ${fmt(state.priceStats.fetched)}`;
        wrap.append(lines);

        if (plan.counts.unpriced) {
          wrap.append(el('p', 'wm-discard-hint', 'Une carte sans prix connu a une valeur inconnue (aucune vente récente, ou chargement échoué : « Actualiser les prix » retente). Elles ne sont jamais cochées d’office ; la case ci-dessous les inclut dans la limite du lot.'));
        }
        if (plan.overList > 0) {
          wrap.append(el('p', 'wm-discard-note', `${plural(plan.overList, 'autre exemplaire éligible n’est pas affiché', 'autres exemplaires éligibles ne sont pas affichés')} (liste limitée à ${fmt(logic.LIST_CAP)}). Restreins les critères pour les voir.`));
        }

        if (!plan.items.length) {
          wrap.append(el('p', 'wm-discard-note', 'Aucune carte à défausser avec ces critères.'));
          const actions = el('div', 'wm-discard-actions');
          actions.append(
            button('Modifier les critères', '', () => { state.view = 'form'; render(); }),
            button('Actualiser les prix', '', () => analyse(true), false, 'refresh-prices')
          );
          wrap.append(actions);
          return wrap;
        }

        const unpricedItems = plan.items.filter((item) => item.unpriced);
        if (unpricedItems.length) {
          const masterLabel = el('label', 'wm-discard-check');
          const master = document.createElement('input');
          master.type = 'checkbox';
          master.dataset.role = 'include-unpriced';
          master.addEventListener('change', () => {
            if (master.checked) {
              // Les sans-prix entrent dans la file d'attente (après les cartes avec prix) : cette salve
              // s'en remplit dans la limite du lot, les suivantes prendront le reste.
              state.includeUnpriced = true;
              for (const id of logic.unpricedToAdd(plan.items, state.selected, state.params.limit)) state.selected.add(id);
            } else {
              state.includeUnpriced = false;
              for (const item of unpricedItems) state.selected.delete(item.userCardId);
            }
            syncRowBoxes();
            refreshFooter();
          });
          masterLabel.append(master, el('span', '', `Défausser aussi les ${plural(unpricedItems.length, 'exemplaire sans prix connu', 'exemplaires sans prix connu')} (valeur inconnue : à tes risques ; elles passent après les cartes avec prix, salve par salve)`));
          wrap.append(masterLabel);
        }

        const list = el('div', 'wm-discard-list');
        list.dataset.role = 'discard-list';
        for (const item of plan.items) {
          const row = el('label', `wm-discard-item${item.unpriced ? ' is-unpriced' : ''}`);
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = state.selected.has(item.userCardId);
          box.dataset.id = item.userCardId;
          box.addEventListener('change', () => {
            if (box.checked) state.selected.add(item.userCardId);
            else state.selected.delete(item.userCardId);
            refreshFooter();
          });
          const worth = item.unpriced
            ? el('span', 'wm-discard-unknown', 'prix inconnu')
            : kit.createPrice(`${runtime.priceUi.formatAverage(item.price)} W`);
          row.append(box, kit.createRarityBadge(item.rarity), el('span', 'wm-discard-title', item.title), worth);
          list.append(row);
        }
        wrap.append(list);
        const info = el('p', 'wm-discard-hint', '');
        info.dataset.role = 'selection-info';
        wrap.append(info);
        const total = el('p', 'wm-discard-hint', '');
        total.dataset.role = 'discard-gain-preview';
        wrap.append(total);

        if (context.familyCount === 0) {
          const ack = el('label', 'wm-discard-check');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.role = 'ack-no-family';
          box.checked = state.ack;
          box.addEventListener('change', () => { state.ack = box.checked; refreshFooter(); });
          ack.append(box, el('span', '', 'Aucune famille n’est enregistrée dans ce navigateur : aucune carte n’est protégée au titre des familles. Je confirme que c’est voulu.'));
          wrap.append(el('p', 'wm-discard-note', 'Attention : aucune famille trouvée. Si tu as des familles sur un autre navigateur ou après un nettoyage des données, leurs cartes ne sont pas protégées ici.'), ack);
        }

        const actions = el('div', 'wm-discard-actions');
        actions.append(
          button('Défausser…', 'is-danger', () => { state.view = 'confirm'; render(); }, true, 'to-confirm'),
          button('Modifier les critères', '', () => { state.view = 'form'; render(); }),
          button('Actualiser les prix', '', () => analyse(true), false, 'refresh-prices')
        );
        wrap.append(actions);
        return wrap;
      }

      function syncRowBoxes() {
        for (const box of document.querySelectorAll(`#${PAGE_ID} [data-role="discard-list"] input[data-id]`)) {
          box.checked = state.selected.has(box.dataset.id);
        }
      }

      function refreshFooter() {
        const go = document.querySelector(`#${PAGE_ID} [data-role="to-confirm"]`);
        if (!go) return;
        const n = state.selected.size;
        const limit = state.params.limit;
        go.textContent = n ? `Défausser ${plural(n, 'carte', 'cartes')}…` : 'Défausser…';

        const gain = document.querySelector(`#${PAGE_ID} [data-role="discard-gain-preview"]`);
        if (gain) gain.textContent = `Gain estimé : +${fmt(n * GAIN_PER_DISCARD)} W (${fmt(GAIN_PER_DISCARD)} W par carte défaussée).`;

        const unpricedSelected = state.plan.items.filter((item) => item.unpriced && state.selected.has(item.userCardId)).length;
        const info = document.querySelector(`#${PAGE_ID} [data-role="selection-info"]`);
        if (info) {
          const queue = logic.queueSize(state.plan, state.includeUnpriced);
          const rest = Math.max(0, queue - n);
          info.textContent = `Sélection : ${fmt(n)} / ${fmt(limit)} (lot de cette salve)${rest ? `, ${fmt(rest)} à traiter ensuite par salves` : ''}${unpricedSelected ? `, dont ${fmt(unpricedSelected)} sans prix connu` : ''}.${n > limit ? ' Trop de cartes : décoche-en ou augmente le lot dans les critères.' : ''}`;
          info.dataset.kind = n > limit ? 'error' : '';
        }

        const master = document.querySelector(`#${PAGE_ID} [data-role="include-unpriced"]`);
        if (master) {
          const all = state.plan.items.filter((item) => item.unpriced);
          const picked = all.filter((item) => state.selected.has(item.userCardId)).length;
          // La case traduit un choix (inclure les sans-prix dans la file), pas un nombre de lignes cochées.
          master.checked = state.includeUnpriced;
          master.indeterminate = false;
          void picked;
        }

        go.disabled = n === 0 || n > limit || (state.context.familyCount === 0 && !state.ack);
      }

      function buildConfirm() {
        const n = state.selected.size;
        const unpricedSelected = state.plan.items.filter((item) => item.unpriced && state.selected.has(item.userCardId)).length;
        const wrap = el('div', 'wm-discard-panel');
        wrap.dataset.role = 'discard-confirm';
        wrap.append(
          el('div', 'wm-discard-warning', `Tu es sur le point de défausser définitivement ${plural(n, 'exemplaire', 'exemplaires')}. Tu recevras ${fmt(n * GAIN_PER_DISCARD)} W (${fmt(GAIN_PER_DISCARD)} W par carte). Cette action est irréversible. Avant d’agir, ta collection est relue et tout ce qui est devenu favori, étiqueté, dans une famille ou dans un échange est retiré de la liste.`)
        );
        const rareSelected = state.plan.items.filter((item) => state.selected.has(item.userCardId) && ['L', 'UR', 'SR'].includes(item.rarity)).length;
        if (rareSelected) {
          wrap.append(el('div', 'wm-discard-warning', `Attention : ${plural(rareSelected, 'carte rare (L / UR / SR)', 'cartes rares (L / UR / SR)')} dans la sélection.`));
        }
        const readAt = state.freshRows ? state.freshAt : state.rowsAt;
        const ageMin = readAt ? Math.floor((Date.now() - readAt) / 60000) : null;
        if (ageMin != null) {
          wrap.append(el('p', 'wm-discard-note', ageMin < Math.floor(FRESH_READ_MS / 60000)
            ? `Collection lue il y a ${ageMin < 1 ? 'moins d’1 min' : `${ageMin} min`} : pas de relecture avant d’agir (les familles sont revérifiées).`
            : 'Lecture de plus de 5 min : la collection sera relue avant d’agir.'));
        }
        if (unpricedSelected) {
          wrap.append(el('div', 'wm-discard-warning', `Dont ${plural(unpricedSelected, 'carte sans prix connu', 'cartes sans prix connu')} : leur valeur est inconnue, tu peux défausser une carte qui vaut cher.`));
        }
        const actions = el('div', 'wm-discard-actions');
        const runButton = button(`Oui, défausser ${plural(n, 'carte', 'cartes')}`, 'is-danger', execute, false, 'confirm-run');
        actions.append(
          runButton,
          button('Annuler', '', () => { state.view = 'preview'; render(); }, false, 'cancel-confirm')
        );
        wrap.append(actions);
        return wrap;
      }

      function buildProgress(withStop) {
        const wrap = el('div', 'wm-discard-panel');
        wrap.dataset.role = 'discard-progress';
        progressText = el('p', 'wm-discard-note', state.progress);
        const bar = el('div', 'wm-discard-bar');
        progressBar = el('div');
        bar.append(progressBar);
        wrap.append(progressText, bar);
        if (withStop) wrap.append(button('Arrêter', '', () => { state.run.stop = true; }, false, 'stop-run'));
        return wrap;
      }

      function buildDone() {
        const { run } = state;
        const wrap = el('div', 'wm-discard-panel');
        wrap.dataset.role = 'discard-done';
        wrap.append(el('p', 'wm-discard-note', `${plural(run.done, 'carte défaussée', 'cartes défaussées')} sur ${fmt(run.total)} prévue${run.total > 1 ? 's' : ''}.`));
        const gain = el('p', 'wm-discard-note', `Gain : +${fmt(run.done * GAIN_PER_DISCARD)} W (${fmt(GAIN_PER_DISCARD)} W par carte).`);
        gain.dataset.role = 'discard-gain';
        wrap.append(gain);
        if (run.gone) wrap.append(el('p', 'wm-discard-note', `${plural(run.gone, 'carte n’était', 'cartes n’étaient')} déjà plus dans ta collection (lecture périmée) : ignorée${run.gone > 1 ? 's' : ''}.`));
        if (run.balance != null) wrap.append(el('p', 'wm-discard-note', `Solde actuel : ${fmt(run.balance)} W.`));
        if (run.dropped) wrap.append(el('p', 'wm-discard-note', `${plural(run.dropped, 'carte a été retirée', 'cartes ont été retirées')} de la liste : elles ont changé depuis l’analyse (favori, étiquette, famille, échange…).`));
        if (run.stopped) wrap.append(el('p', 'wm-discard-note', 'Arrêté à ta demande.'));
        if (run.error) {
          const failure = el('p', 'wm-discard-note', run.error);
          failure.dataset.kind = 'error';
          wrap.append(failure);
        } else if (!run.stopped) {
          wrap.firstChild.dataset.kind = 'success';
        }
        const actions = el('div', 'wm-discard-actions');

        // Salve suivante : on repart de la collection relue moins ce qui vient d'être défaussé,
        // sans refaire l'analyse ni recharger de prix. Une confirmation reste demandée.
        let nextPlan = null;
        if (!run.error && state.freshRows) {
          nextPlan = logic.buildPlan(logic.withoutRows(state.freshRows, state.doneIds), state.freshContext, state.params, priceOf);
        }
        const queue = nextPlan ? logic.queueSize(nextPlan, state.includeUnpriced) : 0;
        if (queue > 0) {
          const size = Math.min(queue, state.params.limit);
          wrap.append(el('p', 'wm-discard-note', `Il reste ${plural(queue, 'exemplaire à défausser', 'exemplaires à défausser')} avec les mêmes critères.`));
          actions.append(button(`Lot suivant (${fmt(size)})`, 'is-primary', () => {
            state.plan = nextPlan;
            state.selected = new Set(logic.nextSelection(nextPlan.items, state.params.limit, state.includeUnpriced));
            state.view = 'preview';
            render();
          }, false, 'next-batch'));
        }
        actions.append(button('Nouvelle analyse', queue > 0 ? '' : 'is-primary', () => { state.view = 'form'; render(); }, false, 'again'));
        wrap.append(actions);
        return wrap;
      }

      function buildError() {
        const wrap = el('div', 'wm-discard-panel');
        wrap.dataset.role = 'discard-error';
        const note = el('p', 'wm-discard-note', `${state.message} Rien n'a été défaussé.`);
        note.dataset.kind = 'error';
        const actions = el('div', 'wm-discard-actions');
        actions.append(button('Revenir aux critères', '', () => { state.view = 'form'; render(); }));
        wrap.append(note, actions);
        return wrap;
      }

      function buildContent() {
        const nodes = [
          title('Défausser en masse', 'Choisis une rareté et une valeur maximale ; l’extension écarte toute seule les cartes protégées.')
        ];
        nodes.push(el('div', 'wm-discard-warning', 'Action irréversible : une carte défaussée est perdue. Fais d’abord un essai avec un lot de 3 cartes. L’automatisation d’actions sur ton compte peut ne pas être permise par les CGU de WikiMasters.'));

        progressText = null;
        progressBar = null;

        if (state.view === 'form') nodes.push(buildForm());
        else if (state.view === 'analysing') nodes.push(buildProgress(false));
        else if (state.view === 'preview') nodes.push(buildPreview());
        else if (state.view === 'confirm') nodes.push(buildConfirm());
        else if (state.view === 'running') nodes.push(buildProgress(true));
        else if (state.view === 'done') nodes.push(buildDone());
        else nodes.push(buildError());

        return nodes;
      }

      function render() {
        const content = document.querySelector(`#${PAGE_ID} [data-role="page-content"]`);
        if (!content) return;
        content.replaceChildren(...buildContent());
        refreshForm();
        refreshFooter();
      }

      // ---- Menu et route -----------------------------------------------------------------------

      function isDiscardRoute() {
        if (location.pathname !== '/marketplace') return false;
        try {
          return new URLSearchParams(location.search).get('wm') === 'discard';
        } catch (_) {
          return false;
        }
      }

      function isDiscardPage() {
        return runtime.settings.isEnabled(SETTING_KEY) && isDiscardRoute();
      }

      function ensureNavLink() {
        if (!runtime.settings.isEnabled(SETTING_KEY)) {
          document.getElementById(NAV_ID)?.remove();
          return;
        }

        let link = document.getElementById(NAV_ID);

        if (!link) {
          const anchor =
            document.getElementById('wm-my-sales-nav') ||
            document.getElementById('wm-my-bids-nav') ||
            document.querySelector('nav a[href="/marketplace"]') ||
            document.querySelector('nav a[href="/collection"]');

          if (!anchor?.parentElement) return;

          link = document.createElement('a');
          link.id = NAV_ID;
          link.href = '/marketplace?wm=discard';
          link.className = 'wm-family-nav flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200';

          const icon = document.createElement('span');
          icon.className = 'wm-family-nav-icon';
          icon.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6M14 11v6"></path>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
            </svg>`;

          const label = document.createElement('span');
          label.textContent = 'Défausser';

          link.append(icon, label);
          anchor.insertAdjacentElement('afterend', link);
        }

        link.classList.toggle('is-active', isDiscardPage());
        if (isDiscardPage()) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }

      function ensurePage() {
        const enabled = runtime.settings.isEnabled(SETTING_KEY);

        if (!enabled && isDiscardRoute()) {
          document.documentElement.classList.remove(ROUTE_CLASS);
          document.getElementById(PAGE_ID)?.remove();
          location.replace('/marketplace');
          return;
        }

        const active = enabled && isDiscardRoute();
        document.documentElement.classList.toggle(ROUTE_CLASS, active);

        if (!active) {
          document.getElementById(PAGE_ID)?.remove();
          return;
        }

        const main = document.querySelector('main');
        if (!main) return;

        let page = document.getElementById(PAGE_ID);

        if (!page) {
          kit.ensureStyles();
          kit.injectStyles('wm-bulk-discard-styles', CSS);
          page = el('section', 'wm-discard-page');
          page.id = PAGE_ID;
          const shell = el('div', 'wm-discard-shell');
          const content = el('div');
          content.dataset.role = 'page-content';
          content.style.display = 'grid';
          content.style.gap = '14px';
          shell.append(content);
          page.append(shell);
          main.append(page);
          // Une opération en cours survit à un re-rendu ; sinon on repart d'un écran propre.
          if (!['running', 'analysing'].includes(state.view)) state.view = 'form';
          render();
        } else if (page.parentElement !== main) {
          main.append(page);
        }
      }

      function renderEntry() {
        ensureNavLink();
        ensurePage();
      }

      return { render: renderEntry, isDiscardPage };
    }
  };
})();
