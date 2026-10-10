(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const OVERLAY_ID = 'wm-list-auction-overlay';
  const CSS = `
#${OVERLAY_ID}{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6);backdrop-filter:blur(3px)}
#${OVERLAY_ID} .wm-la-box{width:min(460px,100%);max-height:calc(100vh - 32px);overflow:auto;border:1px solid rgba(255,255,255,.14);border-radius:16px;background:#1d2321;color:#f8fafc;padding:20px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.6)}
#${OVERLAY_ID} h2{margin:0 0 2px;font-size:19px}
#${OVERLAY_ID} .wm-la-sub{margin:0 0 14px;color:#a8b3ae;font-size:13px}
#${OVERLAY_ID} .wm-la-card{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:10px 12px;border:1px solid rgba(255,255,255,.12);border-radius:12px}
#${OVERLAY_ID} .wm-la-card strong{display:block;font-size:15px}
#${OVERLAY_ID} .wm-la-card span{color:#a8b3ae;font-size:12px}
#${OVERLAY_ID} label.wm-la-label{display:block;margin:12px 0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
#${OVERLAY_ID} input[type=number]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:#111513;color:#fff;font-size:18px;text-align:center}
#${OVERLAY_ID} .wm-la-durations{display:flex;flex-wrap:wrap;gap:8px}
#${OVERLAY_ID} .wm-la-durations button{padding:7px 14px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:transparent;color:#f8fafc;font-weight:700;cursor:pointer}
#${OVERLAY_ID} .wm-la-durations button.is-on{background:#5cf7f0;border-color:#5cf7f0;color:#07201f}
#${OVERLAY_ID} .wm-la-msg{min-height:20px;margin:12px 0 0;font-size:13px}
#${OVERLAY_ID} .wm-la-msg.is-error{color:#fca5a5}
#${OVERLAY_ID} .wm-la-msg.is-ok{color:#6ee7b7}
#${OVERLAY_ID} .wm-la-actions{display:flex;gap:10px;margin-top:14px}
#${OVERLAY_ID} .wm-la-actions button,#${OVERLAY_ID} .wm-la-actions a{flex:1;padding:11px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#f8fafc;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
#${OVERLAY_ID} .wm-la-actions .wm-la-go{background:#5cf7f0;border-color:#5cf7f0;color:#07201f}
#${OVERLAY_ID} .wm-la-actions button:disabled{opacity:.5;cursor:default}`;

  function create(runtime) {
    const logic = runtime.listAuctionLogic;
    const listed = new Set();
    const listeners = new Set();
    let busy = false;

    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };

    async function fetchSlots() {
      try {
        const response = await fetch('/api/marketplace/mine', { credentials: 'include' });
        if (!response.ok) return null;
        return logic.slots(await response.json());
      } catch (_) {
        return null;
      }
    }

    function close() {
      document.getElementById(OVERLAY_ID)?.remove();
      document.removeEventListener('keydown', onKey, true);
    }

    function onKey(event) {
      if (event.key === 'Escape' && !busy) close();
    }

    function isListed(cardId) {
      return listed.has(cardId);
    }

    function onChange(callback) {
      listeners.add(callback);
    }

    // card : { cardId, title, rarity, average }
    function open(card) {
      if (!card?.cardId || document.getElementById(OVERLAY_ID)) return;
      runtime.uiKit?.injectStyles?.('wm-list-auction-styles', CSS);

      const state = { minutes: logic.DEFAULT_MINUTES, sent: false };
      const overlay = el('div');
      overlay.id = OVERLAY_ID;
      overlay.addEventListener('mousedown', (event) => { if (event.target === overlay && !busy) close(); });

      const box = el('div', 'wm-la-box');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const slotsLine = el('p', 'wm-la-sub', 'Un exemplaire sera mis en réserve pour la durée de l’enchère.');

      const info = el('div', 'wm-la-card');
      const infoText = el('div');
      infoText.append(el('strong', '', card.title || 'Carte'));
      const hasAverage = Number.isFinite(card.average);
      infoText.append(el('span', '', hasAverage ? `Prix moyen : ${runtime.priceUi?.formatAverage?.(card.average) ?? Math.round(card.average)} W` : 'Pas de prix moyen connu'));
      if (card.rarity) info.append(el('span', '', card.rarity));
      info.append(infoText);

      const amountLabel = el('label', 'wm-la-label', 'Mise de départ');
      const amount = document.createElement('input');
      amount.type = 'number'; amount.min = '1'; amount.step = '1';
      amount.value = String(logic.suggestBase(card.average));
      amountLabel.append(amount);

      const durationLabel = el('div', 'wm-la-label', 'Durée');
      const durations = el('div', 'wm-la-durations');
      const buttons = logic.DURATIONS.map((d) => {
        const b = el('button', d.minutes === state.minutes ? 'is-on' : '', d.label);
        b.type = 'button';
        b.addEventListener('click', () => {
          state.minutes = d.minutes;
          buttons.forEach((x, i) => x.classList.toggle('is-on', logic.DURATIONS[i].minutes === d.minutes));
        });
        return b;
      });
      durations.append(...buttons);

      const msg = el('div', 'wm-la-msg');
      const actions = el('div', 'wm-la-actions');
      const cancel = el('button', '', 'Annuler'); cancel.type = 'button';
      cancel.addEventListener('click', () => { if (!busy) close(); });
      const go = el('button', 'wm-la-go', 'Lancer l’enchère'); go.type = 'button';
      actions.append(cancel, go);

      const setMsg = (text, kind) => { msg.textContent = text; msg.className = `wm-la-msg${kind ? ` is-${kind}` : ''}`; };

      go.addEventListener('click', async () => {
        if (busy || state.sent) return;
        const built = logic.buildBody({ cardId: card.cardId, baseAmount: amount.value, minutes: state.minutes });
        if (!built.ok) {
          setMsg(built.reason === 'amount' ? 'Mise de départ invalide (entier ≥ 1).' : 'Paramètres invalides.', 'error');
          return;
        }

        busy = true; go.disabled = true; cancel.disabled = true; setMsg('Création de l’enchère…');
        try {
          const response = await fetch('/api/marketplace', {
            method: 'POST',
            credentials: 'include',
            headers: { accept: '*/*', 'content-type': 'application/json' },
            body: JSON.stringify(built.body)
          });
          let json = null;
          try { json = await response.json(); } catch (_) { /* corps vide */ }
          if (!response.ok) {
            throw new Error(String(json?.error || json?.message || `HTTP ${response.status}`));
          }

          state.sent = true;
          listed.add(card.cardId);
          for (const cb of listeners) { try { cb(); } catch (_) { /* ignoré */ } }
          setMsg(`Enchère lancée : ${built.body.base_amount} W de départ.`, 'ok');
          const id = logic.createdId(json);
          actions.replaceChildren();
          if (id) {
            const link = el('a', 'wm-la-go', 'Voir la vente');
            link.href = `/marketplace/${id}`;
            actions.append(link);
          }
          const done = el('button', '', 'Fermer'); done.type = 'button';
          done.addEventListener('click', close);
          actions.append(done);
        } catch (error) {
          // Échec : rien n'est marqué comme listé, l'utilisateur peut corriger et réessayer.
          setMsg(`Échec : ${error.message}`, 'error');
          go.disabled = false;
        } finally {
          busy = false; cancel.disabled = false;
        }
      });

      box.append(el('h2', '', 'Mettre aux enchères'), slotsLine, info, amountLabel, durationLabel, durations, msg, actions);
      overlay.append(box);
      document.body.append(overlay);
      document.addEventListener('keydown', onKey, true);
      amount.focus(); amount.select();

      fetchSlots().then((slots) => {
        if (!slots || !overlay.isConnected) return;
        slotsLine.textContent = `Enchères actives : ${slots.used}/${slots.max}`;
        if (slots.full) { setMsg('Tu as déjà atteint le maximum d’enchères simultanées.', 'error'); go.disabled = true; }
      });
    }

    return { open, isListed, onChange, close };
  }

  if (registry) registry.listAuction = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
