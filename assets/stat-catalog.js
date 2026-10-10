// Stat catalog: groups export keys into sections and gives them readable labels.
// Keys not matched by any rule land in "Other", so new game stats still show up.
// Section notes reference the wiki: https://shminer.miraheze.org/wiki/Stats

window.IOM = window.IOM || {};

IOM.SECTIONS = [
  { id: "progress",  title: "Progress",            icon: "🏔️" },
  { id: "pickaxe",   title: "Pickaxe",             icon: "⛏️", wiki: "Stats/Pickaxe" },
  { id: "bombs",     title: "Bombs",               icon: "💣" },
  { id: "drones",    title: "Drones & Coal",       icon: "🤖", wiki: "Stats/Drones" },
  { id: "ore",       title: "Ore, Veins & Floors", icon: "🪨", wiki: "Stats/Ore" },
  { id: "void",      title: "Void Portals",        icon: "🌀" },
  { id: "stars",     title: "Stargazing",          icon: "⭐", wiki: "Stats/Stars" },
  { id: "lootbugs",  title: "Lootbugs & Elixir",   icon: "🐞", wiki: "Stats/Lootbugs" },
  { id: "lootfrogs", title: "Lootfrogs",           icon: "🐸" },
  { id: "chests",    title: "Chests, Freebies & Stonks", icon: "🎁", wiki: "Stats/Chests" },
  { id: "crafting",  title: "Crafting & Bars",     icon: "⚒️" },
  { id: "contracts", title: "Contracts",           icon: "📜" },
  { id: "pets",      title: "Pets",                icon: "🐾", wiki: "Pets" },
  { id: "fishing",   title: "Fishing",             icon: "🎣", wiki: "Fishing" },
  { id: "statues",   title: "Statues",             icon: "🗿" },
  { id: "collections", title: "Upgrades & Collections", icon: "📦" },
  { id: "other",     title: "Other",               icon: "❔" }
];

// Ordered rules: first match wins.
IOM.RULES = [
  [/^statue_/, "statues"],
  [/^(pet_|pets_)/, "pets"],
  [/^(fishing_|angler_)/, "fishing"],
  [/^is_drone_angler/, "fishing"],
  [/^(lootfrog|golden_lootfrogs)/, "lootfrogs"],
  [/^(lootbug|elixir_)/, "lootbugs"],
  [/^(star_|super_star_|stars_|all_star|novagiant|black_hole|starburst_)/, "stars"],
  [/void_portal/, "void"],
  [/^pickaxe_/, "pickaxe"],
  [/^bomb_/, "bombs"],
  [/^(drone_|drones_|is_drone_|coal_)|_fuel_grade$/, "drones"],
  [/^(ore_|ores_|vein_|golden_|rainbow_|galactic_|prismatic_|gleaming_|all_floor|floor_|multi_rock)/, "ore"],
  [/^(chest_|freebie_|stonks_|super_stonks|ultra_stonks|item_)/, "chests"],
  [/^(craft_|bar_|double_craft|triple_craft|free_craft)/, "crafting"],
  [/^contract/, "contracts"],
  [/^(obelisk_|current_floor|worlds_unlocked|world_\d|game_speed|xp_|experience_|prestige_|infernal_)/, "progress"],
  [/(_array$|^gem_upgrade|^artifact_|_eaten$)/, "collections"]
];

// Highlighted on the overview strip at the top.
IOM.HEADLINE = [
  "obelisk_level", "current_floor", "worlds_unlocked", "pickaxe_damage",
  "bomb_damage", "ore_sell_price_multi", "prestige_point_multi", "experience_multi"
];

// Label overrides where the auto-generated label reads poorly.
IOM.LABELS = {
  pickaxe_attack_speed_per_second: "Pickaxe Attacks / sec",
  obelisk_timer_add: "Obelisk Fight Time Bonus (s)",
  xp_level_cap: "XP Level Cap",
  multi_rock_chance: "Multi-Rock Chance",
  vein_2x_spawn_array: "Vein 2x Spawn",
  vein_researched_array: "Veins Researched",
  bomb_cherry3x_chance: "Cherry Bomb 3x Chance",
  bomb_trans_apply_bop_chance: "Transmuter applies Bomb of Plenty Chance",
  bomb_of_plenty_make_gold_chance: "Bomb of Plenty Gold Chance",
  lootbug_and_elixir_uptime_array: "Lootbug & Elixir Uptime",
  is_drone_chain_equipped_and_fueled: "Chain Drone Fueled",
  game_speed_multi: "Game Speed Multi",
  infernal_card_multi: "Infernal Card Multi",
  novagiant_combo_multi: "Nova-Giant Combo Multi",
  fishing_tier2_dock_multi: "Fishing Tier 2 Dock Multi",
  star_triple_spawn_chance: "Star Triple Spawn Chance"
};

// Systems the wiki documents that are NOT in the reference export (v2.2.30, Obelisk 31).
// Their stats will appear under their section (or "Other") automatically once your export has them.
IOM.NOT_YET_SEEN = [
  { name: "Arcanist", note: "Unlocks at Obelisk 70 — mana regen, spell power, spell duration, wizard chances (Disco, Flashbang, Blind, Party) and wizard loot multi.", wiki: "Arcanist" },
  { name: "Archaeology", note: "Skills (Strength, Agility, Perception, Intellect, Luck, Divinity, Corruption), ascension upgrades and fragments.", wiki: "Archaeology" },
  { name: "Fishing (active)", note: "Unlocks at Obelisk 37. Your export already has the fishing keys, all at 0 for now.", wiki: "Fishing" },
  { name: "Black Hole", note: "World 3 — bonuses like Galactic Floor Chance and Void Portal Chance. Key black_hole_level is already exported.", wiki: "Stargazing" },
  { name: "Prism / Void drones", note: "Void suit unlocks at Obelisk 23, Prism suit at Obelisk 64.", wiki: "Drones" },
  { name: "Cards", note: "Standard, Gilded, Polychrome and Infernal card tiers.", wiki: "Cards" }
];

IOM.sectionFor = function (key) {
  for (const [re, id] of IOM.RULES) if (re.test(key)) return id;
  return "other";
};

const WORD_FIXES = {
  multi: "Multi", xp: "XP", exp: "EXP", bop: "BoP", "2x": "2x", "3x": "3x",
  "5x": "5x", "10x": "10x", "20x": "20x", "100x": "100x", id: "ID"
};

IOM.labelFor = function (key) {
  if (IOM.LABELS[key]) return IOM.LABELS[key];
  let k = key.replace(/^is_/, "").replace(/_array$/, "");
  const words = k.split("_").map(w => WORD_FIXES[w] || (w.charAt(0).toUpperCase() + w.slice(1)));
  let label = words.join(" ").replace(/\bPercent\b/, "%");
  if (key.startsWith("is_")) label += "?";
  return label;
};

// How to display a numeric value.
IOM.kindFor = function (key) {
  if (/(_chance)$/.test(key)) return "percent";
  if (/_percent$/.test(key)) return "percent";
  if (/(_multi|_multiplier|_multipliers)$/.test(key)) return "multi";
  if (/_seconds$/.test(key)) return "seconds";
  return "number";
};
