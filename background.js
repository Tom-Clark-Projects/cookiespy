/**
 * CookieSpy — Background Service Worker
 *
 * Tracks per-tab:
 *   - First-party cookies (domain matches current page)
 *   - Third-party cookies (domain differs from current page)
 *   - External domain connections with IP geolocation
 *
 * No data is written to storage. All state is in-memory and
 * cleared when a tab navigates or is closed.
 */

// ─── In-memory state ─────────────────────────────────────────────────────────

/**
 * tabData: Map<tabId, TabState>
 * TabState {
 *   mainDomain: string           — root domain of the current page
 *   mainUrl:    string           — full URL of the current page
 *   firstParty: Set<string>      — unique first-party cookie identifiers
 *   thirdParty: Set<string>      — unique third-party cookie identifiers
 *   domains:    Map<string, DomainInfo>  — external domains seen
 * }
 * DomainInfo { count, ip, location, flag, org }
 */
const tabData = new Map();

// Simple geo cache so we don't re-lookup the same domain repeatedly
const geoCache = new Map();


// ─── Helpers ─────────────────────────────────────────────────────────────────

function getHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

/** Returns the eTLD+1 root (e.g. "sub.example.co.uk" → "example.co.uk") */
function getRootDomain(hostname) {
  if (!hostname) return '';
  // Simple heuristic: last 2 parts, or last 3 if second-to-last is short (co, com, org…)
  const parts = hostname.replace(/^\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  if (sld.length <= 3 && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function isThirdParty(cookieDomain, mainDomain) {
  const cookieRoot = getRootDomain(cookieDomain.replace(/^\./, ''));
  const mainRoot   = getRootDomain(mainDomain);
  return cookieRoot !== mainRoot && cookieRoot !== '' && mainRoot !== '';
}

function initTab(tabId) {
  if (!tabData.has(tabId)) {
    tabData.set(tabId, {
      mainDomain: '',
      mainUrl: '',
      firstParty: new Set(),
      thirdParty: new Set(),
      domains: new Map(),
    });
  }
  return tabData.get(tabId);
}

/** Country code → emoji flag */
function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐';
  const base = 0x1F1E6 - 65;
  return String.fromCodePoint(base + code.charCodeAt(0), base + code.charCodeAt(1));
}

/** Update the toolbar badge for a tab */
function updateBadge(tabId) {
  const data = tabData.get(tabId);
  if (!data) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const total = data.thirdParty.size + data.domains.size;
  const text  = total > 0 ? String(total) : '';
  const color = total === 0 ? '#22c55e'
               : total <= 5 ? '#f59e0b'
               : '#ef4444';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

/** Notify the popup (if open) that data has changed */
function notifyPopup(tabId) {
  updateBadge(tabId);
  chrome.runtime.sendMessage({ type: 'dataChanged', tabId }).catch(() => {
    // Popup is closed — that's fine, ignore
  });
}


// ─── Navigation — reset on new page load ─────────────────────────────────────

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return; // Only care about main frame
  tabData.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' });
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  if (!url || !url.startsWith('http')) return;

  const data = initTab(tabId);
  data.mainDomain = getHostname(url) || '';
  data.mainUrl    = url;

  // Snapshot existing cookies for this page
  loadExistingCookies(tabId, url);
});


// ─── Cookie tracking via chrome.cookies ──────────────────────────────────────

async function loadExistingCookies(tabId, url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    const data = tabData.get(tabId);
    if (!data) return;

    for (const cookie of cookies) {
      classifyCookie(data, cookie.domain, cookie.name, getHostname(url) || '');
    }
    notifyPopup(tabId);
  } catch { /* permissions or invalid url */ }
}

function classifyCookie(data, cookieDomain, cookieName, mainDomain) {
  const id = `${cookieDomain.replace(/^\./, '')}::${cookieName}`;
  if (isThirdParty(cookieDomain, mainDomain || data.mainDomain)) {
    data.thirdParty.add(id);
  } else {
    data.firstParty.add(id);
  }
}

// Listen for cookies being set/changed in real-time
chrome.cookies.onChanged.addListener(({ removed, cookie }) => {
  if (removed) return;

  // Find tabs whose main domain matches and classify this cookie
  for (const [tabId, data] of tabData.entries()) {
    if (!data.mainDomain) continue;
    // Only process if this cookie is relevant to this tab's domain or is third-party
    classifyCookie(data, cookie.domain, cookie.name, data.mainDomain);
    notifyPopup(tabId);
  }
});


// ─── Network request tracking ────────────────────────────────────────────────

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.url.startsWith('http')) return;
    const data = tabData.get(details.tabId);
    if (!data || !data.mainDomain) return;

    const reqHost = getHostname(details.url);
    if (!reqHost) return;

    const reqRoot  = getRootDomain(reqHost);
    const mainRoot = getRootDomain(data.mainDomain);

    // Skip requests to the same root domain
    if (reqRoot === mainRoot) return;

    if (data.domains.has(reqHost)) {
      data.domains.get(reqHost).count++;
    } else {
      data.domains.set(reqHost, {
        count: 1,
        ip: null,
        location: null,
        flag: '🌐',
        org: null,
      });
      // Kick off async geo lookup for this new domain
      lookupGeo(reqHost, details.tabId);
    }

    notifyPopup(details.tabId);
  },
  { urls: ['<all_urls>'] }
);


// ─── IP Geolocation — ipwho.is (free, HTTPS, no API key) ─────────────────────

async function lookupGeo(domain, tabId) {
  try {
    // Check cache first
    if (geoCache.has(domain)) {
      applyGeo(domain, tabId, geoCache.get(domain));
      return;
    }

    const res = await fetch(`https://ipwho.is/${domain}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;

    const geo = await res.json();
    if (!geo.success) return;

    const info = {
      ip:       geo.ip       || '',
      location: [geo.city, geo.country].filter(Boolean).join(', '),
      flag:     countryFlag(geo.country_code),
      org:      geo.connection?.org || geo.org || '',
    };

    geoCache.set(domain, info);
    applyGeo(domain, tabId, info);

  } catch { /* timeout or network error — geo is optional */ }
}

function applyGeo(domain, tabId, info) {
  const data = tabData.get(tabId);
  if (!data) return;
  const entry = data.domains.get(domain);
  if (!entry) return;
  Object.assign(entry, info);
  notifyPopup(tabId);
}


// ─── Message handler — serves data to popup ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'getData') return false;

  const data = tabData.get(message.tabId);
  if (!data) {
    sendResponse(null);
    return true;
  }

  sendResponse({
    mainDomain: data.mainDomain,
    firstParty: data.firstParty.size,
    thirdParty: data.thirdParty.size,
    domains: Array.from(data.domains.entries()).map(([domain, info]) => ({
      domain,
      ...info,
    })).sort((a, b) => b.count - a.count), // Sort by request count desc
  });

  return true; // Keep message channel open for async
});


// ─── Cleanup — remove data when tab closes ───────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabData.delete(tabId);
});
