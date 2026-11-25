# Stores setup checklist

| Part | Where it lives |
|---|---|
| Stores home, category screen, Stores Directory | Render — StoreMap repo, `public/stores.html` → https://storemap-2g9i.onrender.com/stores |
| Shopping & Gifts products | Lokaalhome1.com → `/all-products` page |
| Home & Hardware products | Lokaalhub.com → `/all-products` page |
| Auto & Equipment | "Coming soon" until it gets a site |
| The app | Lokaalr1.com — its Stores button opens the Render link |

## A. Render (StoreMap repo) — upload 3 changed files on GitHub
1. github.com/Petertoon/StoreMap → open `public` → `stores.html` → pencil (Edit) → select all, delete, paste the new `stores.html` → Commit changes.
2. Same for `routes/stores.js` (adds store tags) and `server.js` (lets `/stores` work without `.html`).
3. Render redeploys on its own (~1–2 min). Open https://storemap-2g9i.onrender.com/stores to check.
4. In the Lokaal app on lokaalr1.com, point the Stores button at that link.

## B. Each Wix site (Lokaalhome1 AND Lokaalhub — same steps on both)
1. **FeaturedStores**: add `region` (Text), `city` (Text), `orderUrl` (URL), optional `tags` (Tags).
   Category must be exactly `Shopping & Gifts`, `Home & Hardware` or `Auto & Equipment`.
2. **StoreItems** collection: `title`, `description`, `price` (Text), `image`, `gallery`,
   `store` (Reference → FeaturedStores), `category` (Text), `subcategory` (Text). Permissions: Anyone can view.
3. **Code**: `storeHelpers.js` → Public (replace the old one).
4. **All Products page**: blank page, URL `/all-products`, elements listed at the top of
   `all-products-page.js`, then paste that code.
5. **Item page**: CMS → StoreItems → Add Dynamic Page → Item, URL `/item/{ID}`,
   elements listed at the top of `item-page.js`, then paste that code.

The Stores page you started on Lokaalhome1 isn't needed anymore — you can delete it.
