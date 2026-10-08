# Invoice Import

Upload a supplier invoice (PDF, photo, Excel or CSV) and add the products that aren't in Shopify yet.

- One AI reading step for every supplier layout. There is no per-supplier code to maintain.
- Takes title, supplier code (saved as SKU) and barcode only. Cost and quantity are ignored.
- Rewrites supplier titles into one consistent house style (for example `BLN LTX 30CM ASST 25PK` becomes
  `Assorted Latex Balloons 30cm (Pack of 25)`), in the same AI request that reads the invoice. The invoice's
  own wording stays visible in the edit panel, one click away. Change the style in `TITLE_STYLE` in
  `src/extract.ts`.
- Checks the live Shopify catalogue every time and skips products whose barcode already exists
  (UPC-A, EAN-13, EAN-8 and GTIN-14 spellings of the same code count as the same product).
- New products are created **active**, price **$0.00**, **not shippable** and with **stock not tracked**, published to
  **Point of Sale only**, so a $0 item never appears on the online store or in the Google Shopping feed.
- Staff review everything in an editable list before anything is created.
- **Supplier**: each invoice is tagged with a supplier, chosen from the store's existing vendors (the AI
  pre-selects it when it recognises the name on the invoice) or typed in as a new one, which is saved for
  next time. Products get it as their Vendor. Products can't be added until their invoice has a supplier.
- **Import ID**: each invoice gets a unique ID such as `20261007-R42-ALPEN-K3F9` (date, run, supplier, random code),
  saved on every product in `custom.import_source` (matching that field's existing type) and as the tag
  `import-20261007-R42-ALPEN-K3F9` plus `run-R42`, so an import or a whole run can be found in Shopify admin
  by searching the tag. Import IDs include the run code.
- **Runs**: every working session is a run (R1, R2, …) saved on the server with who started it and when.
  Uploading on the home page starts a new run at `/runs/R42`; invoices added afterwards join it. Runs save
  automatically, so a reload, another device or a colleague can open the same run. `/runs` lists and searches
  every run (invoice, supplier, import ID, product, barcode, person) with an "Only mine" filter.
- **Ledger**: the server records every product the tool creates (run, invoice, import ID, who, when). An
  invoice can't be removed from its run while any of its products are still in Shopify: delete them with
  Undo import first. The server enforces this, not just the page.
- **Supplier catalogues** (`/catalogues`): upload a supplier's export (Excel with pictures inside, including
  Excel 365 "place in cell" pictures; Excel or CSV with photo links; a ZIP; or photos named by code or barcode).
  AI works out the columns from the first rows (staff can change them), then the browser reads every row.
  Photos are copied into **Shopify Files** at once, so links that expire later don't matter, and the same
  picture is never stored twice. Barcodes, codes and descriptions are kept in the site's database. Nothing is
  created in the store. Then:
  - Importing an invoice matches each line to the catalogue (by barcode from any supplier, or by supplier code
    within the invoice's supplier). Matching products get **copies** of the photos (main photo first) and the
    catalogue's description. Staff can leave photos out, change the main photo, or skip the description in the
    side panel. A catalogue entry showing several colours on one row has no photos picked by default.
  - **Fill in missing photos** lists products already in the store with no photo that a catalogue covers, and
    adds copies.
  - **Look-alike photos are stored once, automatically.** Every photo gets a visual fingerprint in the browser.
    A photo that looks the same as one already stored (resized, re-compressed, from a newer export or another
    supplier) reuses the stored one; a clearly sharper version (1.5x the pixels) replaces it everywhere instead.
    Matching is strict: a 64 x 64 pixel-by-pixel check must find no clearly different pixels, so number
    balloons, "30th" vs "40th", or gold vs silver stay separate. Photo links, and photos stored before this
    check existed, are fingerprinted in the background from Shopify's copy when someone opens the Catalogues
    pages (this needs Shopify's image server to allow it; if it doesn't, those are simply skipped).
  - Each upload (C1, C2, …) has its own page. Uploading a newer export from the same supplier replaces the older
    one; **Undo this upload** stops using it at once (the older one comes back) and deletes its photos from
    Files, except ones a newer upload also uses. Products keep their own copies.
- **Settings** (profile menu → Settings, shared by everyone): turn the import/run tags on or off, and whether
  catalogue photos and descriptions are used automatically. The supplier list shows every supplier with its
  product count in the store and its catalogues; one that no store product and no active catalogue uses can be
  deleted (checked live against the store at the moment of deleting). Set `ADMIN_EMAILS` (comma-separated) in
  `wrangler.toml` to let only those people change settings and delete suppliers; leave it empty for everyone.
- **Undo import**: deletes the products from one import. As a safety check it only deletes a product whose
  `import_source` holds that import ID and whose price is still $0.00; anything already priced is kept.

## Using it

1. **Upload**: drop invoices anywhere on the page, choose files, or take a photo on a phone.
2. **Check**: products are sorted into New, Needs a look, In store and Added. Click any product to edit it
   in the side panel, where the barcode is drawn so a misread digit stands out. **Fix now** steps through
   every product that needs attention; a barcode scanner works in the barcode field (it types, then Enter
   moves on).
3. **Add**: tick products and press **Add** in the bar at the bottom (or Ctrl/Cmd + Enter).

Keyboard: arrow keys move through the list, Space ticks, Enter opens; in the panel, Alt + arrows move
between products and Esc closes. The list is saved in the browser, so a refresh doesn't lose work.

## How it runs

A single Cloudflare Worker on the free plan. The page in `public/` is plain HTML/CSS/JS with no build step.
The Worker in `src/` handles `/api/*`.

| Path | What it does |
| --- | --- |
| `GET /api/health` | Signed-in user, whether the AI and Shopify are reachable |
| `POST /api/extract` | CSV / Excel text (Excel is converted in the browser) to rows, matched against the store |
| `POST /api/extract-file` | PDF / photo as base64, streamed to the AI without parsing (keeps CPU low) |
| `POST /api/lookup` | Checks up to 50 edited barcodes against the store |
| `POST /api/match` | Re-checks the whole list against the full catalogue |
| `POST /api/create` | Creates up to 15 products, re-checking their barcodes first, with catalogue photos and descriptions |
| `/api/catalogues…` | Catalogue uploads: create, photos (streamed to Shopify Files), links, products, finish, undo |
| `POST /api/catalogue/match` | Catalogue entries (with photos) for invoice lines |
| `POST /api/catalogue/map` | AI works out a catalogue spreadsheet's columns from its first rows |
| `GET /api/catalogue/missing-photos`, `POST /api/catalogue/attach` | Fill in photos on existing products |

## Testing it

### 1. Demo mode (no keys, nothing touches your store)

```
npm install
npm run demo
```

Open http://localhost:8787 (needs Node 22.13 or newer, for its built-in SQLite). Shopify and the invoice reader are fake: whatever file you upload, you get
the same sample party-supply invoice, and "adding" only updates the fake store. To try catalogues: on
Catalogues, upload `test/fixtures/harbour-catalogue.xlsx` (supplier "Harbour Novelty Imports"), then import an
invoice containing "HARBOUR NOVELTY" (the sample Harbour order) to see the photos picked up. Photo links are
drawn as stand-in pictures, and links containing "expired" fail, as an expired link would.

### 2. Your computer, real Shopify and real AI

1. **Shopify app** (since 1 January 2026 Shopify only allows Dev Dashboard apps):
   - Go to dev.shopify.com/dashboard, create an app, and in a new version give it the Admin API scopes
     `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_locations`,
     `read_publications`, `write_publications`, `read_files`, `write_files`. Release the version.
     (`write_products` also covers deleting products for Undo import. The files scopes are for supplier
     catalogue photos.)
   - **Already set up before catalogues were added?** Release a new app version that adds `read_files` and
     `write_files`, then approve the update in the store (or reinstall from the install link). Until then the
     Catalogues page says the app can't use Files yet; everything else keeps working.
   - Set distribution to custom, generate an install link for your store, and install it.
   - Copy the app's **Client ID** and **Client secret**. The tool swaps these for a 24-hour access token by
     itself and renews it, so there is nothing to refresh by hand.
2. **AI key**: create one at aistudio.google.com (free tier, no billing needed).
3. In `wrangler.toml`, set `SHOPIFY_STORE_DOMAIN` to your `something.myshopify.com` address.
4. Create `.dev.vars` in the project folder (never commit it):
   ```
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...
   GEMINI_API_KEY=...
   DEV_AUTH_BYPASS=true
   ```
5. `npm run dev`, then open the address it prints (usually http://localhost:8787).

This is your **real store**: anything you add is really created. Start with one real invoice, add one or two
products, check them in Shopify and the POS app, then delete them. `DEV_AUTH_BYPASS` skips sign-in and must
never be set in production.

(An older custom app made in the Shopify admin before 2026 also works: set `SHOPIFY_ADMIN_TOKEN=shpat_...`
instead of the client ID and secret.)

### 3. Live on Cloudflare

First create the database for runs (once):

```
npx wrangler d1 create invoice-import-db
```

Copy the `database_id` it prints into `wrangler.toml` (the `[[d1_databases]]` section). The tables create
themselves on first use. On your computer, `npm run dev` uses a local copy automatically.

```
npx wrangler login
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

Then turn on sign-in: in the Cloudflare dashboard, enable Cloudflare Access for the Worker's `workers.dev`
address (Worker settings, Domains & Routes) with a policy allowing only staff email addresses. Copy the
Access application's Audience (AUD) tag and your team domain (`yourteam.cloudflareaccess.com`) into
`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, and deploy again. Until both are filled in, the
site refuses everyone.

`npm test` runs the unit tests; `npm run typecheck` checks types.

## Settings for import tracking

- `IMPORT_SOURCE_METAFIELD` (default `custom.import_source`): the product field the import ID goes in.
- `IMPORT_TAGS` (default on): set to `false` to stop adding the `import-…` tag.
- New suppliers typed in the tool are kept in a shop metafield owned by this app until a product uses them.

## Changing the AI model or moving to a paid plan

- Busy AI: if Google's model is overloaded or rate-limited, the page waits and tries again (3 tries), and from
  the second try uses `AI_FALLBACK_MODEL` (a lighter model with its own free quota). Leave it empty to turn this off.
- Model: change `AI_MODEL` in `wrangler.toml` (currently `gemini-3.8-flash`; the 2.5 models shut down
  on 16 October 2026).
- Paid plan: enable billing on the Google Cloud project behind the same API key. No code change.
- Another provider: add one function to `PROVIDERS` in `src/extract.ts` and set `AI_PROVIDER`.

## Limits worth knowing

- Workers free plan: about 10 ms CPU and 50 outbound requests per request. That's why the browser converts
  Excel and encodes files, PDFs/photos are streamed rather than parsed, and creation runs in batches of 15.
- Files: PDFs up to 7 MB. Big phone photos are shrunk in the browser before upload.
- The full catalogue fetch is one Shopify request per 250 variants; with ~2,000 variants that is 8 requests.
- Catalogues: each photo is its own request (streamed through to Shopify, never held in memory), three at a
  time, so a catalogue with 3,000 photos takes a while; keep the page open. Photos already in Files are skipped,
  so a stopped upload can simply be run again. Photos must be JPG, PNG, GIF or WebP; ones over Shopify's
  limits (20 MB or 25 megapixels) are shrunk in the browser to 4000 pixels on the long side. Pictures pasted
  into Excel as EMF/WMF are skipped and counted. Catalogue files are read in the browser, up to 400 MB each
  (a 200 MB Excel file with 150 large photos reads in about 5 seconds on a computer; use a computer, not a
  phone, for big files). Old `.xls` files are read, but pictures inside them
  aren't: save as `.xlsx` first.
- Products without a barcode can be added, but nothing stops a second copy being added later, because
  matching is by barcode only.

## Third-party code

`public/vendor/xlsx.core.min.js` is SheetJS Community Edition 0.20.3 (Apache 2.0, see `xlsx.LICENSE.txt`),
loaded only when someone picks an Excel file. `public/vendor/fflate.min.js` is fflate 0.8.2 (MIT, see
`fflate.LICENSE.txt`), used to open ZIP files and the pictures inside Excel files.

Sample catalogues for trying it out (fictional suppliers matching the sample invoices) are in `test/fixtures/`;
`python3 test/fixtures/make.py` rebuilds them.
