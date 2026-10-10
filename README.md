# IOM Calculators

Fan-made stat viewer and (soon) calculators for **Idle Obelisk Miner**.
Reference: [Idle Obelisk Miner Wiki](https://shminer.miraheze.org/wiki).

It's a plain static site (HTML + CSS + JS, no build step), so GitHub Pages can host it directly.

## Using it

1. In the game, open **Stats**, scroll down **all the way**, and tap **Export**. This copies your stats as JSON.
2. Open the site, paste the JSON into the box, and press **Import**. You can also pick a saved `.json` file.
3. Browse your stats by section, filter them, edit values, and download or copy the edited JSON.

Your import is saved in your browser's local storage. Nothing is uploaded anywhere.

## Hosting on GitHub Pages (one-time setup)

1. Merge this branch into `main`.
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*. Pick branch `main` and folder `/ (root)`, then click **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/iom-calculators/`.

Every push to `main` after that redeploys automatically.

## Running locally

Any static file server works. For example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` straight from disk works too, but **Load example** needs a server.)

## Project layout

| Path | What |
|---|---|
| `index.html` | Page markup |
| `assets/style.css` | Styles (responsive, light/dark) |
| `assets/stat-catalog.js` | Sorts export keys into sections, sets labels and display formats, lists not-yet-seen systems |
| `assets/app.js` | Import, rendering, editing, filtering, export, version warnings |
| `assets/array-labels.js` | Names for each array slot (generated, don't edit by hand) |
| `assets/cards.js` | Card list per category with wiki image URLs (generated) |
| `assets/cards-ui.js` | Card picker: click, Shift+click ranges, Range mode on touch |
| `assets/game-version.js` | Latest known game version (bump on each game update) |
| `examples/example-export.json` | Sample export (v2.2.30, Obelisk 31) |
| `tools/fetch-wiki.mjs` | Downloads the wiki's raw page text into `wiki-cache/` for reference |
| `tools/build-array-labels.py` | Builds `assets/array-labels.js` and `assets/cards.js` from `wiki-cache/` |

## Refreshing wiki reference data

The wiki is behind a Cloudflare bot check that blocks cloud servers. Run this from your own computer (needs Node 18+):

```sh
node tools/fetch-wiki.mjs
python3 tools/build-array-labels.py
git add wiki-cache assets/array-labels.js assets/cards.js && git commit -m "Update wiki cache" && git push
```

The label builder only names arrays whose slot order was checked against real exports. If the wiki
changes a table's layout, the builder stops with an error instead of writing wrong names.

Card images are loaded straight from the wiki's image server (`static.wikitide.net`); nothing is
downloaded into the repo. If an image can't load, the card shows its name instead.

## When the game updates

Change `IOM.LATEST_GAME_VERSION` in `assets/game-version.js`. Players whose export is from an older
version then see a warning. There's no public API with the current version, so this is a manual step.

Stats the catalog doesn't recognise show up under **Other**, so newer game stats never get dropped.
To file a new stat under a section, add a rule to `IOM.RULES` in `assets/stat-catalog.js`.
