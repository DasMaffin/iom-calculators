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
| `assets/app.js` | Import, rendering, editing, filtering, export |
| `examples/example-export.json` | Sample export (v2.2.30, Obelisk 31) |

Stats the catalog doesn't recognise show up under **Other**, so newer game stats never get dropped.
To file a new stat under a section, add a rule to `IOM.RULES` in `assets/stat-catalog.js`.
