(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Page Collection : tri par prix décroissant (sur les prix déjà chargés) et bouton « Vendre » sous
  // chaque carte (modale de mise aux enchères, ou file d'attente si les places sont pleines).
  // Le tri utilise la propriété CSS `order` : on ne déplace aucun nœud du DOM de React.
  registry.collectionSell = {
    create(runtime) {
      const SETTING_KEY = 'collectionSell';
      const SORT_ID = 'wm-sort-price';
      const SORT_KEY = 'wm-collection-sort-price';
      const BTN_CLASS = 'wm-sell-card-btn';
      const CSS = `
#${SORT_ID} { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--color-border, rgba(255,255,255,.2)); background: transparent; color: inherit; font: inherit; font-size: .85rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
#${SORT_ID}.is-on { border-color: #34d399; color: #34d399; background: rgba(52,211,153,.12); }
.${BTN_CLASS} { display: block; width: calc(100% - 16px); margin: 6px 8px 8px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--color-border, rgba(255,255,255,.2)); background: rgba(0,0,0,.25); color: inherit; font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; }
.${BTN_CLASS}:hover { border-color: #34d399; color: #34d399; }`;

      const { isCollectionPage, cardMetaById, cacheMemory } = runtime.core;

      let sortOn = false;
      try { sortOn = sessionStorage.getItem(SORT_KEY) === '1'; } catch (_) { /* stockage indisponible */ }

      const enabled = () => runtime.settings.isEnabled(SETTING_KEY);

      function priceOf(card) {
        const id = card.dataset.wmCardId;
        const entry = cacheMemory.get(id);
        if (!entry || entry.ok === false) return null;
        const rarity = runtime.priceUi.getRarityFromCard(card) || cardMetaById.get(id)?.rarity || null;
        const value = runtime.priceUi.chooseAverage(entry, card, rarity);
        return Number.isFinite(value) ? value : null;
      }

      // Élément directement enfant de la grille (ou liste flex) qui contient la carte.
      function gridItem(card) {
        let node = card;
        while (node.parentElement && node.parentElement !== document.body) {
          const parent = node.parentElement;
          const display = getComputedStyle(parent).display;
          if ((display === 'grid' || display === 'flex') && parent.children.length > 1) return node;
          node = parent;
        }
        return card;
      }

      function applySort() {
        const cards = [...document.querySelectorAll('[data-wm-card-id]')];
        if (!sortOn || !enabled()) {
          for (const card of cards) {
            const item = gridItem(card);
            if (item.dataset.wmSortOrder) { item.style.order = ''; delete item.dataset.wmSortOrder; }
          }
          return;
        }
        const ranked = cards
          .map((card, index) => ({ card, index, price: priceOf(card) }))
          .sort((a, b) => {
            if (a.price == null && b.price == null) return a.index - b.index;
            if (a.price == null) return 1;
            if (b.price == null) return -1;
            return b.price - a.price || a.index - b.index;
          });
        ranked.forEach(({ card }, rank) => {
          const item = gridItem(card);
          const value = String(rank + 1);
          if (item.style.order !== value) item.style.order = value;
          item.dataset.wmSortOrder = value;
        });
      }

      function sortHost() {
        const search = document.querySelector('main input[type="search"], main input[placeholder*="echerch" i]');
        const row = search?.closest('div[class*="flex"]') || search?.parentElement?.parentElement;
        return row || document.getElementById('wm-tools-bar');
      }

      function ensureSortButton() {
        let button = document.getElementById(SORT_ID);
        const host = sortHost();
        if (!host) return;
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.id = SORT_ID;
          button.addEventListener('click', () => {
            sortOn = !sortOn;
            try { sessionStorage.setItem(SORT_KEY, sortOn ? '1' : '0'); } catch (_) { /* ignoré */ }
            refreshSortButton();
            applySort();
          });
        }
        if (button.parentElement !== host) host.append(button);
        refreshSortButton();
      }

      function refreshSortButton() {
        const button = document.getElementById(SORT_ID);
        if (!button) return;
        button.classList.toggle('is-on', sortOn);
        button.textContent = sortOn ? 'Prix ↓ (actif)' : 'Trier par prix ↓';
        button.title = 'Trie les cartes affichées par prix moyen décroissant (prix chargés uniquement : utilise « Charger les prix » avant).';
      }

      function ensureSellButton(card) {
        if (card.querySelector(`:scope > .${BTN_CLASS}`)) return;
        const id = card.dataset.wmCardId;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = BTN_CLASS;
        button.textContent = 'Vendre…';
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const meta = cardMetaById.get(id) || {};
          const average = priceOf(card);
          runtime.listAuction?.open({
            cardId: id,
            ownedCardId: null,
            title: meta.title || card.querySelector('h3')?.textContent?.trim() || 'Carte',
            rarity: runtime.priceUi.getRarityFromCard(card) || meta.rarity || '',
            average
          });
        });
        card.append(button);
      }

      function render() {
        if (!isCollectionPage() || !runtime.listAuction) return;
        if (!enabled()) {
          document.getElementById(SORT_ID)?.remove();
          document.querySelectorAll(`.${BTN_CLASS}`).forEach((node) => node.remove());
          applySort();
          return;
        }
        runtime.uiKit?.injectStyles?.('wm-collection-sell-styles', CSS);
        ensureSortButton();
        for (const card of document.querySelectorAll('[data-wm-card-id]')) ensureSellButton(card);
        applySort();
      }

      // Les prix arrivent au fil de l'eau (badges mis à jour sans que l'app ne relance un rendu) :
      // tant que le tri est actif, on le recalcule régulièrement.
      setInterval(() => { if (sortOn && isCollectionPage() && enabled()) applySort(); }, 1500);

      return { render, applySort };
    }
  };
})();
