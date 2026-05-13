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
        // threat starts undefined; the popup treats that as "checking..."
        // until lookupThreat() resolves and applyThreat() fills it in.
        threat: null,
      });
      // Fire both enrichment lookups in parallel. Each is best-effort,
      // independently cached, and merges back into this entry when ready.
      lookupGeo(reqHost, details.tabId);
      lookupThreat(reqHost, details.tabId);
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


// --- Threat Intelligence - URLhaus + DNS comparison (free, no API keys) -----
//
// CookieSpy's threat scoring combines two independent, zero-config signals:
//
//   1. URLhaus (abuse.ch) - a community-maintained malware-distribution
//      database. Domains hosting known malware are flagged. Free, no key.
//
//   2. DNS comparison - we resolve the domain via two DNS-over-HTTPS
//      resolvers in parallel:
//        * Cloudflare's malware-filtering resolver (security.cloudflare-dns.com)
//        * Google's plain recursive resolver (dns.google)
//      If Google resolves the domain but Cloudflare refuses it, that's a
//      strong indication the domain appears on a major threat-intel feed.
//
// Each signal contributes independently to a 0-100 score. We deliberately
// avoid API-key services for v1 so the extension stays drop-in for anyone
// who installs it - no signup, no quotas to manage, no key to leak.

/**
 * Per-domain threat info cache. Lives only for the lifetime of the service
 * worker, matching geoCache. Nothing is persisted to disk, in keeping with
 * CookieSpy's no-storage privacy posture.
 */
const threatCache = new Map();

/** Map a 0-100 score to a coarse level used by the popup for colour-coding. */
function scoreToLevel(score) {
  if (score >= 50) return 'high';
  if (score >= 20) return 'caution';
  return 'safe';
}

/**
 * Query URLhaus for malware-distribution hits against a hostname.
 * Returns { listed: bool, count: number } or null if the call failed.
 */
async function queryUrlhaus(domain) {
  try {
    const body = new URLSearchParams({ host: domain });
    const res  = await fetch('https://urlhaus-api.abuse.ch/v1/host/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal:  AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // `query_status` is 'ok' when URLhaus has records, 'no_results' otherwise.
    if (data.query_status === 'ok') {
      return { listed: true, count: parseInt(data.url_count, 10) || 1 };
    }
    return { listed: false, count: 0 };
  } catch {
    return null; // network/timeout - treat as "no signal"
  }
}

/**
 * Resolve a domain via both a threat-filtering resolver and a plain one.
 * Returns { filtered: bool } or null on error.
 *
 *   filtered === true  ->  Google resolves the domain but Cloudflare's
 *                          security resolver refuses it. That's our signal.
 */
async function queryDnsBlock(domain) {
  const dohFetch = (url) => fetch(url, {
    headers: { 'Accept': 'application/dns-json' },
    signal:  AbortSignal.timeout(3000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  const enc = encodeURIComponent(domain);
  const [filtered, plain] = await Promise.all([
    dohFetch(`https://security.cloudflare-dns.com/dns-query?name=${enc}&type=A`),
    dohFetch(`https://dns.google/resolve?name=${enc}&type=A`),
  ]);

  if (!filtered || !plain) return null;

  // DoH JSON: Status === 0 (NoError) and a non-empty Answer array means
  // the resolver returned at least one A record.
  const filteredResolved = filtered.Status === 0 && Array.isArray(filtered.Answer) && filtered.Answer.length > 0;
  const plainResolved    = plain.Status    === 0 && Array.isArray(plain.Answer)    && plain.Answer.length    > 0;

  // Only flag as filtered when Google has results AND Cloudflare doesn't.
  // If both refuse, the domain simply doesn't exist - not a threat signal.
  return { filtered: plainResolved && !filteredResolved };
}

/**
 * Fuse URLhaus + DNS-block signals into a single 0-100 score and a level.
 * Writes the result into the per-tab domain entry and notifies the popup.
 *
 * Scoring rubric (v1):
 *   +60  URLhaus lists the host as serving malware
 *   +40  Cloudflare's malware resolver refuses the host (Google resolves it)
 *
 * Maximum 100. If we couldn't reach any source we record an 'unknown' level
 * so the popup can render a neutral indicator rather than a green badge.
 */
async function lookupThreat(domain, tabId) {
  try {
    if (threatCache.has(domain)) {
      applyThreat(domain, tabId, threatCache.get(domain));
      return;
    }

    const [urlhaus, dns] = await Promise.all([
      queryUrlhaus(domain),
      queryDnsBlock(domain),
    ]);

    // No data at all -> mark as unknown rather than implying "safe".
    if (!urlhaus && !dns) {
      const unknown = {
        score:    0,
        level:    'unknown',
        sources:  [],
        evidence: 'No threat-intel signal available',
      };
      threatCache.set(domain, unknown);
      applyThreat(domain, tabId, unknown);
      return;
    }

    let score = 0;
    const sources = [];
    const reasons = [];

    if (urlhaus?.listed) {
      score += 60;
      sources.push('URLhaus');
      reasons.push(`Listed by URLhaus (${urlhaus.count} URL${urlhaus.count !== 1 ? 's' : ''})`);
    }
    if (dns?.filtered) {
      score += 40;
      sources.push('Cloudflare');
      reasons.push('Filtered by Cloudflare malware DNS');
    }
    if (reasons.length === 0) {
      reasons.push('No threats detected on URLhaus or Cloudflare');
    }

    const info = {
      score:    Math.min(score, 100),
      level:    scoreToLevel(score),
      sources,
      evidence: reasons.join(' · '),
    };

    threatCache.set(domain, info);
    applyThreat(domain, tabId, info);

  } catch { /* swallow - threat intel is best-effort */ }
}

/** Merge a fresh threat-info object into the per-tab domain entry. */
function applyThreat(domain, tabId, info) {
  const data = tabData.get(tabId);
  if (!data) return;
  const entry = data.domains.get(domain);
  if (!entry) return;
  entry.threat = info;
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
