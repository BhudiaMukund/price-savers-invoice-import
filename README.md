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
  Several spreadsheets can be picked at once (e.g. a portal that exports one file per page of its range): every
  file with the same headings as the chosen sheet is read, and products in more than one are merged by barcode
  or code. Files with different headings are named as left out. Pictures inside old `.xls` files can't be read
  Pictures inside old `.xls` files are read too (including bitmaps, converted to PNG), and a photo-link column
  with no heading ("Click to preview") is found by its links. A picture and a link to it on the same product
  count as one photo: the link (full size) is used and the sheet's small picture is only a spare, in case the
  links don't open from the browser. The same picture twice on a product is merged (even when one copy was stretched to fit a
  cell), straight away for pictures in the files and after Shopify fetches the link for linked ones.
  Alt text and file names use the readable product name (abbreviations like ASST, pack ratios like 12/60 and
  colour initials like R-B-Y are spelled out) and leave out the supplier code.
  The page tells a busy server apart from an expired sign-in, repeats safe calls a few times, and the
  fingerprint list is loaded in pages.
  Photos are copied into **Shopify Files** at once, so links that expire later don't matter, and the same
  picture is never stored twice. Barcodes, codes and descriptions are kept in the site's database. Nothing is
  created in the store. Then:
  - Importing an invoice matches each line to the catalogue (by barcode from any supplier, or by supplier code
    within the invoice's supplier). Matching products get **copies** of the photos (main photo first) and the
    catalogue's description. Staff can leave photos out, change the main photo, or skip the description in the
    side panel. A catalogue entry showing several colours on one row has no photos picked by default.
  - **Fill in missing photos** lists products already in the store with no photo that a catalogue covers, and
    adds copies.
  - **Photo names and alt text.** Catalogue photos are named from the product, e.g.
    `skull-candle-holder-blk-12cm-hn-7701.jpg` (then `-2`, `-3`), with the supplier's name and code as alt text,
    so Content → Files is searchable. A new product's own copies are named from the shop's title
    (`black-skull-candle-holder-12cm.jpg`); the main photo's alt text is the title, extra photos add
    "photo 2 of 3". Copies added to existing products ("Fill in missing photos") get the same alt text and keep
    the catalogue photo's name (Shopify doesn't allow renaming those). Photos already uploaded keep their names.
  - **Look-alike photos are stored once, automatically.** Every photo gets a visual fingerprint in the browser.
    A photo that looks the same as one already stored (resized, re-compressed, from a newer export or another
    supplier) reuses the stored one; a clearly sharper version (1.5x the pixels) replaces it everywhere instead.
    Matching is strict: a 64 x 64 pixel-by-pixel check must find no clearly different pixels, so number
    balloons, "30th" vs "40th", or gold vs silver stay separate. Photo links, and photos stored before this
    check existed, are fingerprinted in the background from Shopify's copy when someone opens the Catalogues
    pages (this needs Shopify's image server to allow it; if it doesn't, those are simply skipped).
  - Uploads are listed in date groups (Today, Yesterday, This week, Last week, earlier this month, then by
    month). Each upload (C1, C2, …) has its own page. Uploading a newer export from the same supplier replaces the
    older one.
  - **Remove catalogue** (with a confirmation) stops using it at once (an older one from the supplier comes back),
    deletes its photos from Files (except ones another catalogue also uses) and takes it off the list.
  - **Photos on store products are protected.** The site records which product got which catalogue photo. If
    any product uses photos from a catalogue, removing it shows a strict warning naming those products and only
    goes ahead once the catalogue's code is typed; those products then lose those photos too. They're listed
    under **Fill in missing photos** ("Photos removed with C3"), first in the list as soon as another catalogue
    has their photos, and as "waiting" until one does. Products given photos before this record existed aren't
    covered by the warning.
- **Settings** (profile menu → Settings, shared by everyone): turn the import/run tags on or off, and whether
  catalogue photos and descriptions are used automatically. The supplier list shows every supplier with its
  product count in the store and its catalogues; one that no store product and no active catalogue uses can be
  deleted (checked live against the store at the moment of deleting). Set `ADMIN_EMAILS` (comma-separated) in
  `wrangler.toml` to let only those people change settings and delete suppliers; leave it empty for everyone.
- **Undo import**: deletes the products from one import. As a safety check it only deletes a product whose
  `import_source` holds that import ID and whose price is still $0.00; anything already priced is kept.

## Suppliers

The supplier of an invoice or catalogue is worked out from the name the AI reads on it, the heading at the top of
a spreadsheet, and the file name ("3 - Harbour Novelty Imports - Order HN-5521.xlsx", "toplite_catalogue.xlsx").
If it's one of your suppliers (under any spelling: "ALPEN PTY LTD" is Alpen) it's chosen for you, with a note
saying where it was found; change it if that's wrong. If it isn't, the name is suggested with an **Add** / **Use**
button, and nothing is added until someone clicks it. The shop itself ("Price Savers") is never taken as the
supplier. A catalogue can't be saved without a supplier: pressing Save without one marks the box and says so.

## Long invoices and product lists

Files of any length are read without splitting them:

- **Excel and CSV** are read by the page itself. The AI looks at the first rows only and says which column is
  the barcode, the code and the description; the page checks that against the data (and fixes or replaces a wrong
  answer with its own reading, which also works with the AI down), then reads every row: barcodes and codes are
  copied exactly, headings, section titles, totals, freight and notes are skipped (the count shows on the invoice
  card), and the column headings repeated on each printed page are recognised. CSVs in UTF-8, UTF-16 or old
  Windows encodings, with commas, semicolons, tabs or pipes, all work. A layout that isn't a table goes to the AI
  in parts instead.
- **Titles** from spreadsheets show a tidy made by simple rules straight away, then the AI tidies them 100 at a
  time ("Tidying titles" on the invoice card). Each line goes out with an id and must come back with that id and
  an exact copy of its own description; a title is only used if it adds no number that wasn't on the line and
  describes its own line better than any other line in the batch, so a title can't land on the neighbouring
  product. Lines the checks turn down are asked again in small batches; if the AI still can't do one (or isn't
  available), the simple tidy is kept and the product is marked **Check title** and left unticked. **Tidy N
  titles again** on the invoice card retries later. A title someone edited is never overwritten. Tidying carries
  on after a page reload, and runs alongside reading the next file.
- **Long PDFs** that don't fit in one AI answer are read three pages at a time (fewer if needed). The page count is
  read from the PDF itself where possible, and the page after the last is always checked in case the count was low.
- **A run holds up to 2,000 products.** A bigger file asks which lines to load (for example 1–2,000 or
  2,001–4,812); add the file again in a new import for the rest. A whole product range that's only wanted for
  photos and descriptions belongs on Catalogues, which has no limit.

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
| `POST /api/invoice/map` | The first rows of a spreadsheet invoice: which column is which |
| `POST /api/titles` | Tidies up to 100 titles, returning only the ones that pass the checks |
| `POST /api/extract` | Text of a spreadsheet the columns couldn't be worked out for (or one part of it), read by the AI |
| `POST /api/extract-file` | PDF / photo as base64, streamed to the AI without parsing (keeps CPU low); `X-Pages: 4-6` reads only those pages |
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

## Large catalogues: saving in small steps

A catalogue with thousands of products is saved in many small requests, each kept inside the Cloudflare free-plan limits (photo links are sent in bounded batches, product rows are written in batched inserts). If one request fails partway, the page stops with "Saving stopped" and keeps the same upload code. Press Save again: photos, links and products already saved are recognised and not repeated, so the save carries on from where it stopped instead of starting over.

## Bigger catalogue photos

Supplier exports often link to thumbnails (`…/74422371_1_200x200.jpg?ft=1`). When a catalogue's photo links are
saved, each one that looks like a thumbnail (a `_200x200` / `-150x150` size in the file name, a `_thumb` or `_small`
word, or `?width=200` in the link) is checked for a bigger copy: first the same link without its size, then larger
sizes (5x and 3x). The worker fetches the start of each one, reads the picture's real size from its header and uses it
only when it is clearly bigger than the thumbnail. If nothing bigger comes back, or Shopify refuses the bigger link,
the link as the supplier gave it is used, so no photo is lost. This is tried for every supplier, not a chosen one.

- It spends one outbound request per link per attempt (at most 25 per batch, within the free plan's 50), so a rule that
  has never worked on a host is tried on 3 links first and given up on after 8 misses.
- Set `PHOTO_UPGRADE = "false"` in `wrangler.toml` to turn it off.
- It only applies when links are saved. Photos already saved keep the size they were saved at.

## Products that are in the store as drafts

If an invoice line matches a product that already exists in Shopify as a **draft**, importing it makes the product
**active** and puts it on **Point of Sale**, the same as a product this tool creates, whether or not the run
updates stock. The row says "A draft in your store. It'll be made active" and is ticked for you. Stock is then added
like for any other product when the run's stock switch is on. Only drafts are touched: an active or archived
product is left alone, and price, title, tags and shipping settings are never changed. **Undo import** does not
turn an activated product back into a draft.

## Stock from invoice quantities

Each run has an **Update stock from these invoices** switch on the review screen, under the heading. It is **on by
default** and is remembered with the run, so turn it off for a run that shouldn't change stock (the Stock boxes
and "Check quantity" flags disappear, and nothing is sent to Shopify's inventory). Settings only has **Stock goes
to**, the Shopify location that receives the stock (the store's first location if you leave it).

When the switch is on:
- The quantity on each invoice line is read: by the AI for PDFs and photos, and by column for spreadsheets
  (headings like Qty, Quantity, Qty Shipped). If an invoice has both an ordered and a supplied/shipped
  quantity, the supplied one is used, never ordered or back-ordered.
- Quantities are turned into single units. "3 CTN" with a pack size of 12 is 36 (the row shows "3 × 12").
  A carton, case or pack with no known size, a missing number, or a quantity the AI couldn't place is marked
  **Check quantity** and can't be added until staff type the number. Typing 0 leaves that product's stock alone.
- Each row has an editable **Stock** box. New products are created with stock tracking on and that count at the
  chosen location. Products already in the store are ticked too: **Add stock** puts the quantity on top of what
  they have, turning tracking on (and stocking the location) if it was off.
- The same barcode on two lines of one invoice adds up on the first line.
- The same invoice can't add its stock twice: each invoice line claims "this invoice adds this stock to this
  product" before Shopify is touched, so a repeat, a retry or a re-import is skipped ("Stock already added").
  A failed attempt gives the claim back so it can be tried again.
- **Undo import** also takes back the stock it added to products that were already in the store (the new
  products go with their deletion). If some have sold since, their count goes lower.

The Shopify app needs `read_inventory`, `write_inventory` and `read_locations` (see the scopes above). If it
doesn't have them, the site says so instead of failing quietly.
