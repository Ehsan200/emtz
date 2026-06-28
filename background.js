// Per-Domain Timezone Spoofer — service worker.
// Responsibilities:
//   1. Read rules from storage.sync  ({ rules: [{ domain, tz }] })
//   2. Register one MAIN-world userScript per rule (timezone baked into the code),
//      injected at document_start so it wins the race vs page JS.
//   3. On any config change, rebuild registrations + reload matching open tabs.

const STORAGE_KEY = "rules";

// ---------------------------------------------------------------------------
// The patcher. Runs in the PAGE (MAIN world) before site scripts. Receives the
// target IANA timezone as an argument. Everything it needs is self-contained.
// ---------------------------------------------------------------------------
function tzPatcher(TZ) {
  if (window.__tzSpoofApplied === TZ) return;
  window.__tzSpoofApplied = TZ;

  const _Date = Date;
  const _DTF = Intl.DateTimeFormat;

  // Formatter that reads wall-clock parts in the target zone, regardless of
  // the host machine's real zone. Built from the ORIGINAL Intl.DateTimeFormat.
  const fmt = new _DTF("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });

  function partsAt(ms) {
    const o = {};
    for (const p of fmt.formatToParts(new _Date(ms))) {
      if (p.type !== "literal") o[p.type] = +p.value;
    }
    return o;
  }

  // offsetAt(ms): ms to ADD to a real UTC instant to get the target-zone wall
  // clock expressed as if it were UTC. (i.e. local = UTC + offset)
  function offsetAt(ms) {
    const p = partsAt(ms);
    const h = p.hour === 24 ? 0 : p.hour;
    const asUTC = _Date.UTC(p.year, p.month - 1, p.day, h, p.minute, p.second);
    const flooredSec = ms - ((ms % 1000) + 1000) % 1000;
    return asUTC - flooredSec;
  }

  // shifted instant whose getUTC* fields equal the target-zone wall clock,
  // preserving fractional milliseconds.
  function shiftedUTC(ms) {
    return new _Date(ms + offsetAt(ms));
  }

  // Inverse: target-zone wall-clock components -> epoch ms. DST-corrected once.
  function wallToMs(y, mo, d, h, mi, s, msec) {
    const guess = _Date.UTC(y, mo, d, h, mi, s, msec);
    let ms = guess - offsetAt(guess);
    ms = guess - offsetAt(ms); // second pass fixes DST transition edges
    return ms;
  }

  const proto = _Date.prototype;
  const _getTime = proto.getTime;

  // --- local getters: derive from the shifted (wall-clock) instant ----------
  const getters = [
    ["getFullYear", "getUTCFullYear"],
    ["getMonth", "getUTCMonth"],
    ["getDate", "getUTCDate"],
    ["getDay", "getUTCDay"],
    ["getHours", "getUTCHours"],
    ["getMinutes", "getUTCMinutes"],
    ["getSeconds", "getUTCSeconds"],
    ["getMilliseconds", "getUTCMilliseconds"]
  ];
  for (const [loc, utc] of getters) {
    proto[loc] = function () {
      const t = _getTime.call(this);
      if (isNaN(t)) return NaN;
      return shiftedUTC(t)[utc]();
    };
  }
  proto.getYear = function () { return this.getFullYear() - 1900; };

  proto.getTimezoneOffset = function () {
    const t = _getTime.call(this);
    if (isNaN(t)) return NaN;
    return -offsetAt(t) / 60000;
  };

  // --- local setters: read wall comps, overwrite, recompute epoch -----------
  function wallComps(date) {
    const u = shiftedUTC(_getTime.call(date));
    return [u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
            u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds(), u.getUTCMilliseconds()];
  }
  const setterStart = {
    setFullYear: 0, setMonth: 1, setDate: 2,
    setHours: 3, setMinutes: 4, setSeconds: 5, setMilliseconds: 6
  };
  for (const name in setterStart) {
    const start = setterStart[name];
    proto[name] = function (...vals) {
      const c = wallComps(this);
      for (let i = 0; i < vals.length && start + i < 7; i++) c[start + i] = +vals[i];
      return this.setTime(wallToMs(c[0], c[1], c[2], c[3], c[4], c[5], c[6]));
    };
  }
  proto.setYear = function (y) { return this.setFullYear(y < 100 ? 1900 + +y : +y); };

  // --- string formatters ----------------------------------------------------
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n, l = 2) => String(Math.trunc(Math.abs(n))).padStart(l, "0");
  const nameFmt = new _DTF("en-US", { timeZone: TZ, timeZoneName: "long" });

  function offStr(date) {
    const o = -date.getTimezoneOffset();
    return "GMT" + (o >= 0 ? "+" : "-") + pad(o / 60) + pad(Math.abs(o) % 60);
  }
  function tzName(date) {
    const p = nameFmt.formatToParts(date).find(x => x.type === "timeZoneName");
    return p ? p.value : TZ;
  }
  proto.toDateString = function () {
    if (isNaN(_getTime.call(this))) return "Invalid Date";
    const c = wallComps(this);
    return DOW[this.getDay()] + " " + MON[c[1]] + " " + pad(c[2]) + " " + c[0];
  };
  proto.toTimeString = function () {
    if (isNaN(_getTime.call(this))) return "Invalid Date";
    const c = wallComps(this);
    return pad(c[3]) + ":" + pad(c[4]) + ":" + pad(c[5]) + " " + offStr(this) + " (" + tzName(this) + ")";
  };
  proto.toString = function () {
    if (isNaN(_getTime.call(this))) return "Invalid Date";
    return this.toDateString() + " " + this.toTimeString();
  };
  proto.toLocaleString = function (l, o) {
    return new _DTF(l, Object.assign({ timeZone: TZ }, o)).format(this);
  };
  proto.toLocaleDateString = function (l, o) {
    return new _DTF(l, Object.assign(
      { year: "numeric", month: "numeric", day: "numeric", timeZone: TZ }, o)).format(this);
  };
  proto.toLocaleTimeString = function (l, o) {
    return new _DTF(l, Object.assign(
      { hour: "numeric", minute: "numeric", second: "numeric", timeZone: TZ }, o)).format(this);
  };

  // --- constructor / parsing ------------------------------------------------
  function parseStr(s) {
    s = String(s).trim();
    if (/(z|[+-]\d\d:?\d\d|gmt|utc)\s*$/i.test(s)) return _Date.parse(s); // explicit zone -> native
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/i);
    if (m) {
      const msec = m[7] ? +(m[7] + "000").slice(0, 3) : 0;
      return wallToMs(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), msec);
    }
    return _Date.parse(s); // non-ISO local strings: best effort via native
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
  TZDate.now = _Date.now;
  TZDate.UTC = _Date.UTC;
  TZDate.parse = parseStr;
  try { Object.defineProperty(TZDate, "name", { value: "Date" }); } catch (e) {}
  Date = TZDate;

  // --- Intl.DateTimeFormat: default timeZone -> target ----------------------
  function TZDateTimeFormat(...args) {
    const opts = Object.assign({}, args[1]);
    if (!opts.timeZone) opts.timeZone = TZ;
    args[1] = opts;
    if (new.target) return Reflect.construct(_DTF, args, new.target);
    return _DTF(...args);
  }
  TZDateTimeFormat.prototype = _DTF.prototype;
  TZDateTimeFormat.supportedLocalesOf = _DTF.supportedLocalesOf.bind(_DTF);
  try { Object.defineProperty(TZDateTimeFormat, "name", { value: "DateTimeFormat" }); } catch (e) {}
  Intl.DateTimeFormat = TZDateTimeFormat;
}

// ---------------------------------------------------------------------------
// Registration plumbing.
// ---------------------------------------------------------------------------
function matchesFor(domain) {
  // domain + every subdomain: example.com, x.example.com, x.y.example.com
  return ["*://" + domain + "/*", "*://*." + domain + "/*"];
}

function buildCode(tz) {
  return "(" + tzPatcher.toString() + ")(" + JSON.stringify(tz) + ");";
}

function hostMatchesRule(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

async function getRules() {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const rules = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  // sanitize
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

  // wipe existing registrations
  try {
    const existing = await chrome.userScripts.getScripts();
    if (existing.length) {
      await chrome.userScripts.unregister({ ids: existing.map(s => s.id) });
    }
  } catch (e) {
    console.warn("[tz-spoofer] unregister failed:", e);
  }

  // register fresh, one per rule
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
    if (rules.some(r => hostMatchesRule(host, r.domain))) {
      chrome.tabs.reload(tab.id);
    }
  }
}

async function rebuildAndReload() {
  const rules = await rebuild();
  await reloadMatchingTabs(rules);
}

// Triggers: install, startup, and any config change.
chrome.runtime.onInstalled.addListener(() => rebuild());
chrome.runtime.onStartup.addListener(() => rebuild());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[STORAGE_KEY]) rebuildAndReload();
});

// Clicking the toolbar icon opens options.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
