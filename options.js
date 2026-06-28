const STORAGE_KEY = "rules";

const $ = (id) => document.getElementById(id);

// IANA timezone list (falls back to a small set on old browsers).
function tzList() {
  try {
    if (Intl.supportedValuesOf) return Intl.supportedValuesOf("timeZone");
  } catch (e) {}
  return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London",
          "Europe/Berlin", "Asia/Tehran", "Asia/Tokyo", "Australia/Sydney"];
}

function localTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return "UTC"; }
}

const TZ_SET = new Set(tzList());
function isValidTz(tz) { return TZ_SET.has(tz); }

// Fill the shared <datalist> once so every tz input gets type-to-search.
function fillDatalist() {
  const dl = $("tz-options");
  if (dl.childElementCount) return;
  for (const tz of tzList()) {
    const opt = document.createElement("option");
    opt.value = tz;
    dl.appendChild(opt);
  }
}

function normalizeDomain(raw) {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); // strip scheme/path
  d = d.replace(/^\*+\./, "");                            // strip leading *.
  d = d.replace(/:\d+$/, "");                             // strip port
  return d;
}

function isValidDomain(d) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(d);
}

async function getRules() {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}
function setRules(rules) {
  return chrome.storage.sync.set({ [STORAGE_KEY]: rules });
}

function render(rules) {
  const body = $("rules-body");
  body.innerHTML = "";
  $("empty").classList.toggle("hidden", rules.length > 0);

  rules.forEach((rule, idx) => {
    const tr = document.createElement("tr");

    const tdDomain = document.createElement("td");
    tdDomain.textContent = rule.domain;

    const tdTz = document.createElement("td");
    const inp = document.createElement("input");
    inp.setAttribute("list", "tz-options");
    inp.value = rule.tz;
    inp.placeholder = "Search timezone…";
    inp.autocomplete = "off";
    const commit = async () => {
      if (!isValidTz(inp.value)) { inp.value = rule.tz; return; } // revert junk
      const r = await getRules();
      r[idx].tz = inp.value;
      rule.tz = inp.value;
      await setRules(r);
    };
    inp.addEventListener("change", commit);
    tdTz.appendChild(inp);

    const tdDel = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "del";
    btn.addEventListener("click", async () => {
      const r = await getRules();
      r.splice(idx, 1);
      await setRules(r);
      render(r);
    });
    tdDel.appendChild(btn);

    tr.append(tdDomain, tdTz, tdDel);
    body.appendChild(tr);
  });
}

async function init() {
  if (!chrome.userScripts) $("warn").classList.remove("hidden");

  fillDatalist();
  $("tz").value = localTz();
  render(await getRules());

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const domain = normalizeDomain($("domain").value);
    if (!isValidDomain(domain)) {
      alert("Enter a valid domain like example.com");
      return;
    }
    const tz = $("tz").value.trim();
    if (!isValidTz(tz)) {
      alert("Pick a timezone from the list (type to search).");
      return;
    }
    const rules = await getRules();
    const existing = rules.find(r => r.domain === domain);
    if (existing) existing.tz = tz;     // update instead of duplicate
    else rules.push({ domain, tz });
    await setRules(rules);
    render(rules);
    $("domain").value = "";
  });
}

init();
