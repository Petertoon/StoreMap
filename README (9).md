# Store Map (Render / Express)

Third map in the set. Shows the stores featured on Lokaalhub.com and Lokaalhome1.com.
Express serves public/index.html (Mapbox) and /api/stores, which reads a stores collection from each Wix site.

## Files
- config/sites.json: one entry per Wix site (domain, env-var names, collection ID, field keys)
- routes/stores.js: queries each site's collection, merges the results, caches 5 minutes
- routes/debug-collections.js: TEMPORARY. /api/debug-collections lists real collection IDs and field keys
- public/index.html: map, pins, bottom card strip with 4 buttons, locate-me button

## Deploy
New GitHub repo, then a new Render Web Service (build `npm install`, start `npm start`).
Env vars (same values as the property map): WIX_API_KEY_SITE1, WIX_ACCOUNT_ID_SITE1, WIX_SITE_ID_SITE1,
WIX_API_KEY_SITE2, WIX_ACCOUNT_ID_SITE2, WIX_SITE_ID_SITE2

## Store collection fields (or edit the "fields" block in sites.json to match yours)
title, lat, lng, address, phone, website, storeUrl (optional), image, status (optional), category (optional), rating (optional), hours (optional)
