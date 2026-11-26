// routes/bizcards.js — Business card listings for the Biz Cards page (public/bizcards.html)
// Reads each site's business-card CMS collection, listed in config/bizcard-sites.json.
// Wix credentials are borrowed from the matching site in config/sites.json (same domain),
// so no new Render environment variables are needed.
//
//   GET /api/bizcards          -> { categories, cards }
//   GET /api/bizcards?debug=1  -> per-site status: collection found, field keys seen, card count, errors
//   GET /api/bizcards?refresh=1 -> skip the 5-minute cache
const express = require("express");
const router = express.Router();
const bizSites = require("../config/bizcard-sites.json");
const storeSites = require("../config/sites.json");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { data, expires }
const collectionIdCache = new Map(); // key -> resolved collection ID
const lastStatus = new Map(); // key -> debug info

// ---------- helpers (same behaviour as routes/stores.js) ----------
function wixImageId(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^wix:image:\/\/v1\/([^/#]+)/);
  if (m) return m[1];
  const s = value.match(/static\.wixstatic\.com\/media\/([^/?#]+)/);
  return s ? s[1] : null;
}
function wixImageToUrl(value) {
  if (!value || typeof value !== "string") return null;
  const id = wixImageId(value);
  if (id) return `https://static.wixstatic.com/media/${id}`;
  return value.startsWith("http") ? value : null;
}
// Smaller copy for the list view (Wix resizes on the fly)
function wixThumb(value, w) {
  const id = wixImageId(value);
  return id ? `https://static.wixstatic.com/media/${id}/v1/fit/w_${w},h_${w},q_85/${id}` : wixImageToUrl(value);
}
function firstImage(v) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  for (const x of list) {
    const s = typeof x === "string" ? x : x && (x.src || x.url || x.image);
    if (wixImageToUrl(s)) return s;
  }
  return null;
}
function toUrl(value, domain) {
  if (!value) return null;
  const v = (typeof value === "string" ? value : value.url || value.href || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/")) return `${domain}${v}`;
  if (/^[^\s/@]+\.[^\s/@]+/.test(v)) return `https://${v}`;
  return null;
}
function cleanText(v) {
  if (v == null) return null;
  if (typeof v === "object") return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t || null;
}
function addressText(v) {
  if (!v) return null;
  if (typeof v === "string") return cleanText(v);
  if (typeof v === "object") {
    if (v.formatted || v.formattedAddress) return cleanText(v.formatted || v.formattedAddress);
    const st = v.streetAddress || {};
    const street = [st.number, st.name].filter(Boolean).join(" ") || v.addressLine || v.addressLine1;
    return cleanText([street, v.city, [v.subdivision, v.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "));
  }
  return null;
}
function cityFromAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  const parts = addr.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2 && /^[A-Za-z]{2}\b/.test(parts[1])) return parts[0];
  return null;
}
function cleanPhone(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9+]/g, "");
  return cleaned.length >= 7 ? cleaned : null;
}
// Read a field: configured key first (any upper/lower case), then the first field whose key matches the pattern.
function getField(d, key, fallback) {
  const has = (n) => d[n] != null && d[n] !== "" && !(Array.isArray(d[n]) && !d[n].length);
  if (key && has(key)) return d[key];
  const names = Object.keys(d);
  const lower = String(key || "").toLowerCase();
  const hit = (key && names.find((n) => n.toLowerCase() === lower && has(n)))
    || (fallback && names.find((n) => fallback.test(n) && has(n)));
  return hit ? d[hit] : null;
}

// ---------- credentials + collection lookup ----------
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return String(u || "").toLowerCase(); }
}
function credsFor(site) {
  const match = storeSites.find((s) => (site.credsFrom && s.siteId === site.credsFrom) || hostOf(s.domain) === hostOf(site.domain)) || {};
  const apiKeyEnv = site.apiKeyEnv || match.apiKeyEnv;
  const accountIdEnv = site.accountIdEnv || match.accountIdEnv;
  const siteIdEnv = site.siteIdEnv || match.siteIdEnv;
  return {
    apiKey: process.env[apiKeyEnv],
    accountId: process.env[accountIdEnv],
    wixSiteId: process.env[siteIdEnv],
    from: match.siteId || null,
  };
}
function headers(c) {
  return { "Content-Type": "application/json", Authorization: c.apiKey, "wix-account-id": c.accountId, "wix-site-id": c.wixSiteId };
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Find the collection ID from its name ("Home Biz Cards") so nobody has to look it up.
async function resolveCollectionId(site, c) {
  if (site.collectionId) return site.collectionId;
  if (collectionIdCache.has(site.key)) return collectionIdCache.get(site.key);
  const res = await fetch("https://www.wixapis.com/wix-data/v2/collections?paging.limit=200", { headers: headers(c) });
  if (!res.ok) throw new Error(`List collections failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const list = json.collections || [];
  const want = norm(site.collectionName);
  const hit = list.find((x) => norm(x.displayName) === want) || list.find((x) => norm(x.id) === want);
  if (!hit) {
    throw new Error(`No collection named "${site.collectionName}". Collections on this site: ` +
      list.map((x) => `${x.displayName} (${x.id})`).join(", "));
  }
  collectionIdCache.set(site.key, hit.id);
  return hit.id;
}

// ---------- read one site ----------
async function fetchSite(site, refresh) {
  const cached = cache.get(site.key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.data;

  const status = { key: site.key, label: site.label, domain: site.domain, collectionName: site.collectionName };
  lastStatus.set(site.key, status);
  if (!site.domain || !site.collectionName && !site.collectionId) {
    status.note = "Coming soon (no site set)";
    return [];
  }
  const c = credsFor(site);
  status.credentialsFrom = c.from;
  if (!c.apiKey || !c.accountId || !c.wixSiteId) {
    status.error = "Missing Wix credentials — no matching site (same domain) in config/sites.json, or its env vars are not set on Render";
    console.warn(`[bizcards] ${status.error} (${site.key})`);
    return [];
  }

  const f = site.fields || {};
  const out = [];
  try {
    const collectionId = await resolveCollectionId(site, c);
    status.collectionId = collectionId;
    for (let offset = 0; offset < 2000; offset += 100) {
      const res = await fetch("https://www.wixapis.com/wix-data/v2/items/query", {
        method: "POST",
        headers: headers(c),
        body: JSON.stringify({ dataCollectionId: collectionId, query: { paging: { limit: 100, offset } } }),
      });
      if (!res.ok) throw new Error(`Wix API ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const items = json.dataItems || [];
      if (offset === 0 && items[0]) status.fieldsSeen = Object.keys(items[0].data).filter((k) => !k.startsWith("_") || k === "_id");
      for (const item of items) {
        const d = item.data || {};
        const name = cleanText(getField(d, f.name || "title", /^(name|business)/i));
        const front = firstImage(getField(d, f.image || "image", /^(image|card|front|photo|logo)/i));
        if (!name && !front) continue;
        const back = firstImage(getField(d, f.backImage || "backImage", /back/i));
        const addrRaw = getField(d, f.address || "address", /address|location/i);
        const address = addressText(addrRaw);
        const order = getField(d, f.order || "order", /^(order|sort|position)/i);
        out.push({
          id: item.id,
          cat: site.key,
          name: name || "Business",
          trade: cleanText(getField(d, f.trade || "trade", /trade|category|service|type/i)) || null,
          listing: cleanText(getField(d, f.listing || "listing", /listing/i)) || null,
          phone: cleanPhone(getField(d, f.phone || "phone", /phone|tel|mobile|cell/i)),
          phoneText: cleanText(getField(d, f.phone || "phone", /phone|tel|mobile|cell/i)),
          address,
          city: cleanText(getField(d, f.city || "city", /^city|town/i))
            || (addrRaw && typeof addrRaw === "object" && cleanText(addrRaw.city))
            || cityFromAddress(address),
          region: cleanText(getField(d, f.region || "region", /region/i)) || site.region || null,
          website: toUrl(getField(d, f.website || "website", /web.?site|url|link$/i), site.domain),
          email: cleanText(getField(d, f.email || "email", /e.?mail/i)),
          description: cleanText(getField(d, f.description || "description", /descr|about|notes/i)),
          order: order != null && order !== "" && isFinite(Number(order)) ? Number(order) : null,
          image: wixImageToUrl(front),
          thumb: wixThumb(front, 700),
          back: wixImageToUrl(back),
        });
      }
      if (items.length < 100) break;
    }
  } catch (err) {
    status.error = String(err.message || err);
    console.error(`[bizcards] ${site.key}:`, status.error);
    if (cached) return cached.data; // keep showing the last good copy
  }
  status.withListing = out.filter((x) => x.listing).length;
  for (const c of out) {
    c.listing = c.listing || c.trade || site.otherListing || "Other";
    c.trade = c.trade || c.listing;
  }
  status.count = out.length;
  status.withCity = out.filter((x) => x.city).length;
  status.listings = [...new Set(out.map((x) => x.listing))].sort();
  if (!status.error) cache.set(site.key, { data: out, expires: Date.now() + CACHE_TTL_MS });
  return out;
}

router.get("/", async (req, res) => {
  try {
    const refresh = req.query.refresh === "1" || req.query.debug === "1";
    const results = await Promise.all(bizSites.map((s) => fetchSite(s, refresh)));
    res.set("Access-Control-Allow-Origin", "*");
    if (req.query.debug === "1") {
      res.set("Cache-Control", "no-store");
      return res.json({ sites: bizSites.map((s) => lastStatus.get(s.key)) });
    }
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({
      categories: bizSites.map((s) => ({
        key: s.key, label: s.label, sub: s.sub || "", icon: s.icon || "", listTitle: s.listTitle || `${s.label} Listings`,
        comingSoon: !s.domain,
      })),
      cards: results.flat(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
