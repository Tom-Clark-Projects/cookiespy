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

The toolbar badge updates live as the page loads additional resources, colour-coded by severity:

| Badge | Meaning |
|-------|---------|
| 🟢 Green | No external tracking detected |
| 🟡 Amber | 1–5 external connections |
| 🔴 Red | 6+ external connections |

---

## Threat-intelligence scoring

Every unique external domain is scored 0–100 by combining two independent, free, no-key sources:

| Source | Signal | Weight |
|--------|--------|--------|
| [URLhaus](https://urlhaus.abuse.ch/) (abuse.ch) | Hostname appears in the URLhaus malware-distribution database | +60 |
| Cloudflare malware DNS vs. Google DNS | Cloudflare's `security.cloudflare-dns.com` refuses the hostname while Google's plain resolver returns it | +40 |

Scores map to popup colour bands: `0–19 safe (green)`, `20–49 caution (amber)`, `50–100 high risk (red)`. Hovering the score pill reveals which source(s) contributed.

Each domain is queried at most once per service-worker lifetime — results are cached in memory only.

---

## Auto-blocking & timed release

When a domain scores **above 55** — in practice, when URLhaus lists it as serving malware (with or without a corroborating Cloudflare DNS signal) — CookieSpy automatically blocks it using a Manifest V3 `declarativeNetRequest` dynamic rule. The block is global: any page loading that domain as a third-party resource is protected.

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

## Privacy by design

- **No disk storage** — all tracking data is held in memory and cleared when you navigate away or close the tab; nothing is written to `localStorage` or `chrome.storage`
- **Block rules are the one exception** — auto-block and timed-allow rules persist via Chrome's own `declarativeNetRequest` and `chrome.alarms` stores so they survive a service-worker restart. These hold only domain names and expiry timestamps, never browsing history, and Chrome clears them when the rules are removed
- **Per-tab isolation** — each tab has independent tracking state that never bleeds across tabs
- **Limited external lookups** — for each *unique* external domain a tab contacts, CookieSpy makes up to four enrichment calls, all over HTTPS and all keyless:
  - `ipwho.is` — IP geolocation
  - `urlhaus-api.abuse.ch` — malware reputation
  - `security.cloudflare-dns.com` — DNS-over-HTTPS (malware-filtering resolver)
  - `dns.google` — DNS-over-HTTPS (plain resolver, used for comparison)
- **No telemetry to Anthropic, the author, or anywhere else** — the only outbound calls are the four lookups above

---

## Tech stack

- **Manifest V3** (Chrome/Edge compatible)
- `chrome.cookies` API — cookie enumeration and change events
- `chrome.webRequest` API — outbound request interception per tab + blocked-attempt counting
- `chrome.webNavigation` API — navigation lifecycle management
- `chrome.declarativeNetRequest` API — dynamic block/allow rules for auto-blocking and timed release
- `chrome.alarms` API — reliable expiry of timed allow rules even when the service worker is idle
- `ipwho.is` — free geolocation API (HTTPS, no key required)
- `urlhaus-api.abuse.ch` — free malware reputation API (HTTPS, no key required)
- DNS-over-HTTPS to `security.cloudflare-dns.com` and `dns.google` — threat-intel signal via resolver comparison
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
├── background.js          # Service worker — tracking logic, badge, geo lookup
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Dark-themed styles
│   └── popup.js           # Popup data fetch & live rendering
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Background

CookieSpy was built as a practical security tool to demonstrate real-world browser privacy concepts: cookie classification, third-party tracking detection, and network connection analysis. The same threat model underpins enterprise browser security controls in products like Microsoft Defender for Cloud Apps and network proxy solutions.

Built by **Tom Clark** — Cyber Security & Platform Engineer · [cloudsecurity.global](https://cloudsecurity.global)
