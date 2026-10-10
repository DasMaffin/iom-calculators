#!/usr/bin/env node
// Downloads the raw wikitext of every content page on the Idle Obelisk Miner wiki
// into wiki-cache/ so it can be used as reference data for the calculators.
//
// Run from the repo root (Node 18+, no dependencies):
//   node tools/fetch-wiki.mjs
// Then commit and push the wiki-cache/ folder.
//
// Uses the public MediaWiki API, 50 pages per request, with a short pause between requests.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = process.env.WIKI_API || "https://shminer.miraheze.org/w/api.php";
const OUT = "wiki-cache";
const USER_AGENT = "iom-calculators/0.1 (fan-made calculator; https://github.com/DasMaffin/iom-calculators)";
const PAUSE_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Turn a page title into a safe file name: "Guides/Working With ExportStats" -> "Guides__Working_With_ExportStats.wiki"
const fileNameFor = (title) => title.replace(/ /g, "_").replace(/\//g, "__").replace(/[<>:"\\|?*]/g, "-") + ".wiki";

async function api(params) {
  const url = API + "?" + new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } });
  const body = await res.text();
  if (!res.ok || body.trimStart().startsWith("<")) {
    throw new Error(
      `HTTP ${res.status} from the wiki. ` +
      (body.includes("Checking your connection") || body.includes("Just a moment")
        ? "Cloudflare showed a bot check. Try again later, or from another network."
        : body.slice(0, 200))
    );
  }
  return JSON.parse(body);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const index = [];
  let cont = {};
  let batch = 0;

  do {
    const data = await api({
      action: "query",
      generator: "allpages",
      gapnamespace: "0",
      gapfilterredir: "nonredirects",
      gaplimit: "50",
      prop: "revisions",
      rvprop: "content|timestamp",
      rvslots: "main",
      ...cont
    });
    for (const page of data.query?.pages ?? []) {
      const rev = page.revisions?.[0];
      const text = rev?.slots?.main?.content;
      if (text == null) continue;
      const file = fileNameFor(page.title);
      await writeFile(join(OUT, file), text, "utf8");
      index.push({ title: page.title, file, updated: rev.timestamp });
    }
    batch++;
    console.log(`batch ${batch}: ${index.length} pages saved`);
    cont = data.continue ?? null;
    if (cont) await sleep(PAUSE_MS);
  } while (cont);

  index.sort((a, b) => a.title.localeCompare(b.title));
  await writeFile(join(OUT, "_index.json"),
    JSON.stringify({ source: API, fetched: new Date().toISOString(), pages: index }, null, 2) + "\n", "utf8");
  console.log(`Done: ${index.length} pages in ${OUT}/. Now commit and push that folder.`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
