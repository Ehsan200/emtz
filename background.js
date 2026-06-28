// Per-Domain Timezone Spoofer — service worker.
// Responsibilities:
//   1. Read rules from storage.sync  ({ rules: [{ domain, tz }] })
//   2. Register one MAIN-world userScript per rule (timezone baked into the code),
//      injected at document_start so it wins the race vs page JS.
//   3. On any config change, rebuild registrations + reload matching open tabs.

const STORAGE_KEY = "rules";

// ---------------------------------------------------------------------------
// The patcher. Runs in the PAGE (MAIN world) AND inside any Worker it spawns,
// before site scripts. Args:
//   TZ     - target IANA timezone
//   LOCALE - BCP-47 locale to report (or null/"" to leave language untouched)
//   SRC    - this function's own source text, so it can re-inject itself into
//            Workers/SharedWorkers the page creates.
// Everything it needs is self-contained; it touches only globalThis.
// ---------------------------------------------------------------------------
function tzPatcher(TZ, LOCALE, SRC) {
  const G = globalThis;
  if (G.__tzSpoofApplied === TZ) return;
  G.__tzSpoofApplied = TZ;

  const _Date = Date;
  const _DTF = Intl.DateTimeFormat;

  // --- make every patched function report as native -------------------------
  const _fnToStr = Function.prototype.toString;
  const masks = new WeakMap();
  function asNative(fn, name) {
    try { Object.defineProperty(fn, "name", { value: name, configurable: true }); } catch (e) {}
    masks.set(fn, "function " + name + "() { [native code] }");
    return fn;
  }
  const ftsPatched = function toString() {
    const m = masks.get(this);
    return m !== undefined ? m : _fnToStr.call(this);
  };
  masks.set(ftsPatched, "function toString() { [native code] }");
  Function.prototype.toString = ftsPatched;
  // assign + mask in one step
  function def(obj, name, fn) { asNative(fn, name); obj[name] = fn; return fn; }

  // --- zone math (uses the ORIGINAL Intl.DateTimeFormat) --------------------
  const fmt = new _DTF("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  function partsAt(ms) {
    const o = {};
    for (const p of fmt.formatToParts(new _Date(ms))) if (p.type !== "literal") o[p.type] = +p.value;
    return o;
  }
  // offsetAt(ms): ms to ADD to a real UTC instant to get the target-zone wall
  // clock expressed as if it were UTC. (local = UTC + offset)
  function offsetAt(ms) {
    const p = partsAt(ms);
    const h = p.hour === 24 ? 0 : p.hour;
    const asUTC = _Date.UTC(p.year, p.month - 1, p.day, h, p.minute, p.second);
    const flooredSec = ms - (((ms % 1000) + 1000) % 1000);
    return asUTC - flooredSec;
  }
  function shiftedUTC(ms) { return new _Date(ms + offsetAt(ms)); }
  // inverse: target-zone wall-clock components -> epoch ms, DST-corrected once.
  function wallToMs(y, mo, d, h, mi, s, msec) {
    const guess = _Date.UTC(y, mo, d, h, mi, s, msec);
    let ms = guess - offsetAt(guess);
    ms = guess - offsetAt(ms);
    return ms;
  }

  const proto = _Date.prototype;
  const _getTime = proto.getTime;

  // --- local getters --------------------------------------------------------
  const getters = [
    ["getFullYear", "getUTCFullYear"], ["getMonth", "getUTCMonth"],
    ["getDate", "getUTCDate"], ["getDay", "getUTCDay"],
    ["getHours", "getUTCHours"], ["getMinutes", "getUTCMinutes"],
    ["getSeconds", "getUTCSeconds"], ["getMilliseconds", "getUTCMilliseconds"]
  ];
  for (const [loc, utc] of getters) {
    def(proto, loc, function () {
      const t = _getTime.call(this);
      if (isNaN(t)) return NaN;
      return shiftedUTC(t)[utc]();
    });
  }
  def(proto, "getYear", function () { return this.getFullYear() - 1900; });
  def(proto, "getTimezoneOffset", function () {
    const t = _getTime.call(this);
    if (isNaN(t)) return NaN;
    return -offsetAt(t) / 60000;
  });

  // --- local setters --------------------------------------------------------
  function wallComps(date) {
    const u = shiftedUTC(_getTime.call(date));
    return [u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
            u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds(), u.getUTCMilliseconds()];
  }
  const setterStart = { setFullYear: 0, setMonth: 1, setDate: 2, setHours: 3, setMinutes: 4, setSeconds: 5, setMilliseconds: 6 };
  for (const name in setterStart) {
    const start = setterStart[name];
    def(proto, name, function (...vals) {
      const c = wallComps(this);
      for (let i = 0; i < vals.length && start + i < 7; i++) c[start + i] = +vals[i];
      return this.setTime(wallToMs(c[0], c[1], c[2], c[3], c[4], c[5], c[6]));
    });
  }
  def(proto, "setYear", function (y) { return this.setFullYear(y < 100 ? 1900 + +y : +y); });

  // --- string formatters ----------------------------------------------------
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n, l = 2) => String(Math.trunc(Math.abs(n))).padStart(l, "0");
  const nameFmt = new _DTF("en-US", { timeZone: TZ, timeZoneName: "long" });
  function offStr(date) {
    const o = -date.getTimezoneOffset();
    return "GMT" + (o >= 0 ? "+" : "-") + pad(o / 60) + pad(Math.abs(o) % 60);
  }
  function tzNm(date) {
    const p = nameFmt.formatToParts(date).find(x => x.type === "timeZoneName");
    return p ? p.value : TZ;
  }
  def(proto, "toDateString", function () {
    if (isNaN(_getTime.call(this))) return "Invalid Date";
    const c = wallComps(this);
    return DOW[this.getDay()] + " " + MON[c[1]] + " " + pad(c[2]) + " " + c[0];
  });
  def(proto, "toTimeString", function () {
    if (isNaN(_getTime.call(this))) return "Invalid Date";
    const c = wallComps(this);
    return pad(c[3]) + ":" + pad(c[4]) + ":" + pad(c[5]) + " " + offStr(this) + " (" + tzNm(this) + ")";
  });
  def(proto, "toString", function () {
    if (isNaN(_getTime.call(this))) return "Invalid Date";
    return this.toDateString() + " " + this.toTimeString();
  });
  def(proto, "toLocaleString", function (l, o) {
    return new _DTF(l, Object.assign({ timeZone: TZ }, o)).format(this);
  });
  def(proto, "toLocaleDateString", function (l, o) {
    return new _DTF(l, Object.assign({ year: "numeric", month: "numeric", day: "numeric", timeZone: TZ }, o)).format(this);
  });
  def(proto, "toLocaleTimeString", function (l, o) {
    return new _DTF(l, Object.assign({ hour: "numeric", minute: "numeric", second: "numeric", timeZone: TZ }, o)).format(this);
  });

  // --- constructor / parsing ------------------------------------------------
  function parseStr(s) {
    s = String(s).trim();
    if (/(z|[+-]\d\d:?\d\d|gmt|utc)\s*$/i.test(s)) return _Date.parse(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/i);
    if (m) {
      const msec = m[7] ? +(m[7] + "000").slice(0, 3) : 0;
      return wallToMs(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), msec);
    }
    return _Date.parse(s);
  }
  function TZDate(...args) {
    if (!(this instanceof TZDate)) return new TZDate().toString();
    let ms;
    if (args.length === 0) ms = _Date.now();
    else if (args.length === 1) {
      const a = args[0];
      if (a instanceof _Date) ms = _getTime.call(a);
      else if (typeof a === "string") ms = parseStr(a);
      else ms = Number(a);
    } else {
      const [y, mo = 0, d = 1, h = 0, mi = 0, s = 0, msec = 0] = args;
      ms = wallToMs(+y, +mo, +d, +h, +mi, +s, +msec);
    }
    return Reflect.construct(_Date, [ms], new.target || TZDate);
  }
  TZDate.prototype = _Date.prototype;
  TZDate.now = _Date.now;   // already native
  TZDate.UTC = _Date.UTC;   // already native
  def(TZDate, "parse", function (s) { return parseStr(s); });
  asNative(TZDate, "Date");
  Date = TZDate;

  // --- Intl.DateTimeFormat: default timeZone (+locale) -> target ------------
  function TZDateTimeFormat(...args) {
    if (LOCALE && args[0] === undefined) args[0] = LOCALE;
    const opts = Object.assign({}, args[1]);
    if (!opts.timeZone) opts.timeZone = TZ;
    args[1] = opts;
    if (new.target) return Reflect.construct(_DTF, args, new.target);
    return _DTF(...args);
  }
  TZDateTimeFormat.prototype = _DTF.prototype;
  TZDateTimeFormat.supportedLocalesOf = _DTF.supportedLocalesOf.bind(_DTF);
  asNative(TZDateTimeFormat.supportedLocalesOf, "supportedLocalesOf");
  asNative(TZDateTimeFormat, "DateTimeFormat");
  Intl.DateTimeFormat = TZDateTimeFormat;

  // --- Locale spoofing (optional) -------------------------------------------
  if (LOCALE) {
    // every other Intl constructor: default locale -> LOCALE when omitted
    for (const name of ["NumberFormat", "Collator", "RelativeTimeFormat",
                        "PluralRules", "ListFormat", "DisplayNames", "Segmenter"]) {
      const Orig = Intl[name];
      if (typeof Orig !== "function") continue;
      const Wrapped = function (...args) {
        if (args[0] === undefined) args[0] = LOCALE;
        if (new.target) return Reflect.construct(Orig, args, new.target);
        return Orig(...args);
      };
      Wrapped.prototype = Orig.prototype;
      if (Orig.supportedLocalesOf) {
        Wrapped.supportedLocalesOf = Orig.supportedLocalesOf.bind(Orig);
        asNative(Wrapped.supportedLocalesOf, "supportedLocalesOf");
      }
      asNative(Wrapped, name);
      Intl[name] = Wrapped;
    }

    // navigator.language / languages (works on Navigator and WorkerNavigator)
    const nav = G.navigator;
    if (nav) {
      try {
        Object.defineProperty(nav, "language", {
          get: asNative(function () { return LOCALE; }, "get language"), configurable: true
        });
      } catch (e) {}
      try {
        Object.defineProperty(nav, "languages", {
          get: asNative(function () { return Object.freeze([LOCALE]); }, "get languages"), configurable: true
        });
      } catch (e) {}
    }
  }

  // --- Workers: re-inject the patcher before the real worker script ---------
  function wrapWorker(Orig, label) {
    const Wrapped = function (url, opts) {
      try {
        const base = (G.location && G.location.href) || undefined;
        const abs = new URL(url, base).href;
        const isMod = opts && opts.type === "module";
        const head = "(" + SRC + ")(" + JSON.stringify(TZ) + "," + JSON.stringify(LOCALE) + "," + JSON.stringify(SRC) + ");\n";
        const body = isMod
          ? head + "import " + JSON.stringify(abs) + ";"
          : head + "importScripts(" + JSON.stringify(abs) + ");";
        const blobUrl = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
        return new Orig(blobUrl, opts);
      } catch (e) {
        // CSP worker-src, cross-origin, or anything unexpected: fall back.
        return new Orig(url, opts);
      }
    };
    Wrapped.prototype = Orig.prototype;
    asNative(Wrapped, label);
    return Wrapped;
  }
  if (G.Worker) G.Worker = wrapWorker(G.Worker, "Worker");
  if (G.SharedWorker) G.SharedWorker = wrapWorker(G.SharedWorker, "SharedWorker");
}

// ---------------------------------------------------------------------------
// Registration plumbing.
// ---------------------------------------------------------------------------
function matchesFor(domain) {
  // domain + every subdomain: example.com, x.example.com, x.y.example.com
  return ["*://" + domain + "/*", "*://*." + domain + "/*"];
}

// Best-effort IANA timezone -> BCP-47 locale, so a spoofed zone comes with a
// matching language. Unknown zones return null (locale left untouched).
const TZ_LOCALE = {
  "Asia/Tehran": "fa-IR", "Asia/Tokyo": "ja-JP", "Asia/Seoul": "ko-KR",
  "Asia/Shanghai": "zh-CN", "Asia/Hong_Kong": "zh-HK", "Asia/Taipei": "zh-TW",
  "Asia/Singapore": "en-SG", "Asia/Kolkata": "hi-IN", "Asia/Calcutta": "hi-IN",
  "Asia/Bangkok": "th-TH", "Asia/Jakarta": "id-ID", "Asia/Manila": "en-PH",
  "Asia/Dubai": "ar-AE", "Asia/Riyadh": "ar-SA", "Asia/Jerusalem": "he-IL",
  "Asia/Istanbul": "tr-TR", "Europe/Istanbul": "tr-TR", "Asia/Karachi": "ur-PK",
  "Asia/Ho_Chi_Minh": "vi-VN",
  "Europe/London": "en-GB", "Europe/Dublin": "en-IE", "Europe/Paris": "fr-FR",
  "Europe/Berlin": "de-DE", "Europe/Madrid": "es-ES", "Europe/Rome": "it-IT",
  "Europe/Amsterdam": "nl-NL", "Europe/Brussels": "fr-BE", "Europe/Lisbon": "pt-PT",
  "Europe/Zurich": "de-CH", "Europe/Vienna": "de-AT", "Europe/Warsaw": "pl-PL",
  "Europe/Prague": "cs-CZ", "Europe/Stockholm": "sv-SE", "Europe/Oslo": "nb-NO",
  "Europe/Copenhagen": "da-DK", "Europe/Helsinki": "fi-FI", "Europe/Athens": "el-GR",
  "Europe/Moscow": "ru-RU", "Europe/Kyiv": "uk-UA", "Europe/Kiev": "uk-UA",
  "Europe/Budapest": "hu-HU", "Europe/Bucharest": "ro-RO",
  "America/New_York": "en-US", "America/Chicago": "en-US", "America/Denver": "en-US",
  "America/Los_Angeles": "en-US", "America/Phoenix": "en-US", "America/Anchorage": "en-US",
  "America/Toronto": "en-CA", "America/Vancouver": "en-CA",
  "America/Mexico_City": "es-MX", "America/Sao_Paulo": "pt-BR",
  "America/Buenos_Aires": "es-AR", "America/Argentina/Buenos_Aires": "es-AR",
  "America/Bogota": "es-CO", "America/Santiago": "es-CL", "America/Lima": "es-PE",
  "Australia/Sydney": "en-AU", "Australia/Melbourne": "en-AU", "Australia/Perth": "en-AU",
  "Pacific/Auckland": "en-NZ", "Africa/Johannesburg": "en-ZA", "Africa/Cairo": "ar-EG",
  "Africa/Lagos": "en-NG", "Africa/Nairobi": "sw-KE", "UTC": "en-US"
};
function tzToLocale(tz) { return TZ_LOCALE[tz] || null; }

function buildCode(tz) {
  const src = tzPatcher.toString();
  const locale = tzToLocale(tz);
  // pass the source last so the patcher can re-inject itself into Workers.
  return "(" + src + ")(" + JSON.stringify(tz) + "," + JSON.stringify(locale) + "," + JSON.stringify(src) + ");";
}

function hostMatchesRule(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

async function getRules() {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const rules = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  return rules
    .filter(r => r && typeof r.domain === "string" && typeof r.tz === "string")
    .map(r => ({ domain: r.domain.trim().toLowerCase().replace(/^\*+\./, ""), tz: r.tz }))
    .filter(r => r.domain);
}

async function rebuild() {
  if (!chrome.userScripts) {
    console.warn("[tz-spoofer] chrome.userScripts unavailable — enable 'Allow user scripts' in the extension details.");
    return;
  }
  const rules = await getRules();

  try {
    const existing = await chrome.userScripts.getScripts();
    if (existing.length) await chrome.userScripts.unregister({ ids: existing.map(s => s.id) });
  } catch (e) {
    console.warn("[tz-spoofer] unregister failed:", e);
  }

  const scripts = rules.map((r, i) => ({
    id: "tz-" + i + "-" + r.domain,
    matches: matchesFor(r.domain),
    js: [{ code: buildCode(r.tz) }],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true
  }));
  if (scripts.length) {
    try {
      await chrome.userScripts.register(scripts);
    } catch (e) {
      console.error("[tz-spoofer] register failed:", e);
    }
  }
  return rules;
}

async function reloadMatchingTabs(rules) {
  if (!rules || !rules.length) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    let host;
    try { host = new URL(tab.url).hostname.toLowerCase(); } catch (e) { continue; }
    if (rules.some(r => hostMatchesRule(host, r.domain))) chrome.tabs.reload(tab.id);
  }
}

async function rebuildAndReload() {
  const rules = await rebuild();
  await reloadMatchingTabs(rules);
}

chrome.runtime.onInstalled.addListener(() => rebuild());
chrome.runtime.onStartup.addListener(() => rebuild());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[STORAGE_KEY]) rebuildAndReload();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
