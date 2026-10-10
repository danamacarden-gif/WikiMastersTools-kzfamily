(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Page « À vendre » : repère les cartes les plus rentables à vendre. La rentabilité se mesure par
  // rapport au prix « normal » de la rareté (médiane des cartes de même rareté) : une commune à 50 W
  // est une meilleure affaire qu'une ultra-rare à 50 W. Les données sont celles de l'extension de base
  // (collection + cache de prix, partagés avec « Charger les prix » et « Plus chères »).
  // Rien n'est vendu automatiquement : chaque vente passe par la modale « Mettre aux enchères ».
  registry.sellIdeas = {
    create(runtime) {
      const PAGE_ID = 'wm-sell-ideas-page';
      const NAV_ID = 'wm-sell-ideas-nav';
      const ROUTE_CLASS = 'wm-sell-route';
      const SETTING_KEY = 'sellIdeas';
      const SETTINGS_STORE_KEY = 'wm_sell_ideas_v1';
      const PAGE_SIZE = 50;
      const POLL_MS = 400;

      const logic = runtime.sellIdeasLogic;
      const kit = runtime.uiKit;
      const {
        ALL_COLLECTION_KEY, cardMetaById, cacheKey, storageGet, storageSet, readLocalValue, writeLocalValue
      } = runtime.core;
      const fmt = (value) => new Intl.NumberFormat('fr-FR').format(value);
      const money = (value) => runtime.priceUi?.formatAverage?.(value) ?? fmt(Math.round(value * 10) / 10);
      const ratioText = (ratio) => `×${(Math.round(ratio * 10) / 10).toString().replace('.', ',')}`;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const saved = (() => {
        const value = readLocalValue?.(SETTINGS_STORE_KEY);
        return value && typeof value === 'object' ? value : {};
      })();

      const state = {
        loading: false,
        loadText: '',
        loadRatio: 0,
        cancel: false,
        message: '',
        loadRarities: new Set(Array.isArray(saved.loadRarities) ? saved.loadRarities : ['L', 'UR', 'SR', 'R', 'PC']),
        force: false,
        filters: {
          rarities: new Set(Array.isArray(saved.rarities) ? saved.rarities : []),
          minPrice: String(saved.minPrice ?? ''),
          minRatio: String(saved.minRatio ?? ''),
          duplicatesOnly: saved.duplicatesOnly !== false,
          hideProtected: saved.hideProtected !== false,
          hideListed: saved.hideListed === true,
          sort: logic.SORTS.some((s) => s.id === saved.sort) ? saved.sort : 'profit'
        },
        shown: PAGE_SIZE,
        sellingIds: new Set(),
        data: null
      };

      function persist() {
        try {
          const f = state.filters;
          writeLocalValue?.(SETTINGS_STORE_KEY, {
            loadRarities: [...state.loadRarities], rarities: [...f.rarities], minPrice: f.minPrice,
            minRatio: f.minRatio, duplicatesOnly: f.duplicatesOnly, hideProtected: f.hideProtected,
            hideListed: f.hideListed, sort: f.sort
          });
        } catch (_) { /* confort seulement */ }
      }

      const CSS = `
html.${ROUTE_CLASS} main > :not(#${PAGE_ID}) { display: none !important; }
.wm-sell-page { width: 100%; min-width: 0; color: var(--color-foreground, #fafafa); }
.wm-sell-shell { width: min(960px, 100%); margin: 0 auto; padding: 24px clamp(14px, 3vw, 28px) 48px; box-sizing: border-box; display: grid; gap: 14px; }
.wm-sell-shell h1 { margin: 0; font-size: 1.5rem; font-weight: 700; }
.wm-sell-sub { margin: 2px 0 0; font-size: 0.85rem; opacity: 0.7; }
.wm-sell-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; background: var(--color-surface, #111114); }
.wm-sell-panel h2 { margin: 0; font-size: 0.95rem; font-weight: 700; }
.wm-sell-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.wm-sell-field { display: grid; gap: 4px; font-size: 0.8rem; }
.wm-sell-field > span:first-child { font-weight: 600; }
.wm-sell-hint { font-size: 0.78rem; opacity: 0.65; line-height: 1.4; margin: 0; }
.wm-sell-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.wm-sell-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--color-border, rgba(255,255,255,.14)); border-radius: 999px; cursor: pointer; font-size: 0.85rem; user-select: none; }
.wm-sell-chip input { margin: 0; }
.wm-sell-chip small { opacity: 0.6; }
.wm-sell-chip:has(input:checked) { border-color: #7c3aed; background: rgba(124, 58, 237, 0.18); }
.wm-sell-input { box-sizing: border-box; min-height: 36px; padding: 0 10px; border: 1px solid var(--color-border, rgba(255,255,255,.14)); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
.wm-sell-input[type="text"] { width: 110px; }
.wm-sell-input option { color: #111; }
.wm-sell-check { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; }
.wm-sell-check input { margin: 0; }
.wm-sell-btn { padding: 8px 14px; border: 1px solid var(--color-border, rgba(255,255,255,.18)); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.wm-sell-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.wm-sell-btn.is-primary { border-color: transparent; background: #7c3aed; color: #fff; }
.wm-sell-btn.is-small { padding: 4px 12px; font-size: 0.82rem; }
.wm-sell-stats { display: flex; flex-wrap: wrap; gap: 8px; font-size: 0.8rem; }
.wm-sell-stats > span { padding: 4px 10px; border: 1px solid var(--color-border, rgba(255,255,255,.1)); border-radius: 8px; }
.wm-sell-list { display: grid; gap: 6px; }
.wm-sell-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--color-border, rgba(255,255,255,.1)); border-radius: 8px; font-size: 0.85rem; }
.wm-sell-item.is-listed { opacity: 0.55; }
.wm-sell-rank { width: 2.2em; text-align: right; opacity: 0.55; font-variant-numeric: tabular-nums; }
.wm-sell-thumb { width: 34px; height: 46px; flex: none; border-radius: 4px; background: rgba(255,255,255,.06) center / cover no-repeat; }
.wm-sell-info { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
.wm-sell-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.wm-sell-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.75rem; opacity: 0.8; }
.wm-sell-price { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wm-sell-price strong { display: block; font-size: 0.95rem; }
.wm-sell-price small { opacity: 0.65; }
.wm-sell-profit { padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 0.78rem; white-space: nowrap; background: rgba(148,163,184,.18); }
.wm-sell-profit.is-good { background: rgba(52,211,153,.2); color: #34d399; }
.wm-sell-profit.is-bad { background: rgba(248,113,113,.18); color: #f87171; }
.wm-sell-tag { font-size: 0.75rem; color: #34d399; white-space: nowrap; }
.wm-sell-warn { font-size: 0.75rem; color: #fbbf24; }
.wm-sell-note { margin: 0; font-size: 0.85rem; line-height: 1.45; }
.wm-sell-note[data-kind="error"] { color: #f87171; }
.wm-sell-bar { height: 8px; border-radius: 999px; background: rgba(255,255,255,.1); overflow: hidden; }
.wm-sell-bar > div { height: 100%; width: 0; background: #7c3aed; transition: width 0.2s; }
`;

      const el = (tag, className = '', text = '') => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      };
      const button = (label, className, onClick, disabled = false) => {
        const node = el('button', `wm-sell-btn ${className}`.trim(), label);
        node.type = 'button';
        node.disabled = disabled;
        node.addEventListener('click', onClick);
        return node;
      };
      const chip = (text, checked, onChange, small = '') => {
        const label = el('label', 'wm-sell-chip');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.addEventListener('change', () => onChange(box.checked));
        label.append(box, el('span', '', text));
        if (small) label.append(el('small', '', small));
        return label;
      };
      const check = (text, checked, onChange) => {
        const label = el('label', 'wm-sell-check');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.addEventListener('change', () => onChange(box.checked));
        label.append(box, el('span', '', text));
        return label;
      };

      // ---- Données : mêmes sources que « Plus chères » ---------------------------------------

      function knownCards() {
        const entry = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
        const known = new Map();
        for (const card of Array.isArray(entry?.cards) ? entry.cards : []) {
          if (card?.id && card?.title) known.set(card.id, { ...card });
        }
        // Cartes vues pendant la session : seulement avec une preuve de possession.
        for (const card of cardMetaById?.values?.() || []) {
          if (!card?.id || !card?.title) continue;
          const owned = Boolean(card.ownedCardId) || (Array.isArray(card.ownedCardIds) && card.ownedCardIds.length > 0);
          if (!known.has(card.id) && !owned) continue;
          known.set(card.id, known.has(card.id) ? { ...known.get(card.id), ...card } : { ...card });
        }
        return { cards: [...known.values()], fetchedAt: entry?.fetchedAt || 0 };
      }

      function computeData() {
        const { cards, fetchedAt } = knownCards();
        const prices = storageGet(cards.map((card) => cacheKey(card.id)));
        const priceOf = (id, rarity) => {
          const cached = prices[cacheKey(id)];
          if (!cached || cached.ok === false) return null;
          return runtime.priceUi.chooseAverage(cached, null, rarity || null);
        };
        const family = runtime.bulkDiscard?.shared?.readFamilyContext?.().familyCardIds || new Set();
        const rows = logic.buildRows(cards, priceOf, family);
        const stats = logic.rarityStats(rows);
        state.data = { rows: logic.annotate(rows, stats), stats, fetchedAt, total: cards.length };
      }

      async function fetchSellingIds() {
        try {
          const response = await fetch('/api/marketplace?page=1&limit=1&mine=1', { credentials: 'include' });
          if (response.ok) state.sellingIds = logic.sellingCardIds(await response.json());
        } catch (_) { /* sans cette info on n'affiche simplement pas le marqueur « En vente » */ }
      }

      // Chargement identique à « Charger les prix » : collection par raretés (pont de l'extension),
      // puis prix des cartes via le chargeur partagé (cache 24 h : un prix récent n'est pas rechargé).
      function requestCollection(rarities, onProgress) {
        return new Promise((resolve, reject) => {
          const requestId = `sell:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          const onProg = (event) => {
            if (event.detail?.requestId !== requestId) return;
            onProgress(Number(event.detail.loadedPages) || 0, Number(event.detail.totalPages) || 0);
          };
          const onDone = (event) => {
            if (event.detail?.requestId !== requestId) return;
            window.removeEventListener('wm-average-all-collection-progress', onProg);
            window.removeEventListener('wm-average-all-collection', onDone);
            clearTimeout(timer);
            if (event.detail.ok) resolve(event.detail);
            else reject(new Error(event.detail.error || 'Erreur réseau'));
          };
          const timer = setTimeout(() => {
            window.removeEventListener('wm-average-all-collection-progress', onProg);
            window.removeEventListener('wm-average-all-collection', onDone);
            reject(new Error('La lecture de la collection a expiré.'));
          }, 10 * 60 * 1000);
          window.addEventListener('wm-average-all-collection-progress', onProg);
          window.addEventListener('wm-average-all-collection', onDone);
          window.dispatchEvent(new CustomEvent('wm-average-load-all-collection', {
            detail: { requestId, selectedRarities: [...rarities] }
          }));
        });
      }

      function storeCollection(detail) {
        const cards = Array.isArray(detail.cards) ? detail.cards : [];
        const fetchedAt = Date.now();
        if (detail.complete) {
          storageSet({ [ALL_COLLECTION_KEY]: { fetchedAt, cards, complete: true } });
          return cards;
        }
        // Chargement partiel : on garde tout ce que l'on connaissait déjà (comme « Charger les prix »).
        const existing = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
        const merged = new Map((Array.isArray(existing?.cards) ? existing.cards : []).map((card) => [card.id, { ...card }]));
        for (const card of cards) merged.set(card.id, merged.has(card.id) ? { ...merged.get(card.id), ...card } : { ...card });
        storageSet({ [ALL_COLLECTION_KEY]: { fetchedAt, cards: [...merged.values()], complete: existing?.complete === true } });
        return cards;
      }

      async function load() {
        if (state.loading) return;
        if (!state.loadRarities.size) { state.message = 'Choisis au moins une rareté à charger.'; render(); return; }
        state.loading = true; state.cancel = false; state.message = ''; state.loadText = 'Lecture de ta collection…'; state.loadRatio = 0;
        render();
        try {
          const detail = await requestCollection(state.loadRarities, (done, total) => {
            setLoad(`Lecture de ta collection… page ${done}${total ? ` / ${total}` : ''}`, total ? done / total : 0);
          });
          const cards = storeCollection(detail);
          const selected = cards.filter((card) => state.loadRarities.has(card.rarity));
          if (selected.length) {
            runtime.priceLoader.loadCacheForCards(selected, {
              forceRarities: state.force ? new Set(state.loadRarities) : null
            });
            for (;;) {
              const left = selected.filter((card) => runtime.priceLoader.isPending(card.id)).length;
              setLoad(`Chargement des prix… ${fmt(selected.length - left)} / ${fmt(selected.length)}`, (selected.length - left) / selected.length);
              if (!left || state.cancel) break;
              await wait(POLL_MS);
            }
          }
          if (state.cancel) state.message = 'Chargement interrompu : les prix déjà reçus sont conservés (le reste continue en arrière-plan).';
        } catch (error) {
          state.message = `Chargement interrompu : ${String(error?.message || error)}`;
        }
        state.loading = false;
        await fetchSellingIds();
        computeData();
        render();
      }

      let loadText = null;
      let loadBar = null;
      function setLoad(text, ratio) {
        state.loadText = text; state.loadRatio = ratio;
        if (loadText) loadText.textContent = text;
        if (loadBar) loadBar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
      }

      // ---- Interface ---------------------------------------------------------------------------

      function humanElapsed(timestamp) {
        const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} j`;
      }

      function buildLoadPanel() {
        const panel = el('div', 'wm-sell-panel');
        panel.dataset.role = 'sell-load';
        panel.append(el('h2', '', '1. Charger les prix'));
        const counts = {};
        for (const row of state.data?.rows || []) if (row.price != null) counts[row.rarity] = (counts[row.rarity] || 0) + 1;
        const chips = el('div', 'wm-sell-chips');
        for (const code of logic.RARITY_ORDER) {
          chips.append(chip(code, state.loadRarities.has(code), (on) => {
            if (on) state.loadRarities.add(code); else state.loadRarities.delete(code);
            persist();
          }, counts[code] ? `${fmt(counts[code])} chiffrées` : ''));
        }
        panel.append(chips);
        const row = el('div', 'wm-sell-row');
        row.append(
          button(state.loading ? 'Chargement…' : 'Charger les prix', 'is-primary', load, state.loading),
          check('Recharger même les prix récents (< 24 h)', state.force, (on) => { state.force = on; })
        );
        if (state.loading) row.append(button('Arrêter d’attendre', '', () => { state.cancel = true; }));
        panel.append(row);
        if (state.loading) {
          loadText = el('p', 'wm-sell-note', state.loadText);
          const bar = el('div', 'wm-sell-bar');
          loadBar = el('div');
          loadBar.style.width = `${Math.round(state.loadRatio * 100)}%`;
          bar.append(loadBar);
          panel.append(loadText, bar);
        }
        panel.append(el('p', 'wm-sell-hint', 'Même chargement que « Charger les prix » de la collection : les prix déjà en cache (24 h) ne sont pas redemandés. Pour comparer les communes, coche aussi C : c’est long, mais c’est ce qui révèle les communes qui se vendent bien.'));
        if (state.message) panel.append(Object.assign(el('p', 'wm-sell-note', state.message), { dataset: { kind: 'error' } }));
        return panel;
      }

      function buildFilterPanel(result) {
        const f = state.filters;
        const rerender = () => { state.shown = PAGE_SIZE; persist(); renderResults(); };
        const panel = el('div', 'wm-sell-panel');
        panel.dataset.role = 'sell-filters';
        panel.append(el('h2', '', '2. Trier et filtrer'));

        const chips = el('div', 'wm-sell-chips');
        for (const code of logic.RARITY_ORDER) {
          const stat = state.data.stats[code];
          const small = stat ? `méd. ${money(stat.median)} W · ${fmt(stat.n)}` : '';
          chips.append(chip(code, f.rarities.has(code), (on) => {
            if (on) f.rarities.add(code); else f.rarities.delete(code);
            rerender();
          }, small));
        }
        panel.append(chips, el('p', 'wm-sell-hint', 'Aucune rareté cochée = toutes. « méd. » = prix normal de la rareté dans ta collection (médiane) ; le nombre est celui des cartes chiffrées.'));

        const row = el('div', 'wm-sell-row');
        const sortField = el('label', 'wm-sell-field');
        sortField.append(el('span', '', 'Trier par'));
        const sort = el('select', 'wm-sell-input');
        sort.dataset.role = 'sell-sort';
        for (const option of logic.SORTS) {
          const node = el('option', '', option.label); node.value = option.id; sort.append(node);
        }
        sort.value = f.sort;
        sort.addEventListener('change', () => { f.sort = sort.value; rerender(); });
        sortField.append(sort);

        const priceField = el('label', 'wm-sell-field');
        priceField.append(el('span', '', 'Prix moyen mini (W)'));
        const price = el('input', 'wm-sell-input'); price.type = 'text'; price.inputMode = 'decimal'; price.value = f.minPrice; price.dataset.role = 'sell-min-price';
        price.addEventListener('input', () => { f.minPrice = price.value.replace(',', '.'); rerender(); });
        priceField.append(price);

        const ratioField = el('label', 'wm-sell-field');
        ratioField.append(el('span', '', 'Au moins × la normale'));
        const ratio = el('select', 'wm-sell-input'); ratio.dataset.role = 'sell-min-ratio';
        for (const [value, label] of [['', 'Toutes'], ['1', '≥ ×1 (au-dessus de la normale)'], ['1.5', '≥ ×1,5'], ['2', '≥ ×2'], ['3', '≥ ×3'], ['5', '≥ ×5']]) {
          const node = el('option', '', label); node.value = value; ratio.append(node);
        }
        ratio.value = f.minRatio;
        ratio.addEventListener('change', () => { f.minRatio = ratio.value; rerender(); });
        ratioField.append(ratio);
        row.append(sortField, priceField, ratioField);

        const checks = el('div', 'wm-sell-row');
        checks.append(
          check('Doublons seulement (garder 1 exemplaire)', f.duplicatesOnly, (on) => { f.duplicatesOnly = on; rerender(); }),
          check('Masquer favoris / étiquetées / familles', f.hideProtected, (on) => { f.hideProtected = on; rerender(); }),
          check('Masquer les cartes déjà en vente', f.hideListed, (on) => { f.hideListed = on; rerender(); })
        );
        panel.append(row, checks);
        return panel;
      }

      function buildRow(item, index) {
        const row = el('div', `wm-sell-item${item.listed ? ' is-listed' : ''}`);
        row.dataset.cardId = item.id;
        row.append(el('span', 'wm-sell-rank', String(index + 1)));
        const thumb = el('div', 'wm-sell-thumb');
        if (item.imageUrl) thumb.style.backgroundImage = `url("${String(item.imageUrl).replace(/"/g, '%22')}")`;
        row.append(thumb);

        const info = el('div', 'wm-sell-info');
        info.append(el('div', 'wm-sell-name', item.title));
        const meta = el('div', 'wm-sell-meta');
        const badge = kit.createRarityBadge?.(item.rarity);
        if (badge) meta.append(badge);
        meta.append(el('span', '', `${item.copies} ex.${state.filters.duplicatesOnly ? ` · ${item.sellable} vendable${item.sellable > 1 ? 's' : ''}` : ''}`));
        if (item.reference != null) meta.append(el('span', '', `normale ${item.rarity} : ${money(item.reference)} W`));
        if (item.protected) {
          const warn = el('span', 'wm-sell-warn', '⚠ protégée');
          warn.title = 'Favori, étiquette ou famille : le site choisit lui-même l’exemplaire vendu.';
          meta.append(warn);
        }
        info.append(meta);
        row.append(info);

        if (item.ratio != null) {
          const cls = item.ratio >= 1.5 ? ' is-good' : item.ratio < 0.8 ? ' is-bad' : '';
          const badgeRatio = el('span', `wm-sell-profit${cls}`, ratioText(item.ratio));
          badgeRatio.dataset.role = 'sell-ratio';
          badgeRatio.title = 'Prix moyen ÷ prix normal de la rareté';
          row.append(badgeRatio);
        }
        const price = el('div', 'wm-sell-price');
        price.append(el('strong', '', `${money(item.price)} W`));
        if (item.sellable > 1) price.append(el('small', '', `${money(item.total)} W au total`));
        row.append(price);

        if (item.listed || runtime.listAuction.isListed(item.id)) row.append(el('span', 'wm-sell-tag', 'En vente'));
        else row.append(button('Vendre…', 'is-small', () => runtime.listAuction.open({
          cardId: item.id, ownedCardId: item.ownedCardId, title: item.title, rarity: item.rarity, average: item.price
        })));
        return row;
      }

      let resultsHost = null;
      function renderResults() {
        if (!resultsHost || !state.data) return;
        const result = logic.select(state.data.rows, state.filters, state.sellingIds);
        const { items, counts, totalValue } = result;
        const nodes = [];

        const stats = el('div', 'wm-sell-stats');
        const stat = (text, role) => { const s = el('span', '', text); s.dataset.role = role; stats.append(s); };
        stat(`${fmt(items.length)} carte${items.length > 1 ? 's' : ''} proposée${items.length > 1 ? 's' : ''}`, 'sell-count');
        stat(`Valeur moyenne des exemplaires vendables : ${fmt(Math.round(totalValue))} W`, 'sell-total');
        if (counts.unpriced) stat(`${fmt(counts.unpriced)} sans prix chargé`, 'sell-unpriced');
        if (counts.protected) stat(`${fmt(counts.protected)} protégée${counts.protected > 1 ? 's' : ''} masquée${counts.protected > 1 ? 's' : ''}`, 'sell-protected');
        if (counts.singles) stat(`${fmt(counts.singles)} en un seul exemplaire`, 'sell-singles');
        nodes.push(stats);

        if (!items.length) {
          nodes.push(el('p', 'wm-sell-note', 'Rien à proposer avec ces critères. Assouplis les filtres ou charge davantage de prix.'));
        } else {
          const list = el('div', 'wm-sell-list');
          list.dataset.role = 'sell-list';
          items.slice(0, state.shown).forEach((item, i) => list.append(buildRow(item, i)));
          nodes.push(list);
          if (items.length > state.shown) {
            nodes.push(button(`Afficher plus (${fmt(items.length - state.shown)} restantes)`, '', () => { state.shown += PAGE_SIZE; renderResults(); }));
          }
        }
        nodes.push(el('p', 'wm-sell-hint', 'Le prix moyen est une indication (ventes passées), pas un prix garanti. La rentabilité compare chaque carte au prix normal de sa rareté dans ta collection ; elle est masquée quand moins de 5 cartes de la rareté ont un prix.'));
        resultsHost.replaceChildren(...nodes);
      }

      function buildContent() {
        const nodes = [];
        const head = el('div');
        head.append(el('h1', '', 'À vendre'), el('p', 'wm-sell-sub', 'Repère les cartes les plus rentables : celles qui se vendent bien plus cher que la normale de leur rareté. Rien n’est vendu automatiquement.'));
        nodes.push(head);
        if (!state.data) computeData();
        const { data } = state;
        const priced = data.rows.filter((row) => row.price != null).length;
        const summary = el('div', 'wm-sell-stats');
        const s1 = el('span', '', `${fmt(data.total)} cartes connues · ${fmt(priced)} avec un prix${data.fetchedAt ? ` · collection lue il y a ${humanElapsed(data.fetchedAt)}` : ''}`);
        s1.dataset.role = 'sell-summary';
        summary.append(s1);
        nodes.push(summary, buildLoadPanel());
        if (priced > 0) {
          nodes.push(buildFilterPanel());
          resultsHost = el('div');
          resultsHost.style.display = 'grid'; resultsHost.style.gap = '10px';
          nodes.push(resultsHost);
        } else {
          resultsHost = null;
          nodes.push(el('p', 'wm-sell-note', 'Aucun prix en cache pour l’instant : lance « Charger les prix » ci-dessus.'));
        }
        return nodes;
      }

      function render() {
        const content = document.querySelector(`#${PAGE_ID} [data-role="page-content"]`);
        if (!content) return;
        loadText = null; loadBar = null;
        content.replaceChildren(...buildContent());
        renderResults();
      }

      runtime.listAuction.onChange(() => { fetchSellingIds().then(() => renderResults()); });

      // ---- Menu et route -----------------------------------------------------------------------

      function isRoute() {
        if (location.pathname !== '/marketplace') return false;
        try { return new URLSearchParams(location.search).get('wm') === 'sell'; } catch (_) { return false; }
      }
      const isSellPage = () => runtime.settings.isEnabled(SETTING_KEY) && isRoute();

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
          link.href = '/marketplace?wm=sell';
          link.className = 'wm-family-nav flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200';
          const icon = document.createElement('span');
          icon.className = 'wm-family-nav-icon';
          icon.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
              <line x1="7" y1="7" x2="7.01" y2="7"></line>
            </svg>`;
          const label = document.createElement('span');
          label.textContent = 'À vendre';
          link.append(icon, label);
          anchor.insertAdjacentElement('afterend', link);
        }
        link.classList.toggle('is-active', isSellPage());
        if (isSellPage()) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }

      function ensurePage() {
        const enabled = runtime.settings.isEnabled(SETTING_KEY);
        if (!enabled && isRoute()) {
          document.documentElement.classList.remove(ROUTE_CLASS);
          document.getElementById(PAGE_ID)?.remove();
          location.replace('/marketplace');
          return;
        }
        const active = enabled && isRoute();
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
          kit.injectStyles('wm-sell-ideas-styles', CSS);
          page = el('section', 'wm-sell-page');
          page.id = PAGE_ID;
          const shell = el('div', 'wm-sell-shell');
          const content = el('div');
          content.dataset.role = 'page-content';
          content.style.display = 'grid';
          content.style.gap = '14px';
          shell.append(content);
          page.append(shell);
          main.append(page);
          state.data = null;
          fetchSellingIds().then(() => { if (document.getElementById(PAGE_ID) && !state.loading) renderResults(); });
          render();
        } else if (page.parentElement !== main) {
          main.append(page);
        }
      }

      function renderEntry() {
        ensureNavLink();
        ensurePage();
      }

      return { render: renderEntry, isSellPage };
    }
  };
})();
