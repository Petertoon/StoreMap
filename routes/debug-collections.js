// routes/debug-collections.js
// TEMPORARY diagnostic route — visit /api/debug-collections in a browser to see
// the exact collection IDs Wix's API expects for each site. Delete this file
// (and its require/app.use line in server.js) once sites.json is confirmed correct.
const express = require("express");
const router = express.Router();

const sites = require("../config/sites.json");

router.get("/", async (req, res) => {
  const results = {};

  for (const site of sites) {
    const apiKey = process.env[site.apiKeyEnv];
    const accountId = process.env[site.accountIdEnv];
    const wixSiteId = process.env[site.siteIdEnv];

    if (!apiKey || !accountId || !wixSiteId) {
      results[site.siteId] = { error: "Missing env vars for this site" };
      continue;
    }

    try {
      const r = await fetch("https://www.wixapis.com/wix-data/v2/collections", {
        method: "GET",
        headers: {
          "Authorization": apiKey,
          "wix-account-id": accountId,
          "wix-site-id": wixSiteId,
        },
      });
      const rawText = await r.text();
      let json = null;
      try { json = rawText ? JSON.parse(rawText) : null; } catch (_) { /* leave null, we'll show rawText */ }

      if (!r.ok) {
        results[site.siteId] = { httpStatus: r.status, body: json || rawText };
      } else if (!json) {
        results[site.siteId] = { httpStatus: r.status, error: "Empty or non-JSON response body", rawText };
      } else {
        const list = json.collections || json.dataCollections || [];
        if (list.length === 0) {
          results[site.siteId] = { httpStatus: r.status, note: "No 'collections' array found — showing raw response", rawJson: json };
        } else {
          results[site.siteId] = list.map((c) => ({
            id: c.id,
            displayName: c.displayName,
            fields: (c.fields || []).map((f) => f.key),
          }));
        }
      }
    } catch (err) {
      results[site.siteId] = { error: err.message };
    }
  }

  res.json(results);
});

module.exports = router;

// New: GET /api/debug-collections/query-test?site=site1&type=commercial
// Runs the exact same items-query call the real listings route makes, but with a
// wide-open bbox (whole world) so it can't fail just from missing coordinates —
// and returns the raw HTTP status + body so we can see the exact error.
router.get("/query-test", async (req, res) => {
  const { site: siteId, type } = req.query;
  const site = sites.find((s) => s.siteId === siteId);
  if (!site) return res.json({ error: `No site found with id ${siteId}` });

  const typeConfig = site.types[type];
  if (!typeConfig) return res.json({ error: `Site ${siteId} has no type '${type}' configured`, availableTypes: Object.keys(site.types) });

  const apiKey = process.env[site.apiKeyEnv];
  const accountId = process.env[site.accountIdEnv];
  const wixSiteId = process.env[site.siteIdEnv];
  if (!apiKey || !accountId || !wixSiteId) {
    return res.json({ error: "Missing env vars for this site" });
  }

  const body = {
    dataCollectionId: typeConfig.collectionId,
    query: {
      filter: {
        lat: { $gte: -90, $lte: 90 },
        lng: { $gte: -180, $lte: 180 },
      },
      paging: { limit: 200 },
    },
  };

  try {
    const r = await fetch("https://www.wixapis.com/wix-data/v2/items/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": apiKey,
        "wix-account-id": accountId,
        "wix-site-id": wixSiteId,
      },
      body: JSON.stringify(body),
    });
    const rawText = await r.text();
    let json = null;
    try { json = rawText ? JSON.parse(rawText) : null; } catch (_) {}

    res.json({
      requestSent: body,
      httpStatus: r.status,
      json: json || undefined,
      rawText: json ? undefined : rawText,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});
