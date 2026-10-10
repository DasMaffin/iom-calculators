#!/usr/bin/env python3
"""Builds assets/array-labels.js from the downloaded wiki pages in wiki-cache/.

Run from the repo root after refreshing the cache:
    python3 tools/build-array-labels.py

Only arrays whose order was checked against real exports are labelled.
Each entry records its source page so it can be re-checked when the wiki changes.
"""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "wiki-cache"
OUT = ROOT / "assets" / "array-labels.js"


def page(name):
    return (CACHE / (name.replace(" ", "_").replace("/", "__") + ".wiki")).read_text(encoding="utf-8")


def clean(s):
    s = re.sub(r"\{\{CollapsedDescription\|.*?\}\}", "", s, flags=re.S)
    s = re.sub(r"\[\[File:[^\]]*\]\]", "", s)
    s = re.sub(r"\[\[[^|\]]*\|([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\{\{Sprites?\|([^|}]*)[^}]*\}\}", r"\1", s)
    s = re.sub(r"<div[^>]*>(</div>)?", "", s)
    s = re.sub(r"<br\s*/?>", " / ", s)
    s = re.sub(r"<ref[^>]*/>|<ref.*?</ref>", "", s, flags=re.S)
    return re.sub(r"\s+", " ", s).strip(" |")


def table_rows(text, id_regex):
    """Return [(id, [cells...])] for wikitable rows carrying an anchor id matching id_regex."""
    rows = []
    for chunk in re.split(r"\n\|-", text):
        m = re.search(r'id="(' + id_regex + r')"', chunk)
        if not m:
            continue
        body = chunk[chunk.index(m.group(0)) + len(m.group(0)):]
        body = re.split(r"\n\|\}", body)[0]
        cells = [clean(c) for c in re.split(r"\|\||\n\|", body)]
        rows.append((m.group(1), [c for c in cells if c and c not in ("/>", "></div>")]))
    return rows


def names(text, id_regex, col=0):
    return [cells[col] for _, cells in table_rows(text, id_regex)]


def raw_block(text, start_marker):
    """Lines of the hastily written notes in the ExportStats TODO section."""
    i = text.index(start_marker)
    return text[i:].splitlines()


labels = {}
sources = {}


def put(key, values, source):
    labels[key] = values
    sources[key] = source


# --- Guides/Working With ExportStats (mappings confirmed with the game devs) ---
guide = page("Guides/Working With ExportStats")

relics = {}
for line in raw_block(guide, "relics_array")[2:]:
    m = re.match(r"\s*(\d+)\s+\d+\s+(\w+)\s+(.+)", line)
    if not m:
        break
    relics[int(m.group(1))] = f"{m.group(3).strip()} ({m.group(2)})"
put("relics_array", [relics.get(i) for i in range(max(relics) + 1)], "Guides/Working_With_ExportStats")

skills = {}
for line in raw_block(guide, "skill_tree_nodes_array")[1:]:
    m = re.match(r"\s*(\d+)\s+(.+)", line)
    if not m:
        break
    skills[int(m.group(1))] = m.group(2).strip()
put("skill_tree_nodes_array", [skills.get(i) for i in range(max(skills) + 1)], "Guides/Working_With_ExportStats")

workshop = {}
for line in raw_block(guide, "Workshop item")[1:]:
    m = re.match(r"[-+ ]\s*(\d+)\s+\d+\s*!?\s+(.+)", line)
    if not m:
        if line.strip() == "":
            break
        continue
    workshop[int(m.group(1))] = m.group(2).strip()
put("workshop_array", [workshop.get(i) for i in range(max(workshop) + 1)], "Guides/Working_With_ExportStats")

uptime = {}
for line in raw_block(guide, "lootbug_and_elixir_uptime_array")[1:]:
    m = re.match(r"[-+]\s*(\d+)\s+(.+)", line)
    if not m:
        break
    uptime[int(m.group(1))] = m.group(2).strip()
put("lootbug_and_elixir_uptime_array", [uptime.get(i) for i in range(max(uptime) + 1)], "Guides/Working_With_ExportStats")

items = {}
for line in raw_block(guide, "Index    Item")[1:]:
    m = re.match(r"\s*(\d+)\s+(.+)", line)
    if not m:
        break
    items[int(m.group(1))] = m.group(2).strip()
put("item_uptime_array", [items.get(i) for i in range(max(items) + 1)], "Guides/Working_With_ExportStats")

pets = re.findall(r"\|\| \[\[File:[^\]]*Default\.png[^\]]*\]\]\s*([^|]+?)\s*\|\|", guide)
put("pet_array", pets, "Guides/Working_With_ExportStats")
put("pet_quest_array", pets, "Guides/Working_With_ExportStats")
skins_a = re.findall(r"\[\[File:[^\]]*Skin\.png[^\]]*\]\]\s*([^|]+?)\s*\|\|", guide)
skins_b = re.findall(r"\[\[File:[^\]]*Quest\.png[^\]]*\]\]\s*([^\n|]+)", guide)
put("pet_skin_set_a_array", [f"{p}: {s}" for p, s in zip(pets, skins_a)], "Guides/Working_With_ExportStats")
put("pet_skin_set_b_array", [f"{p}: {s.strip()}" for p, s in zip(pets, skins_b)], "Guides/Working_With_ExportStats")

drones = ["Bomb Bear", "Chain", "Midas", "Frogger", "Elixir", "Starburst", "Veinseeker", "Void", "Angler", "Prism", "Minotaur"]
put("drones_suit_owned_array", drones, "Guides/Working_With_ExportStats")
put("drones_suit_level_array", drones, "Guides/Working_With_ExportStats")

# --- Fishing (order matches the guide's index ranges; caps verified against a late-game export) ---
fishing = page("Fishing")
docks = ["Lake", "Desert", "Tundra", "Ocean", "Nuclear", "Abyss", "Cave", "Volcano", "Sky", "Solaris", "Galaxy"]
legendaries = re.findall(r"^\|([^<|\n]+?)\s*<br>\{\{OverlayImages\|[^\n]*Dock ", fishing, flags=re.M)
put("fishing_legendary_card_levels_array", [f"{l} ({d})" for l, d in zip(legendaries, docks)], "Fishing")
put("fishing_legendary_tribute_levels_array", [f"{l} ({d})" for l, d in zip(legendaries, docks)], "Fishing")

fish_table = fishing[fishing.index('<div id="Guppy">'):]
fish_table = fish_table[:fish_table.index("\n|}")]
fish = [clean(n) for n in re.findall(r'<div id="[^"]+"></div>\[\[File:[^\]]*\]\]\s*([^{\n|]+)', fish_table)]
put("fishing_regular_card_array", fish, "Fishing")

notice_ids = [i for i, _ in table_rows(fishing, r"Upgrades_T[12]_[A-Za-z0-9_]+")]
first_upgrade = notice_ids.index("Upgrades_T1_FishingRod")
notice_names = names(fishing, r"Upgrades_T[12]_[A-Za-z0-9_]+")[:first_upgrade]
put("fishing_notices_array", [f"T{1 if i < 15 else 2}: {n}" for i, n in enumerate(notice_names)], "Fishing")

upgrade_names = names(fishing, r"Upgrades_T[12]_[A-Za-z0-9_]+")[first_upgrade:]
# The export has one extra slot at index 4 that the wiki table doesn't list (checked against max levels).
upgrade_names = upgrade_names[:4] + [None] + upgrade_names[4:]
put("fishing_upgrades_array", upgrade_names, "Fishing")

enhance_ids = ["FishIncome", "FishingDrone", "FishingRodPower", "FishingTickSpeed", "DronePower", "FishTokenGain",
               "DoubleTick", "TinyNotice", "ShinyMulti", "FishingDrone3", "Tier2DockTicks", "TripleTick",
               "SuperShiny", "Tier2DockPower", "PolyCard"]
enh = dict(table_rows(fishing, "|".join(enhance_ids)))
put("fishing_enhance_array", [f"T{1 if i < 10 else 2}: {enh[k][0]}" for i, k in enumerate(enhance_ids)], "Fishing")

# --- Other pages whose table order matches the export (verified via max levels) ---
put("regular_upgrades_array",
    [f"{w}: {clean(n)}" for w, n in re.findall(r'\|<div id="Upgrades_(W\d)_[^"]*"\s*/>.*?\|\|\s*(.*?)\s*\|\|', page("Upgrades"))],
    "Upgrades")

ch = page("Challenges")
ch = ch[ch.index("==Challenge Rewards=="):]
put("challenge_upgrades_array",
    [f"{tier}: {clean(n)}" for tier, n in re.findall(r'\|<div id="(Regular|Extreme|Divine)Reward_[^"]*"></div>.*?\|\|\s*(.*?)\s*\|\|', ch)],
    "Challenges")

star = page("Stargazing")
put("stars_regular_upgrades_array", names(star, r"[A-Za-z0-9]+Upgrade"), "Stargazing")
put("stars_super_star_upgrades_array",
    names(star, r"[A-Za-z0-9]+_SSUpgrade|UnlockBlackHole"),
    "Stargazing")

put("gem_upgrades_array", names(page("Store")[page("Store").index("==Gem Upgrades=="):],
                                r"PickaxeDamage|BombDamageAndBombCapacity|BankedFreebieCap|ChestMeterFillRate|ItemsContainedInChests|OreSellPrice"),
    "Store#Gem_Upgrades")

# Contract upgrades: levels in wiki order. Checked by comparing two exports from the same player:
# each newly bought level changed exactly the matching stat (e.g. #17 Base Game Speed lvl 8 -> x1.08).
put("contracts_array",
    [f"{w}: {cells[0]}" for (i, cells) in table_rows(page("Contracts"), r"Upgrades_W\d_[A-Za-z0-9]+")
     for w in [i.split("_")[1]]],
    "Contracts")

# Contract upgrades for the planner: name, bonus, base max level and contract point cost per level.
# Costs come from the page's CostTable entries (base and growth per level, listed in upgrade order).
contracts_page = page("Contracts")
contract_rows = table_rows(contracts_page, r"Upgrades_W\d_[A-Za-z0-9]+")
cost_tables = []
for line in contracts_page.splitlines():
    if not line.startswith("{{CostTable|"):
        continue
    parts = line.replace("{{=}}", "=").split("|")   # label | levels | scale | class | type | base | ...
    cost_tables.append((parts[3], parts[5], parts[6]))
if len(contract_rows) != len(cost_tables):
    raise SystemExit(f"contracts: {len(contract_rows)} upgrades but {len(cost_tables)} cost tables")
contracts = []
for (cid, cells), (scale, kind, base) in zip(contract_rows, cost_tables):
    contracts.append({"name": cells[0], "bonus": cells[1], "max": int(cells[2]), "world": int(cid.split("_")[1][1]),
                      "cost": {"type": kind, "base": float(base), "scale": float(scale)}})

# Idols: wiki order minus the idols added in later updates; checked against max levels in a late-game
# export and the Athena/Apollo counts in an early one. Slots after the 19 base idols are not idol counts
# (values exceed every idol cap) and stay unlabelled.
arch = page("Archaeology")
arch = arch[arch.index("== Idols =="):]
LATER_IDOLS = {"Astraeus", "Chione", "Talos", "Aphrodite", "Tethys"}
idols = [n for n in re.findall(r'\|<div id="[^"]+"></div>\[\[File:[^\]]*Idol[^\]]*\]\]\s*\|\|\s*([^|]+?)\s*\|\|', arch)
         if n not in LATER_IDOLS]
put("idols_array", idols, "Archaeology#Idols")

put("stickers_array", names(page("Stickers"), r"[A-Za-z]+Sticker"), "Stickers")

# --- Statues: scalar keys, not arrays ---
statues = {}
for world, set_no in (("World1Statues", 1), ("World3Statues", 2), ("World4Statues", 3)):
    t = page(f"Guides/Working With ExportStats/{world}")
    for idx, name, alias in re.findall(r'"Statue_(\d)_set\d"</syntaxhighlight>\s*\n\|[^|]*\|\|\s*([^|]+?)\s*\|\|\s*([^|]+?)\s*\|\|', t):
        statues[f"statue_{idx}_set{set_no}"] = f"{name} ({alias})"

for key, values in labels.items():
    if not any(values):
        raise SystemExit(f"{key}: no labels parsed, the wiki page format probably changed")


# --- Cards (not in the export; players mark them by hand) ---
def wiki_file_url(file_name):
    """Direct URL of a file on Miraheze's image host (MediaWiki hashed upload path)."""
    name = file_name.strip().replace(" ", "_")
    name = name[0].upper() + name[1:]
    h = hashlib.md5(name.encode("utf-8")).hexdigest()
    return f"https://static.wikitide.net/shminerwiki/{h[0]}/{h[:2]}/{quote(name)}"


CARD_PAGES = [  # in-game tab order; tabs after Archaeology are not confirmed yet
    ("ores", "Ores"), ("bars", "Bars"), ("bombs", "Bombs"), ("misc", "Misc"), ("drones", "Drones"),
    ("pets", "Pets"), ("veins", "Veins"), ("stars", "Stars"), ("archaeology", "Archaeology"),
    ("fish", "Fish"), ("legendary_fish", "Legendary Fish"), ("essences", "Essences"), ("orbs", "Orbs"),
    ("runes", "Runes"), ("spells", "Spells"),
]
# Card art the wiki's card table points at, but which doesn't exist under that name.
# Tried in order after the default; the stat icon is the last resort.
CARD_IMAGE_FALLBACKS = {
    "Misc Big Lootfrog": ["Misc Big Frog.png", "Big Lootfrog Multi.png"],
    "Misc Massive Lootfrog": ["Misc Massive Frog.png"],
}

cards = []
for cid, title in CARD_PAGES:
    t = page(f"Cards/Card Effects/{title}")
    entries = []
    for line in t.splitlines():
        m = re.search(r"\{\{CardShowcase\|card=([^}|]+)[^}]*\}\}\s*\|\|(.*)", line)
        if not m:
            continue
        cells = [clean(c) for c in m.group(2).split("||")]
        name, effects = cells[0], cells[1:5]
        infernal = len(effects) > 3 and effects[3] not in ("", "{{NA}}")
        entries.append({
            "name": name,
            "img": [wiki_file_url(f) for f in [m.group(1) + ".png"] + CARD_IMAGE_FALLBACKS.get(m.group(1).strip(), [])],
            "fx": [e if e != "{{NA}}" else None for e in effects],
            "max": 4 if infernal else 3,
        })
    if not entries:
        raise SystemExit(f"cards/{cid}: no cards parsed, the wiki page format probably changed")
    cards.append({"id": cid, "title": title, "wiki": f"Cards/Card_Effects/{title.replace(' ', '_')}", "cards": entries})

# --- Ores: floors and modifiers from Data-JSON-Ore, health and exp from the Ores tables ---
SUFFIX = {"": 1, "k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12, "q": 1e15, "qi": 1e18, "sx": 1e21, "sp": 1e24,
          "oc": 1e27, "no": 1e30, "dc": 1e33, "udc": 1e36, "ddc": 1e39}


def wiki_number(text):
    m = re.fullmatch(r"([0-9.,]+)\s*([a-z]*)", text.strip().lower())
    if not m or m.group(2) not in SUFFIX:
        raise SystemExit(f"ores: can't read number {text!r}")
    return float(m.group(1).replace(",", "")) * SUFFIX[m.group(2)]


ore_json = page("Data-JSON-Ore")
ore_json = json.loads(ore_json[ore_json.index("{"):ore_json.rindex("}") + 1])
ore_table = {}
for name, hp, xp in re.findall(r'^\|\s*<div id="[^"]+"></div>\[\[File:[^\]]*\]\]\s*\|\|\s*(.+?) Ore\s*\|\|\s*([^|]+?)\s*\|\|\s*([^|]+?)\s*\|\|',
                               page("Ores"), flags=re.M):
    ore_table[name.strip()] = (wiki_number(hp), wiki_number(xp))
ores = []
for row in ore_json["data"]:
    _, name, lo, hi, *rest = row
    if name not in ore_table:
        raise SystemExit(f"ores: {name} has no health/exp row on the Ores page")
    hp, xp = ore_table[name]
    ores.append({"name": name, "min": lo, "max": hi, "hp": hp, "xp": xp, "img": wiki_file_url(f"{name} Ore.png"),
                 "mod": rest[0].strip().lower() if rest else None, "amt": rest[1] if len(rest) > 1 else None})
# Ore split per floor (Floors page): floors come in pairs of two ores; the first floor of a pair is
# 80% the first ore / 20% the second, the following floor 50% / 50%.
floor_ores = {}
for lo, hi, first, second in re.findall(r"\{\{FloorLine\|(\d+)-(\d+)\|([^|}]+)\|([^|}]+)\}\}", page("Floors")):
    lo, hi, first, second = int(lo), int(hi), first.strip(), second.strip()
    for name in (first, second):
        if not any(o["name"] == name for o in ores):
            raise SystemExit(f"floors: {name} on floors {lo}-{hi} isn't in the ore data")
    floor_ores[lo] = [[first, 0.8], [second, 0.2]]
    for f in range(lo + 1, hi + 1):
        floor_ores[f] = [[first, 0.5], [second, 0.5]]
if len(floor_ores) < 100:
    raise SystemExit("floors: floor list not found or changed")

# Base bomb cooldowns (seconds, before Bomb Recharge Speed) from the Bombs page.
bombs_page = page("Bombs")
cooldowns = bombs_page[bombs_page.index("==Bomb Cooldowns=="):]
bombs = [{"name": n.strip(), "cd": float(cd)}
         for n, cd in re.findall(r"^\|\s*\{\{Sprite\|([^|}]+)[^}]*\}\}\s*\|\|\s*([0-9.]+)", cooldowns, flags=re.M)]
if len(bombs) < 10:
    raise SystemExit("bombs: cooldown table not found or changed")

ORES_OUT = ROOT / "assets" / "ores.js"
ORES_OUT.write_text(
    "// Generated by tools/build-array-labels.py from wiki-cache/ (Data-JSON-Ore, Ores, Bombs). Do not edit by hand.\n"
    "window.IOM = window.IOM || {};\n"
    f"window.IOM.ORES = {json.dumps(ores, separators=(',', ':'))};\n"
    f"window.IOM.BOMBS = {json.dumps(bombs, separators=(',', ':'))};\n"
    f"window.IOM.FLOOR_ORES = {json.dumps(floor_ores, separators=(',', ':'))};\n"
    f"window.IOM.CONTRACTS = {json.dumps(contracts, ensure_ascii=False, separators=(',', ':'))};\n",
    encoding="utf-8",
)
print("bombs: " + ", ".join(f"{b['name']} {b['cd']:g}s" for b in bombs))
print(f"ores: {len(ores)}, floors {min(o['min'] for o in ores)}-{max(o['max'] for o in ores)}, floor splits: {len(floor_ores)}")

card_backs = {lvl: wiki_file_url(f"Card Backing {name}.png")
              for lvl, name in ((1, "Standard"), (2, "Gilded"), (3, "Polychrome"), (4, "Infernal"))}
CARDS_OUT = ROOT / "assets" / "cards.js"
CARDS_OUT.write_text(
    "// Generated by tools/build-array-labels.py from wiki-cache/. Do not edit by hand.\n"
    "window.IOM = window.IOM || {};\n"
    f"window.IOM.CARD_BACKS = {json.dumps(card_backs)};\n"
    f"window.IOM.CARDS = {json.dumps(cards, ensure_ascii=False, separators=(',', ':'))};\n",
    encoding="utf-8",
)
print("cards: " + ", ".join(f"{c['id']} {len(c['cards'])}" for c in cards))
print(f"wrote {CARDS_OUT.relative_to(ROOT)}")

OUT.write_text(
    "// Generated by tools/build-array-labels.py from wiki-cache/. Do not edit by hand.\n"
    "window.IOM = window.IOM || {};\n"
    f"window.IOM.ARRAY_LABELS = {json.dumps(labels, indent=1, ensure_ascii=False)};\n"
    f"window.IOM.ARRAY_SOURCES = {json.dumps(sources, indent=1)};\n"
    f"window.IOM.STATUE_LABELS = {json.dumps(statues, indent=1, ensure_ascii=False)};\n",
    encoding="utf-8",
)
for key, values in labels.items():
    print(f"{key:42s} {sum(1 for v in values if v):3d} labels")
print(f"statues: {len(statues)}")
print(f"wrote {OUT.relative_to(ROOT)}")
