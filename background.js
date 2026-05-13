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

// --- In-memory state --------------------------------------------------------

/**
 * tabData: Map<tabId, TabState>
 * TabState {
 *   mainDomain: string           - root domain of the current page
 *   mainUrl:    string           - full URL of the current page
 *   firstParty: Map<id, Cookie>  - unique first-party cookies (id = "domain::name")
 *   thirdParty: Map<id, Cookie>  - unique third-party cookies (id = "domain::name")
 *   domains:    Map<string, DomainInfo>  - external domains seen
 * }
 * Cookie     { domain, name }
 * DomainInfo { count, ip, location, flag, org }
 */
const tabData = new Map();

// Simple geo cache so we don't re-lookup the same domain repeatedly
const geoCache = new Map();


// --- Helpers ----------------------------------------------------------------

function getHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

/** Returns the eTLD+1 root (e.g. "sub.example.co.uk" -> "example.co.uk") */
function getRootDomain(hostname) {
  if (!hostname) return '';
  // Simple heuristic: last 2 parts, or last 3 if second-to-last is short (co, com, org...)
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
      // Keyed by "domain::name" so re-classifying the same cookie is idempotent,
      // but the value holds the structured fields the popup needs to render.
      firstParty: new Map(),
      thirdParty: new Map(),
      domains: new Map(),
    });
  }
  return tabData.get(tabId);
}

/** Country code -> emoji flag */
function countryFlag(code) {
  if (!code || code.length !== 2) return '\u{1F310}';
  const base = 0x1F1E6 - 65;
  return String.fromCodePoint(base + code.charCodeAt(0), base + code.charCodeAt(1));
}

/**
 * Paint the toolbar icon for a given tab.
 *
 * Updates two pieces of UI that live immediately adjacent to the URL bar:
 *   1. Badge text - coloured count overlaid on the extension icon
 *      (green = clean, amber = 1-5 external, red = 6+ external)
 *   2. Tooltip   - rich per-tab summary shown on hover, no click required
 *
 * Both are scoped per-tab using the `tabId` option, so each tab gets its
 * own independent badge/title and switching tabs swaps them instantly.
 *
 * Note: the actual browser URL bar (omnibox) cannot be drawn into by
 * extensions - that's a hard-coded Chromium security restriction to
 * prevent URL spoofing. The icon-adjacent badge is the closest we can
 * legally get, and is the same pattern used by uBlock Origin, Privacy
 * Badger, Ghostery, etc.
 */
function paintIcon(tabId) {
  const data = tabData.get(tabId);

  // No data yet for this tab (e.g. fresh service-worker start, chrome:// page,
  // or page hasn't begun loading). Show a neutral placeholder.
  if (!data || !data.mainDomain) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({
      tabId,
      title: 'CookieSpy - Cookie & Connection Tracker\nNo data yet for this tab',
    }).catch(() => {});
    return;
  }

  // -- Badge ----------------------------------------------------------------
  // Total external exposure = third-party cookies + unique external domains.
  // Shown as a coloured pill on the icon, capped to 4 chars so it fits.
  const total = data.thirdParty.size + data.domains.size;
  const text  = total > 0 ? (total > 999 ? '999+' : String(total)) : '0';

  // Severity colours mirror the README's spec
  const color = total === 0 ? '#22c55e'  // green - no external tracking
              : total <= 5  ? '#f59e0b'  // amber - light tracking
              :                '#ef4444'; // red   - heavy tracking

  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});

  // -- Tooltip --------------------------------------------------------------
  // Multi-line title shown on hover. Newlines work in Chrome/Edge tooltips.
  // Gives the user the full picture without having to open the popup.
  const tooltip = [
    `CookieSpy - ${data.mainDomain}`,
    '-------------------------',
    `First-party cookies:   ${data.firstParty.size}`,
    `Third-party cookies:   ${data.thirdParty.size}`,
    `External connections:  ${data.domains.size}`,
    '',
    'Click the icon for full details',
  ].join('\n');

  chrome.action.setTitle({ tabId, title: tooltip }).catch(() => {});
}

/** Notify the popup (if open) that data has changed, and repaint the icon */
function notifyPopup(tabId) {
  paintIcon(tabId);
  chrome.runtime.sendMessage({ type: 'dataChanged', tabId }).catch(() => {
    // Popup is closed - that's fine, ignore
  });
}


// --- Navigation - reset on new page load ------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return; // Only care about main frame
  tabData.delete(tabId);
  // Clear badge + tooltip so the user sees a clean state during navigation
  paintIcon(tabId);
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


// --- Cookie tracking via chrome.cookies -------------------------------------

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
  const cleanDomain = cookieDomain.replace(/^\./, '');
  const id    = `${cleanDomain}::${cookieName}`;
  const entry = { domain: cleanDomain, name: cookieName };
  if (isThirdParty(cookieDomain, mainDomain || data.mainDomain)) {
    data.thirdParty.set(id, entry);
  } else {
    data.firstParty.set(id, entry);
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


// --- Network request tracking -----------------------------------------------

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
        flag: '\u{1F310}',
        org: null,
      });
      // Kick off async geo lookup for this new domain
      lookupGeo(reqHost, details.tabId);
    }

    notifyPopup(details.tabId);
  },
  { urls: ['<all_urls>'] }
);


// --- IP Geolocation - ipwho.is (free, HTTPS, no API key) --------------------

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

  } catch { /* timeout or network error - geo is optional */ }
}

function applyGeo(domain, tabId, info) {
  const data = tabData.get(tabId);
  if (!data) return;
  const entry = data.domains.get(domain);
  if (!entry) return;
  Object.assign(entry, info);
  notifyPopup(tabId);
}


// --- Message handler - serves data to popup ---------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'getData') return false;

  const data = tabData.get(message.tabId);
  if (!data) {
    sendResponse(null);
    return true;
  }

  // Sort cookies alphabetically by name (then by domain) so the user gets a
  // stable, scannable list rather than insertion order.
  const cookieSort = (a, b) =>
    a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain);

  sendResponse({
    mainDomain: data.mainDomain,
    firstParty: Array.from(data.firstParty.values()).sort(cookieSort),
    thirdParty: Array.from(data.thirdParty.values()).sort(cookieSort),
    domains: Array.from(data.domains.entries()).map(([domain, info]) => ({
      domain,
      ...info,
    })).sort((a, b) => b.count - a.count), // Sort by request count desc
  });

  return true; // Keep message channel open for async
});


// --- Cleanup - remove data when tab closes ----------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  tabData.delete(tabId);
});


// --- Tab-switch repaint - keep icon in sync with active tab -----------------

/*
 * The badge & tooltip are per-tab, so Chrome already swaps them automatically
 * when the user changes tabs. BUT there are two cases where the icon can go
 * stale and need an explicit repaint:
 *
 *   1. The MV3 service worker is recycled after ~30s idle. When it wakes back
 *      up, `tabData` is empty (we deliberately don't persist). Until new
 *      events fire, the old badge from before the recycle is still showing.
 *      Repainting on tab switch forces a "no data yet" state until we re-scan.
 *
 *   2. A user reloads a page - onActivated doesn't fire, but onUpdated does
 *      with status === 'complete'. We repaint to reflect any new state.
 *
 * These listeners are belt-and-braces for icon consistency across tabs.
 */

chrome.tabs.onActivated.addListener(({ tabId }) => {
  paintIcon(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only repaint on a meaningful state change, not every URL/title tweak
  if (changeInfo.status === 'complete') {
    paintIcon(tabId);
  }
});
