// routes/community.js — Lokaal Community data API (public/community.html)
// GET /api/community            -> { sections, regions, items, ads, welcome, links }
// GET /api/community?refresh=1  -> skip the 5-minute cache
// GET /api/community?debug=1    -> per-source report (collection found, fields seen, field map, counts, errors)
//
// Sections come from config/community-sites.json. Each section has a "kind":
//   events    -> dated events (upcoming / past)            e.g. CommunityEvents on lokaalr1.com
//   churches  -> church & ministry directory                e.g. Church Podcast on lokaalr1.com
//   podcasts  -> churches with a podcast / Listen link      e.g. Church Podcast on lokaalr1.com
//   fundraisers, projects -> cards with goal/progress or needs (collections can be added later)
// A section whose collection doesn't exist yet just shows "Coming soon".
// Optional paid ad: Biz Listings rows with Page = "Community", Title "Main Page" replace the welcome picture.
// Wix keys come from config/sites.json + Render env vars, same as routes/bizcards.js.

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const CONFIG_DIR = path.join(__dirname, "..", "config");
const WIX = "https://www.wixapis.com/wix-data/v2";
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const bareDomain = (d) => String(d || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), "utf8")); } catch (e) { return null; }
}

// ---------- Wix connection (same as bizcards.js) ----------
function findWixCreds(domain) {
  const want = bareDomain(domain);
  const cfg = readJson("sites.json");
  if (!cfg) return { error: "config/sites.json not found or not valid JSON" };
  const list = Array.isArray(cfg) ? cfg : cfg.sites || [];
  const match = list.find((s) => bareDomain(s.domain) === want);
  if (!match) return { error: `no site with domain ${want} in config/sites.json` };
  const c = {
    apiKey: process.env[match.apiKeyEnv],
    accountId: process.env[match.accountIdEnv],
    siteId: process.env[match.siteIdEnv],
    from: match.siteId || want,
  };
  if (!c.apiKey || !c.accountId || !c.siteId) return { error: `env vars for ${want} not all set on Render` };
  return c;
}
async function wix(c, method, url, body) {
  const res = await fetch(WIX + url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: c.apiKey, "wix-account-id": c.accountId, "wix-site-id": c.siteId },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
async function listCollections(c) {
  const out = await wix(c, "GET", "/collections?paging.limit=200");
  return out.collections || [];
}
function findCollection(list, name) {
  const n = norm(name);
  return list.find((x) => norm(x.displayName) === n) || list.find((x) => norm(x.id) === n);
}
async function queryAll(c, id) {
  const items = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const out = await wix(c, "POST", "/items/query", { dataCollectionId: id, query: { paging: { limit: 100, offset } } });
    const page = (out.dataItems || []).map((d) => ({ ...(d.data || {}), _id: (d.data && d.data._id) || d.id }));
    items.push(...page);
    if (page.length < 100) break;
  }
  return items;
}

// ---------- field matching ----------

// ---------- field matching ----------
const ROLES = {
  title: ["title", "name", "eventname", "churchname"],
  subtitle: ["title2", "subtitle", "denomination", "organization", "ministry"],
  start: ["eventdate", "startdate", "date", "start", "when"],
  end: ["enddate", "end"],
  location: ["location", "venue", "place"],
  address: ["address", "maplocation", "streetaddress"],
  city: ["city", "town"],
  region: ["region"],
  desc: ["description", "details", "about", "shortdescription"],
  image: ["eventimage", "image", "logo", "photo", "picture"],
  contactName: ["contactname", "contact", "pastor", "organizer"],
  phone: ["phone", "contactphone", "phonenumber"],
  email: ["contactemail", "email"],
  category: ["eventcategory", "category", "type"],
  link: ["url", "link", "website", "weburl", "registrationlink", "registerlink", "donatelink", "podcastlink"],
  podcast: ["podcast", "podcasturl", "podcastlink", "rss"],
  serviceTimes: ["servicetimes", "services", "servicetime", "worshiptimes"],
  goal: ["goal", "fundraisinggoal", "target"],
  raised: ["raised", "amountraised", "collected", "total"],
  needs: ["needs", "whatsneeded", "helpneeded", "volunteersneeded"],
  // Biz Listings
  page: ["page"], adImage: ["adimage"], adLink: ["adlink"], adStart: ["adstart"], adEnd: ["adend"], adActive: ["adactive"],
  adTitle: ["adtitle"], adCity: ["adcity"], order: ["order"],
};
function mapFields(coll, overrides = {}) {
  const fields = (coll && coll.fields) || [];
  const map = {};
  for (const [role, names] of Object.entries(ROLES)) {
    if (overrides[role]) { map[role] = overrides[role]; continue; }
    for (const w of names) {
      const f = fields.find((x) => norm(x.displayName) === norm(w) || norm(x.key) === norm(w));
      if (f) { map[role] = f.key; break; }
    }
  }
  if (!map.title) map.title = "title";
  return map;
}
function wixImage(v) {
  if (!v) return "";
  if (typeof v === "object") v = v.src || v.url || "";
  v = String(v);
  const m = v.match(/^wix:image:\/\/v1\/([^/#]+)/);
  if (m) return `https://static.wixstatic.com/media/${m[1]}`;
  return v.startsWith("http") ? v : "";
}
function text(v) { if (v == null || typeof v === "object") return ""; return String(v).replace(/\s+/g, " ").trim(); }
const isPlaceholder = (s) => /placeholder text/i.test(String(s || ""));
function titleCase(s) { return s.replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
function cleanCity(s) { return titleCase(text(s).replace(/[.,]+$/, "").replace(/,\s*tx$/i, "").toLowerCase()); }
function addressText(v) {
  if (!v) return "";
  if (typeof v === "string") return /[a-z]/i.test(v) ? text(v) : "";
  return text(v.formatted || v.formattedAddress || "");
}
function toDate(v) {
  if (!v) return null;
  const t = Date.parse(typeof v === "object" ? v.$date || v.date || "" : v);
  return isFinite(t) ? t : null;
}
function num(v) { const n = Number(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return v !== "" && v != null && isFinite(n) ? n : null; }
function url(v) { const t = text(v); return /^https?:\/\//i.test(t) ? t : ""; }
function cityToRegion(city, regions) {
  const c = norm(city);
  for (const [r, list] of Object.entries(regions || {})) if (list.some((x) => norm(x) === c)) return r;
  return "";
}

// ---------- loader ----------
async function load() {
  const cfg = readJson("community-sites.json");
  if (!cfg) throw new Error("config/community-sites.json missing or invalid");
  const debug = { sources: [], ads: [] };
  const items = [], ads = [];
  const sites = new Map();
  async function site(domain) {
    const key = bareDomain(domain);
    if (sites.has(key)) return sites.get(key);
    const c = findWixCreds(domain);
    let out;
    if (c.error) out = { error: c.error };
    else { try { out = { c, collections: await listCollections(c) }; } catch (e) { out = { error: "list collections: " + e.message }; } }
    sites.set(key, out);
    return out;
  }
  const ready = {}; // section key -> true when at least one collection was found

  for (const sec of cfg.sections || []) {
    for (const src of sec.sources || []) {
      const d = { section: sec.key, domain: src.domain, collectionName: src.collectionName, errors: [] };
      debug.sources.push(d);
      const st = await site(src.domain);
      if (st.error) { d.errors.push(st.error); continue; }
      const coll = findCollection(st.collections, src.collectionName);
      d.collectionFound = coll ? coll.displayName || coll.id : null;
      if (!coll) { d.errors.push(`collection "${src.collectionName}" not found (section shows "Coming soon")`); continue; }
      ready[sec.key] = true;
      const f = mapFields(coll, src.fields);
      d.fieldsSeen = (coll.fields || []).map((x) => `${x.displayName} → ${x.key}`);
      d.fieldMap = f;
      try {
        const rows = await queryAll(st.c, coll.id);
        d.itemCount = rows.length;
        for (const r of rows) {
          const title = text(r[f.title]);
          if (!title) continue;
          const addr = r[f.address];
          const city = cleanCity(r[f.city]) || cleanCity(addr && typeof addr === "object" ? addr.city : "");
          const loc = addr && typeof addr === "object" ? addr.location || {} : {};
          const goal = num(r[f.goal]), raised = num(r[f.raised]);
          items.push({
            id: `${sec.key}:${bareDomain(src.domain).split(".")[0]}:${r._id}`,
            sec: sec.key,
            title,
            subtitle: text(r[f.subtitle]),
            start: toDate(r[f.start]),
            end: toDate(r[f.end]),
            location: text(r[f.location]),
            address: addressText(addr),
            lat: num(loc.latitude), lng: num(loc.longitude),
            city,
            region: text(r[f.region]) || cityToRegion(city, cfg.regions),
            desc: isPlaceholder(r[f.desc]) ? "" : text(r[f.desc]),
            image: wixImage(r[f.image]),
            contactName: text(r[f.contactName]),
            phone: text(r[f.phone]),
            email: text(r[f.email]),
            category: text(r[f.category]),
            link: url(r[f.link]),
            podcast: url(r[f.podcast]),
            serviceTimes: text(r[f.serviceTimes]),
            goal, raised,
            needs: text(r[f.needs]),
            created: toDate(r._createdDate) || 0,
          });
        }
      } catch (e) { d.errors.push("items: " + e.message); }
    }
  }

  // ---- optional paid ad (Biz Listings, Page = Community) ----
  const now = Date.now();
  for (const [domain, st] of sites) {
    const d = { domain, errors: [] };
    debug.ads.push(d);
    if (st.error) { d.errors.push(st.error); continue; }
    const lcoll = findCollection(st.collections, cfg.listingsCollectionName || "Biz Listings");
    d.listingsFound = lcoll ? lcoll.displayName : null;
    if (!lcoll) continue;
    const f = mapFields(lcoll);
    if (!f.page) continue;
    try {
      const rows = await queryAll(st.c, lcoll.id);
      for (const r of rows.filter((x) => norm(x[f.page]).includes(norm(cfg.adPage || "Community")))) {
        if (f.adActive && r[f.adActive] === false) continue;
        const s = toDate(r[f.adStart]), e = toDate(r[f.adEnd]);
        if ((s && s > now) || (e && e + 86400000 < now)) continue;
        const img = wixImage(r[f.adImage]);
        if (!img) continue;
        ads.push({ spot: text(r[f.title]), image: img, link: text(r[f.adLink]), title: text(r[f.adTitle]), city: text(r[f.adCity]), order: Number(r[f.order]) || 0 });
      }
    } catch (e) { d.errors.push("Biz Listings: " + e.message); }
  }
  ads.sort((a, b) => a.order - b.order);

  return {
    sections: (cfg.sections || []).map(({ key, label, sub, kind, listTitle, addLink }) => ({ key, label, sub, kind, listTitle, addLink, ready: !!ready[key] })),
    regions: cfg.regions || {},
    welcome: cfg.welcome || {},
    links: cfg.links || {},
    timeZone: cfg.timeZone || "America/Chicago",
    items, ads, debug,
  };
}

router.get("/", async (req, res) => {
  try {
    if (req.query.refresh || req.query.debug || !cache.data || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), data: await load() };
    }
    const { debug, ...data } = cache.data;
    res.set("Cache-Control", "no-store");
    if (req.query.debug) return res.json({ cachedAt: new Date(cache.at).toISOString(), itemCount: data.items.length, adCount: data.ads.length, ...debug });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
