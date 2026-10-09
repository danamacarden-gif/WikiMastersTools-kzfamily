(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Page « À vendre » : classe les cartes de ta collection par valeur de marché décroissante pour
  // repérer ce qui vaut la peine d'être vendu. Rien n'est vendu automatiquement : chaque vente passe
  // par la modale « Mettre aux enchères », où tu fixes toi-même la mise et la durée.
  registry.sellIdeas = {
    create(runtime) {
      const PAGE_ID = 'wm-sell-ideas-page';
      const NAV_ID = 'wm-sell-ideas-nav';
      const ROUTE_CLASS = 'wm-sell-route';
      const SETTING_KEY = 'sellIdeas';

      const logic = runtime.sellIdeasLogic;
      const kit = runtime.uiKit;
      const fmt = (value) => new Intl.NumberFormat('fr-FR').format(value);
      const price = (value) => runtime.priceUi?.formatAverage?.(value) ?? fmt(Math.round(value));

      const state = {
        view: 'form', // form | analysing | result | error
        form: { rarities: new Set(logic.DEFAULT_RARITIES), minPrice: String(logic.DEFAULT_MIN_PRICE), keepOne: true },
        result: null,
        progress: '',
        message: ''
      };

      const CSS = `
html.${ROUTE_CLASS} main > :not(#${PAGE_ID}) { display: none !important; }
.wm-sell-page { width: 100%; min-width: 0; color: var(--color-foreground, #fafafa); }
.wm-sell-shell { width: min(920px, 100%); margin: 0 auto; padding: 24px clamp(14px, 3vw, 28px) 48px; box-sizing: border-box; display: grid; gap: 14px; }
.wm-sell-shell h1 { margin: 0; font-size: 1.5rem; font-weight: 700; }
.wm-sell-sub { margin: 2px 0 0; font-size: 0.85rem; opacity: 0.7; }
.wm-sell-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 12px; background: var(--color-surface, #111114); }
.wm-sell-field { display: grid; gap: 6px; font-size: 0.85rem; }
.wm-sell-field > span:first-child { font-weight: 600; }
.wm-sell-hint { font-size: 0.78rem; opacity: 0.65; line-height: 1.4; }
.wm-sell-rarities { display: flex; flex-wrap: wrap; gap: 8px; }
.wm-sell-rarity { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 8px; cursor: pointer; }
.wm-sell-rarity input, .wm-sell-check input { margin: 0; }
.wm-sell-input { box-sizing: border-box; width: 160px; min-height: 38px; padding: 0 10px; border: 1px solid var(--color-border, rgba(255,255,255,.14)); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
.wm-sell-check { display: flex; align-items: flex-start; gap: 8px; font-size: 0.85rem; line-height: 1.4; }
.wm-sell-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.wm-sell-btn { padding: 9px 16px; border: 1px solid var(--color-border, rgba(255,255,255,.18)); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.wm-sell-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.wm-sell-btn.is-primary { border-color: transparent; background: #7c3aed; color: #fff; }
.wm-sell-btn.is-small { padding: 5px 12px; font-size: 0.82rem; }
.wm-sell-lines { display: grid; gap: 6px; }
.wm-sell-lines > div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--color-border, rgba(255,255,255,.1)); border-radius: 8px; font-size: 0.85rem; }
.wm-sell-lines strong { font-variant-numeric: tabular-nums; }
.wm-sell-list { display: grid; gap: 6px; }
.wm-sell-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--color-border, rgba(255,255,255,.1)); border-radius: 8px; font-size: 0.85rem; }
.wm-sell-item.is-listed { opacity: 0.55; }
.wm-sell-rank { width: 2.2em; text-align: right; opacity: 0.55; font-variant-numeric: tabular-nums; }
.wm-sell-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-sell-price { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.wm-sell-copies { font-size: 0.78rem; opacity: 0.7; white-space: nowrap; }
.wm-sell-tag { font-size: 0.75rem; color: #34d399; white-space: nowrap; }
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
      const head = (text, sub) => {
        const box = el('div');
        box.append(el('h1', '', text));
        if (sub) box.append(el('p', 'wm-sell-sub', sub));
        return box;
      };

      let progressText = null;
      let progressBar = null;
      function setProgress(text, ratio = null) {
        state.progress = text;
        if (progressText) progressText.textContent = text;
        if (progressBar && ratio != null) progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
      }

      async function fetchSellingIds() {
        try {
          const response = await fetch('/api/marketplace?page=1&limit=1&mine=1', { credentials: 'include' });
          if (!response.ok) return new Set();
          return logic.sellingCardIds(await response.json());
        } catch (_) {
          return new Set(); // sans cette info on n'affiche simplement pas le marqueur « en vente »
        }
      }

      async function analyse(refresh = false) {
        const checked = logic.validateParams({
          rarities: [...state.form.rarities], minPrice: state.form.minPrice, keepOne: state.form.keepOne
        });
        if (!checked.ok) {
          state.message = checked.reason === 'no-rarity' ? 'Choisis au moins une rareté.' : 'Prix minimum invalide.';
          render();
          return;
        }

        const shared = runtime.bulkDiscard.shared;
        state.params = checked.params;
        state.view = 'analysing';
        state.message = '';
        setProgress('Lecture de ta collection…', 0);
        render();

        try {
          const { rows, pending } = await shared.loadCollection(checked.params.rarities, (text) => setProgress(text), refresh);
          const context = { familyCardIds: shared.readFamilyContext().familyCardIds, pendingIds: pending };
          const { candidates } = runtime.bulkDiscardLogic.classify(rows, { ...context, rarities: checked.params.rarities });
          // Seules les cartes qui peuvent réellement être vendues (doublon ou « garder 1 » désactivé) ont besoin d'un prix.
          const needPrice = candidates.filter((card) => (checked.params.keepOne ? card.copies.length > 1 : true));
          await shared.ensurePrices(needPrice, (text, ratio) => setProgress(text, ratio), refresh);
          setProgress('Classement…', 1);
          const selling = await fetchSellingIds();
          state.result = logic.rank(rows, context, checked.params, shared.priceOf, selling);
          state.view = 'result';
        } catch (error) {
          state.view = 'error';
          state.message = String(error?.message || error);
        }
        render();
      }

      function buildForm() {
        const panel = el('div', 'wm-sell-panel');
        panel.dataset.role = 'sell-form';

        const rarityField = el('div', 'wm-sell-field');
        rarityField.append(el('span', '', 'Raretés à examiner'));
        const group = el('div', 'wm-sell-rarities');
        for (const code of runtime.bulkDiscardLogic.RARITIES) {
          const label = el('label', 'wm-sell-rarity');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = code;
          box.checked = state.form.rarities.has(code);
          box.addEventListener('change', () => {
            if (box.checked) state.form.rarities.add(code); else state.form.rarities.delete(code);
          });
          label.append(box, el('span', '', code));
          group.append(label);
        }
        rarityField.append(group, el('span', 'wm-sell-hint', 'Plus tu coches de raretés, plus il y a de prix à charger (le résultat est ensuite mémorisé 7 jours).'));

        const priceField = el('label', 'wm-sell-field');
        priceField.append(el('span', '', 'Valeur moyenne minimale (W)'));
        const input = el('input', 'wm-sell-input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.value = state.form.minPrice;
        input.addEventListener('input', () => { state.form.minPrice = input.value; });
        priceField.append(input);

        const keep = el('label', 'wm-sell-check');
        const keepBox = document.createElement('input');
        keepBox.type = 'checkbox';
        keepBox.checked = state.form.keepOne;
        keepBox.addEventListener('change', () => { state.form.keepOne = keepBox.checked; });
        keep.append(keepBox, el('span', '', 'Garder au moins un exemplaire de chaque carte (ne proposer que les doublons)'));

        const note = el('p', 'wm-sell-hint', 'Sont exclues d’office : favoris, cartes étiquetées, shiny, cartes de tes familles, échanges en cours et exemplaires empilés. Le prix moyen est une indication, pas un prix garanti.');
        const actions = el('div', 'wm-sell-actions');
        actions.append(button('Trouver quoi vendre', 'is-primary', () => analyse(false)));
        panel.append(rarityField, priceField, keep, note, actions);
        if (state.message) panel.append(Object.assign(el('p', 'wm-sell-note', state.message), { dataset: { kind: 'error' } }));
        return panel;
      }

      function buildProgress() {
        const panel = el('div', 'wm-sell-panel');
        panel.dataset.role = 'sell-progress';
        progressText = el('p', 'wm-sell-note', state.progress);
        const bar = el('div', 'wm-sell-bar');
        progressBar = el('div');
        bar.append(progressBar);
        panel.append(progressText, bar);
        return panel;
      }

      function buildRow(item, index) {
        const row = el('div', `wm-sell-item${item.listed ? ' is-listed' : ''}`);
        row.dataset.cardId = item.cardId;
        row.append(el('span', 'wm-sell-rank', String(index + 1)));
        const badge = kit.createRarityBadge?.(item.rarity);
        if (badge) row.append(badge);
        row.append(el('span', 'wm-sell-name', item.title || 'Carte'));
        row.append(el('span', 'wm-sell-copies', `${item.copies} ex.`));
        row.append(el('span', 'wm-sell-price', `${price(item.price)} W`));
        if (item.listed || runtime.listAuction.isListed(item.cardId)) {
          row.append(el('span', 'wm-sell-tag', 'En vente'));
        } else {
          row.append(button('Vendre…', 'is-small', () => runtime.listAuction.open({
            cardId: item.cardId, title: item.title, rarity: item.rarity, average: item.price
          })));
        }
        return row;
      }

      function buildResult() {
        const { items, counts, totalValue } = state.result;
        const nodes = [];
        const lines = el('div', 'wm-sell-lines');
        const add = (label, value, role) => {
          const row = el('div');
          row.dataset.role = role;
          row.append(el('span', '', label), el('strong', '', fmt(value)));
          lines.append(row);
        };
        add('Cartes proposées', items.length + counts.hidden, 'sell-count');
        add('Valeur moyenne des exemplaires vendables (hors déjà en vente)', Math.round(totalValue), 'sell-total');
        add('Exclues : protégées', counts.protected, 'sell-protected');
        add('Exclues : sans prix connu', counts.unpriced, 'sell-unpriced');
        add('Exclues : sous le minimum', counts.belowMin, 'sell-below');
        if (state.form.keepOne) add('Exclues : un seul exemplaire', counts.singles, 'sell-singles');
        nodes.push(lines);

        if (!items.length) {
          nodes.push(el('p', 'wm-sell-note', 'Rien à proposer avec ces critères.'));
        } else {
          const list = el('div', 'wm-sell-list');
          list.dataset.role = 'sell-list';
          items.forEach((item, i) => list.append(buildRow(item, i)));
          nodes.push(list);
          if (counts.hidden) nodes.push(el('p', 'wm-sell-hint', `${fmt(counts.hidden)} carte(s) de moindre valeur non affichée(s) : relève le minimum pour les voir.`));
        }

        const actions = el('div', 'wm-sell-actions');
        actions.append(button('Modifier les critères', '', () => { state.view = 'form'; render(); }),
          button('Actualiser les prix', '', () => analyse(true)));
        nodes.push(actions);
        return nodes;
      }

      function buildContent() {
        const sub = 'Tes cartes classées par valeur de marché : tu choisis lesquelles mettre aux enchères, rien n’est vendu automatiquement.';
        const nodes = [head('À vendre', sub)];
        if (state.view === 'analysing') nodes.push(buildProgress());
        else if (state.view === 'result' && state.result) nodes.push(...buildResult());
        else if (state.view === 'error') {
          nodes.push(Object.assign(el('p', 'wm-sell-note', `Analyse interrompue : ${state.message}`), { dataset: { kind: 'error' } }));
          nodes.push(button('Retour', '', () => { state.view = 'form'; state.message = ''; render(); }));
        } else nodes.push(buildForm());
        return nodes;
      }

      function render() {
        const content = document.querySelector(`#${PAGE_ID} [data-role="page-content"]`);
        if (!content) return;
        content.replaceChildren(...buildContent());
      }

      runtime.listAuction.onChange(() => { if (state.view === 'result') render(); });

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
          if (state.view !== 'analysing') state.view = 'form';
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
