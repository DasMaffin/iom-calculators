#!/usr/bin/env python3
"""Builds assets/array-labels.js from the downloaded wiki pages in wiki-cache/.

Run from the repo root after refreshing the cache:
    python3 tools/build-array-labels.py

Only arrays whose order was checked against real exports are labelled.
Each entry records its source page so it can be re-checked when the wiki changes.
"""
import json
import re
from pathlib import Path

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
