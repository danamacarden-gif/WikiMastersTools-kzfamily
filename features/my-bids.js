(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.myBids = {
    create(runtime) {
      const PAGE_ID = 'wm-my-bids-page';
      const NAV_ID = 'wm-my-bids-nav';
      const ROUTE_CLASS = 'wm-bids-route';
      const SETTING_KEY = 'myBids';

      const SOUND_KEY = 'wm_my_bids_sound_v1';
      const AUTO_KEY = 'wm_auto_bids_v1';
      const DISMISSED_KEY = 'wm_bids_dismissed_v1';
      // Dans les 45 dernières secondes d'une enchère armée, on relit la liste toutes les 1,5 s.
      const FAST_WINDOW_MS = 45 * 1000;
      const FAST_REFRESH_MS = 1500;
      // En dessous de cet écart, on considère l'horloge du PC comme juste.
      const SKEW_MIN_MS = 2000;
      const POLL_VISIBLE_MS = 7000;
      const POLL_HIDDEN_MS = 20000;
      const BALANCE_REFRESH_MS = 60 * 1000;

      const { readLocalValue, writeLocalValue } = runtime.core;
      const logic = runtime.myBidsLogic;
      const autoLogic = runtime.autoBidLogic;
      const kit = runtime.uiKit;
      const alerts = logic.createAlertTracker();

      const state = {
        bids: [],
        userId: null,
        balance: null,
        loaded: false,
        error: null,
        updatedAt: 0,
        soundOn: readLocalValue(SOUND_KEY) !== false,
        pending: new Set(),
        rowErrors: new Map(),
        minHints: new Map(),
        // Auto-enchère : réglages par enchère (persistés), brouillons de saisie, panneaux ouverts.
        autoBids: autoLogic.normalizeStore(readLocalValue(AUTO_KEY), Date.now()),
        autoDrafts: new Map(),
        autoOpen: new Set(),
        autoNotes: new Map(),
        // Enchères retirées de la liste par l'utilisateur : id -> date (masquage local uniquement).
        dismissed: logic.normalizeDismissed(readLocalValue(DISMISSED_KEY)),
        lastAttempt: new Map(),
        // Écart horloge serveur - horloge locale (ms), estimé via l'en-tête Date de l'API.
        skewMs: 0
      };

      let running = false;
      let loading = false;
      let refreshQueued = false;
      let bidGeneration = 0;
      let pollTimer = null;
      let tickTimer = null;
      let balanceAt = 0;
      let lastRefreshAt = 0;
      let audioContext = null;

      // Styles propres à la page (badge, auto-enchère). Injectés par le JS : toujours synchrones avec le balisage.
      const AUTO_BID_CSS = `
.wm-bids-row {
  grid-template-columns: 46px minmax(0, 1fr) auto 76px 104px;
}

.wm-bids-rarity {
  opacity: 1;
}

.wm-bids-price {
  font-weight: 800;
}

.wm-bids-auto {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding-top: 2px;
}

.wm-bids-auto-btn {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.wm-bids-auto-btn:hover {
  border-color: rgba(52, 211, 153, 0.5);
}

.wm-bids-auto-btn.is-primary {
  border-color: rgba(52, 211, 153, 0.45);
  background: rgba(52, 211, 153, 0.14);
  color: #34d399;
}

.wm-bids-auto-state {
  font-size: 0.75rem;
  opacity: 0.75;
}

.wm-bids-auto-state.is-armed {
  color: #34d399;
  font-weight: 700;
  opacity: 1;
}

.wm-bids-auto-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(52, 211, 153, 0.3);
  border-radius: 10px;
  background: rgba(52, 211, 153, 0.06);
}

.wm-bids-auto-field {
  display: grid;
  gap: 4px;
  font-size: 0.72rem;
  font-weight: 700;
}

.wm-bids-auto-field input {
  box-sizing: border-box;
  width: 110px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 700;
}

.wm-bids-auto-field input:focus {
  border-color: #34d399;
  outline: 2px solid rgba(52, 211, 153, 0.3);
  outline-offset: 1px;
}

.wm-bids-auto-buttons {
  display: flex;
  gap: 8px;
}

.wm-bids-auto-error {
  flex: 1 1 100%;
  color: #f87171;
  font-size: 0.75rem;
}

.wm-bids-auto-error[hidden],
.wm-bids-auto-banner[hidden] {
  display: none;
}

.wm-bids-auto-help {
  flex: 1 1 100%;
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.45;
  opacity: 0.65;
}

.wm-bids-auto-note {
  grid-column: 1 / -1;
  color: #34d399;
  font-size: 0.75rem;
}

.wm-bids-auto-banner {
  display: flex;
  flex: 1 1 100%;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 10px 14px;
  border: 1px solid rgba(52, 211, 153, 0.4);
  border-radius: 10px;
  background: rgba(52, 211, 153, 0.1);
  color: #a7f3d0;
  font-size: 0.8rem;
  line-height: 1.4;
}

.wm-bids-auto-off {
  padding: 4px 10px;
  border: 1px solid rgba(248, 113, 113, 0.5);
  border-radius: 8px;
  background: transparent;
  color: #fca5a5;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.wm-bids-actions {
  display: grid;
  gap: 4px;
  align-content: start;
}

.wm-bids-remove,
.wm-bids-restore {
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.72rem;
  opacity: 0.7;
  cursor: pointer;
}

.wm-bids-remove:hover,
.wm-bids-restore:hover {
  opacity: 1;
  border-color: rgba(248, 113, 113, 0.5);
}

.wm-bids-restore {
  justify-self: center;
}

@media (max-width: 640px) {
  .wm-bids-row {
    grid-template-columns: 42px minmax(0, 1fr) 96px;
  }

  .wm-bids-actions {
    grid-column: 3;
    grid-row: 1 / span 3;
  }

  .wm-bids-actions .wm-bids-bid {
    grid-column: auto;
    grid-row: auto;
  }
}
`;

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
      }

      const serverNow = () => Date.now() + state.skewMs;

      const numberFormat = new Intl.NumberFormat('fr-FR');
      const formatAmount = (value) => `${numberFormat.format(value)} W`;

      function isBidsRoute() {
        if (location.pathname !== '/marketplace') return false;
        try {
          return new URLSearchParams(location.search).get('wm') === 'bids';
        } catch (_) {
          return false;
        }
      }

      function isBidsPage() {
        return runtime.settings.isEnabled(SETTING_KEY) && isBidsRoute();
      }

      function ensureNavLink() {
        if (!runtime.settings.isEnabled(SETTING_KEY)) {
          document.getElementById(NAV_ID)?.remove();
          return;
        }

        let link = document.getElementById(NAV_ID);

        if (!link) {
          const anchor =
            document.querySelector('nav a[href="/marketplace"]') ||
            document.querySelector('nav a[href="/collection"]');

          if (!anchor?.parentElement) return;

          link = document.createElement('a');
          link.id = NAV_ID;
          link.href = '/marketplace?wm=bids';
          link.className = 'wm-family-nav flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200';

          const icon = document.createElement('span');
          icon.className = 'wm-family-nav-icon';
          icon.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15.5 14"></polyline>
            </svg>`;

          const label = document.createElement('span');
          label.textContent = 'Mes enchères';

          link.append(icon, label);
          anchor.insertAdjacentElement('afterend', link);
        }

        link.classList.toggle('is-active', isBidsPage());
        if (isBidsPage()) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }

      function buildPage() {
        kit.ensureStyles();
        kit.injectStyles('wm-auto-bid-styles', AUTO_BID_CSS);
        const page = document.createElement('section');
        page.id = PAGE_ID;
        page.className = 'wm-bids-page';

        const shell = document.createElement('div');
        shell.className = 'wm-bids-shell';

        const content = document.createElement('div');
        content.dataset.role = 'page-content';

        shell.append(content);
        page.append(shell);
        return page;
      }

      function audioRunning() {
        return audioContext?.state === 'running';
      }

      function unlockAudio() {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return;
          audioContext ||= new AudioCtx();
          if (audioContext.state === 'suspended') {
            audioContext.resume().then(updateSoundButton).catch(() => {});
          }
        } catch (error) {
          console.debug('[WM Average] audio indisponible', error);
        }
      }

      function playUrgentBeep() {
        if (!audioRunning()) return;

        const now = audioContext.currentTime;
        for (let index = 0; index < 3; index += 1) {
          const start = now + index * 0.16;
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.type = 'square';
          oscillator.frequency.setValueAtTime(index === 2 ? 1175 : 880, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.09, start + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.14);
        }
      }

      function checkAlerts() {
        if (state.soundOn && !audioRunning()) return;
        const fresh = alerts.collect(logic.visibleBids(state.bids, state.dismissed), serverNow());
        if (fresh.length && state.soundOn) playUrgentBeep();
      }

      async function fetchBids() {
        const response = await fetch('/api/marketplace?page=1&limit=1&mine=1', {
          method: 'GET',
          credentials: 'include',
          headers: { accept: '*/*' }
        });

        if (response.status === 401 || response.status === 403) {
          throw new Error('Session expirée, reconnecte-toi à WikiMasters.');
        }
        if (!response.ok) throw new Error(`Actualisation impossible (HTTP ${response.status}).`);

        // L'en-tête Date a une précision d'1 s : on ne corrige que si l'horloge du PC est nettement décalée.
        const serverTime = Date.parse(response.headers.get('date') || '');
        if (Number.isFinite(serverTime)) {
          const skew = serverTime - Date.now();
          state.skewMs = Math.abs(skew) >= SKEW_MIN_MS ? skew : 0;
        }

        return logic.extractBids(await response.json());
      }

      async function refreshBalance() {
        balanceAt = Date.now();

        try {
          const response = await fetch('/api/wikibidous', {
            method: 'GET',
            credentials: 'include',
            headers: { accept: '*/*' }
          });
          if (!response.ok) return;

          const balance = Number((await response.json())?.balance);
          if (Number.isFinite(balance)) {
            state.balance = balance;
            renderHeader();
          }
        } catch (_) {}
      }

      async function refresh() {
        if (loading) {
          refreshQueued = true;
          return;
        }
        loading = true;
        lastRefreshAt = Date.now();
        const generation = bidGeneration;

        try {
          const bids = await fetchBids();
          if (generation !== bidGeneration) return;
          state.bids = bids;
          const ids = new Set(bids.map((item) => item.id));
          for (const id of state.minHints.keys()) {
            if (!ids.has(id)) state.minHints.delete(id);
          }
          state.userId = logic.parseUserIdFromCookies(document.cookie);
          forgetFinishedAutoBids(ids);
          const pruned = logic.pruneDismissed(state.dismissed, ids);
          if (Object.keys(pruned).length !== Object.keys(state.dismissed).length) {
            state.dismissed = pruned;
            writeLocalValue(DISMISSED_KEY, state.dismissed);
          }
          state.error = null;
          state.loaded = true;
          state.updatedAt = Date.now();
          checkAlerts();
          autoStep();

          if (Date.now() - balanceAt > BALANCE_REFRESH_MS) refreshBalance();
        } catch (error) {
          state.error = String(error?.message || error);
        } finally {
          loading = false;
          try {
            renderAll();
          } catch (error) {
            console.debug('[WM Average] rendu Mes enchères', error);
          }
          if (refreshQueued) {
            refreshQueued = false;
            if (running) refresh();
          }
        }
      }

      // Renvoie { ok } : l'auto-enchère s'en sert pour compter les mises et les échecs.
      async function placeBid(auctionId, options = {}) {
        const bid = state.bids.find((item) => item.id === auctionId);
        if (!bid || state.pending.has(auctionId)) return { ok: false, skipped: true };

        const amount = Number.isInteger(options.amount) ? options.amount : bidAmountFor(bid);
        let ok = false;
        state.pending.add(auctionId);
        state.rowErrors.delete(auctionId);
        renderList();

        try {
          const response = await fetch(`/api/marketplace/${encodeURIComponent(auctionId)}/bid`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
          });

          let json = null;
          try {
            json = await response.json();
          } catch (_) {}

          if (!response.ok) {
            state.rowErrors.set(
              auctionId,
              `${options.auto ? 'Auto : ' : ''}${String(json?.error || json?.message || `Mise refusée (HTTP ${response.status}).`)}`
            );

            const minimum = logic.parseMinimumFromError(state.rowErrors.get(auctionId));
            if (minimum) {
              state.minHints.set(auctionId, { price: logic.currentPrice(bid), amount: minimum });
            }
          } else {
            ok = true;
            bidGeneration += 1;
            state.bids = state.bids.map((item) =>
              item.id === auctionId
                ? logic.applyBidResult(item, json, amount, state.userId)
                : item
            );

            const balance = Number(json?.bidder_balance);
            if (Number.isFinite(balance)) state.balance = balance;
          }
        } catch (_) {
          state.rowErrors.set(auctionId, 'Erreur réseau, réessaie.');
        } finally {
          state.pending.delete(auctionId);
          renderAll();
          if (running) refresh();
        }

        return { ok };
      }

      // ---- Auto-enchère ---------------------------------------------------------------

      function saveAutoBids() {
        writeLocalValue(AUTO_KEY, state.autoBids);
      }

      function setAutoConfig(auctionId, config) {
        state.autoBids = { ...state.autoBids, [auctionId]: { ...config, updatedAt: Date.now() } };
        saveAutoBids();
      }

      function removeAutoConfig(auctionId) {
        const { [auctionId]: _removed, ...rest } = state.autoBids;
        state.autoBids = rest;
        state.autoDrafts.delete(auctionId);
        state.autoOpen.delete(auctionId);
        state.autoNotes.delete(auctionId);
        state.lastAttempt.delete(auctionId);
        saveAutoBids();
      }

      function disarmAuto(auctionId, reason) {
        const config = state.autoBids[auctionId];
        if (!config) return;
        setAutoConfig(auctionId, autoLogic.disarm(config, reason));
        renderList();
        renderHeader();
      }

      function disarmAll() {
        for (const [id, config] of Object.entries(state.autoBids)) {
          if (config.armed) state.autoBids[id] = autoLogic.disarm(config, 'manual');
        }
        saveAutoBids();
        renderAll();
      }

      // Une enchère qui n'est plus dans la liste est terminée : son réglage n'a plus lieu d'être.
      function forgetFinishedAutoBids(presentIds) {
        let changed = false;
        for (const id of Object.keys(state.autoBids)) {
          if (!presentIds.has(id)) {
            const { [id]: _removed, ...rest } = state.autoBids;
            state.autoBids = rest;
            state.autoNotes.delete(id);
            state.autoOpen.delete(id);
            state.autoDrafts.delete(id);
            changed = true;
          }
        }
        if (changed) saveAutoBids();
      }

      async function runAutoBid(bid, amount) {
        state.lastAttempt.set(bid.id, Date.now());
        const remaining = Math.max(0, Math.round(logic.remainingMs(bid, serverNow()) / 1000));
        const result = await placeBid(bid.id, { amount, auto: true });
        if (result.skipped) return;

        const config = state.autoBids[bid.id];
        if (!config) return;

        if (result.ok) {
          setAutoConfig(bid.id, autoLogic.afterBidSuccess(config));
          state.autoNotes.set(bid.id, `Auto : mise de ${formatAmount(amount)} placée à ${remaining} s de la fin.`);
        } else {
          setAutoConfig(bid.id, autoLogic.afterBidFailure(config));
        }
        renderAll();
      }

      // Appelée chaque seconde et après chaque actualisation : décide, pour chaque enchère armée,
      // s'il faut miser, attendre ou s'arrêter, et resserre l'actualisation en fin d'enchère.
      function autoStep() {
        if (!running || !state.loaded) return;

        const now = serverNow();
        let needFast = false;

        for (const bid of logic.visibleBids(state.bids, state.dismissed)) {
          const config = state.autoBids[bid.id];
          if (!config?.armed) continue;

          const remaining = logic.remainingMs(bid, now);
          if (remaining > 0 && remaining <= FAST_WINDOW_MS) needFast = true;
          if (state.pending.has(bid.id)) continue;

          const decision = autoLogic.decide({
            config,
            remainingMs: remaining,
            leading: logic.bidStatus(bid, state.userId) === 'leading',
            nextAmount: bidAmountFor(bid),
            balance: state.balance,
            now: Date.now(),
            lastAttemptAt: state.lastAttempt.get(bid.id) || 0
          });

          if (decision.action === 'stop') {
            disarmAuto(bid.id, decision.reason);
          } else if (decision.action === 'bid') {
            runAutoBid(bid, decision.amount);
          }
        }

        if (needFast && !loading && Date.now() - lastRefreshAt >= FAST_REFRESH_MS) refresh();
      }

      function pageContent() {
        return document.querySelector(`#${PAGE_ID} [data-role="page-content"]`);
      }

      function soundLabel() {
        if (!state.soundOn) return 'Son coupé';
        return audioRunning() ? 'Son activé' : 'Cliquer pour activer le son';
      }

      function updateSoundButton() {
        const button = document.querySelector(`#${PAGE_ID} [data-role="sound"]`);
        if (!button) return;
        button.textContent = soundLabel();
        button.classList.toggle('is-off', !state.soundOn);
        button.classList.toggle('is-blocked', state.soundOn && !audioRunning());
      }

      function buildHeader() {
        const header = el('div', 'wm-bids-head');
        header.dataset.role = 'header';

        const titleWrap = el('div', 'wm-bids-title');
        titleWrap.append(
          el('h1', null, 'Mes enchères'),
          el('p', 'wm-bids-sub', null)
        );
        titleWrap.lastChild.dataset.role = 'sub';

        const controls = el('div', 'wm-bids-controls');

        const banner = el('div', 'wm-bids-auto-banner');
        banner.dataset.role = 'auto-banner';
        banner.hidden = true;

        const balance = el('span', 'wm-bids-balance', null);
        balance.dataset.role = 'balance';

        const sound = el('button', 'wm-bids-sound', soundLabel());
        sound.type = 'button';
        sound.dataset.role = 'sound';
        sound.addEventListener('click', () => {
          if (state.soundOn && !audioRunning()) {
            unlockAudio();
            setTimeout(() => {
              playUrgentBeep();
              updateSoundButton();
            }, 120);
            return;
          }

          state.soundOn = !state.soundOn;
          writeLocalValue(SOUND_KEY, state.soundOn);
          if (state.soundOn) {
            unlockAudio();
            setTimeout(() => {
              playUrgentBeep();
              updateSoundButton();
            }, 120);
          }
          updateSoundButton();
        });

        controls.append(balance, sound);
        header.append(titleWrap, controls, banner);
        return header;
      }

      function renderHeader() {
        const balance = document.querySelector(`#${PAGE_ID} [data-role="balance"]`);
        if (balance) {
          balance.textContent = state.balance == null ? '' : `Solde : ${formatAmount(state.balance)}`;
        }

        const sub = document.querySelector(`#${PAGE_ID} [data-role="sub"]`);
        if (sub) {
          if (state.error) {
            sub.textContent = state.error;
            sub.classList.add('is-error');
          } else if (!state.loaded) {
            sub.textContent = 'Chargement…';
            sub.classList.remove('is-error');
          } else {
            const time = new Date(state.updatedAt).toLocaleTimeString('fr-FR');
            sub.textContent = `${state.bids.length} en cours, actualisé à ${time}`;
            sub.classList.remove('is-error');
          }
        }

        updateSoundButton();
        renderAutoBanner();
      }

      function renderAutoBanner() {
        const banner = document.querySelector(`#${PAGE_ID} [data-role="auto-banner"]`);
        if (!banner) return;

        const armedCount = Object.values(state.autoBids).filter((config) => config.armed).length;
        banner.hidden = armedCount === 0;
        banner.replaceChildren();
        if (!armedCount) return;

        const text = el(
          'span',
          null,
          `⚡ Auto-enchère armée sur ${armedCount} enchère${armedCount > 1 ? 's' : ''}. Garde cet onglet ouvert et visible : si la page est fermée ou mise longtemps en arrière-plan, aucune mise ne partira.`
        );
        const off = el('button', 'wm-bids-auto-off', 'Tout désarmer');
        off.type = 'button';
        off.addEventListener('click', disarmAll);
        banner.append(text, off);
      }

      function bidAmountFor(bid) {
        const computed = logic.nextBidAmount(bid);
        const hint = state.minHints.get(bid.id);
        return hint && hint.price === logic.currentPrice(bid)
          ? Math.max(computed, hint.amount)
          : computed;
      }

      function isBidDisabled(bid, remaining) {
        return state.pending.has(bid.id) ||
          remaining <= 0 ||
          logic.bidStatus(bid, state.userId) === 'leading';
      }

      function buildAutoBlock(bid, remaining) {
        const block = el('div', 'wm-bids-auto');
        block.dataset.role = 'auto';
        if (remaining <= 0) return block;

        const config = state.autoBids[bid.id];
        const open = state.autoOpen.has(bid.id);
        const minimum = bidAmountFor(bid);

        const openPanel = () => {
          if (!state.autoDrafts.has(bid.id)) {
            state.autoDrafts.set(bid.id, {
              max: config ? String(config.max) : '',
              maxBids: config ? (config.maxBids == null ? '' : String(config.maxBids)) : String(autoLogic.DEFAULT_MAX_BIDS)
            });
          }
          state.autoOpen.add(bid.id);
          renderList();
        };

        if (config?.armed) {
          const summary = el(
            'span',
            'wm-bids-auto-state is-armed',
            `⚡ Auto armée : max ${formatAmount(config.max)} • ${config.maxBids == null ? `${config.placed} mise${config.placed > 1 ? 's' : ''} (illimité)` : `${config.placed}/${config.maxBids} mise${config.maxBids > 1 ? 's' : ''}`} • à ${autoLogic.TRIGGER_MS / 1000} s de la fin`
          );
          const off = el('button', 'wm-bids-auto-btn', 'Désarmer');
          off.type = 'button';
          off.dataset.role = 'auto-disarm';
          off.addEventListener('click', () => disarmAuto(bid.id, 'manual'));
          block.append(summary, off);
          return block;
        }

        if (!open) {
          const toggle = el('button', 'wm-bids-auto-btn', config?.stopReason && config.stopReason !== 'manual' ? '⚡ Reconfigurer l’auto-enchère' : '⚡ Auto-enchère');
          toggle.type = 'button';
          toggle.dataset.role = 'auto-open';
          toggle.addEventListener('click', openPanel);
          block.append(toggle);

          const why = config?.stopReason ? autoLogic.STOP_MESSAGES[config.stopReason] : null;
          if (why) block.append(el('span', 'wm-bids-auto-state', `Auto arrêtée : ${why}`));
          return block;
        }

        const draft = state.autoDrafts.get(bid.id) || { max: '', maxBids: String(autoLogic.DEFAULT_MAX_BIDS) };
        const panel = el('form', 'wm-bids-auto-panel');
        panel.dataset.role = 'auto-panel';
        // Nos messages d'erreur remplacent les bulles natives du navigateur.
        panel.noValidate = true;

        const field = (labelText, key, extra) => {
          const label = el('label', 'wm-bids-auto-field');
          label.append(el('span', null, labelText));
          const input = document.createElement('input');
          input.type = 'number';
          input.step = '1';
          input.inputMode = 'numeric';
          input.autocomplete = 'off';
          input.dataset.role = `auto-${key}`;
          input.value = draft[key] ?? '';
          Object.assign(input, extra);
          input.addEventListener('input', () => {
            state.autoDrafts.set(bid.id, { ...(state.autoDrafts.get(bid.id) || draft), [key]: input.value });
          });
          label.append(input);
          return label;
        };

        const maxField = field('Prix max (W)', 'max', { min: String(minimum), placeholder: `≥ ${minimum}` });
        const bidsField = field('Mises max (vide = illimité)', 'maxBids', { min: '1', placeholder: 'illimité' });

        const error = el('div', 'wm-bids-auto-error');
        error.dataset.role = 'auto-error';
        error.hidden = true;

        const arm = el('button', 'wm-bids-auto-btn is-primary', 'Armer');
        arm.type = 'submit';
        arm.dataset.role = 'auto-arm';

        const cancel = el('button', 'wm-bids-auto-btn', 'Annuler');
        cancel.type = 'button';
        cancel.addEventListener('click', () => {
          document.activeElement?.blur?.();
          state.autoOpen.delete(bid.id);
          state.autoDrafts.delete(bid.id);
          renderList();
        });

        const help = el(
          'p',
          'wm-bids-auto-help',
          `À ${autoLogic.TRIGGER_MS / 1000} s de la fin, si tu n’es pas en tête, mise le minimum requis (${formatAmount(minimum)} maintenant), puis recommence après chaque surenchère, jusqu’au prix max (et au nombre de mises si tu en as fixé un). Onglet à garder ouvert et visible.`
        );

        panel.addEventListener('submit', (event) => {
          event.preventDefault();
          const current = state.bids.find((item) => item.id === bid.id);
          const values = state.autoDrafts.get(bid.id) || draft;
          const result = autoLogic.validateConfig(values, current ? bidAmountFor(current) : minimum);

          if (!result.ok) {
            error.textContent = {
              'invalid-max': 'Prix max : entre un nombre entier.',
              'max-too-low': `Prix max trop bas : la prochaine mise minimale est de ${formatAmount(current ? bidAmountFor(current) : minimum)}.`,
              'invalid-bids': 'Mises max : un entier ≥ 1, ou laisse vide pour illimité.'
            }[result.reason] || 'Réglage invalide.';
            error.hidden = false;
            return;
          }

          // On quitte le champ : sinon la ligne en cours de saisie ne serait pas reconstruite.
          document.activeElement?.blur?.();
          setAutoConfig(bid.id, result.config);
          state.autoOpen.delete(bid.id);
          state.autoDrafts.delete(bid.id);
          state.autoNotes.delete(bid.id);
          renderAll();
          autoStep();
        });

        const buttons = el('div', 'wm-bids-auto-buttons');
        buttons.append(arm, cancel);
        panel.append(maxField, bidsField, buttons, error, help);
        block.append(panel);
        return block;
      }

      function dismissBid(auctionId) {
        const bid = state.bids.find((item) => item.id === auctionId);
        if (!bid) return;
        const leading = logic.bidStatus(bid, state.userId) === 'leading' && logic.remainingMs(bid, serverNow()) > 0;
        if (leading && !window.confirm('Tu es en tête sur cette enchère. Ta mise reste valable sur le site : si personne ne surenchérit, tu remporteras la carte et le montant sera débité. Retirer seulement l’enchère de cette liste ?')) return;

        removeAutoConfig(auctionId);
        state.rowErrors.delete(auctionId);
        state.dismissed = { ...state.dismissed, [auctionId]: Date.now() };
        writeLocalValue(DISMISSED_KEY, state.dismissed);
        renderAll();
      }

      function restoreDismissed() {
        state.dismissed = {};
        writeLocalValue(DISMISSED_KEY, state.dismissed);
        renderAll();
      }

      function buildRow(bid) {
        const now = serverNow();
        const remaining = logic.remainingMs(bid, now);
        const status = logic.bidStatus(bid, state.userId);
        const nextAmount = bidAmountFor(bid);
        const pending = state.pending.has(bid.id);

        const row = el('li', 'wm-bids-row');
        row.dataset.auctionId = bid.id;
        row.classList.toggle('is-ended', remaining <= 0);
        row.classList.toggle('is-urgent', remaining > 0 && remaining <= 60000);

        const rarity = String(bid.snapshot_rarity || bid.card?.rarity || '');
        const rarityCell = el('span', 'wm-bids-rarity');
        const rarityBadge = kit.createRarityBadge(rarity);
        if (rarityBadge) rarityCell.append(rarityBadge);
        else rarityCell.textContent = rarity;
        row.append(rarityCell);

        const title = el('a', 'wm-bids-card', bid.card?.wikipedia_title || 'Carte');
        title.href = `/marketplace/${encodeURIComponent(bid.id)}`;

        const info = el('div', 'wm-bids-info');
        info.append(title);

        if (status === 'leading') info.append(el('span', 'wm-bids-badge is-leading', 'En tête'));
        else if (status === 'outbid') info.append(el('span', 'wm-bids-badge is-outbid', 'Dépassé'));

        const price = el('span', 'wm-bids-price');
        price.append(kit.createPrice(formatAmount(logic.currentPrice(bid))));

        const countdown = el('span', 'wm-bids-countdown', logic.formatRemaining(remaining));
        countdown.dataset.role = 'countdown';

        const button = el('button', 'wm-bids-bid', pending ? '…' : `Miser ${numberFormat.format(nextAmount)}`);
        button.type = 'button';
        button.disabled = isBidDisabled(bid, remaining);
        button.title = status === 'leading'
          ? 'Tu es déjà en tête'
          : `Miser ${formatAmount(nextAmount)}`;
        button.setAttribute('aria-label', `Miser ${formatAmount(nextAmount)} sur ${bid.card?.wikipedia_title || 'cette carte'}`);
        button.addEventListener('click', () => placeBid(bid.id));

        // « Retirer » : masque l'enchère de la liste et désarme l'auto-enchère. Le site ne permet pas
        // d'annuler une mise : si tu mènes, ta mise reste valable.
        const remove = el('button', 'wm-bids-remove', 'Retirer');
        remove.type = 'button';
        remove.dataset.role = 'dismiss';
        remove.title = 'Retire cette enchère de la liste et désarme l’auto-enchère. N’annule pas une mise déjà placée.';
        remove.setAttribute('aria-label', `Retirer ${bid.card?.wikipedia_title || 'cette enchère'} de ma liste`);
        remove.addEventListener('click', () => dismissBid(bid.id));

        const actions = el('div', 'wm-bids-actions');
        actions.append(button, remove);
        row.append(info, price, countdown, actions);
        row.append(buildAutoBlock(bid, remaining));

        const note = state.autoNotes.get(bid.id);
        if (note) row.append(el('div', 'wm-bids-auto-note', note));

        const error = state.rowErrors.get(bid.id);
        if (error) {
          const message = el('div', 'wm-bids-row-error', error);
          message.setAttribute('role', 'alert');
          row.append(message);
        }

        return row;
      }

      function renderList() {
        const content = pageContent();
        if (!content) return;

        let list = content.querySelector('[data-role="list"]');
        if (!list) return;

        const sorted = logic.sortBids(logic.visibleBids(state.bids, state.dismissed), serverNow());

        // Une ligne dont un champ a le focus n'est pas reconstruite : sinon l'actualisation
        // (toutes les 1,5 s en fin d'enchère) ferait perdre la saisie.
        const kept = new Map();
        for (const existing of list.children) {
          const active = document.activeElement;
          if (active?.tagName === 'INPUT' && existing.contains(active)) {
            kept.set(existing.dataset.auctionId, existing);
          }
        }
        const desired = sorted.map((bid) => kept.get(bid.id) || buildRow(bid));

        // Pas de replaceChildren : retirer puis remettre une ligne fait perdre le focus de son champ.
        for (const child of [...list.children]) {
          if (!desired.includes(child)) child.remove();
        }
        desired.forEach((node, index) => {
          if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
        });

        const empty = content.querySelector('[data-role="empty"]');
        if (empty) empty.hidden = !(state.loaded && !state.error && !sorted.length);

        const hiddenCount = logic.visibleBids(state.bids, {}).length - sorted.length;
        const restore = content.querySelector('[data-role="dismissed"]');
        if (restore) {
          restore.hidden = hiddenCount <= 0;
          restore.textContent = `${hiddenCount} enchère${hiddenCount > 1 ? 's' : ''} retirée${hiddenCount > 1 ? 's' : ''} de la liste — réafficher`;
        }
      }

      function renderAll() {
        renderHeader();
        renderList();
      }

      function buildContent() {
        const fragment = document.createDocumentFragment();

        const list = el('ul', 'wm-bids-list');
        list.dataset.role = 'list';

        const empty = el('p', 'wm-bids-empty', 'Vous n’êtes en lice sur aucune enchère.');
        empty.dataset.role = 'empty';
        empty.hidden = true;

        const restore = el('button', 'wm-bids-restore', '');
        restore.type = 'button';
        restore.dataset.role = 'dismissed';
        restore.hidden = true;
        restore.addEventListener('click', restoreDismissed);

        fragment.append(buildHeader(), list, empty, restore);
        return fragment;
      }

      function tick() {
        const now = serverNow();

        for (const row of document.querySelectorAll(`#${PAGE_ID} .wm-bids-row`)) {
          const bid = state.bids.find((item) => item.id === row.dataset.auctionId);
          if (!bid) continue;

          const remaining = logic.remainingMs(bid, now);
          const countdown = row.querySelector('[data-role="countdown"]');
          if (countdown) countdown.textContent = logic.formatRemaining(remaining);

          row.classList.toggle('is-ended', remaining <= 0);
          row.classList.toggle('is-urgent', remaining > 0 && remaining <= 60000);

          const button = row.querySelector('.wm-bids-bid');
          if (button) button.disabled = isBidDisabled(bid, remaining);
        }

        checkAlerts();
        updateSoundButton();
        autoStep();
      }

      function schedulePoll() {
        clearTimeout(pollTimer);
        if (!running) return;

        pollTimer = setTimeout(async () => {
          try {
            await refresh();
          } finally {
            schedulePoll();
          }
        }, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
      }

      function onVisibilityChange() {
        if (!running) return;
        if (!document.hidden) refresh();
        schedulePoll();
      }

      function start() {
        if (running) return;
        running = true;

        document.addEventListener('visibilitychange', onVisibilityChange);
        for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
          document.addEventListener(type, unlockAudio, true);
        }

        tickTimer = setInterval(tick, 1000);
        refresh();
        schedulePoll();
      }

      function stop() {
        if (!running) return;
        running = false;

        clearTimeout(pollTimer);
        clearInterval(tickTimer);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
          document.removeEventListener(type, unlockAudio, true);
        }
      }

      function ensurePage() {
        const enabled = runtime.settings.isEnabled(SETTING_KEY);

        if (!enabled && isBidsRoute()) {
          document.documentElement.classList.remove(ROUTE_CLASS);
          document.getElementById(PAGE_ID)?.remove();
          stop();
          location.replace('/marketplace');
          return;
        }

        const active = enabled && isBidsRoute();
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
          page = buildPage();
          main.append(page);
          page.querySelector('[data-role="page-content"]').append(buildContent());
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

      return { render, isBidsPage };
    }
  };
})();
