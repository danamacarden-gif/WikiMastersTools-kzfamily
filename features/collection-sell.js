(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Page Collection : tri par prix décroissant (sur les prix déjà chargés) et bouton « Vendre » sous
  // chaque carte (modale de mise aux enchères, ou file d'attente si les places sont pleines) et bouton
  // « Défausser » (un exemplaire, avec confirmation ; cartes protégées refusées).
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
.wm-sell-card-actions { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 5; display: flex; gap: 6px; }
.wm-sell-card-actions > button { flex: 1 1 0; min-width: 0; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--color-border, rgba(255,255,255,.2)); background: rgba(0,0,0,.25); color: inherit; font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; }
.wm-sell-card-actions > button:hover { border-color: #34d399; color: #34d399; }
.wm-sell-card-actions > .wm-discard-card-btn:hover { border-color: #f87171; color: #f87171; }
.wm-sell-card-actions > button:disabled { opacity: .5; cursor: default; }`;

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

      function discardCard(card, button) {
        const id = card.dataset.wmCardId;
        const meta = cardMetaById.get(id) || {};
        const title = meta.title || card.querySelector('h3')?.textContent?.trim() || 'cette carte';
        const ids = (Array.isArray(meta.ownedCardIds) ? meta.ownedCardIds : []).filter(Boolean);
        if (!ids.length) { window.alert('Exemplaire inconnu : recharge la page Collection puis réessaie.'); return; }
        const family = runtime.bulkDiscard?.shared?.readFamilyContext?.().familyCardIds;
        if (meta.starred === true || (Array.isArray(meta.tags) && meta.tags.length) || family?.has?.(id)) {
          window.alert(`« ${title} » est protégée (favori, étiquette ou famille) : elle n’est pas défaussée ici. Retire la protection d’abord.`);
          return;
        }
        const url = runtime.bulkDiscardLogic?.discardUrl?.(ids[ids.length - 1]);
        if (!url) { window.alert('Identifiant d’exemplaire invalide.'); return; }
        const count = Math.max(1, Number(meta.count) || ids.length);
        const rest = count > 1 ? `Il t’en restera ${count - 1}.` : 'C’est ton dernier exemplaire : la carte quitte ta collection.';
        if (!window.confirm(`Défausser 1 exemplaire de « ${title} » ? ${rest} Action irréversible.`)) return;
        button.disabled = true; button.textContent = 'Défausse…';
        fetch(url, { method: 'POST', credentials: 'include', headers: { accept: '*/*' } })
          .then(async (response) => {
            if (!response.ok) {
              let message = `HTTP ${response.status}`;
              try { const body = await response.json(); message = String(body?.error || body?.message || message); } catch (_) { /* ignoré */ }
              throw new Error(message);
            }
            meta.ownedCardIds = ids.slice(0, -1);
            meta.count = count - 1;
            button.textContent = 'Défaussée ✓';
          })
          .catch((error) => {
            button.disabled = false; button.textContent = 'Défausser';
            window.alert(`Défausse impossible : ${error.message}`);
          });
      }

      function ensureSellButton(card) {
        if (card.querySelector(`:scope > .wm-sell-card-actions`)) return;
        const id = card.dataset.wmCardId;
        const actions = document.createElement('div');
        actions.className = 'wm-sell-card-actions';
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
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'wm-discard-card-btn';
        discard.textContent = 'Défausser';
        discard.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); discardCard(card, discard); });
        actions.append(button, discard);
        card.append(actions);
      }

      function render() {
        if (!isCollectionPage() || !runtime.listAuction) return;
        if (!enabled()) {
          document.getElementById(SORT_ID)?.remove();
          document.querySelectorAll('.wm-sell-card-actions').forEach((node) => node.remove());
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
