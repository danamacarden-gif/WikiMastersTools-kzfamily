(() => {
  const registry = typeof window !== 'undefined'
    ? (window.__wmAverageFeatures ||= {})
    : null;

  const RARITY_LABELS = {
    L: 'Légendaire',
    UR: 'Ultra rare',
    SR: 'Super rare',
    R: 'Rare',
    PC: 'Peu commun',
    C: 'Commun'
  };

  // Styles partagés. Ils sont injectés par le JS (feuille constructible), pas via le manifest :
  // ils restent donc synchronisés avec le balisage même si l'extension n'a pas été rechargée.
  const KIT_CSS = `
.wm-rarity-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--wm-rarity-color, #d1d5db);
  box-shadow: 0 0 10px color-mix(in srgb, var(--wm-rarity-color, #d1d5db) 40%, transparent);
  color: rgb(13, 17, 23);
  font-size: 11px;
  font-weight: 800;
  line-height: 1.5;
  white-space: nowrap;
}

.wm-rarity-badge[data-rarity="L"] { --wm-rarity-color: var(--color-rarity-l, #facc15); }
.wm-rarity-badge[data-rarity="UR"] { --wm-rarity-color: var(--color-rarity-ur, #f87171); }
.wm-rarity-badge[data-rarity="SR"] { --wm-rarity-color: var(--color-rarity-sr, #c084fc); }
.wm-rarity-badge[data-rarity="R"] { --wm-rarity-color: var(--color-rarity-r, #60a5fa); }
.wm-rarity-badge[data-rarity="PC"] { --wm-rarity-color: var(--color-rarity-pc, #34d399); }
.wm-rarity-badge[data-rarity="C"] { --wm-rarity-color: var(--color-rarity-c, #d1d5db); }

.wm-price {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #34d399;
  font-weight: 800;
  white-space: nowrap;
}

.wm-price svg {
  width: 16px;
  height: 16px;
  flex: none;
}
`;

  function create() {
    const sheets = new Map();

    // Injecte `css` une seule fois sous l'identifiant `id` ; repli sur un <style>.
    function injectStyles(id, css) {
      try {
        let sheet = sheets.get(id);
        if (!sheet) {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          sheets.set(id, sheet);
        }
        if (!document.adoptedStyleSheets.includes(sheet)) {
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }
        return;
      } catch (_) {
        // pas de feuilles constructibles
      }

      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = css;
      document.head.append(style);
    }

    function ensureStyles() {
      injectStyles('wm-ui-kit-styles', KIT_CSS);
    }

    // Pastille de rareté : le code (L, UR, SR, R, PC, C) dans une pastille colorée, nom complet au survol.
    function createRarityBadge(rarity) {
      if (!Object.prototype.hasOwnProperty.call(RARITY_LABELS, rarity)) return null;
      ensureStyles();

      const badge = document.createElement('span');
      badge.className = 'wm-rarity-badge';
      badge.dataset.rarity = rarity;
      badge.textContent = rarity;
      badge.title = RARITY_LABELS[rarity];
      badge.setAttribute('aria-label', RARITY_LABELS[rarity]);
      return badge;
    }

    // Icône WikiBidous du site (cercle + W), en currentColor.
    function createWikiBidousIcon() {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');

      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '9');
      const letter = document.createElementNS(ns, 'path');
      letter.setAttribute('d', 'M7.5 8.5 9.5 15.5 12 10 14.5 15.5 16.5 8.5');
      svg.append(circle, letter);
      return svg;
    }

    // Prix en vert avec l'icône du site : <span class="wm-price"><svg/>texte</span>.
    function createPrice(text) {
      ensureStyles();
      const price = document.createElement('span');
      price.className = 'wm-price';
      price.append(createWikiBidousIcon(), text);
      return price;
    }

    return { RARITY_LABELS, injectStyles, ensureStyles, createRarityBadge, createWikiBidousIcon, createPrice };
  }

  if (registry) registry.uiKit = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create, RARITY_LABELS };
})();
