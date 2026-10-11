(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Page « Mes ventes » : tableau de bord de tes ventes en cours (jusqu'à 5 en compte gratuit).
  // Pour chaque vente : visuel de la carte, mise de départ, prix actuel, temps restant et
  // historique des mises, sans ouvrir l'annonce. Lecture seule : aucune action sur ton compte.
  registry.mySales = {
    create(runtime) {
      const PAGE_ID = 'wm-my-sales-page';
      const NAV_ID = 'wm-my-sales-nav';
      const ROUTE_CLASS = 'wm-sales-route';
      const SETTING_KEY = 'mySales';
      const SKEW_MIN_MS = 2000;
      const NEW_BID_MS = 2 * 60 * 1000;
      const DETAIL_GAP_MS = 150;
      const REFRESH_ON_END_GAP_MS = 5000;
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      const logic = runtime.mySalesLogic;
      const bidsLogic = runtime.myBidsLogic;
      const kit = runtime.uiKit;
      const numberFormat = new Intl.NumberFormat('fr-FR');
      const formatAmount = (value) => `${numberFormat.format(value)} W`;
      const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

      const state = {
        sales: [],
        maxConcurrent: null,
        histories: new Map(), // id -> { sig, bids, error }
        sigs: new Map(),
        newUntil: new Map(),
        loaded: false,
        error: '',
        skewMs: 0,
        updatedAt: 0,
        tab: 'current', // 'current' | 'history' | 'queue'
        history: [],
        historySources: [],
        responseKeys: [],
        historyFilter: 'all', // 'all' | 'sold' | 'unsold' | 'cancelled'
        historySort: 'date' // 'date' | 'price' | 'rarity'
      };

      let running = false;
      let pollTimer = null;
      let tickTimer = null;
      let refreshing = false;
      let lastEndRefresh = 0;

      const serverNow = () => Date.now() + state.skewMs;

      const CSS = `
html.${ROUTE_CLASS} main > :not(#${PAGE_ID}) { display: none !important; }
.wm-sales-page { width: 100%; min-width: 0; color: var(--color-foreground, #fafafa); }
.wm-sales-shell { width: min(920px, 100%); margin: 0 auto; padding: 24px clamp(14px, 3vw, 28px) 48px; box-sizing: border-box; display: grid; gap: 14px; }
.wm-sales-head h1 { margin: 0; font-size: 1.5rem; font-weight: 700; }
.wm-sales-sub { margin: 2px 0 0; font-size: 0.85rem; opacity: 0.7; }
.wm-sales-sub.is-error { color: #f87171; opacity: 1; }
.wm-sales-stats { display: flex; flex-wrap: wrap; gap: 10px; }
.wm-sales-stat { padding: 8px 12px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 10px; font-size: 0.8rem; display: grid; gap: 2px; }
.wm-sales-stat strong { font-size: 1rem; font-variant-numeric: tabular-nums; }
.wm-sales-list { display: grid; gap: 12px; }
.wm-sales-empty { padding: 28px 16px; border: 1px dashed var(--color-border, rgba(255,255,255,.18)); border-radius: 12px; text-align: center; font-size: 0.9rem; opacity: 0.75; }
.wm-sales-row { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 14px; padding: 12px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; background: var(--color-surface, #111114); }
.wm-sales-row.has-bids { border-color: rgba(52, 211, 153, 0.45); }
.wm-sales-row.is-new { box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.7); }
.wm-sales-art { position: relative; width: 150px; height: 224px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; border-radius: 12px; border: 2px solid rgba(255,255,255,.18); background: #15191a; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
.wm-sales-art[data-rarity="R"] { border-color: #60a5fa; }
.wm-sales-art[data-rarity="SR"] { border-color: #c084fc; }
.wm-sales-art[data-rarity="UR"] { border-color: #f472b6; }
.wm-sales-art[data-rarity="L"] { border-color: #fbbf24; }
.wm-sales-art[data-rarity="PC"] { border-color: #94a3b8; }
.wm-sales-art.is-shiny { box-shadow: 0 0 0 1px #fde68a, 0 0 16px rgba(253,230,138,.45); }
.wm-sales-card-pic { position: relative; flex: 0 0 96px; display: grid; place-items: center; background: rgba(255,255,255,.06); font-size: 2rem; font-weight: 800; overflow: hidden; }
.wm-sales-card-pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wm-sales-card-rarity { position: absolute; top: 6px; left: 6px; }
.wm-sales-card-body { flex: 1; min-height: 0; padding: 6px 8px 2px; display: grid; gap: 2px; align-content: start; overflow: hidden; }
.wm-sales-card-title { font-size: 12px; font-weight: 800; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wm-sales-card-cat { font-size: 10px; color: #a8b3ae; }
.wm-sales-card-sum { font-size: 10px; line-height: 1.3; color: #c4ccc8; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.wm-sales-card-stats { display: flex; justify-content: space-between; padding: 4px 8px 6px; font-size: 10px; font-weight: 800; color: #e2e8f0; }
.wm-sales-main { min-width: 0; display: grid; gap: 10px; align-content: start; }
.wm-sales-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.wm-sales-title a { color: inherit; font-weight: 700; font-size: 1.02rem; text-decoration: none; overflow-wrap: anywhere; }
.wm-sales-title a:hover { text-decoration: underline; }
.wm-sales-new { padding: 2px 8px; border-radius: 999px; background: #7c3aed; color: #fff; font-size: 0.72rem; font-weight: 700; }
.wm-sales-facts { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 0.85rem; }
.wm-sales-fact { display: grid; gap: 1px; }
.wm-sales-fact > span:first-child { font-size: 0.72rem; opacity: 0.6; }
.wm-sales-fact strong { font-variant-numeric: tabular-nums; }
.wm-sales-remaining.is-urgent { color: #f87171; }
.wm-sales-history { display: grid; gap: 4px; font-size: 0.82rem; }
.wm-sales-history h3 { margin: 0; font-size: 0.78rem; font-weight: 700; opacity: 0.7; }
.wm-sales-bid { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; padding: 5px 10px; border-radius: 8px; background: rgba(255,255,255,.04); }
.wm-sales-bid.is-top { background: rgba(52, 211, 153, 0.12); }
.wm-sales-bid .wm-sales-when { opacity: 0.6; }
.wm-sales-nobid { font-size: 0.82rem; opacity: 0.65; }
.wm-sales-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--color-border, rgba(255,255,255,.12)); }
.wm-sales-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; color: inherit; opacity: .65; padding: 8px 12px; font: inherit; font-weight: 700; font-size: .9rem; cursor: pointer; }
.wm-sales-tab:hover { opacity: 1; }
.wm-sales-tab.is-active { opacity: 1; border-bottom-color: #7c3aed; }
.wm-sales-tab span { margin-left: 6px; font-size: .75rem; opacity: .7; font-variant-numeric: tabular-nums; }
.wm-hist-tools { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
.wm-hist-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wm-hist-chip { appearance: none; border: 1px solid var(--color-border, rgba(255,255,255,.16)); background: transparent; color: inherit; border-radius: 999px; padding: 4px 11px; font: inherit; font-size: .8rem; cursor: pointer; }
.wm-hist-chip.is-active { background: rgba(124,58,237,.22); border-color: #7c3aed; }
.wm-hist-chip strong { margin-left: 4px; font-variant-numeric: tabular-nums; }
.wm-hist-sort { display: flex; align-items: center; gap: 6px; font-size: .8rem; opacity: .85; }
.wm-hist-sort select { background: var(--color-surface, #111114); color: inherit; border: 1px solid var(--color-border, rgba(255,255,255,.16)); border-radius: 8px; padding: 4px 8px; font: inherit; }
.wm-hist-list { display: grid; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; overflow: hidden; }
.wm-hist-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) 96px 104px 112px; align-items: center; gap: 10px; padding: 8px 12px; font-size: .85rem; border-top: 1px solid var(--color-border, rgba(255,255,255,.08)); border-left: 3px solid transparent; }
.wm-hist-row:first-child { border-top: 0; }
.wm-hist-row:nth-child(even) { background: rgba(255,255,255,.025); }
.wm-hist-row.is-sold { border-left-color: #34d399; }
.wm-hist-row.is-unsold { border-left-color: #6b7280; }
.wm-hist-row.is-unsold .wm-hist-name, .wm-hist-row.is-cancelled .wm-hist-name { opacity: .8; }
.wm-hist-row.is-cancelled { border-left-color: #fb923c; }
.wm-hist-name { min-width: 0; display: flex; align-items: center; gap: 8px; }
.wm-hist-name a { color: inherit; font-weight: 600; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-hist-name a:hover { text-decoration: underline; }
.wm-hist-relist { flex: none; padding: 1px 7px; border-radius: 999px; background: rgba(96,165,250,.18); color: #93c5fd; font-size: .7rem; font-weight: 700; cursor: help; }
.wm-hist-price { text-align: right; font-variant-numeric: tabular-nums; display: grid; }
.wm-hist-price small { font-size: .7rem; opacity: .6; }
.wm-hist-date { font-size: .78rem; opacity: .7; font-variant-numeric: tabular-nums; text-align: right; }
.wm-hist-status { justify-self: end; padding: 3px 10px; border-radius: 999px; font-size: .74rem; font-weight: 700; white-space: nowrap; }
.wm-hist-status.is-sold { background: rgba(52,211,153,.16); color: #34d399; }
.wm-hist-status.is-unsold { background: rgba(148,163,184,.14); color: #cbd5e1; }
.wm-hist-status.is-cancelled { background: rgba(251,146,60,.16); color: #fb923c; }
.wm-hist-head { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .55; background: none !important; border-left-color: transparent !important; }
.wm-queue-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 10px 12px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; font-size: .85rem; }
.wm-queue-bar.is-paused { border-color: rgba(251,146,60,.5); }
.wm-queue-event { opacity: .75; font-size: .8rem; }
.wm-queue-btn { appearance: none; border: 1px solid var(--color-border, rgba(255,255,255,.18)); background: transparent; color: inherit; border-radius: 8px; padding: 4px 10px; font: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; }
.wm-queue-btn:hover:not(:disabled) { border-color: #7c3aed; }
.wm-queue-btn:disabled { opacity: .35; cursor: default; }
.wm-queue-btn.is-danger:hover { border-color: #f87171; color: #f87171; }
.wm-queue-row { display: grid; grid-template-columns: 26px 38px minmax(0, 1fr) 90px 60px auto; align-items: center; gap: 10px; padding: 8px 12px; font-size: .85rem; border-top: 1px solid var(--color-border, rgba(255,255,255,.08)); }
.wm-queue-row:first-child { border-top: 0; }
.wm-queue-row.is-error { background: rgba(248,113,113,.06); }
.wm-queue-pos { opacity: .55; font-variant-numeric: tabular-nums; text-align: right; }
.wm-queue-name { min-width: 0; display: grid; }
.wm-queue-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-queue-name small { font-size: .74rem; opacity: .6; }
.wm-queue-name small.is-error { color: #f87171; opacity: 1; }
.wm-queue-actions { display: flex; gap: 4px; justify-content: end; }
@media (max-width: 620px) { .wm-queue-row { grid-template-columns: 22px minmax(0, 1fr) auto; } .wm-queue-row > :nth-child(2), .wm-queue-row > :nth-child(5) { display: none; } .wm-queue-actions { grid-column: 1 / -1; } }
.wm-hist-note { font-size: .75rem; opacity: .6; margin: 0; }
@media (max-width: 620px) {
  .wm-hist-row { grid-template-columns: 34px minmax(0, 1fr) auto; row-gap: 2px; }
  .wm-hist-date { grid-column: 2; text-align: left; grid-row: 2; }
  .wm-hist-price { grid-column: 3; grid-row: 1; }
  .wm-hist-status { grid-column: 3; grid-row: 2; }
  .wm-hist-row > :first-child { grid-row: span 2; }
  .wm-hist-head { display: none; }
}
@media (max-width: 520px) { .wm-sales-row { grid-template-columns: 104px minmax(0, 1fr); } .wm-sales-art { width: 104px; height: 156px; } .wm-sales-card-pic { flex-basis: 64px; } .wm-sales-card-sum { display: none; } }
`;

      // ---- Données -----------------------------------------------------------------------------

      async function fetchSales() {
        const response = await fetch('/api/marketplace?page=1&limit=1&mine=1', {
          method: 'GET',
          credentials: 'include',
          headers: { accept: '*/*' }
        });

        if (response.status === 401 || response.status === 403) {
          throw new Error('Session expirée, reconnecte-toi à WikiMasters.');
        }
        if (!response.ok) throw new Error(`Actualisation impossible (HTTP ${response.status}).`);

        const serverTime = Date.parse(response.headers.get('date') || '');
        if (Number.isFinite(serverTime)) {
          const skew = serverTime - Date.now();
          state.skewMs = Math.abs(skew) >= SKEW_MIN_MS ? skew : 0;
        }

        const json = await response.json();
        return { sales: logic.extractSales(json), max: Number(json?.maxConcurrentAuctions) || null, json };
      }

      async function fetchBidHistory(id) {
        if (!UUID.test(id)) throw new Error('Identifiant de vente invalide.');
        const response = await fetch(`/api/marketplace/${id}`, {
          method: 'GET',
          credentials: 'include',
          headers: { accept: '*/*' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return logic.normalizeBids(await response.json());
      }

      // Relit le détail d'une vente seulement si l'état de ses mises a changé (ou jamais lu).
      async function refreshHistories() {
        const present = new Set(state.sales.map((sale) => sale.id));
        for (const id of [...state.histories.keys()]) if (!present.has(id)) state.histories.delete(id);

        for (const sale of state.sales) {
          if (!logic.hasBids(sale)) {
            state.histories.delete(sale.id);
            continue;
          }

          const sig = logic.signature(sale);
          const known = state.histories.get(sale.id);
          if (known && known.sig === sig) continue;

          try {
            state.histories.set(sale.id, { sig, bids: await fetchBidHistory(sale.id), error: false });
          } catch (_) {
            // sig = null : la lecture sera retentée au prochain relevé.
            state.histories.set(sale.id, { sig: null, bids: known?.bids || [], error: true });
          }

          if (state.tab === 'current') renderList();
          await new Promise((resolve) => setTimeout(resolve, DETAIL_GAP_MS));
        }
      }

      async function refresh() {
        if (refreshing) return;
        refreshing = true;

        try {
          const { sales, max, json } = await fetchSales();
          const history = logic.extractHistory(json);
          const historySig = history.items.map((item) => `${item.id}:${item._status}`).join('|');
          const historyChanged = historySig !== state.historySig;
          state.historySig = historySig;
          state.history = history.items;
          state.historySources = history.sources;
          state.responseKeys = json && typeof json === 'object' ? Object.keys(json) : [];
          const fresh = logic.detectNewBids(state.sigs, sales);
          const now = Date.now();
          for (const id of fresh) state.newUntil.set(id, now + NEW_BID_MS);
          state.sigs = logic.signatures(sales);

          state.sales = sales;
          state.maxConcurrent = max;
          state.loaded = true;
          const wasError = Boolean(state.error);
          state.error = '';
          state.updatedAt = now;
          if (state.tab !== 'history' || historyChanged || wasError) renderAll();
          await refreshHistories();
        } catch (error) {
          state.error = String(error?.message || error);
          state.loaded = true;
          renderAll();
        } finally {
          refreshing = false;
        }
      }

      // ---- Interface -----------------------------------------------------------------------------

      function el(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      }

      function fact(label, valueNode) {
        const wrap = el('div', 'wm-sales-fact');
        wrap.append(el('span', '', label), valueNode);
        return wrap;
      }

      function strong(text) {
        return el('strong', '', text);
      }

      // Carte complète (cadre, rareté, visuel, titre, résumé, ATK/DEF), pas seulement l'illustration.
      function buildArt(sale) {
        const card = sale.card || {};
        const rarityCode = sale.snapshot_rarity || card.rarity || '';
        const art = el('div', 'wm-sales-art');
        art.dataset.rarity = rarityCode;
        if (sale.is_shiny || card.is_shiny) art.classList.add('is-shiny');

        const picture = el('div', 'wm-sales-card-pic');
        const url = card.hide_image ? null : card.image_url;
        const placeholder = () => {
          picture.replaceChildren(document.createTextNode((card.wikipedia_title || '?').trim().charAt(0).toUpperCase() || '?'));
        };

        if (url) {
          const img = document.createElement('img');
          img.alt = card.wikipedia_title || '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', placeholder);
          img.src = url;
          picture.append(img);
        } else {
          placeholder();
        }

        const badge = kit.createRarityBadge(rarityCode);
        if (badge) { badge.classList.add('wm-sales-card-rarity'); picture.append(badge); }

        const body = el('div', 'wm-sales-card-body');
        body.append(el('div', 'wm-sales-card-title', card.wikipedia_title || 'Carte'));
        if (card.category) body.append(el('div', 'wm-sales-card-cat', card.category));
        if (card.summary) body.append(el('div', 'wm-sales-card-sum', String(card.summary).replace(/\s+/g, ' ')));

        const stats = el('div', 'wm-sales-card-stats');
        const atk = Number(sale.snapshot_atk ?? card.atk);
        const def = Number(sale.snapshot_def ?? card.def);
        if (Number.isFinite(atk)) stats.append(el('span', '', `ATK ${atk}`));
        if (Number.isFinite(def)) stats.append(el('span', '', `DEF ${def}`));

        art.append(picture, body);
        if (stats.childNodes.length) art.append(stats);
        return art;
      }

      function buildHistory(sale) {
        const wrap = el('div', 'wm-sales-history');

        if (!logic.hasBids(sale)) {
          wrap.append(el('div', 'wm-sales-nobid', 'Aucune mise pour l’instant.'));
          wrap.dataset.role = 'history-empty';
          return wrap;
        }

        const entry = state.histories.get(sale.id);
        wrap.dataset.role = 'history';
        const count = entry?.bids?.length || 0;
        wrap.append(el('h3', '', count ? `Historique des mises (${count})` : 'Historique des mises'));

        if (!entry) {
          wrap.append(el('div', 'wm-sales-nobid', 'Chargement de l’historique…'));
          return wrap;
        }

        if (entry.error && !count) {
          wrap.append(el('div', 'wm-sales-nobid', 'Historique indisponible pour le moment, nouvel essai au prochain relevé.'));
          return wrap;
        }

        const now = serverNow();
        entry.bids.forEach((bid, index) => {
          const row = el('div', `wm-sales-bid${index === 0 ? ' is-top' : ''}`);
          row.dataset.role = 'bid';
          const who = el('span', '', `${bid.bidder} — `);
          who.append(strong(formatAmount(bid.amount)));
          row.append(who, el('span', 'wm-sales-when', `${logic.formatBidAge(bid.at, now)} (${dateTimeFormat.format(bid.at)})`));
          wrap.append(row);
        });

        return wrap;
      }

      function buildRow(sale) {
        const bids = logic.hasBids(sale);
        const isNew = (state.newUntil.get(sale.id) || 0) > Date.now();
        const row = el('article', `wm-sales-row${bids ? ' has-bids' : ''}${isNew ? ' is-new' : ''}`);
        row.dataset.id = sale.id;
        row.dataset.role = 'sale';

        const main = el('div', 'wm-sales-main');
        const title = el('div', 'wm-sales-title');

        const link = document.createElement('a');
        link.href = UUID.test(sale.id) ? `/marketplace/${sale.id}` : '#';
        link.textContent = sale.card?.wikipedia_title || 'Carte';
        title.append(link);
        if (isNew) title.append(el('span', 'wm-sales-new', 'Nouvelle mise'));

        const facts = el('div', 'wm-sales-facts');
        facts.append(fact('Mise de départ', strong(formatAmount(logic.startPrice(sale) ?? 0))));

        const priceNode = kit.createPrice(formatAmount(logic.currentPrice(sale) ?? 0));
        priceNode.dataset.role = 'current-price';
        facts.append(fact(bids ? 'Prix actuel' : 'Prix actuel (aucune mise)', priceNode));

        if (bids) {
          const leader = logic.signature(sale) && (sale.current_bidder?.username || 'Anonyme');
          facts.append(fact('En tête', strong(leader)));
        }

        const remaining = strong('');
        remaining.className = 'wm-sales-remaining';
        remaining.dataset.role = 'remaining';
        remaining.dataset.end = sale.end_at || '';
        facts.append(fact('Temps restant', remaining));

        const end = Date.parse(sale.end_at);
        if (Number.isFinite(end)) facts.append(fact('Fin', strong(dateTimeFormat.format(end))));

        main.append(title, facts, buildHistory(sale));
        row.append(buildArt(sale), main);
        paintRemaining(remaining);
        return row;
      }

      function paintRemaining(node) {
        const end = Date.parse(node.dataset.end);
        const ms = Number.isFinite(end) ? end - serverNow() : 0;
        node.textContent = ms > 0 ? bidsLogic.formatRemaining(ms) : 'Terminée — règlement en cours…';
        node.classList.toggle('is-urgent', ms > 0 && ms < 60 * 1000);
      }

      function setTab(tab) {
        if (state.tab === tab) return;
        state.tab = tab;
        try { sessionStorage.setItem('wm-sales-tab', tab); } catch (_) { /* stockage indisponible */ }
        renderAll();
      }

      function buildTabs() {
        const tabs = el('div', 'wm-sales-tabs');
        tabs.setAttribute('role', 'tablist');
        const make = (id, label, count) => {
          const button = el('button', `wm-sales-tab${state.tab === id ? ' is-active' : ''}`, label);
          button.type = 'button';
          button.setAttribute('role', 'tab');
          button.setAttribute('aria-selected', String(state.tab === id));
          button.dataset.role = `tab-${id}`;
          if (state.loaded && count != null) button.append(el('span', '', String(count)));
          button.addEventListener('click', () => setTab(id));
          return button;
        };
        tabs.append(make('current', 'En cours', state.sales.length), make('history', 'Historique', state.history.length));
        const queue = queueApi();
        if (queue) tabs.append(make('queue', 'File d’attente', queue.list().items.length));
        return tabs;
      }

      const STATUS_LABELS = { sold: 'Vendue', unsold: 'Non vendue', cancelled: 'Annulée' };

      function buildHistoryControls() {
        const nodes = [];
        if (!state.loaded || (state.error && !state.history.length)) return nodes;

        const info = logic.historyStats(state.history);
        const stats = el('div', 'wm-sales-stats');
        stats.dataset.role = 'history-stats';
        const stat = (label, value) => {
          const box = el('div', 'wm-sales-stat');
          box.append(el('span', '', label), strong(value));
          return box;
        };
        stats.append(
          stat('Taux de vente', info.rate == null ? '—' : `${Math.round(info.rate * 100)} % (${info.counts.sold} / ${info.counts.sold + info.counts.unsold})`),
          stat('Total encaissé', formatAmount(info.earned)),
          stat('Prix moyen vendu', info.average == null ? '—' : formatAmount(info.average))
        );
        nodes.push(stats);

        const tools = el('div', 'wm-hist-tools');
        const chips = el('div', 'wm-hist-chips');
        for (const [id, label] of [['all', 'Toutes'], ['sold', 'Vendues'], ['unsold', 'Invendues'], ['cancelled', 'Annulées']]) {
          const chip = el('button', `wm-hist-chip${state.historyFilter === id ? ' is-active' : ''}`, label);
          chip.type = 'button';
          chip.dataset.role = `filter-${id}`;
          chip.append(strong(String(info.counts[id] ?? 0)));
          chip.addEventListener('click', () => { state.historyFilter = id; renderAll(); });
          chips.append(chip);
        }

        const sortWrap = el('label', 'wm-hist-sort', 'Trier par');
        const select = document.createElement('select');
        select.dataset.role = 'history-sort';
        for (const [id, label] of [['date', 'Date'], ['price', 'Prix'], ['rarity', 'Rareté']]) {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = label;
          option.selected = state.historySort === id;
          select.append(option);
        }
        select.addEventListener('change', () => { state.historySort = select.value; renderList(); });
        sortWrap.append(select);

        tools.append(chips, sortWrap);
        nodes.push(tools);
        return nodes;
      }

      function buildHistoryRow(item, relists) {
        const status = item._status;
        const row = el('div', `wm-hist-row is-${status}`);
        row.dataset.role = 'history-row';
        row.dataset.status = status;

        const badge = kit.createRarityBadge(logic.rarityOf(item));
        const badgeCell = el('div');
        if (badge) badgeCell.append(badge);

        const name = el('div', 'wm-hist-name');
        const link = document.createElement('a');
        link.href = UUID.test(String(item.id)) ? `/marketplace/${item.id}` : '#';
        link.textContent = item.card?.wikipedia_title || 'Carte';
        link.title = link.textContent;
        name.append(link);

        const times = relists.get(logic.cardKey(item)) || 0;
        if (times > 1) {
          const tag = el('span', 'wm-hist-relist', `×${times}`);
          tag.dataset.role = 'relist';
          tag.title = `Carte mise en vente ${times} fois dans cet historique.`;
          name.append(tag);
        }

        const price = el('div', 'wm-hist-price');
        const start = logic.startPrice(item);
        if (status === 'sold') {
          price.append(strong(formatAmount(logic.soldPrice(item) ?? start ?? 0)));
          if (start) price.append(el('small', '', `départ ${formatAmount(start)}`));
        } else {
          price.append(el('span', '', start ? formatAmount(start) : '—'), el('small', '', 'prix de départ'));
        }

        const date = el('div', 'wm-hist-date', item._endedAt ? dateTimeFormat.format(item._endedAt) : '—');
        const pill = el('span', `wm-hist-status is-${status}`, STATUS_LABELS[status] || status);

        row.append(badgeCell, name, price, date, pill);
        return row;
      }

      function renderHistoryList(list) {
        if (!state.history.length) {
          const empty = el('div', 'wm-sales-empty', state.responseKeys.length
            ? `Aucune vente terminée trouvée dans la réponse de WikiMasters (clés reçues : ${state.responseKeys.join(', ')}).`
            : 'Aucune vente terminée.');
          empty.dataset.role = 'history-empty';
          list.replaceChildren(empty);
          return;
        }

        const relists = logic.relistCounts(state.history);
        const items = logic.sortHistory(logic.filterHistory(state.history, state.historyFilter), state.historySort);
        const table = el('div', 'wm-hist-list');
        table.dataset.role = 'history-list';
        const head = el('div', 'wm-hist-row wm-hist-head');
        head.append(el('span', '', ''), el('span', '', 'Carte'), el('span', '', 'Prix'), el('span', '', 'Fin'), el('span', '', 'Statut'));
        head.children[2].style.textAlign = 'right';
        head.children[3].style.textAlign = 'right';
        head.children[4].style.justifySelf = 'end';
        table.append(head);

        if (!items.length) {
          const empty = el('div', 'wm-sales-empty', 'Aucune vente pour ce filtre.');
          empty.style.border = '0';
          table.append(empty);
        } else {
          table.append(...items.map((item) => buildHistoryRow(item, relists)));
        }
        list.replaceChildren(table);
      }

      const queueApi = () => (runtime.saleQueue?.enabled?.() ? runtime.saleQueue : null);
      const durationLabel = (minutes) =>
        runtime.listAuctionLogic?.DURATIONS?.find((d) => d.minutes === minutes)?.label || `${minutes} min`;

      function buildQueueControls() {
        const queue = queueApi();
        if (!queue) return [];
        const store = queue.list();
        const slots = queue.lastSlots();
        const bar = el('div', `wm-queue-bar${store.paused ? ' is-paused' : ''}`);
        bar.dataset.role = 'queue-bar';

        const info = el('div');
        const pending = store.items.filter((item) => !item.error).length;
        const errors = store.items.length - pending;
        info.append(strong(store.paused ? 'File en pause' : (pending ? 'File active' : 'File vide')));
        const parts = [`${pending} en attente`];
        if (errors) parts.push(`${errors} bloquée${errors > 1 ? 's' : ''}`);
        if (slots) parts.push(`places : ${slots.used} / ${slots.max}`);
        info.append(document.createTextNode(` · ${parts.join(' · ')}`));
        const event = queue.lastEvent();
        if (event) {
          info.append(el('br'));
          info.append(el('span', 'wm-queue-event', event));
        }

        const buttons = el('div', 'wm-queue-actions');
        const pause = el('button', 'wm-queue-btn', store.paused ? 'Reprendre' : 'Mettre en pause');
        pause.type = 'button';
        pause.dataset.role = 'queue-pause';
        pause.addEventListener('click', () => queue.setPaused(!store.paused));
        buttons.append(pause);
        if (store.items.length) {
          const clear = el('button', 'wm-queue-btn is-danger', 'Vider');
          clear.type = 'button';
          clear.addEventListener('click', () => {
            if (window.confirm(`Retirer les ${store.items.length} ventes de la file ?`)) queue.clear();
          });
          buttons.append(clear);
        }

        bar.append(info, buttons);
        const note = el('p', 'wm-hist-note', 'Les ventes partent dans l’ordre, au prix et pour la durée choisis, dès qu’une place se libère. Il faut qu’un onglet WikiMasters reste ouvert.');
        return [bar, note];
      }

      function renderQueueList(list) {
        const queue = queueApi();
        const items = queue ? queue.list().items : [];
        if (!items.length) {
          const empty = el('div', 'wm-sales-empty', 'Aucune vente en file. Depuis « À vendre », « Vendre… » propose la file quand tes places sont pleines.');
          empty.dataset.role = 'queue-empty';
          list.replaceChildren(empty);
          return;
        }

        const table = el('div', 'wm-hist-list');
        table.dataset.role = 'queue-list';
        let position = 0;
        items.forEach((item, index) => {
          const row = el('div', `wm-queue-row${item.error ? ' is-error' : ''}`);
          row.dataset.role = 'queue-row';
          row.append(el('span', 'wm-queue-pos', item.error ? '—' : String(++position)));

          const badgeCell = el('div');
          const badge = kit.createRarityBadge(item.rarity || '');
          if (badge) badgeCell.append(badge);
          row.append(badgeCell);

          const name = el('div', 'wm-queue-name');
          name.append(strong(item.title));
          name.lastChild.title = item.title;
          name.append(item.error
            ? el('small', 'is-error', item.error)
            : el('small', '', `ajoutée le ${dateTimeFormat.format(item.addedAt)}${item.average != null ? ` · prix moyen ${formatAmount(Math.round(item.average))}` : ''}`));
          row.append(name);

          const price = el('div', 'wm-hist-price');
          price.append(strong(formatAmount(item.baseAmount)), el('small', '', 'mise de départ'));
          row.append(price, el('span', 'wm-hist-date', durationLabel(item.durationMinutes)));

          const actions = el('div', 'wm-queue-actions');
          const btn = (label, title, onClick, disabled = false, extra = '') => {
            const b = el('button', `wm-queue-btn${extra}`, label);
            b.type = 'button';
            b.title = title;
            b.disabled = disabled;
            b.addEventListener('click', onClick);
            actions.append(b);
          };
          if (item.error) btn('Réessayer', 'Remettre en attente', () => queue.retry(item.id));
          btn('↑', 'Monter', () => queue.move(item.id, -1), index === 0);
          btn('↓', 'Descendre', () => queue.move(item.id, 1), index === items.length - 1);
          btn('Retirer', 'Retirer de la file', () => queue.remove(item.id), false, ' is-danger');
          row.append(actions);
          table.append(row);
        });
        list.replaceChildren(table);
      }

      function buildContent() {
        const nodes = [];
        const head = el('div', 'wm-sales-head');
        head.append(el('h1', '', 'Mes ventes'));
        const sub = el('p', `wm-sales-sub${state.error ? ' is-error' : ''}`);
        sub.dataset.role = 'sub';
        if (state.error) sub.textContent = state.error;
        else if (!state.loaded) sub.textContent = 'Chargement de tes ventes…';
        else if (state.tab === 'history') sub.textContent = 'Tes dernières ventes terminées (les 50 dernières conservées par WikiMasters).';
        else if (state.tab === 'queue') sub.textContent = 'Ventes planifiées : elles partent automatiquement quand une place d’enchère se libère.';
        else sub.textContent = 'Tes ventes en cours, avec le prix actuel et l’historique des mises. Actualisation automatique.';
        head.append(sub);
        nodes.push(head, buildTabs());

        if (state.tab === 'queue') {
          nodes.push(...buildQueueControls());
        } else if (state.tab === 'history') {
          nodes.push(...buildHistoryControls());
        } else if (state.loaded && !state.error || state.sales.length) {
          const info = logic.summary(state.sales);
          const total = state.sales.filter(logic.hasBids).reduce((sum, sale) => sum + (logic.currentPrice(sale) || 0), 0);
          const stats = el('div', 'wm-sales-stats');
          stats.dataset.role = 'stats';
          const stat = (label, value) => {
            const box = el('div', 'wm-sales-stat');
            box.append(el('span', '', label), strong(value));
            return box;
          };
          stats.append(
            stat('Ventes en cours', state.maxConcurrent ? `${info.total} / ${state.maxConcurrent}` : String(info.total)),
            stat('Avec des mises', String(info.withBids)),
            stat('Mises en cours (total)', formatAmount(total))
          );
          nodes.push(stats);
        }

        const list = el('div', 'wm-sales-list');
        list.dataset.role = 'list';
        nodes.push(list);
        return nodes;
      }

      function renderList() {
        const list = document.querySelector(`#${PAGE_ID} [data-role="list"]`);
        if (!list) return;

        if (!state.loaded) {
          list.replaceChildren();
          return;
        }

        if (state.tab === 'history') {
          renderHistoryList(list);
          return;
        }

        if (state.tab === 'queue') {
          renderQueueList(list);
          return;
        }

        if (!state.sales.length) {
          const empty = el('div', 'wm-sales-empty', 'Aucune vente en cours.');
          empty.dataset.role = 'empty';
          list.replaceChildren(empty);
          return;
        }

        const ordered = bidsLogic.sortBids(state.sales, serverNow());
        list.replaceChildren(...ordered.map(buildRow));
      }

      function renderAll() {
        const content = document.querySelector(`#${PAGE_ID} [data-role="page-content"]`);
        if (!content) return;
        content.replaceChildren(...buildContent());
        renderList();
      }

      // Une fois par seconde : compte à rebours seulement, sans reconstruire la liste.
      function tick() {
        for (const node of document.querySelectorAll(`#${PAGE_ID} [data-role="remaining"]`)) paintRemaining(node);

        const ended = state.sales.some((sale) => {
          const end = Date.parse(sale.end_at);
          return Number.isFinite(end) && end <= serverNow();
        });
        if (ended && Date.now() - lastEndRefresh > REFRESH_ON_END_GAP_MS) {
          lastEndRefresh = Date.now();
          refresh();
        }
      }

      function schedule() {
        clearTimeout(pollTimer);
        if (!running) return;
        const delay = logic.pollDelay({ sales: state.sales, now: serverNow(), hidden: document.hidden });
        pollTimer = setTimeout(async () => {
          await refresh();
          schedule();
        }, delay);
      }

      function onVisibility() {
        if (!document.hidden && running) refresh().then(schedule);
      }

      let queueUnsubscribe = null;
      const onQueueChange = () => { if (running && state.tab === 'queue') renderAll(); };

      function start() {
        if (running) return;
        running = true;
        if (!queueUnsubscribe && runtime.saleQueue?.onChange) queueUnsubscribe = runtime.saleQueue.onChange(onQueueChange);
        document.addEventListener('visibilitychange', onVisibility);
        tickTimer = setInterval(tick, 1000);
        refresh().then(schedule);
      }

      function stop() {
        running = false;
        queueUnsubscribe?.();
        queueUnsubscribe = null;
        clearTimeout(pollTimer);
        clearInterval(tickTimer);
        pollTimer = null;
        tickTimer = null;
        document.removeEventListener('visibilitychange', onVisibility);
      }

      // ---- Menu et route ---------------------------------------------------------------------------

      function isSalesRoute() {
        if (location.pathname !== '/marketplace') return false;
        try {
          return new URLSearchParams(location.search).get('wm') === 'sales';
        } catch (_) {
          return false;
        }
      }

      function isSalesPage() {
        return runtime.settings.isEnabled(SETTING_KEY) && isSalesRoute();
      }

      function ensureNavLink() {
        if (!runtime.settings.isEnabled(SETTING_KEY)) {
          document.getElementById(NAV_ID)?.remove();
          return;
        }

        let link = document.getElementById(NAV_ID);

        if (!link) {
          const anchor =
            document.getElementById('wm-my-bids-nav') ||
            document.querySelector('nav a[href="/marketplace"]') ||
            document.querySelector('nav a[href="/collection"]');

          if (!anchor?.parentElement) return;

          link = document.createElement('a');
          link.id = NAV_ID;
          link.href = '/marketplace?wm=sales';
          link.className = 'wm-family-nav flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200';

          const icon = document.createElement('span');
          icon.className = 'wm-family-nav-icon';
          icon.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"></path>
              <circle cx="7.5" cy="7.5" r="1.5"></circle>
            </svg>`;

          const label = document.createElement('span');
          label.textContent = 'Mes ventes';

          link.append(icon, label);
          anchor.insertAdjacentElement('afterend', link);
        }

        link.classList.toggle('is-active', isSalesPage());
        if (isSalesPage()) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }

      function ensurePage() {
        const enabled = runtime.settings.isEnabled(SETTING_KEY);

        if (!enabled && isSalesRoute()) {
          document.documentElement.classList.remove(ROUTE_CLASS);
          document.getElementById(PAGE_ID)?.remove();
          stop();
          location.replace('/marketplace');
          return;
        }

        const active = enabled && isSalesRoute();
        document.documentElement.classList.toggle(ROUTE_CLASS, active);

        if (!active) {
          stop();
          document.getElementById(PAGE_ID)?.remove();
          return;
        }

        const main = document.querySelector('main');
        if (!main) return;

        let page = document.getElementById(PAGE_ID);

        if (!page) {
          kit.ensureStyles();
          kit.injectStyles('wm-my-sales-styles', CSS);
          try {
            const wanted = new URLSearchParams(location.search).get('tab') || sessionStorage.getItem('wm-sales-tab');
            if (wanted === 'history' || (wanted === 'queue' && queueApi())) state.tab = wanted;
          } catch (_) { /* stockage indisponible */ }
          page = el('section', 'wm-sales-page');
          page.id = PAGE_ID;
          const shell = el('div', 'wm-sales-shell');
          const content = el('div');
          content.dataset.role = 'page-content';
          content.style.display = 'grid';
          content.style.gap = '14px';
          shell.append(content);
          page.append(shell);
          main.append(page);
          renderAll();
        } else if (page.parentElement !== main) {
          main.append(page);
        }

        start();
      }

      function render() {
        ensureNavLink();
        ensurePage();
      }

      return { render, isSalesPage };
    }
  };
})();
