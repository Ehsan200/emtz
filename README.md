# Per-Domain Timezone Spoofer

A Chrome (Manifest V3) extension that forces a timezone of your choice on specific
domains. When you visit a configured domain (or any of its subdomains), every
JavaScript date/time API on the page behaves as if the browser were in the
timezone you picked — without changing your system clock or affecting other sites.

## Features

- **Per-domain timezone** — each domain gets its own IANA timezone (e.g. `app.work.com` → `Asia/Tokyo`, `news.site.io` → `Europe/London`).
- **Subdomain matching** — adding `example.com` covers `example.com`, `app.example.com`, `a.b.example.com`, and any depth of subdomain.
- **Full JS override** — patches `Date` (getters, setters, `toString`, `toLocale*`, constructor, `parse`), `Date.prototype.getTimezoneOffset`, and `Intl.DateTimeFormat` (default zone + `resolvedOptions`). UTC methods and `toISOString()` are left intact (correct behavior). DST transitions are handled.
- **Injected before page scripts** — runs in the page's MAIN world at `document_start`, so the site never sees the real timezone.
- **Live updates** — changing the config re-applies immediately and auto-reloads any matching open tabs.
- **Searchable timezone picker** — type to filter the full IANA timezone list.
- **Sync storage** — your domain/timezone list syncs across your Chrome profiles via `chrome.storage.sync`.

## How it works

Reliable timezone spoofing must override the page's `Date`/`Intl` **before** any
site script reads the clock. That requires injecting page-context (MAIN world)
code at `document_start`, with the chosen timezone baked in.

This extension uses the **`chrome.userScripts` API**: the service worker
(`background.js`) registers one user script per domain rule, each carrying a
self-contained patcher with the target timezone hard-coded into the code string.
The patcher derives wall-clock values for the target zone from the *original*
`Intl.DateTimeFormat` (which reports any zone correctly regardless of the host
machine), then rewrites the local `Date` methods to use them.

```
manifest.json    MV3 manifest (permissions: storage, tabs, userScripts; host *://*/*)
background.js    Patcher source + userScript register/rebuild + tab auto-reload
options.html     Settings UI
options.css      Settings UI styles
options.js       CRUD for domain→timezone rules
icons/           Toolbar / store icons (16/32/48/128)
```

Storage shape (`chrome.storage.sync`):

```json
{ "rules": [ { "domain": "example.com", "tz": "Asia/Tokyo" } ] }
```

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder.
4. Open the extension's **Details** page and enable **“Allow user scripts.”**
   This toggle is required by Chrome for the `chrome.userScripts` API. The
   options page shows a red banner if it is still off.
5. Reload the extension after enabling the toggle.

## Usage

1. Click the toolbar icon (or open the extension's Options page).
2. Enter a base domain (e.g. `example.com`) — no scheme or path needed.
3. Type to search and pick a timezone.
4. Click **Add**.

Edit a row's timezone or remove a row at any time. Open tabs on a matching
domain reload automatically so the change takes effect right away. New page
loads always get the override at `document_start`.

## Verifying it works

On a configured page, open DevTools console and check the **method calls**
(not the object preview):

```js
new Date().getHours();          // hour in your chosen zone
new Date().getTimezoneOffset(); // offset of your chosen zone, in minutes
new Date().toString();          // e.g. "... GMT+0900 (Japan Standard Time)"
Intl.DateTimeFormat().resolvedOptions().timeZone; // your chosen zone
window.__tzSpoofApplied;        // your chosen zone (proof the patcher ran)
```

> **Note:** The grey inline *preview chip* DevTools shows next to a `Date` is
> rendered by V8 natively in your real host zone and ignores JS overrides. It
> will look "wrong" even when the extension is working — it is cosmetic and not
> what pages see. Trust the method calls above.

## Limitations

- **`chrome.userScripts` toggle required** — the only reliable way to inject
  dynamic MAIN-world code at `document_start` in MV3. Without it, nothing is
  injected.
- **Web Workers are not patched** — `allFrames` covers iframes, but code running
  in a dedicated/shared Web Worker has its own global scope and still sees the
  real timezone.
- **Non-ISO timezone-less date strings** (e.g. `new Date("July 1 2026")`) fall
  back to native parsing. ISO-like strings without an offset (e.g.
  `"2026-07-01T12:00:00"`) are correctly interpreted in the target zone.
- **DevTools Date preview chip** is native and unaffected (see note above).

## Permissions rationale

| Permission | Why |
| --- | --- |
| `userScripts` | Register MAIN-world patcher at `document_start` with the per-domain timezone baked in. |
| `storage` | Persist and sync the domain→timezone rules. |
| `tabs` | Reload open tabs matching a rule when the config changes. |
| `host_permissions: *://*/*` | Allow user-script registration and tab reload for any domain you add. |
