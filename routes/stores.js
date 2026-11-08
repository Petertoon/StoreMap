
// routes/stores.js
const express = require("express");
const router = express.Router();
const sites = require("../config/sites.json");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // siteId -> { data, expires }

const DEFAULT_FIELDS = {
  name: "title", lat: "lat", lng: "lng", address: "address", phone: "phone",
  websiteUrl: "website", storeUrl: "storeUrl", photos: "image", status: "status",
  category: "category", rating: "rating", hours: "hours",
};

// "wix:image://v1/<fileId>/<name>#..." -> loadable https URL
function wixImageToUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("http")) return value;
  const m = value.match(/^wix:image:\/\/v1\/([^/]+)\//);
  return m ? `https://static.wixstatic.com/media/${m[1]}` : null;
}

// Photos may be a media-gallery array (objects with src), an array of strings, or one string.
function extractPhotos(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((v) => (typeof v === "string" ? v : v && (v.src || v.url || v.image)))
    .map(wixImageToUrl)
    .filter(Boolean)
    .filter((u, i, arr) => arr.indexOf(u) === i) // same photo in image and gallery shows once
    .slice(0, 5);
}

// Accept full URLs, site-relative paths ("/stores/x"), or bare addresses ("www.site.com/shop").
function toUrl(value, domain) {
  if (!value) return null;
  const v = (typeof value === "string" ? value : value.url || value.href || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/")) return `${domain}${v}`;
  if (/^[^\s/]+\.[^\s/]+/.test(v)) return `https://${v}`;
  return null;
}

// Read a field by its configured key, ignoring upper/lower case; optional regex fallback on field names.
function getField(d, key, fallback) {
  if (key && d[key] != null && d[key] !== "") return d[key];
  const lower = String(key || "").toLowerCase();
  const names = Object.keys(d);
  const hit = names.find((n) => n.toLowerCase() === lower && d[n] != null && d[n] !== "")
    || (fallback && names.find((n) => fallback.test(n) && d[n] != null && d[n] !== ""));
  return hit ? d[hit] : null;
}

function cleanPhone(value) {
  if (!value || typeof value !== "string") return null;
  const cleaned = value.replace(/[^0-9+]/g, "");
  return cleaned.length >= 7 ? cleaned : null;
}

async function fetchSite(site) {
  const cached = cache.get(site.siteId);
  if (cached && cached.expires > Date.now()) return cached.data;

  const apiKey = process.env[site.apiKeyEnv];
  const accountId = process.env[site.accountIdEnv];
  const wixSiteId = process.env[site.siteIdEnv];
  if (!apiKey || !accountId || !wixSiteId) {
    console.warn(`Missing credentials for ${site.siteId} — skipping`);
    return [];
  }

  const f = { ...DEFAULT_FIELDS, ...(site.fields || {}) };
  // Wix builds the dynamic-page link field name from the collection ID: lowercase, hyphen before every digit.
  const linkField = `link-${site.collectionId.toLowerCase().replace(/(\d)/g, "-$1")}-title`;

  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await fetch("https://www.wixapis.com/wix-data/v2/items/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
        "wix-account-id": accountId,
        "wix-site-id": wixSiteId,
      },
      body: JSON.stringify({
        dataCollectionId: site.collectionId,
        query: { paging: { limit: 100, offset } },
      }),
    });
    if (!res.ok) {
      console.error(`Wix API error for ${site.siteId}:`, res.status, await res.text());
      break;
    }
    const json = await res.json();
    const items = json.dataItems || [];
    for (const item of items) {
      const d = item.data;
      const lat = Number(d[f.lat]);
      const lng = Number(d[f.lng]);
      if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
      out.push({
        id: item.id,
        sourceSite: site.siteId,
        siteName: site.siteName,
        name: d[f.name] || d.storeName || d.title || d.title_fld || null,
        lat,
        lng,
        address: d[f.address] || null,
        category: d[f.category] || null,
        rating: parseFloat(d[f.rating]) || null,
        hours: getField(d, f.hours, /hours/i),
        status: d[f.status] || null,
        phone: cleanPhone(d[f.phone]),
        // Visit Store: an explicit storeUrl field wins, otherwise the store's dynamic page link
        storeUrl: toUrl(getField(d, f.storeUrl), site.domain) || toUrl(d[linkField], site.domain),
        websiteUrl: toUrl(getField(d, f.websiteUrl, /web.?site|shop/i), site.domain),
        photos: extractPhotos([].concat(d[f.photos] || [], d.gallery || [])),
      });
    }
    if (items.length < 100) break;
  }

  cache.set(site.siteId, { data: out, expires: Date.now() + CACHE_TTL_MS });
  return out;
}

router.get("/", async (req, res) => {
  try {
    const results = await Promise.all(sites.map(fetchSite));
    const stores = results.flat();
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({ count: stores.length, stores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
