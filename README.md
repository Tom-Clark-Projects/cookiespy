# CookieSpy 🕵️

> A browser extension for Chrome and Edge that gives you real-time, per-tab visibility into first-party cookies, third-party cookies, and external network connections — with IP geolocation.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-0ea5e9?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-supported-22c55e?style=flat-square&logo=googlechrome&logoColor=white)
![Edge](https://img.shields.io/badge/Edge-supported-22c55e?style=flat-square&logo=microsoftedge&logoColor=white)
![Privacy](https://img.shields.io/badge/No_data_stored-8b5cf6?style=flat-square)

---

## What it does

When you visit a page, CookieSpy immediately shows you:

- **First-party cookies** — cookies set by the site you're visiting
- **Third-party cookies** — cookies from domains other than the current site
- **External connections** — every external domain the page contacts, with request count
- **IP geolocation** — each external domain's IP address, country, city, and organisation (ISP/CDN/cloud provider)
- **Threat score** — each external domain is enriched with a 0–100 risk score from free, keyless threat-intel sources (see below)
- **Auto-blocking with timed release** — domains scoring above 55 are automatically blocked, with a per-site "allow temporarily" escape hatch (see below)
- **Hover inspector** — an opt-in mode that outlines resource elements on the page and shows what domain served them, on hover (see below)

The toolbar badge updates live as the page loads additional resources, colour-coded by severity:

| Badge | Meaning |
|-------|---------|
| 🟢 Green | No external tracking detected |
| 🟡 Amber | 1–5 external connections |
| 🔴 Red | 6+ external connections |

---

## Threat-intelligence scoring

Every unique external domain is scored 0–100 by combining two independent sources:

| Source | Signal | Weight |
|--------|--------|--------|
| [URLhaus](https://urlhaus.abuse.ch/) (abuse.ch) | Host has at least one **currently online** malware URL | +60 |
| [URLhaus](https://urlhaus.abuse.ch/) (abuse.ch) | Host is listed but every malware URL is **offline** (historical only) | +15 |
| Cloudflare malware DNS vs. Google DNS | Cloudflare's `security.cloudflare-dns.com` refuses the hostname while Google's plain resolver returns it | +40 |

The online/offline distinction matters: URLhaus keeps historical records forever, so large legitimate hosts (e.g. `www.google.com`, abused once via an open-redirect URL) stay in the database indefinitely. Scoring those as live threats would be a false positive, so a host with only offline URLs gets a low +15 that stays inside the green "safe" band.

Scores map to popup colour bands: `0–19 safe (green)`, `20–49 caution (amber)`, `50–100 high risk (red)`. Hovering the score pill reveals which source(s) contributed.

Each domain is queried at most once per service-worker lifetime — results are cached in memory only.

### URLhaus needs a free Auth-Key

As of 2024, abuse.ch requires a free **Auth-Key** to query the URLhaus API. CookieSpy ships without one, so out of the box only the keyless Cloudflare-vs-Google DNS check is active — which catches far fewer threats. To enable the stronger URLhaus signal:

1. Open CookieSpy's **Settings** (right-click the toolbar icon → *Options*, or click the in-popup hint).
2. Follow the link to [auth.abuse.ch](https://auth.abuse.ch/), sign in with Google/GitHub/X/LinkedIn, and create an Auth-Key under the "Optional" section.
3. Paste the key into Settings, click **Save**, then **Test threat scoring** to confirm it's accepted.

The key is stored in `chrome.storage.local` (see *Privacy by design*). Until one is set, the popup shows a one-line hint above the domains list.

### Verifying it works

Scores are mostly `0` on normal browsing — legitimate CDNs and analytics domains genuinely *are* clean, so that's expected. To exercise the full pipeline on demand, visit [`testsafebrowsing.appspot.com`](https://testsafebrowsing.appspot.com/): CookieSpy treats that host as a built-in self-test entry and forces it to score 100, so it appears blocked with the complete timed-allow UI.

---

## Auto-blocking & timed release

When a domain scores **above 55** — in practice, when URLhaus has a *currently online* malware URL for it (with or without a corroborating Cloudflare DNS signal) — CookieSpy automatically blocks it using a Manifest V3 `declarativeNetRequest` dynamic rule. Historical-only listings (+15) and a lone Cloudflare DNS signal (+40) stay below the threshold and are flagged but not blocked. The block is global: any page loading that domain as a third-party resource is protected.

Blocked domains still appear in the popup's External Connections list, marked with a red accent bar and a 🚫 status button. Because the block happens at the network layer, the request-count pill stops climbing — instead the status button shows how many requests have been *blocked* since the page loaded.

### Temporary per-site release

Sometimes a blocked domain is breaking a login, payment, or embed you actually need. Click the 🚫 button on its row and choose how long to allow it **on the current site only**:

| Option | Behaviour |
|--------|-----------|
| **10m** | Allowed for 10 minutes, then the block silently re-engages |
| **1h** | Allowed for 1 hour, then the block silently re-engages |
| **Until tab close** | Allowed until you close the tab or navigate away from the site |

Timed allows are backed by `chrome.alarms`, so expiry is reliable even if the service worker has gone idle. The allow is scoped to the site's root domain via a higher-priority `allow` rule — releasing `google.com` on `msn.com` does **not** release it on `cnn.com`. An allowed domain shows a green accent bar and a ✓ status button with the remaining time; click it to revoke early.

No other major content blocker offers timed, auto-reverting exceptions — they only do permanent allow-listing, which quietly erodes your protection over time.

---

## Hover inspector

Flip the **🔍 Hover Inspector** toggle at the bottom of the popup and CookieSpy injects a lightweight on-page overlay. Hovering any *resource element* outlines it and shows a tooltip with:

- the **domain** that served it
- the **request type** — `script`, `image`, `iframe`, `media`, `stylesheet`, `object`, etc.
- whether it's **first-party or third-party**, relative to the page's root domain
- the **threat score**, pulled live from the background's cache

The outline is colour-coded: blue for first-party, amber for third-party, red if the domain is high-risk.

Scope is deliberately limited to genuine resource elements — `<img>`, `<script>`, `<iframe>`, `<video>`, `<audio>`, `<source>`, `<link>`, `<embed>`, `<object>` — because their source URL is right there in the DOM, so the attribution is honest. CookieSpy does **not** try to tell you which domain "served" an arbitrary `<button>` or `<div>`: once a script has run, that lineage isn't reliably recoverable from the DOM, and guessing would only produce confident-looking fiction.

The toggle state is stored in `chrome.storage.local`; the content script is injected on every page but stays completely inert until you switch it on. Pages already open when you flip the toggle pick it up immediately; pages open from *before* the extension was installed or reloaded need a refresh first.

---

## Privacy by design

- **No browsing data on disk** — all tracking data (cookies, connections, scores) is held in memory and cleared when you navigate away or close the tab; no browsing history is ever written to `localStorage` or `chrome.storage`
- **Two persisted exceptions, neither is browsing history:**
  - Auto-block and timed-allow rules persist via Chrome's own `declarativeNetRequest` and `chrome.alarms` stores so they survive a service-worker restart. They hold only domain names and expiry timestamps, and Chrome clears them when the rules are removed.
  - Your abuse.ch Auth-Key, if you set one, is saved in `chrome.storage.local`. It is user-supplied configuration — a credential you chose to add — not data CookieSpy collected about you.
- **Per-tab isolation** — each tab has independent tracking state that never bleeds across tabs
- **Limited external lookups** — for each *unique* external domain a tab contacts, CookieSpy makes up to four enrichment calls, all over HTTPS:
  - `ipwho.is` — IP geolocation (keyless)
  - `urlhaus-api.abuse.ch` — malware reputation (only if you've configured an Auth-Key)
  - `security.cloudflare-dns.com` — DNS-over-HTTPS (malware-filtering resolver, keyless)
  - `dns.google` — DNS-over-HTTPS (plain resolver, used for comparison, keyless)
- **No telemetry to Anthropic, the author, or anywhere else** — the only outbound calls are the lookups above

---

## Tech stack

- **Manifest V3** (Chrome/Edge compatible)
- `chrome.cookies` API — cookie enumeration and change events
- `chrome.webRequest` API — outbound request interception per tab + blocked-attempt counting
- `chrome.webNavigation` API — navigation lifecycle management
- `chrome.declarativeNetRequest` API — dynamic block/allow rules for auto-blocking and timed release
- `chrome.alarms` API — reliable expiry of timed allow rules even when the service worker is idle
- `chrome.storage.local` API — persists the optional abuse.ch Auth-Key and the hover-inspector toggle
- Content script — the hover inspector's on-page overlay, inert until toggled on
- `ipwho.is` — free geolocation API (HTTPS, no key required)
- `urlhaus-api.abuse.ch` — malware reputation API (HTTPS, requires a free Auth-Key — see *Threat-intelligence scoring*)
- DNS-over-HTTPS to `security.cloudflare-dns.com` and `dns.google` — keyless threat-intel signal via resolver comparison
- Vanilla JS, zero dependencies

---

## Installation (Developer Mode)

CookieSpy is a sideloaded developer extension — no Chrome Web Store required.

### Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `cookiespy-extension` folder
5. Pin it from the Extensions menu

### Microsoft Edge
1. Open `edge://extensions`
2. Enable **Developer mode** (left sidebar)
3. Click **"Load unpacked"**
4. Select the `cookiespy-extension` folder
5. Pin it to the toolbar

---

## Project structure

```
cookiespy-extension/
├── manifest.json          # MV3 extension manifest
├── background.js          # Service worker — tracking, scoring, block/allow rules
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Dark-themed styles
│   └── popup.js           # Popup data fetch & live rendering
├── options/
│   ├── options.html       # Settings page — abuse.ch Auth-Key + self-test
│   ├── options.css        # Dark-themed styles
│   └── options.js         # Key storage & test-connection logic
├── content/
│   └── inspector.js       # Hover inspector — on-page resource overlay
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Background

CookieSpy was built as a practical security tool to demonstrate real-world browser privacy concepts: cookie classification, third-party tracking detection, and network connection analysis. The same threat model underpins enterprise browser security controls in products like Microsoft Defender for Cloud Apps and network proxy solutions.

Built by **Tom Clark** — Cyber Security & Platform Engineer · [cloudsecurity.global](https://cloudsecurity.global)
