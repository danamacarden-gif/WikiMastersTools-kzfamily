(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.packs = {
    create(runtime) {
      const {
        PULL_RECAP_ENABLED_KEY, AUTO_OPEN_ENABLED_KEY, AUTO_OPEN_NEXT_AT_KEY,
        AUTO_OPEN_SESSION_KEY, AUTO_OPEN_MIN_MINUTES_KEY, AUTO_OPEN_MAX_MINUTES_KEY,
        AUTO_OPEN_DEFAULT_MIN_MINUTES, AUTO_OPEN_DEFAULT_MAX_MINUTES,
        ALL_COLLECTION_KEY, cacheMemory, isPullsPage, isLastPullCardVisible,
        normalizeTitle, readLocalValue, writeLocalValue, storageGet, storageSet,
        reportError
      } = runtime.core;
      const { formatAverage, chooseAverage } = runtime.priceUi;

      let pullRecapEnabled = runtime.settings.isEnabled('packRecap') && readLocalValue(PULL_RECAP_ENABLED_KEY) !== false;
      let activePackRecap = null;
      let packRecapDismissed = false;
      let openAllActive = false;
      let openAllRequestId = null;
      let openAllButton = null;
      let openAllSummaryCards = [];
      let openAllOpenedPacks = 0;
      let openAllError = null;
      let openAllRenderTimer = null;
      let openAllSummaryTitle = 'Cartes obtenues';
      let openAllSummaryOnClose = null;
      let openAllSummaryReloadOnClose = true;
      let autoOpenEnabled = runtime.settings.isEnabled('autoOpen') && readLocalValue(AUTO_OPEN_ENABLED_KEY) === true;
      let autoOpenTimer = null;
      let autoOpenRequestId = null;
      let autoOpenShowSummaryAfterCurrent = false;
      let autoOpenToggleInput = null;
      let autoOpenToggleLabel = null;

      let confirmationPending = false;
      let openAllProgressLabel = null;
      let openAllTotalPacks = null;

      if (!runtime.settings.isEnabled('autoOpen')) {
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
      }

      // Le widget de vérification du site reste une interaction explicite de l'utilisateur.

      function stopOpening() {
        if (!openAllActive) return;
        if (autoOpenRequestId === openAllRequestId) {
          autoOpenEnabled = false;
          autoOpenShowSummaryAfterCurrent = true;
          writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          clearAutoOpenTimer();
          updateAutoOpenToggleUi();
        }
        window.dispatchEvent(new CustomEvent('wm-average-cancel-open-all-packs', {
          detail: { requestId: openAllRequestId }
        }));
      }

      function readAutoOpenSession() {
        const raw = readLocalValue(AUTO_OPEN_SESSION_KEY);

        return {
          startedAt: Number(raw?.startedAt) || Date.now(),
          openedPacks: Math.max(0, Number(raw?.openedPacks) || 0),
          runs: Math.max(0, Number(raw?.runs) || 0),
          cards: Array.isArray(raw?.cards) ? raw.cards.filter((card) => card?.id && card?.title) : [],
          errors: Array.isArray(raw?.errors) ? raw.errors.map(String).slice(-10) : []
        };
      }

      function writeAutoOpenSession(session) {
        writeLocalValue(AUTO_OPEN_SESSION_KEY, {
          startedAt: Number(session?.startedAt) || Date.now(),
          openedPacks: Math.max(0, Number(session?.openedPacks) || 0),
          runs: Math.max(0, Number(session?.runs) || 0),
          cards: Array.isArray(session?.cards) ? session.cards : [],
          errors: Array.isArray(session?.errors) ? session.errors.slice(-10) : []
        });
      }

      function resetAutoOpenSession() {
        const session = {
          startedAt: Date.now(),
          openedPacks: 0,
          runs: 0,
          cards: [],
          errors: []
        };
        writeAutoOpenSession(session);
        return session;
      }

      function getAutoOpenDelayBounds() {
        const normalizeMinutes = (value, fallback) => {
          const numeric = value == null || value === '' ? NaN : Math.round(Number(value));
          if (!Number.isFinite(numeric)) return fallback;
          return Math.max(1, Math.min(10080, numeric));
        };

        const first = normalizeMinutes(
          readLocalValue(AUTO_OPEN_MIN_MINUTES_KEY),
          AUTO_OPEN_DEFAULT_MIN_MINUTES
        );
        const second = normalizeMinutes(
          readLocalValue(AUTO_OPEN_MAX_MINUTES_KEY),
          AUTO_OPEN_DEFAULT_MAX_MINUTES
        );

        return {
          minDelay: Math.min(first, second) * 60 * 1000,
          maxDelay: Math.max(first, second) * 60 * 1000
        };
      }

      function randomAutoOpenDelay() {
        const { minDelay, maxDelay } = getAutoOpenDelayBounds();
        return Math.round(
          minDelay +
          Math.random() * (maxDelay - minDelay)
        );
      }

      function clearAutoOpenTimer() {
        if (autoOpenTimer) {
          clearTimeout(autoOpenTimer);
          autoOpenTimer = null;
        }
      }

      function updateAutoOpenToggleUi() {
        if (autoOpenToggleInput) {
          autoOpenToggleInput.checked = autoOpenEnabled;
        }
        if (autoOpenToggleLabel) {
          autoOpenToggleLabel.classList.toggle('is-enabled', autoOpenEnabled);
        }
      }

      function scheduleNextAutoOpen({ keepExisting = true } = {}) {
        clearAutoOpenTimer();

        if (!runtime.settings.isEnabled('autoOpen')) {
          autoOpenEnabled = false;
          writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          return;
        }

        if (!autoOpenEnabled) {
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          return;
        }

        let nextAt = keepExisting ? Number(readLocalValue(AUTO_OPEN_NEXT_AT_KEY)) || 0 : 0;
        const now = Date.now();

        if (nextAt <= now) {
          nextAt = now + randomAutoOpenDelay();
          writeLocalValue(AUTO_OPEN_NEXT_AT_KEY, nextAt);
        }

        const delay = Math.max(1000, nextAt - now);

        autoOpenTimer = setTimeout(() => {
          autoOpenTimer = null;
          runAutomaticOpen().catch((error) => {
            reportError('ouverture automatique', error);
            if (autoOpenEnabled) scheduleNextAutoOpen({ keepExisting: false });
          });
        }, delay);
      }

      function appendAutomaticOpenResult(detail) {
        const session = readAutoOpenSession();
        const cards = Array.isArray(detail?.cards) ? detail.cards : [];
        const openedPacks = Math.max(0, Number(detail?.openedPacks) || 0);

        if (cards.length || openedPacks > 0) {
          session.cards.push(...cards);
          session.openedPacks += openedPacks;
          if (detail?.countRun !== false) session.runs += 1;
        }

        if (!detail?.ok && detail?.error) {
          session.errors.push(String(detail.error));
        }

        writeAutoOpenSession(session);
        return session;
      }

      function showAutomaticOpenSummary() {
        const session = readAutoOpenSession();

        if (!session.cards.length) {
          localStorage.removeItem(AUTO_OPEN_SESSION_KEY);
          runtime.modalUi.showInfoModal(
            'Ouverture automatique',
            'Aucune carte n’a été ouverte automatiquement pendant cette session.'
          );
          return;
        }

        const error =
          session.errors.length > 0
            ? `${session.errors.length} cycle${session.errors.length > 1 ? 's' : ''} interrompu${session.errors.length > 1 ? 's' : ''} pendant la session.`
            : null;

        openOpenAllSummary(
          session.cards,
          session.openedPacks,
          error,
          {
            title: 'Récap ouverture automatique',
            reloadOnClose: false,
            onClose: () => {
              localStorage.removeItem(AUTO_OPEN_SESSION_KEY);
            }
          }
        );
      }

      function disableAutomaticOpening({ showSummary = true } = {}) {
        autoOpenEnabled = false;
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
        clearAutoOpenTimer();
        updateAutoOpenToggleUi();

        if (autoOpenRequestId && openAllActive && openAllRequestId === autoOpenRequestId) {
          autoOpenShowSummaryAfterCurrent = showSummary;
          stopOpening();
          return;
        }

        if (showSummary) {
          showAutomaticOpenSummary();
        }
      }

      function enableAutomaticOpening() {
        if (!runtime.settings.isEnabled('autoOpen')) return;
        autoOpenEnabled = true;
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, true);
        resetAutoOpenSession();
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
        autoOpenShowSummaryAfterCurrent = false;
        updateAutoOpenToggleUi();
        scheduleNextAutoOpen({ keepExisting: false });
      }

      function startOpenAllPacks({ automatic = false } = {}) {
        if (openAllActive) return false;

        openAllActive = true;
        openAllSummaryCards = [];
        openAllOpenedPacks = 0;
        openAllError = null;
        openAllRequestId = `${automatic ? 'auto-packs' : 'packs'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        openAllTotalPacks = null;
        setOpenAllProgress(0);
        if (automatic) {
          autoOpenRequestId = openAllRequestId;
        }

        if (openAllButton?.isConnected) {
          openAllButton.disabled = true;
          openAllButton.textContent = automatic ? 'Auto ouverture…' : 'Ouverture…';
        }

        document.getElementById('wm-pack-recap')?.remove();
        document.getElementById('wm-open-all-overlay')?.remove();

        window.dispatchEvent(new CustomEvent('wm-average-open-all-packs', {
          detail: { requestId: openAllRequestId }
        }));

        return true;
      }

      async function runAutomaticOpen() {
        if (!autoOpenEnabled || readLocalValue(AUTO_OPEN_ENABLED_KEY) !== true || !runtime.settings.isEnabled('autoOpen')) return;

        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);

        if (openAllActive) {
          scheduleNextAutoOpen({ keepExisting: false });
          return;
        }

        const started = startOpenAllPacks({ automatic: true });
        if (!started && autoOpenEnabled) {
          scheduleNextAutoOpen({ keepExisting: false });
        }
      }

      function showAutoOpenHelp() {
        const { minDelay, maxDelay } = getAutoOpenDelayBounds();
        runtime.modalUi.showInfoModal(
          'Ouverture automatique',
          `L’extension attend entre ${minDelay / 60000} et ${maxDelay / 60000} minutes, puis ouvre les paquets disponibles. WikiMasters doit rester ouvert. Un seul onglet peut ouvrir des paquets à la fois. Désactiver l’option arrête le lot après le paquet en cours et affiche le récapitulatif cumulé. Les vérifications du site restent à valider manuellement.`
        );
      }

      function ensurePullsToolbar() {
        if (!isPullsPage() || document.getElementById('wm-pulls-info')) return;

        const h1 = [...document.querySelectorAll('h1')]
          .find((el) => normalizeTitle(el.textContent) === 'Ouvrir un paquet');
        if (!h1) return;

        const header = h1.parentElement;
        if (!header) return;
        header.classList.add('wm-pulls-header');

        const tools = document.createElement('div');
        tools.id = 'wm-pulls-tools';
        tools.className = 'wm-pulls-tools';

        if (runtime.settings.isEnabled('packRecap')) {
          const label = document.createElement('label');
          label.className = 'wm-pulls-toggle';
          label.title = 'Afficher le récapitulatif des prix après chaque paquet';

          const textWrap = document.createElement('span');
          textWrap.className = 'wm-pulls-toggle-text';
          const title = document.createElement('strong');
          title.textContent = 'Récap prix';
          textWrap.append(title);

          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = pullRecapEnabled;

          const track = document.createElement('span');
          track.className = 'wm-toggle-track';
          const knob = document.createElement('span');
          knob.className = 'wm-toggle-knob';
          track.append(knob);

          input.addEventListener('change', () => {
            pullRecapEnabled = input.checked;
            writeLocalValue(PULL_RECAP_ENABLED_KEY, pullRecapEnabled);
            label.classList.toggle('is-enabled', pullRecapEnabled);

            if (pullRecapEnabled) {
              packRecapDismissed = false;
              renderPackRecap();
            } else {
              document.getElementById('wm-pack-recap')?.remove();
            }
          });

          label.classList.toggle('is-enabled', pullRecapEnabled);
          label.append(textWrap, input, track);
          tools.append(label);
        }

        if (runtime.settings.isEnabled('autoOpen')) {
          const autoControl = document.createElement('span');
          autoControl.className = 'wm-auto-open-control';

          autoOpenToggleLabel = document.createElement('label');
          autoOpenToggleLabel.className = 'wm-pulls-toggle wm-auto-open-toggle';
          autoOpenToggleLabel.title = 'Ouvrir automatiquement tous les paquets à intervalles aléatoires';

          const autoTextWrap = document.createElement('span');
          autoTextWrap.className = 'wm-pulls-toggle-text';
          const autoTitle = document.createElement('strong');
          autoTitle.textContent = 'Ouvrir automatiquement';
          autoTextWrap.append(autoTitle);

          autoOpenToggleInput = document.createElement('input');
          autoOpenToggleInput.type = 'checkbox';
          autoOpenToggleInput.checked = autoOpenEnabled;

          const autoTrack = document.createElement('span');
          autoTrack.className = 'wm-toggle-track';
          const autoKnob = document.createElement('span');
          autoKnob.className = 'wm-toggle-knob';
          autoTrack.append(autoKnob);

          autoOpenToggleInput.addEventListener('change', () => {
            if (autoOpenToggleInput.checked) enableAutomaticOpening();
            else disableAutomaticOpening({ showSummary: true });
          });

          autoOpenToggleLabel.classList.toggle('is-enabled', autoOpenEnabled);
          autoOpenToggleLabel.append(autoTextWrap, autoOpenToggleInput, autoTrack);

          const helpButton = document.createElement('button');
          helpButton.type = 'button';
          helpButton.className = 'wm-auto-open-help';
          helpButton.textContent = '?';
          helpButton.title = 'Comment fonctionne l’ouverture automatique ?';
          helpButton.setAttribute('aria-label', 'Aide ouverture automatique');
          helpButton.addEventListener('click', showAutoOpenHelp);

          autoControl.append(autoOpenToggleLabel, helpButton);
          tools.append(autoControl);
        }

        if (tools.childElementCount > 0) {
          h1.insertAdjacentElement('afterend', tools);
        }

        const info = document.createElement('div');
        info.id = 'wm-pulls-info';
        info.className = 'wm-pulls-info';

        if (runtime.settings.isEnabled('openAll')) {
          openAllButton = document.createElement('button');
          openAllButton.type = 'button';
          openAllButton.className = 'wm-tool-button wm-open-all-button';
          openAllButton.textContent = openAllActive ? 'Ouverture…' : 'Tout ouvrir';
          openAllButton.disabled = openAllActive;
          openAllButton.title = 'Ouvrir tous les paquets disponibles sans afficher les animations';
          openAllButton.addEventListener('click', () => {
            handleOpenAllPacksClick().catch((error) => reportError('tout ouvrir', error));
          });
          info.append(openAllButton);
        }

        openAllProgressLabel = document.createElement('span');
        openAllProgressLabel.className = 'wm-open-all-progress';
        openAllProgressLabel.setAttribute('role', 'status');
        openAllProgressLabel.setAttribute('aria-live', 'polite');
        openAllProgressLabel.hidden = !openAllActive;
        info.append(openAllProgressLabel);
        if (openAllActive) setOpenAllProgress(openAllOpenedPacks);

        if (
          runtime.settings.isEnabled('packRecap') ||
          runtime.settings.isEnabled('openAll') ||
          runtime.settings.isEnabled('autoOpen')
        ) {
          const cacheNote = document.createElement('div');
          cacheNote.className = 'wm-pulls-cache-note';
          cacheNote.textContent = 'Les prix moyens utilisés par les outils sont conservés dans le cache local.';
          info.append(cacheNote);
        }

        const pageSubtitle = [...header.children].find((el) => el.tagName === 'P');
        if (pageSubtitle) pageSubtitle.insertAdjacentElement('afterend', info);
        else header.append(info);
      }

      function showOpenAllConfirmation() {
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.className = 'wm-modal-overlay';

          const modal = document.createElement('div');
          modal.className = 'wm-modal wm-confirm-modal';

          const title = document.createElement('h2');
          title.textContent = 'Ouvrir tous les paquets ?';

          const text = document.createElement('p');
          text.textContent = 'Tous les paquets disponibles vont être ouverts immédiatement, sans animation. Cette action consomme les paquets.';

          const actions = document.createElement('div');
          actions.className = 'wm-modal-actions';

          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.className = 'wm-tool-button wm-secondary-button';
          cancel.textContent = 'Annuler';

          const confirm = document.createElement('button');
          confirm.type = 'button';
          confirm.className = 'wm-tool-button';
          confirm.textContent = 'Tout ouvrir';

          const close = (value) => {
            overlay.remove();
            resolve(value);
          };

          cancel.addEventListener('click', () => close(false));
          confirm.addEventListener('click', () => close(true));
          overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(false);
          });

          actions.append(cancel, confirm);
          modal.append(title, text, actions);
          overlay.append(modal);
          document.body.append(overlay);
        });
      }

      async function handleOpenAllPacksClick() {
        if (openAllActive || confirmationPending) return;
        confirmationPending = true;
        try {
          const confirmed = await showOpenAllConfirmation();
          if (confirmed) startOpenAllPacks({ automatic: false });
        } finally {
          confirmationPending = false;
        }
      }

      function setOpenAllProgress(openedPacks, packsRemaining = null, waitMs = null) {
        if (packsRemaining != null && Number.isInteger(Number(packsRemaining)) && Number(packsRemaining) >= 0) {
          const total = openedPacks + Number(packsRemaining);
          openAllTotalPacks = Math.max(openAllTotalPacks || 0, total);
        }
        if (!openAllProgressLabel) return;
        openAllProgressLabel.hidden = !openAllActive;
        openAllProgressLabel.textContent = openAllTotalPacks != null
          ? `${openedPacks}/${openAllTotalPacks} ouverts`
          : `${openedPacks} ouverts`;
        openAllProgressLabel.title = waitMs != null
          ? `Reprise dans ${Math.max(1, Math.ceil(Number(waitMs) / 1000))} s`
          : '';
      }

      function scheduleOpenAllSummaryRender() {
        if (openAllRenderTimer) return;

        openAllRenderTimer = setTimeout(() => {
          openAllRenderTimer = null;
          renderOpenAllSummary();
        }, 100);
      }

      function renderOpenAllSummary() {
        const overlay = document.getElementById('wm-open-all-overlay');
        if (!overlay || !openAllSummaryCards.length) return;

        const list = overlay.querySelector('.wm-open-all-list');
        const subtitle = overlay.querySelector('[data-role="subtitle"]');
        const footer = overlay.querySelector('[data-role="footer"]');
        if (!list || !subtitle || !footer) return;

        const rows = openAllSummaryCards.map((card, index) => {
          const entry = cacheMemory.get(card.id);
          const loaded = Boolean(entry);
          const average = entry ? chooseAverage(entry, null, card.rarity || null) : null;
          return { ...card, _originalIndex: index, loaded, average };
        });

        rows.sort((a, b) => {
          const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
          const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
          if (bPrice !== aPrice) return bPrice - aPrice;

          if (a.loaded !== b.loaded) return a.loaded ? 1 : -1;
          return a._originalIndex - b._originalIndex;
        });

        const loadedCount = rows.filter((row) => row.loaded).length;
        const pricedRows = rows.filter((row) => Number.isFinite(row.average));
        const total = pricedRows.reduce((sum, row) => sum + row.average, 0);

        subtitle.textContent =
          `${openAllOpenedPacks} paquet${openAllOpenedPacks > 1 ? 's' : ''} • ${rows.length} cartes • ${loadedCount}/${rows.length} prix chargés`;

        list.replaceChildren();
        const fragment = document.createDocumentFragment();

        rows.forEach((row, index) => {
          const item = document.createElement('div');
          item.className = 'wm-open-all-row';

          const rank = document.createElement('span');
          rank.className = 'wm-open-all-rank';
          rank.textContent = String(index + 1);

          const thumb = document.createElement('span');
          thumb.className = 'wm-open-all-thumb';
          if (row.imageUrl) {
            const img = document.createElement('img');
            img.src = row.imageUrl;
            img.alt = '';
            img.loading = 'lazy';
            thumb.append(img);
          }

          const info = document.createElement('span');
          info.className = 'wm-open-all-info';

          const name = document.createElement('strong');
          name.textContent = row.title;

          const meta = document.createElement('span');
          meta.textContent = row.rarity || '—';

          info.append(name, meta);

          const value = document.createElement('span');
          value.className = 'wm-open-all-price';

          if (!row.loaded) {
            value.classList.add('is-loading');
            const spinner = document.createElement('span');
            spinner.className = 'wm-average-spinner';
            value.append(spinner, document.createTextNode('…'));
          } else if (Number.isFinite(row.average)) {
            value.textContent = `${formatAverage(row.average)} W`;
          } else {
            value.textContent = '—';
            value.classList.add('is-empty');
          }

          item.append(rank, thumb, info, value);
          fragment.append(item);
        });

        list.append(fragment);

        if (loadedCount < rows.length) {
          footer.textContent = 'Chargement des prix moyens…';
        } else if (!pricedRows.length) {
          footer.textContent = 'Aucune carte n’a de prix moyen';
        } else {
          footer.textContent = `Total des prix moyens connus : ${formatAverage(total)} W`;
        }

        if (openAllError) {
          const error = document.createElement('div');
          error.className = 'wm-open-all-error';
          error.textContent = openAllError;
          footer.append(document.createElement('br'), error);
        }
      }

      function openOpenAllSummary(cards, openedPacks, error = null, options = {}) {
        document.getElementById('wm-open-all-overlay')?.remove();

        openAllSummaryCards = cards;
        openAllOpenedPacks = openedPacks;
        openAllError = error;
        openAllSummaryTitle = options.title || 'Cartes obtenues';
        openAllSummaryOnClose = typeof options.onClose === 'function' ? options.onClose : null;
        openAllSummaryReloadOnClose = options.reloadOnClose !== false;

        const overlay = document.createElement('div');
        overlay.id = 'wm-open-all-overlay';
        overlay.className = 'wm-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-open-all-modal';

        const header = document.createElement('div');
        header.className = 'wm-open-all-header';

        const headingWrap = document.createElement('div');

        const title = document.createElement('h2');
        title.textContent = openAllSummaryTitle;

        const subtitle = document.createElement('p');
        subtitle.dataset.role = 'subtitle';

        headingWrap.append(title, subtitle);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'wm-ranking-close';
        closeButton.textContent = '×';
        closeButton.setAttribute('aria-label', 'Fermer');

        const close = () => {
          overlay.remove();
          const onClose = openAllSummaryOnClose;
          const reloadOnClose = openAllSummaryReloadOnClose;

          openAllSummaryCards = [];
          openAllError = null;
          openAllSummaryTitle = 'Cartes obtenues';
          openAllSummaryOnClose = null;
          openAllSummaryReloadOnClose = true;

          try {
            onClose?.();
          } catch (error) {
            reportError('fermeture récap', error);
          }

          if (reloadOnClose) {
            location.reload();
          }
        };

        closeButton.addEventListener('click', close);

        header.append(headingWrap, closeButton);

        const list = document.createElement('div');
        list.className = 'wm-open-all-list';

        const footer = document.createElement('div');
        footer.className = 'wm-open-all-footer';
        footer.dataset.role = 'footer';

        modal.append(header, list, footer);
        overlay.append(modal);
        document.body.append(overlay);

        renderOpenAllSummary();
      }

      function mergePulledCardsIntoCollectionCache(cards) {
        const stored = storageGet(ALL_COLLECTION_KEY);
        const entry = stored[ALL_COLLECTION_KEY];
        if (!Array.isArray(entry?.cards) || !entry.cards.length) return;

        const byId = new Map(entry.cards.map((card) => [card.id, { ...card }]));
        const addedCounts = new Map();

        for (const card of cards) {
          addedCounts.set(card.id, (addedCounts.get(card.id) || 0) + 1);
          const existing = byId.get(card.id);
          if (!existing) {
            byId.set(card.id, { ...card, count: 0 });
          }
        }

        for (const [id, amount] of addedCounts) {
          const current = byId.get(id);
          current.count = (Number(current.count) || 0) + amount;
        }

        storageSet({
          [ALL_COLLECTION_KEY]: {
            ...entry,
            cards: [...byId.values()]
          }
        });
      }

      function renderPackRecap() {
        const existing = document.getElementById('wm-pack-recap');

        if (
          !runtime.settings.isEnabled('packRecap') ||
          !isPullsPage() ||
          !pullRecapEnabled ||
          packRecapDismissed ||
          !activePackRecap?.cards?.length ||
          !isLastPullCardVisible()
        ) {
          existing?.remove();
          return;
        }

        const signature = JSON.stringify(activePackRecap.cards.map((card) => [
          card.id, card.rarity, cacheMemory.get(card.id)
        ]));
        if (existing?.dataset.signature === signature) return;
        const panel = existing || document.createElement('aside');
        panel.id = 'wm-pack-recap';
        panel.className = 'wm-pack-recap';
        panel.dataset.signature = signature;
        panel.replaceChildren();

        const header = document.createElement('div');
        header.className = 'wm-pack-recap-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = 'Prix moyens du paquet';

        const subtitle = document.createElement('span');
        const loaded = activePackRecap.cards.filter((card) => cacheMemory.has(card.id)).length;
        subtitle.textContent = `${loaded}/${activePackRecap.cards.length} chargées`;

        headingWrap.append(title, subtitle);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'wm-pack-recap-close';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Fermer le récap');
        close.addEventListener('click', () => {
          packRecapDismissed = true;
          panel.remove();
        });

        header.append(headingWrap, close);

        const list = document.createElement('div');
        list.className = 'wm-pack-recap-list';

        let total = 0;
        let priced = 0;

        for (const card of activePackRecap.cards) {
          const row = document.createElement('div');
          row.className = 'wm-pack-recap-row';

          const rarity = document.createElement('span');
          rarity.className = 'wm-pack-recap-rarity';
          rarity.textContent = card.rarity || '—';

          const name = document.createElement('span');
          name.className = 'wm-pack-recap-name';
          name.textContent = card.title;

          const value = document.createElement('span');
          value.className = 'wm-pack-recap-price';

          const cacheEntry = cacheMemory.get(card.id);
          if (!cacheEntry) {
            value.classList.add('is-loading');
            const spinner = document.createElement('span');
            spinner.className = 'wm-average-spinner';
            value.append(spinner, document.createTextNode('…'));
          } else {
            const average = chooseAverage(cacheEntry, null, card.rarity || null);
            if (Number.isFinite(average)) {
              total += average;
              priced += 1;
              value.textContent = `${formatAverage(average)} W`;
            } else {
              value.textContent = '—';
              value.classList.add('is-empty');
            }
          }

          row.append(rarity, name, value);
          list.append(row);
        }

        const footer = document.createElement('div');
        footer.className = 'wm-pack-recap-footer';

        if (loaded < activePackRecap.cards.length) {
          footer.textContent = 'Chargement des prix moyens…';
        } else if (priced === 0) {
          footer.textContent = 'Aucune carte n’a de prix moyen';
        } else {
          footer.textContent = `Total des prix moyens connus : ${formatAverage(total)} W`;
        }

        panel.append(header, list, footer);

        if (!existing) {
          document.body.append(panel);
        }
      }

      function handlePackOpened(cards) {
        if (!Array.isArray(cards) || !cards.length) return;

        runtime.pullStats.recordPullStats(cards);
        mergePulledCardsIntoCollectionCache(cards);

        if (!runtime.settings.isEnabled('packRecap')) return;

        activePackRecap = {
          openedAt: Date.now(),
          cards
        };
        packRecapDismissed = false;

        try {
          runtime.priceLoader.loadCacheForCards(cards);
          renderPackRecap();
        } catch (error) {
          reportError('paquet', error);
        }
      }


      document.addEventListener('click', (event) => {
        if (!isPullsPage() || !activePackRecap) return;

        const button = event.target?.closest?.('button');
        if (!button) return;

        // Dès que l'utilisateur valide le widget de confirmation, on masque le
        // récap du paquet précédent pour laisser la place à la suite.
        if (button.parentElement?.querySelector('input[name="website"]')) {
          packRecapDismissed = true;
          document.getElementById('wm-pack-recap')?.remove();
        }
      }, true);

      window.addEventListener('wm-average-open-all-packs-progress', (event) => {
        const detail = event.detail || {};
        if (!openAllActive || detail.requestId !== openAllRequestId) return;

        const previousOpenedPacks = openAllOpenedPacks;
        openAllOpenedPacks = Number(detail.openedPacks) || 0;

        setOpenAllProgress(openAllOpenedPacks, detail.packsRemaining, detail.waiting ? detail.waitMs : null);
        if (detail.waiting) return;

        const packCards = Array.isArray(detail.cards) ? detail.cards : [];
        if (!packCards.length || openAllOpenedPacks <= previousOpenedPacks) return;

        runtime.pullStats.recordPullStats(packCards);
        openAllSummaryCards.push(...packCards);
        mergePulledCardsIntoCollectionCache(packCards);
        // Sauvegarder à chaque paquet permet de retrouver la session après un rechargement.
        if (autoOpenRequestId === openAllRequestId) {
          appendAutomaticOpenResult({ ok: true, openedPacks: 1, cards: packCards, countRun: false });
        }

        const uniquePackCards = [...new Map(packCards.map((card) => [card.id, card])).values()];
        try {
          runtime.priceLoader.loadCacheForCards(uniquePackCards);
        } catch (error) {
          reportError('prix pendant tout ouvrir', error);
        }
      });

      window.addEventListener('wm-average-open-all-packs-result', (event) => {
        const detail = event.detail || {};
        if (!openAllActive || detail.requestId !== openAllRequestId) return;

        const wasAutomatic = Boolean(autoOpenRequestId && detail.requestId === autoOpenRequestId);

        openAllActive = false;
        openAllRequestId = null;
        if (openAllProgressLabel) openAllProgressLabel.hidden = true;

        if (openAllButton?.isConnected) {
          openAllButton.disabled = false;
          openAllButton.textContent = 'Tout ouvrir';
        }

        const cards = Array.isArray(detail.cards) ? detail.cards : [];
        const openedPacks = Number(detail.openedPacks) || 0;

        if (wasAutomatic) {
          autoOpenRequestId = null;

          if (openedPacks > 0) {
            const session = readAutoOpenSession();
            session.runs += 1;
            writeAutoOpenSession(session);
          }
          if (!detail.ok && detail.error) appendAutomaticOpenResult({ ok: false, error: detail.error });
          document.getElementById('wm-open-all-overlay')?.remove();
          document.getElementById('wm-pack-recap')?.remove();
          openAllSummaryCards = [];
          openAllError = null;

          if (autoOpenShowSummaryAfterCurrent || !autoOpenEnabled) {
            autoOpenShowSummaryAfterCurrent = false;
            showAutomaticOpenSummary();
          } else {
            scheduleNextAutoOpen({ keepExisting: false });
          }
          return;
        }

        if (!cards.length) {
          runtime.modalUi.showInfoModal(
            detail.ok ? 'Aucun paquet ouvert' : 'Ouverture impossible',
            detail.error || 'Aucun paquet disponible.'
          );
          return;
        }

        const message = detail.cancelled ? 'Ouverture arrêtée. Les cartes déjà obtenues sont conservées.'
          : (detail.ok ? null : `Ouverture interrompue : ${detail.error || 'erreur inconnue'}`);
        openOpenAllSummary(cards, openedPacks, message);
      });

      window.addEventListener('wm-average-pack-opened', (event) => {
        const cards = event.detail?.cards;
        if (!Array.isArray(cards) || !cards.length) return;
        handlePackOpened(cards);
      });


      function onPriceUpdated(id) {
        if (activePackRecap?.cards?.some((card) => card.id === id)) renderPackRecap();
        if (openAllSummaryCards.some((card) => card.id === id)) scheduleOpenAllSummaryRender();
      }

      window.addEventListener('storage', (event) => {
        if (event.key === AUTO_OPEN_ENABLED_KEY) {
          autoOpenEnabled = readLocalValue(AUTO_OPEN_ENABLED_KEY) === true;
          updateAutoOpenToggleUi();
          if (!autoOpenEnabled) {
            clearAutoOpenTimer();
            if (autoOpenRequestId) stopOpening();
          } else {
            scheduleNextAutoOpen({ keepExisting: true });
          }
        }
        if (event.key === AUTO_OPEN_NEXT_AT_KEY && autoOpenEnabled && event.newValue != null) {
          scheduleNextAutoOpen({ keepExisting: true });
        }
      });

      function isAutoOpenEnabled() {
        return runtime.settings.isEnabled('autoOpen') && autoOpenEnabled;
      }

      return {
        ensurePullsToolbar, updateAutoOpenToggleUi, renderPackRecap,
        scheduleNextAutoOpen, onPriceUpdated,
        isAutoOpenEnabled
      };
    }
  };
})();
