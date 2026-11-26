// routes/vehicles.js — Lokaal Vehicles data API (public/vehicles.html)
// GET /api/vehicles            -> { sections, regions, items, ads, advertise }
// GET /api/vehicles?refresh=1  -> skip the 5-minute cache
// GET /api/vehicles?debug=1    -> per-section report (collection found, fields seen, field map, counts, errors)
//
// Sections (Cars & Trucks, Recreational) come from config/vehicles-sites.json; each section can
// pull from several sites (add another { domain, collectionName } to its "sources" list).
// Paid ads come from that site's "Biz Listings" collection, rows whose Page field = "Vehicles":
//   Title "Main Page"             -> big Featured window at the top
//   Title "Cars & Trucks"         -> ad inside the Cars & Trucks box
//   Title "Recreational Vehicles" -> ad inside the Recreational box
//   Optional Biz Listings fields Ad Title / Ad Price / Ad City show text over the ad picture.
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
const ROLES = {
  title: ["title", "name", "vehiclename"],
  condition: ["neworused", "condition", "status", "newused"],
  type: ["vehicletype", "type", "rvtype", "class", "category"],
  make: ["maker", "make", "brand", "manufacturer"],
  model: ["model"],
  year: ["year", "modelyear"],
  price: ["price", "askingprice", "price1"],
  image: ["image", "mainimage", "photo"],
  gallery: ["gallery", "mediagallery", "photos", "images"],
  city: ["city", "location", "nameofcity", "town"],
  region: ["region"],
  address: ["maplocation", "address"],
  desc: ["description", "shortdescription", "details"],
  seller: ["sellername", "agentname", "seller", "dealer", "agent"],
  phone: ["sellerphone", "phone", "agentphone", "phonenumber"],
  email: ["selleremail", "agentemail", "email"],
  featured: ["featured"],
  order: ["order"],
  // Biz Listings
  page: ["page"],
  adImage: ["adimage"],
  adCard: ["adcard"],
  adLink: ["adlink"],
  adStart: ["adstart"],
  adEnd: ["adend"],
  adActive: ["adactive"],
  adTitle: ["adtitle"],
  adPrice: ["adprice"],
  adCity: ["adcity"],
};
// Key specs shown on the card (when the column exists)
const SPECS = [
  ["Year", ["year", "modelyear"]],
  ["Mileage", ["mileage", "miles", "odometer"]],
  ["Hours", ["hours", "enginehours"]],
  ["Length", ["length", "lengthft"]],
  ["Sleeps", ["sleeps"]],
  ["Slides", ["slides", "slideouts"]],
  ["Transmission", ["transmission", "transmissiontype"]],
  ["Drive", ["drive", "drivetrain"]],
  ["Fuel", ["fuel", "fueltype"]],
  ["Engine", ["engine"]],
  ["Dry Weight", ["dryweight", "weight"]],
  ["Color", ["color", "exteriorcolor"]],
];
const SKIP_MORE = /alt.?text|^_|^link-|slug|seo/i;

function mapFields(coll, overrides = {}) {
  const fields = (coll && coll.fields) || [];
  const find = (names) => {
    for (const w of names) {
      const f = fields.find((x) => norm(x.displayName) === norm(w) || norm(x.key) === norm(w));
      if (f) return f.key;
    }
    return null;
  };
  const map = {};
  for (const [role, names] of Object.entries(ROLES)) map[role] = overrides[role] || find(names);
  if (!map.title) map.title = "title";
  const specs = SPECS.map(([label, names]) => [label, find(names)]).filter(([, k]) => k);
  return { map, specs };
}

function wixImage(v) {
  if (!v) return "";
  if (typeof v === "object") v = v.src || v.url || "";
  v = String(v);
  const m = v.match(/^wix:image:\/\/v1\/([^/#]+)/);
  if (m) return `https://static.wixstatic.com/media/${m[1]}`;
  return v.startsWith("http") ? v : "";
}
function text(v) {
  if (v == null || typeof v === "object") return "";
  return String(v).replace(/\s+/g, " ").trim();
}
const isPlaceholder = (s) => /placeholder text/i.test(String(s || ""));
function titleCase(s) { return s.replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
function cleanCity(s) { return titleCase(text(s).replace(/[.,]+$/, "").replace(/,\s*tx$/i, "").toLowerCase()); }
function addressText(v) {
  if (!v) return "";
  if (typeof v === "string") return text(v);
  return text(v.formatted || v.formattedAddress || "");
}
function addressCity(v) {
  if (!v || typeof v !== "object") return "";
  return text(v.city || (v.subdivisions && "") || "");
}
function cleanPrice(v) {
  const s = text(v);
  if (!s) return "";
  const num = Number(s.replace(/[$,\s]/g, ""));
  if (!isNaN(num) && s.replace(/[$,.\s\d]/g, "") === "") return "$" + num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return s;
}
function priceNum(p) { const n = Number(String(p).replace(/[^0-9.]/g, "")); return isFinite(n) && n > 0 ? n : null; }
function itemLink(row, domain) {
  let best = "";
  for (const [k, v] of Object.entries(row)) {
    if (!/^link-/.test(k) || typeof v !== "string" || !v.startsWith("/")) continue;
    if (v.split("/").filter(Boolean).length >= 2 && v.length > best.length) best = v;
  }
  return best ? `https://www.${bareDomain(domain)}${best}` : "";
}
function cityToRegion(city, regions) {
  const c = norm(city);
  for (const [r, list] of Object.entries(regions || {})) if (list.some((x) => norm(x) === c)) return r;
  return "";
}
function toDate(v) {
  if (!v) return null;
  const t = Date.parse(typeof v === "object" ? v.$date || "" : v);
  return isFinite(t) ? t : null;
}

// ---------- loader ----------
// Each section lists one or more sources { domain, collectionName } so more sites can be added later.
async function load() {
  const cfg = readJson("vehicles-sites.json");
  if (!cfg) throw new Error("config/vehicles-sites.json missing or invalid");
  const debug = { sources: [], ads: [] };
  const items = [], ads = [];
  const sites = new Map(); // domain -> { c, collections } or { error }

  async function site(domain) {
    const key = bareDomain(domain);
    if (sites.has(key)) return sites.get(key);
    const c = findWixCreds(domain);
    let out;
    if (c.error) out = { error: c.error };
    else {
      try { out = { c, collections: await listCollections(c) }; }
      catch (e) { out = { error: "list collections: " + e.message }; }
    }
    sites.set(key, out);
    return out;
  }

  for (const sec of cfg.sections || []) {
    for (const src of sec.sources || []) {
      const d = { section: sec.key, domain: src.domain, collectionName: src.collectionName, errors: [] };
      debug.sources.push(d);
      const st = await site(src.domain);
      if (st.error) { d.errors.push(st.error); continue; }
      d.credentialsFrom = st.c.from;
      const coll = findCollection(st.collections, src.collectionName);
      d.collectionFound = coll ? coll.displayName || coll.id : null;
      if (!coll) { d.errors.push(`collection "${src.collectionName}" not found`); continue; }
      const { map: f, specs } = mapFields(coll, src.fields);
      const used = new Set(Object.values(f).filter(Boolean).concat(specs.map(([, k]) => k)));
      const labelOf = {}; (coll.fields || []).forEach((x) => { labelOf[x.key] = x.displayName || x.key; });
      d.fieldsSeen = (coll.fields || []).map((x) => `${x.displayName} → ${x.key}`);
      d.fieldMap = f; d.specs = specs;
      try {
        const rows = await queryAll(st.c, coll.id);
        d.itemCount = rows.length;
        for (const r of rows) {
          const addr = r[f.address];
          const city = cleanCity(r[f.city]) || cleanCity(addressCity(addr));
          const gallery = (Array.isArray(r[f.gallery]) ? r[f.gallery] : []).map(wixImage).filter(Boolean);
          const image = wixImage(r[f.image]) || gallery[0] || "";
          const price = cleanPrice(r[f.price]);
          const more = [];
          for (const [k, v] of Object.entries(r)) {
            if (used.has(k) || SKIP_MORE.test(k) || !labelOf[k]) continue;
            const t = text(v);
            if (t && !isPlaceholder(t) && t.length < 200) more.push([labelOf[k], t]);
          }
          items.push({
            id: `${sec.key}:${bareDomain(src.domain).split(".")[0]}:${r._id}`,
            sec: sec.key,
            title: text(r[f.title]),
            condition: titleCase(text(r[f.condition]).toLowerCase()),
            type: text(r[f.type]),
            make: text(r[f.make]),
            model: text(r[f.model]),
            price, priceNum: priceNum(price),
            image,
            gallery: [image, ...gallery.filter((g) => g !== image)].filter(Boolean),
            city,
            region: text(r[f.region]) || cityToRegion(city, cfg.regions),
            address: addressText(addr),
            desc: isPlaceholder(r[f.desc]) ? "" : text(r[f.desc]),
            seller: text(r[f.seller]),
            phone: text(r[f.phone]),
            email: text(r[f.email]),
            featured: !!(f.featured && r[f.featured] === true),
            specs: specs.map(([label, k]) => [label, text(r[k])]).filter(([, v]) => v),
            more,
            link: itemLink(r, src.domain),
            created: toDate(r._createdDate) || 0,
          });
        }
      } catch (e) { d.errors.push("items: " + e.message); }
    }
  }

  // ---- paid ads: Biz Listings on every site used above, rows with Page = Vehicles ----
  const want = norm(cfg.adPage || "Vehicles").replace(/s$/, "");
  const now = Date.now();
  for (const [domain, st] of sites) {
    const d = { domain, errors: [] };
    debug.ads.push(d);
    if (st.error) { d.errors.push(st.error); continue; }
    const lcoll = findCollection(st.collections, cfg.listingsCollectionName || "Biz Listings");
    d.listingsFound = lcoll ? lcoll.displayName : null;
    if (!lcoll) continue;
    const { map: f } = mapFields(lcoll);
    if (!f.page) { d.errors.push('Biz Listings has no "Page" field yet — add a Text field named Page'); continue; }
    try {
      const rows = await queryAll(st.c, lcoll.id);
      const vRows = rows.filter((r) => norm(r[f.page]).includes(want));
      d.vehicleAdRows = vRows.length;
      for (const r of vRows) {
        if (f.adActive && r[f.adActive] === false) continue;
        const s = toDate(r[f.adStart]), e = toDate(r[f.adEnd]);
        if (s && s > now) continue;
        if (e && e + 86400000 < now) continue;
        const img = wixImage(r[f.adImage]);
        if (!img) continue;
        ads.push({
          spot: text(r[f.title]),
          image: img,
          link: text(r[f.adLink]),
          title: text(r[f.adTitle]),
          price: cleanPrice(r[f.adPrice]),
          city: text(r[f.adCity]),
          order: Number(r[f.order]) || 0,
        });
      }
    } catch (e) { d.errors.push("Biz Listings: " + e.message); }
  }
  ads.sort((a, b) => a.order - b.order);
  return pack(cfg, items, ads, debug);
}

function pack(cfg, items, ads, debug) {
  items.sort((a, b) => (b.featured - a.featured) || (b.created - a.created));
  return {
    sections: (cfg.sections || []).map(({ key, label, adTitle, listTitle, addItemLink }) => ({ key, label, adTitle, listTitle, addItemLink })),
    regions: cfg.regions || {},
    advertise: { text: cfg.advertiseText || "Your Vehicle Here — Advertise on Lokaal", link: cfg.advertiseLink || "" },
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
