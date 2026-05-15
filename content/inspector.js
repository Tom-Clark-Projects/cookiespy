/**
 * CookieSpy — Hover Inspector (content script)
 *
 * When enabled (toggle in the popup), hovering a resource element on the page
 * outlines it and shows a small tooltip with:
 *   - the domain that served it
 *   - the request type (script, image, iframe, ...)
 *   - first-party vs third-party (relative to the page's own root domain)
 *   - the CookieSpy threat score, fetched from the background's cache
 *
 * Scope is deliberately limited to real *resource elements* — <img>, <script>,
 * <iframe>, <video>, <audio>, <source>, <link>, <embed>, <object> — because
 * their source URL is right there in the DOM. We don't try to attribute
 * arbitrary <div>/<button> elements to a domain: that lineage isn't reliably
 * recoverable from the DOM and would only produce confident-looking guesses.
 *
 * The script is always injected but completely inert until the toggle is on.
 */

(() => {
  'use strict';

  // Guard against double-initialisation within a single frame.
  if (window.__cookieSpyInspectorLoaded) return;
  window.__cookieSpyInspectorLoaded = true;

  const STYLE_ID      = '__cookiespy-inspector-style';
  const TOOLTIP_ID    = '__cookiespy-inspector-tooltip';
  const HIGHLIGHT_CLS = '__cookiespy-inspector-highlight';

  let enabled       = false;
  let tooltipEl     = null;
  let currentTarget = null;
  let reqToken      = 0;   // guards async threat responses against fast hovers

  // --- Root-domain heuristic (mirrors background.js) ------------------------
  function getRootDomain(hostname) {
    if (!hostname) return '';
    const parts = hostname.replace(/^\./, '').split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    if (sld.length <= 3 && parts.length >= 3) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }

  const pageRoot = getRootDomain(location.hostname);

  // --- Element classification ----------------------------------------------
  /**
   * Map a DOM element to { type, url } if it's a resource element we inspect,
   * else null. `url` is an absolute, http(s)-only URL object.
   */
  function classifyElement(el) {
    if (!el || el.nodeType !== 1) return null;
    let type = null;
    let raw  = null;

    switch (el.tagName) {
      case 'IMG':    type = 'image';  raw = el.currentSrc || el.src; break;
      case 'SCRIPT': type = 'script'; raw = el.src; break;
      case 'IFRAME': type = 'iframe'; raw = el.src; break;
      case 'VIDEO':  type = 'media';  raw = el.currentSrc || el.src; break;
      case 'AUDIO':  type = 'media';  raw = el.currentSrc || el.src; break;
      case 'EMBED':  type = 'object'; raw = el.src;  break;
      case 'OBJECT': type = 'object'; raw = el.data; break;
      case 'SOURCE': {
        const parentTag = el.parentElement ? el.parentElement.tagName : '';
        type = parentTag === 'PICTURE' ? 'image' : 'media';
        raw  = el.src || (el.srcset || '').split(',')[0].trim().split(' ')[0];
        break;
      }
      case 'LINK': {
        const rel = (el.rel || '').toLowerCase();
        if (rel.includes('stylesheet')) type = 'stylesheet';
        else if (rel.includes('icon')) type = 'icon';
        else if (rel.includes('preload') || rel.includes('prefetch')) type = 'preload';
        else return null; // ordinary <link> (canonical, etc.) — not a resource
        raw = el.href;
        break;
      }
      default:
        return null;
    }

    if (!raw) return null;
    let url;
    try { url = new URL(raw, location.href); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { type, url };
  }

  // --- Tooltip --------------------------------------------------------------
  function ensureTooltip() {
    if (tooltipEl && document.documentElement.contains(tooltipEl)) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = TOOLTIP_ID;
    (document.body || document.documentElement).appendChild(tooltipEl);
    return tooltipEl;
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Render + position the tooltip for an element. `threat` may be:
   *   undefined  - not requested yet (first-party resources are never scored)
   *   null       - requested, nothing cached
   *   object     - { score, level, evidence, ... }
   */
  function renderTooltip(el, data) {
    const tip = ensureTooltip();
    const { hostname, type, party, threat } = data;
    const partyClass = party === 'first-party' ? 'fp' : 'tp';

    let scoreHtml;
    if (party === 'first-party') {
      scoreHtml = '<span class="cs-row">Score: <b>n/a (first-party)</b></span>';
    } else if (threat === undefined) {
      scoreHtml = '<span class="cs-row">Score: <b>checking…</b></span>';
    } else if (!threat || threat.level === 'unknown') {
      scoreHtml = '<span class="cs-row">Score: <b>not scored</b></span>';
    } else {
      scoreHtml = `<span class="cs-row">Score: <b class="cs-${threat.level}">`
                + `${threat.score}/100 (${threat.level})</b></span>`;
    }

    tip.innerHTML =
      `<span class="cs-domain">${escapeHtml(hostname)}</span>`
      + `<span class="cs-row">Type: <b>${escapeHtml(type)}</b></span>`
      + `<span class="cs-row">Origin: <b class="cs-${partyClass}">${party}</b></span>`
      + scoreHtml;

    tip.style.display = 'block';

    // Position above the element, clamped to the viewport; flip below if there
    // isn't room above.
    const rect    = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let top  = rect.top - tipRect.height - 8;
    let left = rect.left;
    if (top < 4) top = rect.bottom + 8;
    if (left + tipRect.width > window.innerWidth - 4) {
      left = window.innerWidth - tipRect.width - 4;
    }
    if (left < 4) left = 4;
    tip.style.top  = `${Math.max(4, top)}px`;
    tip.style.left = `${left}px`;
  }

  // --- Hover handlers -------------------------------------------------------
  function clearHighlight(el) {
    if (el) el.classList.remove(HIGHLIGHT_CLS, '__cs-tp', '__cs-high');
  }

  function onMouseOver(e) {
    const info = classifyElement(e.target);
    if (!info) return;

    if (currentTarget && currentTarget !== e.target) clearHighlight(currentTarget);
    currentTarget = e.target;

    const hostname = info.url.hostname;
    const party = getRootDomain(hostname) === pageRoot ? 'first-party' : 'third-party';

    e.target.classList.add(HIGHLIGHT_CLS);
    e.target.classList.toggle('__cs-tp', party === 'third-party');

    renderTooltip(e.target, { hostname, type: info.type, party, threat: undefined });

    // Only third-party domains are ever scored by the background.
    if (party === 'third-party') {
      const token = ++reqToken;
      try {
        chrome.runtime.sendMessage({ type: 'getThreat', domain: hostname }, (res) => {
          if (chrome.runtime.lastError) return;             // SW asleep — ignore
          if (token !== reqToken || currentTarget !== e.target) return; // stale
          const threat = res && res.threat ? res.threat : null;
          renderTooltip(e.target, { hostname, type: info.type, party, threat });
          if (threat && threat.level === 'high') e.target.classList.add('__cs-high');
        });
      } catch { /* extension context invalidated — ignore */ }
    }
  }

  function onMouseOut(e) {
    if (e.target !== currentTarget) return;
    clearHighlight(e.target);
    currentTarget = null;
    reqToken++;              // invalidate any in-flight threat response
    hideTooltip();
  }

  // --- Style injection ------------------------------------------------------
  // One stylesheet, unique IDs/classes, every rule !important and ID-scoped so
  // hostile page CSS can't restyle our overlay. The tooltip itself starts from
  // `all: initial` so it doesn't inherit anything from the page.
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLS} {
        outline: 2px solid #38bdf8 !important;
        outline-offset: 1px !important;
        cursor: help !important;
      }
      .${HIGHLIGHT_CLS}.__cs-tp   { outline-color: #f59e0b !important; }
      .${HIGHLIGHT_CLS}.__cs-high { outline-color: #ef4444 !important; }

      #${TOOLTIP_ID} {
        all: initial !important;
        position: fixed !important;
        z-index: 2147483647 !important;
        display: none;
        max-width: 320px !important;
        padding: 7px 10px !important;
        background: #0d1628 !important;
        border: 1px solid #1e2f52 !important;
        border-radius: 6px !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5) !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
        font-size: 11.5px !important;
        line-height: 1.5 !important;
        color: #e2e8f0 !important;
        pointer-events: none !important;
      }
      #${TOOLTIP_ID} .cs-domain {
        display: block !important;
        font-family: 'Cascadia Code', 'Consolas', monospace !important;
        font-weight: 700 !important;
        color: #38bdf8 !important;
        margin-bottom: 3px !important;
        word-break: break-all !important;
      }
      #${TOOLTIP_ID} .cs-row { display: block !important; color: #94a3b8 !important; }
      #${TOOLTIP_ID} .cs-row b { color: #e2e8f0 !important; font-weight: 600 !important; }
      #${TOOLTIP_ID} .cs-fp      { color: #38bdf8 !important; }
      #${TOOLTIP_ID} .cs-tp      { color: #f59e0b !important; }
      #${TOOLTIP_ID} .cs-safe    { color: #22c55e !important; }
      #${TOOLTIP_ID} .cs-caution { color: #f59e0b !important; }
      #${TOOLTIP_ID} .cs-high    { color: #ef4444 !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- Enable / disable -----------------------------------------------------
  function cleanup() {
    clearHighlight(currentTarget);
    currentTarget = null;
    hideTooltip();
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      injectStyle();
      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mouseout', onMouseOut, true);
    } else {
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('mouseout', onMouseOut, true);
      cleanup();
    }
  }

  // --- Wire up to the stored toggle ----------------------------------------
  chrome.storage.local.get('inspectorEnabled')
    .then((r) => setEnabled(!!r.inspectorEnabled))
    .catch(() => { /* storage unavailable — stay inert */ });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.inspectorEnabled) {
      setEnabled(!!changes.inspectorEnabled.newValue);
    }
  });
})();
