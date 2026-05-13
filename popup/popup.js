/**
 * CookieSpy — Popup Script
 *
 * Requests data from the background service worker for the active tab
 * and renders it. Listens for live 'dataChanged' messages to refresh.
 */

// ─── DOM refs ────────────────────────────────────────────────────────────────

const elDomain       = document.getElementById('main-domain');
const elFirst        = document.getElementById('count-first');
const elThird        = document.getElementById('count-third');
const elDomains      = document.getElementById('count-domains');
const elDomainList   = document.getElementById('domain-list');
const elSectionTitle = document.getElementById('section-title');
const elSectionHint  = document.getElementById('section-hint');
const elStatCards    = document.querySelectorAll('.stat-card');


// ─── View state ──────────────────────────────────────────────────────────────

/**
 * Which list the user is currently looking at. One of:
 *   'first'   → first-party cookies
 *   'third'   → third-party cookies
 *   'domains' → external connections (default, matches the HTML)
 *
 * We keep the latest payload from the background in `lastData` so we can
 * re-render without a round-trip when the user just switches tabs.
 */
let activeView = 'domains';
let lastData   = null;

/** Per-view configuration: section header text and empty-state copy. */
const VIEW_CONFIG = {
  first: {
    title:      'First-Party Cookies',
    emptyIcon:  '🍪',
    emptyText:  'No first-party cookies on this page',
    hint:       (n) => `${n} cookie${n !== 1 ? 's' : ''} · sorted by name`,
  },
  third: {
    title:      'Third-Party Cookies',
    emptyIcon:  '🍪',
    emptyText:  'No third-party cookies on this page',
    hint:       (n) => `${n} cookie${n !== 1 ? 's' : ''} · sorted by name`,
  },
  domains: {
    title:      'External Domains',
    emptyIcon:  '🔍',
    emptyText:  'No external connections yet',
    hint:       (n) => `${n} domain${n !== 1 ? 's' : ''} · sorted by requests`,
  },
};


// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Flash a counter element when its value changes */
function flashEl(el, newValue) {
  const prev = el.textContent;
  el.textContent = newValue;
  if (String(newValue) !== prev) {
    el.classList.remove('flash');
    // Force reflow so the animation re-triggers
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

/**
 * Build a single cookie row element.
 *
 * Cookies don't carry geo/IP info, so the layout is simpler than a domain
 * row: a cookie icon, the cookie name (primary) and its domain (secondary).
 * We re-use `.domain-row` so the alternating-row striping still applies.
 */
function buildCookieRow(item) {
  const row = document.createElement('div');
  row.className = 'domain-row cookie-row';

  const flag = document.createElement('span');
  flag.className = 'row-flag';
  flag.textContent = '🍪';

  const info = document.createElement('div');
  info.className = 'row-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'row-domain'; // re-uses the existing monospace styling
  nameEl.textContent = item.name;
  nameEl.title = item.name;

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = item.domain;
  meta.title = item.domain;

  info.appendChild(nameEl);
  info.appendChild(meta);

  row.appendChild(flag);
  row.appendChild(info);

  return row;
}

/**
 * Build a small coloured pill showing the threat score for a domain.
 *
 * States:
 *   null / undefined  -> dim "…" pill while the lookup is in flight
 *   level 'unknown'   -> grey dash, no score (lookup completed with no signal)
 *   level 'safe'      -> green
 *   level 'caution'   -> amber
 *   level 'high'      -> red
 *
 * Hovering the pill reveals the source breakdown via the title attribute.
 */
function buildThreatBadge(threat) {
  const pill = document.createElement('span');
  pill.className = 'row-threat';

  if (!threat) {
    pill.classList.add('pending');
    pill.textContent = '…';
    pill.title = 'Checking threat intelligence…';
    return pill;
  }

  if (threat.level === 'unknown') {
    pill.classList.add('unknown');
    pill.textContent = '–';
    pill.title = threat.evidence || 'No threat-intel signal available';
    return pill;
  }

  pill.classList.add(threat.level); // safe / caution / high
  pill.textContent = String(threat.score);
  const sourceList = threat.sources?.length
    ? `\nSources: ${threat.sources.join(', ')}`
    : '';
  pill.title = `Threat score ${threat.score}/100 (${threat.level})\n${threat.evidence || ''}${sourceList}`.trim();
  return pill;
}

/** Build a single domain row element */
function buildDomainRow(item) {
  const row = document.createElement('div');
  row.className = 'domain-row';

  // Flag
  const flag = document.createElement('span');
  flag.className = 'row-flag';
  flag.textContent = item.flag || '🌐';

  // Info
  const info = document.createElement('div');
  info.className = 'row-info';

  const domainEl = document.createElement('div');
  domainEl.className = 'row-domain';
  domainEl.textContent = item.domain;
  domainEl.title = item.domain;

  const meta = document.createElement('div');
  meta.className = 'row-meta';

  const parts = [];
  if (item.ip) {
    parts.push(`<span class="ip">${escapeHtml(item.ip)}</span>`);
  }
  if (item.location) {
    parts.push(escapeHtml(item.location));
  }
  if (item.org) {
    // Trim AS number prefix e.g. "AS15169 Google LLC" → "Google LLC"
    const orgClean = item.org.replace(/^AS\d+\s+/i, '');
    parts.push(escapeHtml(orgClean));
  }

  meta.innerHTML = parts.join('<span class="sep">·</span>');

  info.appendChild(domainEl);
  info.appendChild(meta);

  // Threat-score badge sits before the count so the eye lands on risk first.
  const threatBadge = buildThreatBadge(item.threat);

  // Request count badge
  const countBadge = document.createElement('span');
  countBadge.className = 'row-count';
  if (item.count >= 20) countBadge.classList.add('high');
  else if (item.count >= 5)  countBadge.classList.add('mid');
  countBadge.textContent = item.count;

  row.appendChild(flag);
  row.appendChild(info);
  row.appendChild(threatBadge);
  row.appendChild(countBadge);

  return row;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ─── Render ───────────────────────────────────────────────────────────────────

function renderNoData() {
  lastData = null;
  elDomain.textContent  = '—';
  elFirst.textContent   = '0';
  elThird.textContent   = '0';
  elDomains.textContent = '0';

  elDomainList.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'no-data-msg';
  msg.innerHTML = `
    <span class="no-data-icon">🛡️</span>
    <span>Navigate to a page to start tracking cookies and connections.</span>
  `;
  elDomainList.appendChild(msg);
  elSectionHint.textContent = '';
}

/**
 * Top-level render: stamp the header + counters from the latest payload,
 * cache it, then delegate the list itself to renderActiveView() so a tab
 * switch can re-use the same code path without a fresh fetch.
 */
function render(data) {
  if (!data) {
    renderNoData();
    return;
  }

  lastData = data;

  // Header domain
  elDomain.textContent = data.mainDomain || '—';
  elDomain.title = data.mainDomain || '';

  // Stat counters (now always derived from list lengths)
  flashEl(elFirst,   data.firstParty.length);
  flashEl(elThird,   data.thirdParty.length);
  flashEl(elDomains, data.domains.length);

  renderActiveView();
}

/**
 * Render the list portion based on `activeView`. Safe to call any time after
 * `lastData` has been populated — used both on fresh data and on tab clicks.
 */
function renderActiveView() {
  // Sync the visual + a11y state of the tab strip every time, so the active
  // card stays correct even if it changed via keyboard rather than click.
  elStatCards.forEach((card) => {
    const isActive = card.dataset.view === activeView;
    card.classList.toggle('active', isActive);
    card.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (!lastData) return;

  const cfg  = VIEW_CONFIG[activeView];
  const list = activeView === 'first'  ? lastData.firstParty
             : activeView === 'third'  ? lastData.thirdParty
             :                           lastData.domains;

  elSectionTitle.textContent = cfg.title;
  elSectionHint.textContent  = list.length > 0 ? cfg.hint(list.length) : '';

  elDomainList.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <span class="empty-icon">${cfg.emptyIcon}</span>
      <span>${escapeHtml(cfg.emptyText)}</span>
    `;
    elDomainList.appendChild(empty);
    return;
  }

  const frag    = document.createDocumentFragment();
  const builder = activeView === 'domains' ? buildDomainRow : buildCookieRow;
  for (const item of list) {
    frag.appendChild(builder(item));
  }
  elDomainList.appendChild(frag);
}


// ─── Data fetching ────────────────────────────────────────────────────────────

let activeTabId = null;

async function refresh() {
  if (activeTabId === null) return;
  chrome.runtime.sendMessage({ type: 'getData', tabId: activeTabId }, (response) => {
    if (chrome.runtime.lastError) return; // background not ready
    render(response);
  });
}

// ─── Tab switching ────────────────────────────────────────────────────────────

/**
 * Wire the three stat cards as tabs. A click (or Enter/Space when focused)
 * switches `activeView` and re-renders from the cached payload — no extra
 * round-trip to the background.
 */
function setActiveView(view) {
  if (!VIEW_CONFIG[view] || view === activeView) return;
  activeView = view;
  renderActiveView();
}

elStatCards.forEach((card) => {
  card.addEventListener('click', () => setActiveView(card.dataset.view));
  card.addEventListener('keydown', (e) => {
    // Enter/Space activate the focused tab. Arrow keys move focus along the
    // tablist, matching the WAI-ARIA "tabs" pattern.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setActiveView(card.dataset.view);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cards = Array.from(elStatCards);
      const idx   = cards.indexOf(card);
      const next  = e.key === 'ArrowRight'
        ? cards[(idx + 1) % cards.length]
        : cards[(idx - 1 + cards.length) % cards.length];
      next.focus();
      setActiveView(next.dataset.view);
    }
  });
});


// ─── Initialise ───────────────────────────────────────────────────────────────

// Reflect the default active view in the DOM before the first fetch so the
// UI doesn't briefly show the wrong tab as selected.
renderActiveView();

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs || tabs.length === 0) { renderNoData(); return; }
  activeTabId = tabs[0].id;
  refresh();
});

// ─── Live updates from background ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'dataChanged' && message.tabId === activeTabId) {
    refresh();
  }
});
