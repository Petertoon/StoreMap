// routes/exchange.js — Lokaal Exchange data API
// GET /api/exchange            -> { sites, regions, items, ads, advertise }
// GET /api/exchange?refresh=1  -> skip the 5-minute cache
// GET /api/exchange?debug=1    -> per-site report (collection found, fields seen, counts, errors)
//
// Items come from each site's exchange collection (config/exchange-sites.json).
// Paid ads come from each site's "Biz Listings" collection, rows whose Page field = "Exchange".
//   Title "Main Page"  -> big window on the Exchange start screen (both sites rotate)
//   Title "Home Items" / "Work Items" (the site's adTitle) -> window inside that list
// Wix keys are borrowed from the site with the same domain in config/sites.json (no new env vars).

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const CONFIG_DIR = path.join(__dirname, "..", "config");
const WIX = "https://www.wixapis.com/wix-data/v2";
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

// ---------- helpers ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const bareDomain = (d) => String(d || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), "utf8")); }
  catch (e) { return null; }
}

// Wix credentials — same method as routes/bizcards.js: find the site with the same domain
// in config/sites.json and read its apiKeyEnv / accountIdEnv / siteIdEnv from Render env vars.
function findWixCreds(domain) {
  const want = bareDomain(domain);
  const cfg = readJson("sites.json");
  if (!cfg) return { error: "config/sites.json not found or not valid JSON" };
  const list = Array.isArray(cfg) ? cfg : cfg.sites || [];
  const match = list.find((s) => bareDomain(s.domain) === want);
  if (!match) return { error: `no site with domain ${want} in config/sites.json` };
  const creds = {
    apiKey: process.env[match.apiKeyEnv],
    accountId: process.env[match.accountIdEnv],
    siteId: process.env[match.siteIdEnv],
    from: match.siteId || want,
  };
  if (!creds.apiKey || !creds.accountId || !creds.siteId) {
    return { error: `found ${want} in sites.json but its env vars (${match.apiKeyEnv}, ${match.accountIdEnv}, ${match.siteIdEnv}) are not all set on Render` };
  }
  return creds;
}

async function wix(creds, method, url, body) {
  const res = await fetch(WIX + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: creds.apiKey,
      "wix-account-id": creds.accountId,
      "wix-site-id": creds.siteId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function listCollections(creds) {
  const out = await wix(creds, "GET", "/collections?paging.limit=200");
  return out.collections || out.dataCollections || [];
}

function findCollection(collections, name) {
  const n = norm(name);
  return collections.find((c) => norm(c.displayName) === n || norm(c.id) === n)
      || collections.find((c) => norm(c.displayName).includes(n) || n.includes(norm(c.displayName)));
}

async function queryAll(creds, collectionId) {
  const items = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const out = await wix(creds, "POST", "/items/query", {
      dataCollectionId: collectionId,
      query: { paging: { limit: 100, offset } },
    });
    const batch = (out.dataItems || []).map((d) => ({ ...(d.data || {}), _id: (d.data && d.data._id) || d.id }));
    items.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  return items;
}

// Build { role: fieldKey } from the collection's field list, matching display names loosely.
const ROLES = {
  title: ["itemname", "name", "title"],
  condition: ["neworused", "condition", "newused"],
  city: ["nameofcity", "city", "location", "town"],
  region: ["region"],
  price: ["price1", "price", "askingprice"],
  image: ["image", "mainimage", "photo", "picture"],
  gallery: ["gallery", "mediagallery", "photos", "images"],
  desc: ["shortdescription", "description", "details", "introduction"],
  phone: ["phone", "phonenumber", "phone#", "contactphone", "sellerphone", "cell"],
  seller: ["seller", "sellername", "yourname", "contactname", "postedby"],
  email: ["email", "selleremail", "contactemail"],
  featured: ["featured", "new"],
  order: ["order", "sortorder"],
  page: ["page"],
  adImage: ["adimage"],
  adCard: ["adcard"],
  adLink: ["adlink"],
  adStart: ["adstart"],
  adEnd: ["adend"],
  adActive: ["adactive"],
};

function mapFields(collection, overrides = {}) {
  const fields = (collection && collection.fields) || [];
  const map = {};
  for (const [role, names] of Object.entries(ROLES)) {
    if (overrides[role]) { map[role] = overrides[role]; continue; }
    for (const want of names) {
      const f = fields.find((x) => norm(x.displayName) === norm(want) || norm(x.key) === norm(want));
      if (f) { map[role] = f.key; break; }
    }
  }
  // title fallback = the collection's primary "title" key
  if (!map.title) map.title = "title";
  return map;
}

function wixImage(v) {
  if (!v) return "";
  if (typeof v === "object") v = v.src || v.url || "";
  v = String(v);
  const m = v.match(/^wix:image:\/\/v1\/([^/]+)\//);
  if (m) return `https://static.wixstatic.com/media/${m[1]}`;
  if (v.startsWith("http")) return v;
  if (/^[\w-]+~mv2\.\w+$/.test(v) || /^[\w]+_[\w]+~mv2/.test(v)) return `https://static.wixstatic.com/media/${v}`;
  return "";
}

const isPlaceholder = (s) => /placeholder text/i.test(String(s || ""));

function cleanPrice(v) {
  if (v === undefined || v === null || v === "") return "";
  const s = String(v).trim();
  const num = Number(s.replace(/[$,\s]/g, ""));
  if (!isNaN(num) && s.replace(/[$,.\s\d]/g, "") === "") {
    return "$" + num.toLocaleString("en-US", { minimumFractionDigits: num % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  return s;
}

// Dynamic item page link: field key like "link-exchange-1-title" with value "/exchange-1/slug".
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
  if (!c) return "";
  for (const [region, cities] of Object.entries(regions || {})) {
    if (cities.some((x) => norm(x) === c)) return region;
  }
  return "";
}

function cleanCity(s) {
  return String(s || "").trim().replace(/[.,]+$/, "").replace(/,\s*tx$/i, "").trim();
}

function adIsLive(row, f) {
  const now = Date.now();
  if (f.adActive && row[f.adActive] === false) return false;
  const start = f.adStart && row[f.adStart] ? new Date(row[f.adStart].$date || row[f.adStart]).getTime() : null;
  const end = f.adEnd && row[f.adEnd] ? new Date(row[f.adEnd].$date || row[f.adEnd]).getTime() : null;
  if (start && now < start) return false;
  if (end && now > end + 24 * 3600 * 1000) return false;
  return true;
}

// ---------- main loader ----------
async function load() {
  const cfg = readJson("exchange-sites.json");
  if (!cfg) throw new Error("config/exchange-sites.json missing or invalid");
  const bizCfg = readJson("bizcard-sites.json");
  const bizBlocks = Array.isArray(bizCfg) ? bizCfg : (bizCfg && (bizCfg.sites || bizCfg.tiles)) || [];

  const items = [];
  const ads = [];
  const debug = [];

  for (const site of cfg.sites || []) {
    const d = { key: site.key, domain: site.domain, collectionName: site.collectionName, errors: [] };
    debug.push(d);
    const creds = findWixCreds(site.domain);
    if (creds.error) { d.errors.push(creds.error); continue; }
    d.credentialsFrom = creds.from;

    let collections = [];
    try { collections = await listCollections(creds); }
    catch (e) { d.errors.push("list collections: " + e.message); continue; }
    d.collectionsOnSite = collections.map((c) => c.displayName || c.id);

    // --- exchange items ---
    const coll = findCollection(collections, site.collectionName);
    d.collectionFound = coll ? (coll.displayName || coll.id) : null;
    if (coll) {
      const f = mapFields(coll, site.fields);
      d.fieldsSeen = (coll.fields || []).map((x) => `${x.displayName} → ${x.key}`);
      d.fieldMap = f;
      try {
        const rows = await queryAll(creds, coll.id);
        d.itemCount = rows.length;
        for (const r of rows) {
          const city = cleanCity(r[f.city]);
          const gallery = (Array.isArray(r[f.gallery]) ? r[f.gallery] : []).map(wixImage).filter(Boolean);
          const image = wixImage(r[f.image]) || gallery[0] || "";
          const desc = isPlaceholder(r[f.desc]) ? "" : String(r[f.desc] || "");
          items.push({
            id: `${site.key}:${r._id}`,
            site: site.key,
            title: String(r[f.title] || "").trim(),
            condition: String(r[f.condition] || "").trim(),
            city,
            region: String(r[f.region] || "").trim() || cityToRegion(city, cfg.regions),
            price: cleanPrice(r[f.price]),
            image,
            gallery: [image, ...gallery.filter((g) => g !== image)].filter(Boolean),
            desc,
            phone: String(r[f.phone] || "").trim(),
            email: String(r[f.email] || "").trim(),
            seller: String(r[f.seller] || "").trim(),
            featured: !!(f.featured && r[f.featured] === true),
            order: f.order && r[f.order] !== undefined ? Number(r[f.order]) : null,
            link: itemLink(r, site.domain),
            created: r._createdDate ? new Date(r._createdDate.$date || r._createdDate).getTime() : 0,
          });
        }
      } catch (e) { d.errors.push("items: " + e.message); }
    } else {
      d.errors.push(`collection "${site.collectionName}" not found`);
    }

    // --- paid ads from Biz Listings (Page = Exchange) ---
    const lcoll = findCollection(collections, cfg.listingsCollectionName || "Biz Listings");
    d.listingsFound = lcoll ? (lcoll.displayName || lcoll.id) : null;
    if (lcoll) {
      const f = mapFields(lcoll);
      try {
        const rows = await queryAll(creds, lcoll.id);
        const exRows = rows.filter((r) => f.page && /exchange/i.test(String(r[f.page] || "")));
        d.exchangeAdRows = exRows.length;
        if (!f.page) d.errors.push('Biz Listings has no "Page" field yet — add a Text field named Page');

        // look up advertiser cards (Ad Card reference) in this site's biz card collection
        const cardIds = exRows.map((r) => r[f.adCard]).map((v) => (v && typeof v === "object" ? v._id : v)).filter(Boolean);
        const cards = {};
        if (cardIds.length) {
          const block = bizBlocks.find((b) => bareDomain(b.domain) === bareDomain(site.domain));
          const cardColl = findCollection(collections, (block && block.collectionName) || "");
          if (cardColl) {
            const cf = mapFields(cardColl, (block && block.fields) || {});
            const phoneKey = cf.phone;
            const crow = await queryAll(creds, cardColl.id);
            for (const c of crow) {
              if (!cardIds.includes(c._id)) continue;
              cards[c._id] = { title: c[cf.title] || "", image: wixImage(c[cf.image]), phone: phoneKey ? String(c[phoneKey] || "") : "" };
            }
          }
        }

        for (const r of exRows) {
          if (!adIsLive(r, f)) continue;
          const img = wixImage(r[f.adImage]);
          if (!img) continue;
          const cardId = r[f.adCard] && typeof r[f.adCard] === "object" ? r[f.adCard]._id : r[f.adCard];
          ads.push({
            site: site.key,
            spot: String(r[f.title] || "").trim(),
            image: img,
            link: String(r[f.adLink] || "").trim(),
            card: cardId ? cards[cardId] || null : null,
            order: f.order ? Number(r[f.order]) || 0 : 0,
          });
        }
      } catch (e) { d.errors.push("Biz Listings: " + e.message); }
    }
  }

  items.sort((a, b) => (b.featured - a.featured) || (b.created - a.created));
  ads.sort((a, b) => a.order - b.order);

  return {
    updated: Date.now(),
    sites: (cfg.sites || []).map(({ key, label, short, adTitle, icon, addItemLink }) => ({ key, label, short, adTitle, icon, addItemLink })),
    regions: cfg.regions || {},
    advertise: { text: cfg.advertiseText || "Your Business Here — Advertise on Lokaal Exchange", link: cfg.advertiseLink || "" },
    items,
    ads,
    debug,
  };
}

router.get("/", async (req, res) => {
  try {
    if (req.query.refresh || !cache.data || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), data: await load() };
    }
    const { debug, ...data } = cache.data;
    res.set("Cache-Control", "no-store");
    if (req.query.debug) return res.json({ cachedAt: new Date(cache.at).toISOString(), itemCount: data.items.length, adCount: data.ads.length, sites: debug });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
