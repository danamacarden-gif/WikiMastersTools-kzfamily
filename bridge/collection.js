(() => {
  const registry = window.__wmBridgeFeatures ||= {};

  registry.bridgeCollection = {
    create(runtime) {
      const {
        originalFetch, MAX_COLLECTION_PAGES, RARITY_ORDER,
        extractCards, fetchJsonRetry, mapTags
      } = runtime.core;

      function extractRarityCounts(json) {
        if (!json || typeof json !== 'object') return null;

        const candidates = [
          json.rarityCounts,
          json.rarity_counts,
          json.rarities,
          json.counts,
          json.stats?.rarityCounts,
          json.stats?.rarity_counts,
          json.stats?.rarities,
          json.stats?.counts
        ];

        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

          const counts = {};
          let found = false;

          for (const rarity of RARITY_ORDER) {
            const value = Number(candidate[rarity]);
            if (Number.isFinite(value) && value >= 0) {
              counts[rarity] = value;
              found = true;
            }
          }

          if (found) return counts;
        }

        if (Array.isArray(json.rarities)) {
          const counts = {};
          for (const row of json.rarities) {
            const rarity = row?.rarity || row?.name || row?.key;
            const count = Number(row?.count ?? row?.total ?? row?.value);
            if (RARITY_ORDER.includes(rarity) && Number.isFinite(count) && count >= 0) {
              counts[rarity] = count;
            }
          }
          if (Object.keys(counts).length) return counts;
        }

        return null;
      }

      async function fetchCollectionRarityCounts() {
        try {
          const json = await fetchJsonRetry(
            '/api/my-collection/stats?sort=rarity',
            {
              method: 'GET',
              credentials: 'include',
              headers: { accept: '*/*' }
            },
            { label: 'Stats collection', maxAttempts: 3 }
          );
          return extractRarityCounts(json);
        } catch (error) {
          console.debug('[WM Average] stats de rareté indisponibles, fallback pages', error);
          return null;
        }
      }

      async function fetchCollectionPage(page, stats = false, { tagId = null, sort = 'rarity' } = {}) {
        const tagQuery = tagId ? `&tag_id=${encodeURIComponent(tagId)}` : '';
        return fetchJsonRetry(
          `/api/my-collection?sort=${encodeURIComponent(sort)}${tagQuery}&page=${encodeURIComponent(page)}&stats=${stats ? 1 : 0}`,
          { method: 'GET', credentials: 'include', headers: { accept: '*/*' } },
          { label: `Collection page ${page}`, maxAttempts: 3, timeoutMs: 15000 }
        );
      }

      function dedupeCards(pages) {
        const deduped = new Map();

        for (const pageCards of pages) {
          if (!Array.isArray(pageCards)) continue;

          for (const card of pageCards) {
            const existing = deduped.get(card.id);

            if (existing) {
              const ownershipIds = new Set([
                ...(Array.isArray(existing.ownedCardIds) ? existing.ownedCardIds : []),
                ...(Array.isArray(card.ownedCardIds) ? card.ownedCardIds : []),
                card.ownedCardId
              ].filter(Boolean));

              existing.ownedCardIds = [...ownershipIds];
              // Chaque exemplaire est une entrée distincte avec count = 1.
              existing.count = Math.max(
                existing.count || 1,
                card.count || 1,
                existing.ownedCardIds.length
              );
              if (!existing.ownedCardId && existing.ownedCardIds.length) {
                existing.ownedCardId = existing.ownedCardIds[0];
              }

              // Favori et étiquettes sont portés par chaque exemplaire possédé.
              existing.starred = Boolean(existing.starred || card.starred);
              existing.tags = mapTags(existing.tags, card.tags);
            } else {
              deduped.set(card.id, { ...card });
            }
          }
        }

        return deduped;
      }

      // Cartes portant une étiquette, via le même filtre que la page Collection du site.
      async function fetchTagCards(requestId, tagId) {
        try {
          const first = await fetchCollectionPage(0, false, { tagId });
          const firstCards = extractCards(first);
          const total = Number(first?.total);
          const pageSize = firstCards.length;
          const pages = [firstCards];

          const hasReliableTotal = Number.isFinite(total) && total > 0 && pageSize > 0;
          const maxPageExclusive = hasReliableTotal
            ? Math.min(Math.ceil(total / pageSize), MAX_COLLECTION_PAGES)
            : MAX_COLLECTION_PAGES;

          // Certaines réponses filtrées par étiquette n'exposent pas `total`.
          // Dans ce cas, ne surtout pas supposer qu'il n'existe qu'une seule page
          // (50 cartes) : on continue jusqu'à la première page incomplète/vide.
          if (pageSize > 0) {
            for (let page = 1; page < maxPageExclusive; page += 1) {
              const cards = extractCards(await fetchCollectionPage(page, false, { tagId }));
              pages.push(cards);

              if (!cards.length || cards.length < pageSize) break;
            }
          }

          window.dispatchEvent(new CustomEvent('wm-average-tag-cards', {
            detail: {
              requestId,
              tagId,
              ok: true,
              cards: [...dedupeCards(pages).values()]
            }
          }));
        } catch (error) {
          window.dispatchEvent(new CustomEvent('wm-average-tag-cards', {
            detail: {
              requestId,
              tagId,
              ok: false,
              error: String(error?.message || error)
            }
          }));
        }
      }

      // Cartes en favori : le tri « starred » du site les place en tête, on s'arrête
      // à la première page qui contient une carte non favorite.
      async function fetchStarredCards(requestId) {
        try {
          const pages = [];
          let pageSize = 0;

          for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
            const cards = extractCards(await fetchCollectionPage(page, false, { sort: 'starred' }));
            const starred = cards.filter((card) => card.starred);
            pages.push(starred);

            if (page === 0) pageSize = cards.length;
            if (!cards.length || starred.length < cards.length || cards.length < pageSize) break;
          }

          window.dispatchEvent(new CustomEvent('wm-average-starred-cards', {
            detail: {
              requestId,
              ok: true,
              cards: [...dedupeCards(pages).values()]
            }
          }));
        } catch (error) {
          window.dispatchEvent(new CustomEvent('wm-average-starred-cards', {
            detail: {
              requestId,
              ok: false,
              error: String(error?.message || error)
            }
          }));
        }
      }

      // Liste complète des étiquettes du joueur (renvoyée avec les stats de la collection).
      async function fetchTagOptions(requestId) {
        try {
          const json = await fetchJsonRetry(
            '/api/my-collection?sort=rarity&page=0&stats=1',
            {
              method: 'GET',
              credentials: 'include',
              headers: { accept: '*/*' }
            },
            { label: 'Étiquettes', maxAttempts: 3 }
          );

          window.dispatchEvent(new CustomEvent('wm-average-tag-options', {
            detail: { requestId, ok: true, tags: mapTags(json?.tagOptions) }
          }));
        } catch (error) {
          window.dispatchEvent(new CustomEvent('wm-average-tag-options', {
            detail: { requestId, ok: false, error: String(error?.message || error) }
          }));
        }
      }

      async function fetchAllCollection(requestId, selectedRarities = []) {
        try {
          const selectedIndexes = (Array.isArray(selectedRarities) ? selectedRarities : [])
            .map((rarity) => RARITY_ORDER.indexOf(rarity))
            .filter((index) => index >= 0);

          const lowestRequestedIndex = selectedIndexes.length
            ? Math.max(...selectedIndexes)
            : RARITY_ORDER.length - 1;

          const rarityCounts = await fetchCollectionRarityCounts();
          const first = await fetchCollectionPage(0, true);
          const firstCards = extractCards(first);
          const total = typeof first?.total === 'number' ? first.total : Number.NaN;
          const pageSize = firstCards.length;
          const pages = [firstCards];

          let totalPages = 1;
          if (Number.isFinite(total) && total > 0 && pageSize > 0) {
            totalPages = Math.max(1, Math.ceil(total / pageSize));
          }

          let targetPages = totalPages;
          let exactTargetFromStats = false;

          if (rarityCounts && pageSize > 0 && selectedIndexes.length) {
            let cardsThroughLowestRarity = 0;

            for (let index = 0; index <= lowestRequestedIndex; index += 1) {
              cardsThroughLowestRarity += Number(rarityCounts[RARITY_ORDER[index]]) || 0;
            }

            if (cardsThroughLowestRarity > 0) {
              targetPages = Math.max(1, Math.ceil(cardsThroughLowestRarity / pageSize));
              if (Number.isFinite(totalPages) && totalPages > 0) {
                targetPages = Math.min(targetPages, totalPages);
              }
              exactTargetFromStats = true;
            }
          }

          let loadedPages = 1;
          let stoppedEarly = exactTargetFromStats && targetPages < totalPages;

          const pageHasPassedRequestedRarity = (cards) => {
            if (!Array.isArray(cards) || !cards.length) return false;
            const lastRarity = cards[cards.length - 1]?.rarity;
            const lastIndex = RARITY_ORDER.indexOf(lastRarity);
            return lastIndex >= 0 && lastIndex > lowestRequestedIndex;
          };

          window.dispatchEvent(new CustomEvent('wm-average-all-collection-progress', {
            detail: {
              requestId,
              loadedPages,
              totalPages: exactTargetFromStats ? targetPages : totalPages,
              serverTotalPages: totalPages
            }
          }));

          if (!exactTargetFromStats && pageHasPassedRequestedRarity(firstCards)) {
            stoppedEarly = true;
          } else if (pageSize > 0) {
            const maxPageExclusive = exactTargetFromStats
              ? Math.min(targetPages, MAX_COLLECTION_PAGES)
              : (Number.isFinite(total) && totalPages > 0
                  ? Math.min(totalPages, MAX_COLLECTION_PAGES)
                  : MAX_COLLECTION_PAGES);

            for (let page = 1; page < maxPageExclusive; page += 1) {
              const json = await fetchCollectionPage(page, false);
              const cards = extractCards(json);
              pages[page] = cards;
              loadedPages += 1;

              window.dispatchEvent(new CustomEvent('wm-average-all-collection-progress', {
                detail: {
                  requestId,
                  loadedPages,
                  totalPages: exactTargetFromStats ? targetPages : (Number.isFinite(total) ? totalPages : 0),
                  serverTotalPages: totalPages
                }
              }));

              if (!exactTargetFromStats && pageHasPassedRequestedRarity(cards)) {
                stoppedEarly = Number.isFinite(total) ? page + 1 < totalPages : true;
                break;
              }

              if (cards.length < pageSize) break;
            }
          }

          const deduped = dedupeCards(pages);

          const complete =
            lowestRequestedIndex >= RARITY_ORDER.length - 1 &&
            !stoppedEarly &&
            (
              !Number.isFinite(total) ||
              loadedPages >= totalPages
            );

          window.dispatchEvent(new CustomEvent('wm-average-all-collection', {
            detail: {
              requestId,
              ok: true,
              cards: [...deduped.values()],
              total: Number.isFinite(total) ? total : deduped.size,
              complete,
              loadedPages,
              totalPages: exactTargetFromStats ? targetPages : totalPages,
              usedRarityStats: exactTargetFromStats
            }
          }));
        } catch (error) {
          window.dispatchEvent(new CustomEvent('wm-average-all-collection', {
            detail: {
              requestId,
              ok: false,
              error: String(error?.message || error)
            }
          }));
        }
      }


      return { fetchAllCollection, fetchTagCards, fetchStarredCards, fetchTagOptions };
    }
  };
})();
