/**
 * CookieSpy — Popup Script
 *
 * Requests data from the background service worker for the active tab
 * and renders it. Listens for live 'dataChanged' messages to refresh.
 */

// ─── DOM refs ────────────────────────────────────────────────────────────────

const elDomain      = document.getElementById('main-domain');
const elFirst       = document.getElementById('count-first');
const elThird       = document.getElementById('count-third');
const elDomains     = document.getElementById('count-domains');
const elDomainList  = document.getElementById('domain-list');
const elEmptyState  = document.getElementById('empty-state');
const elSectionHint = document.getElementById('section-hint');


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

  // Request count badge
  const countBadge = document.createElement('span');
  countBadge.className = 'row-count';
  if (item.count >= 20) countBadge.classList.add('high');
  else if (item.count >= 5)  countBadge.classList.add('mid');
  countBadge.textContent = item.count;

  row.appendChild(flag);
  row.appendChild(info);
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
  elDomain.textContent = '—';
  elFirst.textContent  = '0';
  elThird.textContent  = '0';
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

function render(data) {
  if (!data) {
    renderNoData();
    return;
  }

  // Header domain
  elDomain.textContent = data.mainDomain || '—';
  elDomain.title = data.mainDomain || '';

  // Stats
  flashEl(elFirst,   data.firstParty);
  flashEl(elThird,   data.thirdParty);
  flashEl(elDomains, data.domains.length);

  // Section hint
  elSectionHint.textContent = data.domains.length > 0
    ? `${data.domains.length} domain${data.domains.length !== 1 ? 's' : ''} · sorted by requests`
    : '';

  // Domain list
  elDomainList.innerHTML = '';

  if (data.domains.length === 0) {
    elDomainList.appendChild(elEmptyState);
    elEmptyState.style.display = 'flex';
  } else {
    elEmptyState.style.display = 'none';
    const frag = document.createDocumentFragment();
    for (const item of data.domains) {
      frag.appendChild(buildDomainRow(item));
    }
    elDomainList.appendChild(frag);
  }
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

// ─── Initialise ───────────────────────────────────────────────────────────────

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
