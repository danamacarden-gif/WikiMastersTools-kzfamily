(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.ranking = {
    create(runtime) {
      const {
        ALL_COLLECTION_KEY, cardMetaById, cacheMemory, cacheKey,
        storageGet, storageSet, mergeTags
      } = runtime.core;
      const { formatAverage, chooseAverage } = runtime.priceUi;
      const pendingMarketplaceListings = new Map();
      const pendingBridgeRequests = new Map();

      // Requête au bridge résolue par l'événement de réponse portant le même requestId.
      function requestBridge(eventName, detail = {}, timeoutMs = 12000) {
        return new Promise((resolve) => {
          const requestId = `${eventName}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

          const timeout = setTimeout(() => {
            const pending = pendingBridgeRequests.get(requestId);
            if (!pending) return;

            pendingBridgeRequests.delete(requestId);
            resolve({
              requestId,
              ok: false,
              timeout: true,
              error: 'La requête a expiré.'
            });
          }, timeoutMs);

          pendingBridgeRequests.set(requestId, { resolve, timeout });
          window.dispatchEvent(new CustomEvent(eventName, {
            detail: { ...detail, requestId }
          }));
        });
      }

      function resolveBridgeRequest(event) {
        const detail = event.detail || {};
        const pending = pendingBridgeRequests.get(detail.requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        pendingBridgeRequests.delete(detail.requestId);
        pending.resolve(detail);
      }

      window.addEventListener('wm-average-tag-cards', resolveBridgeRequest);
      window.addEventListener('wm-average-starred-cards', resolveBridgeRequest);
      window.addEventListener('wm-average-tag-options', resolveBridgeRequest);

      function humanElapsed(timestamp) {
        const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remaining = minutes % 60;
        return remaining ? `${hours} h ${remaining} min` : `${hours} h`;
      }

      function requestListing({ button, row, amount, duration, ownedCardId, allowStarred = false }) {
        const requestId = `listing:${row.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        button.disabled = true;
        button.dataset.state = 'pending';
        button.textContent = ownedCardId ? 'Mise en vente…' : 'Recherche ID…';

        pendingMarketplaceListings.set(requestId, { button, row, amount, duration });

        window.dispatchEvent(new CustomEvent('wm-average-create-listing', {
          detail: {
            requestId,
            ownedCardId,
            catalogueCardId: row.id,
            title: row.title,
            baseAmount: amount,
            durationMinutes: duration,
            allowStarred
          }
        }));
      }

      // Les cartes vues pendant la session ne décrivent parfois qu'un seul exemplaire d'un doublon :
      // elles ne doivent pas faire perdre ce que le chargement complet connaît des autres copies.
      function mergeKnownCard(stored, seen) {
        const merged = { ...stored, ...seen };
        const storedCopies = Array.isArray(stored.ownedCardIds) ? stored.ownedCardIds : [];
        if (storedCopies.length <= 1) return merged;

        merged.ownedCardIds = [...new Set([
          ...storedCopies,
          ...(Array.isArray(seen.ownedCardIds) ? seen.ownedCardIds : [])
        ])];
        merged.count = Math.max(stored.count || 1, seen.count || 1, merged.ownedCardIds.length);
        merged.starred = Boolean(stored.starred || seen.starred);
        merged.tags = mergeTags(stored.tags, seen.tags);

        return merged;
      }

      async function openRankingModal() {
        const storedCollection = storageGet(ALL_COLLECTION_KEY);
        const collectionEntry = storedCollection[ALL_COLLECTION_KEY];
        const storedCards = Array.isArray(collectionEntry?.cards) ? collectionEntry.cards : [];

        // Merge persisted metadata with cards already discovered during this page session.
        // This lets the ranking work even before a full bulk collection load.
        const knownCards = new Map();

        for (const card of storedCards) {
          if (card?.id && card?.title) knownCards.set(card.id, { ...card });
        }

        for (const card of cardMetaById.values()) {
          if (!card?.id || !card?.title) continue;

          const previous = knownCards.get(card.id);
          const hasOwnershipEvidence =
            Boolean(card.ownedCardId) ||
            (Array.isArray(card.ownedCardIds) && card.ownedCardIds.length > 0);

          // cardMetaById is shared by several features (collection, marketplace,
          // packs, trades...). A marketplace card viewed during the session must
          // never become a collection candidate just because its price was cached.
          // Existing persisted collection cards are still allowed to absorb fresher
          // metadata, while new session-only cards need proof that they are owned.
          if (!previous && !hasOwnershipEvidence) continue;

          knownCards.set(card.id, previous ? mergeKnownCard(previous, card) : { ...card });
        }

        const candidates = [...knownCards.values()];

        if (!candidates.length) {
          runtime.modalUi.showInfoModal(
            'Aucun prix chargé',
            'Aucune carte avec métadonnées n’est encore disponible. Parcourez votre collection ou utilisez « Charger les prix », puis réessayez.'
          );
          return;
        }

        const priceKeys = candidates.map((card) => cacheKey(card.id));
        const prices = storageGet(priceKeys);

        const rows = candidates
          .map((card) => {
            const entry = prices[cacheKey(card.id)];

            // Errors are not useful in a "most expensive" ranking.
            if (!entry || entry.ok === false) return null;

            const average = chooseAverage(entry, null, card.rarity || null);

            return {
              ...card,
              average,
              fetchedAt: Number(entry?.fetchedAt) || 0
            };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
            const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
            if (bPrice !== aPrice) return bPrice - aPrice;
            return a.title.localeCompare(b.title, 'fr');
          });

        if (!rows.length) {
          runtime.modalUi.showInfoModal(
            'Aucun prix chargé',
            'Aucun prix n’est encore présent dans le cache. Parcourez votre collection ou utilisez « Charger les prix », puis réessayez.'
          );
          return;
        }

        // Cartes connues sans prix en cache : hors classement, mais utiles aux filtres
        // favoris / étiquettes pour ne pas donner un résultat incomplet.
        const rankedIds = new Set(rows.map((row) => row.id));
        const unpricedRows = candidates
          .filter((card) => (
            !rankedIds.has(card.id) &&
            (card.starred || (Array.isArray(card.tags) && card.tags.length > 0))
          ))
          .map((card) => ({ ...card, average: Number.NaN, fetchedAt: 0 }))
          .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

        const isComplete =
          collectionEntry?.complete === true &&
          rows.length >= candidates.length;

        renderRankingModal(
          rows,
          collectionEntry?.fetchedAt || 0,
          {
            incomplete: !isComplete,
            unpricedRows,
            knownCards: candidates.length,
            cachedCards: rows.length
          }
        );
      }

      function renderRankingModal(rows, collectionFetchedAt, status = {}) {
        const salesEnabled = runtime.settings.isEnabled('rankingSales');
        const overlay = document.createElement('div');
        overlay.className = 'wm-modal-overlay wm-ranking-overlay';

        const modal = document.createElement('div');
        modal.className = `wm-modal wm-ranking-modal ${salesEnabled ? 'wm-ranking-sales-enabled' : 'wm-ranking-sales-disabled'}`;

        const header = document.createElement('div');
        header.className = 'wm-ranking-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = 'Cartes les plus chères';

        const subtitle = document.createElement('p');
        const pricedCount = rows.filter((row) => Number.isFinite(row.average)).length;
        subtitle.textContent = `${rows.length} cartes du cache • ${pricedCount} avec un prix moyen${collectionFetchedAt ? ` • données collection il y a ${humanElapsed(collectionFetchedAt)}` : ''}`;

        headingWrap.append(title, subtitle);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'wm-ranking-close';
        closeButton.setAttribute('aria-label', 'Fermer');
        closeButton.textContent = '×';

        header.append(headingWrap, closeButton);

        let cacheNotice = null;
        if (status.incomplete) {
          cacheNotice = document.createElement('div');
          cacheNotice.className = 'wm-ranking-cache-notice';

          const noticeTitle = document.createElement('strong');
          noticeTitle.textContent = 'Classement partiel';

          const noticeText = document.createElement('span');
          noticeText.textContent =
            'Vous n’avez pas chargé tous les prix : seules les cartes actuellement disponibles dans votre cache sont affichées ici.';

          cacheNotice.append(noticeTitle, noticeText);
        }

        const saleControls = document.createElement('div');
        saleControls.className = 'wm-ranking-sale-controls';

        const priceField = document.createElement('label');
        priceField.className = 'wm-ranking-sale-field';

        const priceLabel = document.createElement('span');
        priceLabel.textContent = 'Prix de mise en vente';

        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '1';
        priceInput.step = '1';
        priceInput.value = '10';
        priceInput.inputMode = 'decimal';

        priceField.append(priceLabel, priceInput);

        const durationField = document.createElement('label');
        durationField.className = 'wm-ranking-sale-field';

        const durationLabel = document.createElement('span');
        durationLabel.textContent = 'Durée';

        const durationInput = document.createElement('select');

        const durationOptions = [
          [10, '10 min'],
          [30, '30 min'],
          [60, '1 h'],
          [180, '3 h'],
          [360, '6 h'],
          [720, '12 h'],
          [1440, '24 h']
        ];

        for (const [value, label] of durationOptions) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          durationInput.append(option);
        }

        durationInput.value = '10';

        durationField.append(durationLabel, durationInput);

        const hint = document.createElement('div');
        hint.className = 'wm-ranking-sale-hint';
        hint.textContent = 'Chaque bouton utilise ces deux valeurs.';

        saleControls.append(priceField, durationField, hint);

        const tagKey = (tag) => tag.id || tag.name;
        const rowTags = (row) => mergeTags(row.tags);

        // Le rang affiché reste celui du classement complet, même une fois filtré.
        const rankedRows = rows.map((row, index) => ({ row, index }));
        const rankedById = new Map(rankedRows.map((entry) => [entry.row.id, entry]));
        // Sans prix chargé : pas de rang, affichées seulement quand un filtre est actif.
        const unrankedRows = (Array.isArray(status.unpricedRows) ? status.unpricedRows : [])
          .map((row) => ({ row, index: null }));
        const filterableRows = [...rankedRows, ...unrankedRows];
        let visibleRows = rankedRows;
        let closed = false;

        const knownTags = new Map();
        const addKnownTags = (tags) => {
          for (const tag of mergeTags(tags)) {
            // Une même étiquette ne doit apparaître qu'une fois, qu'on connaisse son id ou non.
            const sameName = [...knownTags.values()].find((known) => known.name === tag.name);
            if (sameName && sameName.id && !tag.id) continue;
            if (sameName) knownTags.delete(tagKey(sameName));
            knownTags.set(tagKey(tag), {
              ...tag,
              cardCount: tag.cardCount ?? sameName?.cardCount
            });
          }
        };
        filterableRows.forEach(({ row }) => addKnownTags(row.tags));

        // Cartes d'un filtre telles que renvoyées par le site : clé -> { state, rows }.
        const fetchedResults = new Map();
        const STARRED_KEY = '__starred__';

        const filters = document.createElement('div');
        filters.className = 'wm-ranking-filters';

        const starredFilter = document.createElement('label');
        starredFilter.className = 'wm-ranking-filter-starred';

        const starredInput = document.createElement('input');
        starredInput.type = 'checkbox';

        const starredText = document.createElement('span');
        starredText.textContent = '★ Favoris uniquement';

        starredFilter.append(starredInput, starredText);

        const tagSelect = document.createElement('select');
        tagSelect.className = 'wm-ranking-filter-tag';
        tagSelect.setAttribute('aria-label', 'Filtrer par étiquette');

        const allTagsOption = document.createElement('option');
        allTagsOption.value = '';
        allTagsOption.textContent = 'Toutes les étiquettes';

        const fillTagOptions = () => {
          const selected = tagSelect.value;
          const options = [...knownTags.values()]
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
            .map((tag) => {
              const option = document.createElement('option');
              option.value = tagKey(tag);
              option.textContent = Number.isFinite(tag.cardCount)
                ? `${tag.name} (${tag.cardCount})`
                : tag.name;
              return option;
            });

          tagSelect.replaceChildren(allTagsOption, ...options);
          tagSelect.value = knownTags.has(selected) ? selected : '';
          tagSelect.hidden = knownTags.size === 0;
        };

        fillTagOptions();

        const filterCount = document.createElement('span');
        filterCount.className = 'wm-ranking-filter-count';

        filters.append(starredFilter, tagSelect, filterCount);

        const list = document.createElement('div');
        list.className = 'wm-ranking-list';

        const PAGE_SIZE = 50;
        let renderedCount = 0;

        const saleInputsAreValid = () => {
          const amount = Number(priceInput.value);
          const duration = Number(durationInput.value);
          return Number.isFinite(amount) && amount > 0 && Number.isFinite(duration) && duration > 0;
        };

        const refreshSaleButtons = () => {
          const valid = saleInputsAreValid();

          for (const button of list.querySelectorAll('.wm-ranking-sell-button')) {
            if (button.dataset.state === 'pending' || button.dataset.state === 'success') continue;
            button.disabled = !valid;
          }
        };

        const createRankingRow = (row, index) => {
          const item = document.createElement('div');
          item.className = 'wm-ranking-row';

          const rank = document.createElement('div');
          rank.className = 'wm-ranking-rank';
          rank.textContent = index == null ? '—' : String(index + 1);
          if (index == null) rank.title = 'Carte absente du classement en cache';

          const thumb = document.createElement('div');
          thumb.className = 'wm-ranking-thumb';
          if (row.imageUrl) {
            const img = document.createElement('img');
            img.src = row.imageUrl;
            img.alt = '';
            img.loading = 'lazy';
            thumb.append(img);
          }

          const info = document.createElement('div');
          info.className = 'wm-ranking-info';

          const name = document.createElement('div');
          name.className = 'wm-ranking-title';
          name.textContent = row.title;

          if (row.starred) {
            const star = document.createElement('span');
            star.className = 'wm-ranking-star';
            star.textContent = '★';
            star.title = 'Carte en favori';
            name.prepend(star);
          }

          const meta = document.createElement('div');
          meta.className = 'wm-ranking-meta';
          meta.textContent = row.rarity || '—';

          if (row.count > 1) {
            const count = document.createElement('span');
            count.className = 'wm-ranking-count';
            count.textContent = `×${row.count}`;
            count.title = `${row.count} exemplaires possédés`;
            meta.append(count);
          }

          for (const tag of rowTags(row)) {
            const chip = document.createElement('span');
            chip.className = 'wm-ranking-tag';

            if (/^#[0-9a-f]{3,8}$/i.test(tag.color || '')) {
              const dot = document.createElement('span');
              dot.className = 'wm-ranking-tag-dot';
              dot.style.background = tag.color;
              chip.append(dot);
            }

            chip.append(document.createTextNode(tag.name));
            meta.append(chip);
          }

          info.append(name, meta);

          const price = document.createElement('div');
          price.className = 'wm-ranking-price';
          if (Number.isFinite(row.average)) {
            price.textContent = `${formatAverage(row.average)} W`;
          } else {
            price.textContent = '—';
            price.classList.add('wm-ranking-price-empty');
          }

          const sellButton = document.createElement('button');
          sellButton.type = 'button';
          sellButton.className = 'wm-tool-button wm-ranking-sell-button';
          sellButton.textContent = 'Mettre en vente';
          sellButton.dataset.cardId = row.id;
          sellButton.disabled = !saleInputsAreValid();

          sellButton.addEventListener('click', () => {
            const amount = Number(priceInput.value);
            const duration = Number(durationInput.value);

            if (!Number.isFinite(amount) || amount <= 0) {
              priceInput.focus();
              return;
            }

            if (!Number.isFinite(duration) || duration <= 0) {
              durationInput.focus();
              return;
            }

            // Le favori est connu par carte, pas par exemplaire : pour une carte en favori,
            // on laisse le bridge choisir un exemplaire non favori s'il en existe un.
            const ownedCardId = row.starred
              ? null
              : (row.ownedCardId || row.ownedCardIds?.[0] || null);

            requestListing({ button: sellButton, row, amount, duration, ownedCardId });
          });

          item.append(rank, thumb, info, price);
          if (salesEnabled) item.append(sellButton);
          return item;
        };

        const sentinel = document.createElement('div');
        sentinel.className = 'wm-ranking-sentinel';

        const renderNextChunk = () => {
          if (renderedCount >= visibleRows.length) {
            sentinel.remove();
            return;
          }

          const fragment = document.createDocumentFragment();
          const end = Math.min(renderedCount + PAGE_SIZE, visibleRows.length);

          for (let position = renderedCount; position < end; position += 1) {
            const { row, index } = visibleRows[position];
            fragment.append(createRankingRow(row, index));
          }

          renderedCount = end;
          sentinel.remove();
          list.append(fragment);

          if (renderedCount < visibleRows.length) {
            list.append(sentinel);
          }

          refreshSaleButtons();
        };

        const byPriceThenTitle = (a, b) => {
          const aPrice = Number.isFinite(a.row.average) ? a.row.average : -Infinity;
          const bPrice = Number.isFinite(b.row.average) ? b.row.average : -Infinity;
          if (bPrice !== aPrice) return bPrice - aPrice;
          return a.row.title.localeCompare(b.row.title, 'fr');
        };

        // Le site renvoie toutes les cartes du filtre, y compris celles absentes du classement.
        // Il ne renvoie que les exemplaires concernés : on complète ce qu'on sait déjà de la carte
        // sans réduire son nombre d'exemplaires.
        const buildFetchedRows = (cards) => {
          const outside = cards.filter((card) => !rankedById.has(card.id));
          const prices = storageGet(outside.map((card) => cacheKey(card.id)));

          return cards.map((card) => {
            const ranked = rankedById.get(card.id);

            if (ranked) {
              const ownedCardIds = [...new Set([
                ...(Array.isArray(ranked.row.ownedCardIds) ? ranked.row.ownedCardIds : []),
                ...(Array.isArray(card.ownedCardIds) ? card.ownedCardIds : [])
              ])];

              Object.assign(ranked.row, {
                starred: Boolean(ranked.row.starred || card.starred),
                tags: mergeTags(ranked.row.tags, card.tags),
                count: Math.max(ranked.row.count || 1, card.count || 1, ownedCardIds.length),
                ownedCardId: ranked.row.ownedCardId || card.ownedCardId,
                ownedCardIds
              });
              return ranked;
            }

            const entry = prices[cacheKey(card.id)];
            const average = entry && entry.ok !== false
              ? chooseAverage(entry, null, card.rarity || null)
              : Number.NaN;

            return { row: { ...card, average }, index: null };
          }).sort(byPriceThenTitle);
        };

        const loadFetchedRows = (key, eventName, detail = {}) => {
          if (fetchedResults.has(key)) return;
          fetchedResults.set(key, { state: 'loading' });

          requestBridge(eventName, detail).then((response) => {
            if (closed) return;

            fetchedResults.set(key, response.ok
              ? {
                  state: 'ready',
                  rows: buildFetchedRows(Array.isArray(response.cards) ? response.cards : [])
                }
              : { state: 'error' });

            // Ne redessine que si ce filtre est toujours celui affiché.
            const currentKey = tagSelect.value || (starredInput.checked ? STARRED_KEY : '');
            if (currentKey === key) applyFilters();
          });
        };

        const applyFilters = () => {
          const starredOnly = starredInput.checked;
          const key = tagSelect.value;
          const tag = key ? knownTags.get(key) : null;
          const filterActive = starredOnly || Boolean(tag);

          let pool = filterActive ? filterableRows : rankedRows;
          let result = null;

          if (tag) {
            if (tag.id) loadFetchedRows(key, 'wm-average-load-tag-cards', { tagId: tag.id });
            result = fetchedResults.get(key) || null;

            // En attendant (ou en cas d'échec) : les cartes déjà connues de l'extension.
            pool = result?.state === 'ready'
              ? result.rows
              : filterableRows.filter(({ row }) => (
                  rowTags(row).some((rowTag) => tagKey(rowTag) === key)
                ));
          } else if (starredOnly) {
            loadFetchedRows(STARRED_KEY, 'wm-average-load-starred-cards');
            result = fetchedResults.get(STARRED_KEY) || null;

            if (result?.state === 'ready') {
              const fetchedIds = new Set(result.rows.map(({ row }) => row.id));
              pool = [
                ...result.rows,
                ...filterableRows.filter(({ row }) => row.starred && !fetchedIds.has(row.id))
              ].sort(byPriceThenTitle);
            }
          }

          let note = '';
          if (result?.state === 'loading') note = ' • chargement…';
          if (result?.state === 'error') note = ' • liste peut-être incomplète';

          visibleRows = pool.filter(({ row }) => !starredOnly || row.starred);

          const unpricedCount = visibleRows
            .filter(({ row }) => !Number.isFinite(row.average)).length;
          const plural = visibleRows.length > 1 ? 's' : '';

          filterCount.textContent = filterActive
            ? `${visibleRows.length} carte${plural}${unpricedCount ? ` • ${unpricedCount} sans prix chargé` : ''}${note}`
            : '';

          renderedCount = 0;
          list.replaceChildren();
          list.scrollTop = 0;

          if (!visibleRows.length) {
            const empty = document.createElement('div');
            empty.className = 'wm-ranking-empty';
            empty.textContent = result?.state === 'loading'
              ? 'Chargement des cartes…'
              : 'Aucune carte ne correspond à ces filtres.';
            list.append(empty);
            return;
          }

          renderNextChunk();
        };

        starredInput.addEventListener('change', applyFilters);
        tagSelect.addEventListener('change', applyFilters);

        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            renderNextChunk();
          }
        }, {
          root: list,
          rootMargin: '250px 0px',
          threshold: 0
        });

        priceInput.addEventListener('input', refreshSaleButtons);
        durationInput.addEventListener('change', refreshSaleButtons);

        renderNextChunk();
        observer.observe(sentinel);

        const close = () => {
          closed = true;
          observer.disconnect();
          overlay.remove();
        };

        closeButton.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });

        modal.append(header);
        if (cacheNotice) modal.append(cacheNotice);
        if (salesEnabled) modal.append(saleControls);
        modal.append(filters, list);
        overlay.append(modal);
        document.body.append(overlay);

        // Le menu propose toutes les étiquettes du joueur, pas seulement celles des cartes en cache.
        requestBridge('wm-average-load-tag-options').then((detail) => {
          if (closed || !detail.ok) return;
          addKnownTags(detail.tags);
          fillTagOptions();
        });
      }


      window.addEventListener('wm-average-create-listing-progress', (event) => {
        const detail = event.detail || {};
        const pending = pendingMarketplaceListings.get(detail.requestId);
        if (!pending?.button?.isConnected) return;

        if (detail.state === 'refreshing-id') {
          pending.button.textContent = 'ID expiré • recherche…';
        } else if (detail.state === 'resolving-id') {
          pending.button.textContent = 'Recherche ID…';
        }
      });

      window.addEventListener('wm-average-create-listing-result', (event) => {
        const detail = event.detail || {};
        const pending = pendingMarketplaceListings.get(detail.requestId);
        if (!pending) return;

        pendingMarketplaceListings.delete(detail.requestId);

        const { button, row, amount, duration } = pending;
        if (!button?.isConnected) return;

        if (detail.needsStarredConfirmation) {
          button.textContent = 'Confirmation…';

          runtime.modalUi.showConfirmModal(
            'Vendre ton exemplaire favori ?',
            `« ${row.title} » : le seul exemplaire disponible est en favori. Le mettre en vente quand même ?`,
            { confirmLabel: 'Vendre le favori', cancelLabel: 'Garder la carte' }
          ).then((confirmed) => {
            if (!button.isConnected) return;

            if (!confirmed) {
              delete button.dataset.state;
              button.disabled = false;
              button.textContent = 'Mettre en vente';
              return;
            }

            requestListing({
              button,
              row,
              amount,
              duration,
              ownedCardId: detail.ownedCardId,
              allowStarred: true
            });
          });
          return;
        }

        if (detail.ok) {
          if (detail.ownedCardId) {
            const staleId = detail.staleOwnedCardId || null;

            row.ownedCardId = detail.ownedCardId;
            row.ownedCardIds = [
              ...new Set([
                ...(Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [])
                  .filter((id) => id && id !== staleId),
                detail.ownedCardId
              ])
            ];

            const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
            if (Array.isArray(stored?.cards)) {
              const target = stored.cards.find((card) => card?.id === row.id);
              if (target) {
                target.ownedCardId = detail.ownedCardId;
                target.ownedCardIds = [
                  ...new Set([
                    ...(Array.isArray(target.ownedCardIds) ? target.ownedCardIds : [])
                      .filter((id) => id && id !== staleId),
                    detail.ownedCardId
                  ])
                ];
                storageSet({ [ALL_COLLECTION_KEY]: stored });
              }
            }
          }

          button.dataset.state = 'success';
          button.disabled = true;
          button.textContent = 'En vente ✓';
          button.title = `${formatAverage(amount)} W pendant ${formatAverage(duration)} min`;
          return;
        }

        if (detail.notOwned) {
          const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];

          if (Array.isArray(stored?.cards)) {
            stored.cards = stored.cards.filter((card) => card?.id !== row.id);
            storageSet({ [ALL_COLLECTION_KEY]: stored });
          }

          row.ownedCardId = null;
          row.ownedCardIds = [];

          const rankingRow = button.closest('.wm-ranking-row');
          rankingRow?.classList.add('wm-ranking-row-unowned');

          button.dataset.state = 'success';
          button.disabled = true;
          button.textContent = 'Plus possédée';
          button.title = 'Cette carte n’est plus dans ta collection.';
          return;
        }

        if (detail.alreadyListed) {
          button.dataset.state = 'success';
          button.disabled = true;
          button.textContent = 'Déjà en vente';
          button.title = detail.error || 'Toutes tes copies disponibles sont déjà en vente.';
          return;
        }

        const staleId = detail.staleOwnedCardId || (detail.ownershipError ? detail.ownedCardId : null);

        if (staleId) {
          if (row.ownedCardId === staleId) {
            row.ownedCardId = null;
          }
          row.ownedCardIds = (Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [])
            .filter((id) => id && id !== staleId);

          const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
          if (Array.isArray(stored?.cards)) {
            const target = stored.cards.find((card) => card?.id === row.id);
            if (target) {
              if (target.ownedCardId === staleId) {
                target.ownedCardId = null;
              }
              target.ownedCardIds = (Array.isArray(target.ownedCardIds) ? target.ownedCardIds : [])
                .filter((id) => id && id !== staleId);
              storageSet({ [ALL_COLLECTION_KEY]: stored });
            }
          }
        }

        button.dataset.state = 'error';
        button.disabled = false;
        button.textContent = detail.ownershipError
          ? 'ID invalide — réessayer'
          : 'Erreur — réessayer';
        button.title = detail.error || 'Impossible de mettre cette carte en vente.';
      });


      return { openRankingModal };
    }
  };
})();
