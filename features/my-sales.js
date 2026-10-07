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
        updatedAt: 0
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
.wm-sales-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 14px; padding: 12px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; background: var(--color-surface, #111114); }
.wm-sales-row.has-bids { border-color: rgba(52, 211, 153, 0.45); }
.wm-sales-row.is-new { box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.7); }
.wm-sales-art { width: 96px; height: 134px; border-radius: 8px; background: rgba(255,255,255,.06); overflow: hidden; display: grid; place-items: center; font-size: 2rem; font-weight: 800; opacity: 0.9; }
.wm-sales-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
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
@media (max-width: 520px) { .wm-sales-row { grid-template-columns: 72px minmax(0, 1fr); } .wm-sales-art { width: 72px; height: 101px; } }
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
        return { sales: logic.extractSales(json), max: Number(json?.maxConcurrentAuctions) || null };
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

          renderList();
          await new Promise((resolve) => setTimeout(resolve, DETAIL_GAP_MS));
        }
      }

      async function refresh() {
        if (refreshing) return;
        refreshing = true;

        try {
          const { sales, max } = await fetchSales();
          const fresh = logic.detectNewBids(state.sigs, sales);
          const now = Date.now();
          for (const id of fresh) state.newUntil.set(id, now + NEW_BID_MS);
          state.sigs = logic.signatures(sales);

          state.sales = sales;
          state.maxConcurrent = max;
          state.loaded = true;
          state.error = '';
          state.updatedAt = now;
          renderAll();
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

      function buildArt(sale) {
        const art = el('div', 'wm-sales-art');
        const card = sale.card || {};
        const url = card.hide_image ? null : card.image_url;

        const placeholder = () => {
          art.replaceChildren(document.createTextNode((card.wikipedia_title || '?').trim().charAt(0).toUpperCase() || '?'));
        };

        if (url) {
          const img = document.createElement('img');
          img.alt = card.wikipedia_title || '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', placeholder);
          img.src = url;
          art.append(img);
        } else {
          placeholder();
        }

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
        const rarity = kit.createRarityBadge(sale.snapshot_rarity || sale.card?.rarity);
        if (rarity) title.append(rarity);

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

      function buildContent() {
        const nodes = [];
        const head = el('div', 'wm-sales-head');
        head.append(el('h1', '', 'Mes ventes'));
        const sub = el('p', `wm-sales-sub${state.error ? ' is-error' : ''}`);
        sub.dataset.role = 'sub';
        if (state.error) sub.textContent = state.error;
        else if (!state.loaded) sub.textContent = 'Chargement de tes ventes…';
        else sub.textContent = 'Tes ventes en cours, avec le prix actuel et l’historique des mises. Actualisation automatique.';
        head.append(sub);
        nodes.push(head);

        if (state.loaded && !state.error || state.sales.length) {
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

      function start() {
        if (running) return;
        running = true;
        document.addEventListener('visibilitychange', onVisibility);
        tickTimer = setInterval(tick, 1000);
        refresh().then(schedule);
      }

      function stop() {
        running = false;
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
