// Experience calculator: statistical exp per minute from mining floors, using the imported stats.
// Model (every unknown is an input so players can match their own measurements):
//   exp per floor  = ores on screen x average base exp of the floor's ores x exp multi (x triple rock bonus)
//   time per floor = clear time + respawn wait, in game seconds, divided by game speed
//   clear time     = pickaxe off: bombs/drones clear instantly after their detonation delay
//                    pickaxe on:  every swing hits every ore; the floor clears when the toughest ore dies
(function () {
  "use strict";

  const PREF_KEY = "iom.calc.exp.v1";
  const DEFAULTS = {
    usePickaxe: false,
    respawnMode: "after",      // "after": wait starts when the floor is cleared; "tick": fixed 1 s check
    respawnWait: 1,            // game seconds (wiki: the game checks once per second)
    bombDelay: 0.25,           // game seconds for bombs to detonate (wiki)
    scaleWithSpeed: true,      // game speed also speeds up attacks and the respawn wait
    tripleExp: false,          // unknown whether triple rocks give 3x exp (wiki only says 3x ores)
    measuredFpm: ""            // optional: measured floors per minute overrides the timing model
  };
  const STAT_FIELDS = [
    ["current_floor", "Floor", 1],
    ["experience_multi", "Exp multi", 0.01],
    ["game_speed_multi", "Game speed", 0.01],
    ["ores_per_screen", "Ores on screen", 1],
    ["multi_rock_chance", "Triple rock chance %", 0.1]
  ];
  const PICK_FIELDS = [
    ["pickaxe_damage", "Damage"],
    ["pickaxe_attack_speed_per_second", "Attacks / sec"],
    ["pickaxe_crit_chance", "Crit chance %"],
    ["pickaxe_crit_damage", "Crit damage ×"],
    ["pickaxe_super_crit_chance", "Super crit chance %"],
    ["pickaxe_super_crit_damage", "Super crit damage ×"],
    ["pickaxe_ultra_crit_chance", "Ultra crit chance %"],
    ["pickaxe_ultra_crit_damage", "Ultra crit damage ×"],
    ["pickaxe_omega_crit_chance", "Omega crit chance %"],
    ["pickaxe_omega_crit_damage", "Omega crit damage ×"]
  ];

  const root = document.getElementById("calcExp");
  if (!root || !window.IOM || !IOM.ORES) return;

  let prefs = Object.assign({}, DEFAULTS);
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch { /* defaults */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

  let stats = null;        // values used by the calculator (copied from the save, editable here)
  let sourceKey = null;    // detects when a different save/import is shown

  // ---------- helpers ----------
  const $ = (s) => root.querySelector(s);
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }
  const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc", "UDc", "DDc"];
  function fmt(n, digits = 2) {
    if (!isFinite(n)) return "∞";
    const a = Math.abs(n);
    if (a < 1000) return String(Number(n.toFixed(a < 10 ? digits + 1 : digits)));
    const tier = Math.min(Math.floor(Math.log10(a) / 3), SUFFIXES.length - 1);
    return (n / Math.pow(1000, tier)).toFixed(2).replace(/\.?0+$/, "") + SUFFIXES[tier];
  }
  const tidy = (n) => typeof n === "number" ? Number(n.toPrecision(12)) : n;  // hides float noise
  // Small seeded RNG so results don't jump around between renders.
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------- model ----------
  function oresOnFloor(floor) { return IOM.ORES.filter(o => floor >= o.min && floor <= o.max); }

  // Damage outcomes per pickaxe hit: [probability, multiplier, tier] for normal, crit, super, ultra, omega.
  function hitTable(s) {
    const p = (k) => Math.min(Math.max((s[k] || 0) / 100, 0), 1);
    const c = p("pickaxe_crit_chance"), sc = p("pickaxe_super_crit_chance"),
          uc = p("pickaxe_ultra_crit_chance"), oc = p("pickaxe_omega_crit_chance");
    const cd = s.pickaxe_crit_damage || 1, sd = s.pickaxe_super_crit_damage || 1,
          ud = s.pickaxe_ultra_crit_damage || 1, od = s.pickaxe_omega_crit_damage || 1;
    return [
      [1 - c, 1, 0],
      [c * (1 - sc), cd, 1],
      [c * sc * (1 - uc), cd * sd, 2],
      [c * sc * uc * (1 - oc), cd * sd * ud, 3],
      [c * sc * uc * oc, cd * sd * ud * od, 4]
    ];
  }
  const IMMUNITY = { "super crit+ only": 2, "ultra crit+ only": 3, "omega crit+ only": 4 };

  // Per-ore damage outcomes after its modifier: [probability, damage].
  function oreHits(ore, s, table) {
    let dmg = s.pickaxe_damage || 0;
    if (ore.mod === "damage" && ore.amt) dmg *= Math.max(0, 1 + ore.amt / 100);
    const minTier = IMMUNITY[ore.mod] || 0;
    return table.map(([pr, mult, tier]) => [pr, tier >= minTier ? dmg * mult : 0]);
  }
  function oreHp(ore) {
    return ore.mod === "health" && ore.amt ? ore.hp * (1 + ore.amt / 100) : ore.hp;
  }

  // Hits needed to break one ore (one random sample).
  function sampleHits(hp, outcomes, rand) {
    const mean = outcomes.reduce((a, [p, d]) => a + p * d, 0);
    if (mean <= 0) return Infinity;
    if (hp / mean > 5000) return hp / mean;            // many hits: the average is precise enough
    let left = hp, n = 0;
    while (left > 0) {
      let r = rand(), d = 0;
      for (const [p, dm] of outcomes) { if ((r -= p) <= 0) { d = dm; break; } d = dm; }
      left -= d; n++;
      if (n > 20000) return hp / mean;
    }
    return n;
  }

  // Expected swings to clear a floor when every swing hits every ore: the toughest ore decides.
  function swingsToClear(floorOres, count, s) {
    const table = hitTable(s);
    const per = floorOres.map(o => ({ hp: oreHp(o), out: oreHits(o, s, table) }));
    const rand = rng(12345 + count * 7 + floorOres.length);
    const samples = 300;
    let total = 0;
    for (let i = 0; i < samples; i++) {
      let worst = 0;
      for (let j = 0; j < count; j++) {
        const o = per[Math.floor(rand() * per.length)];
        worst = Math.max(worst, sampleHits(o.hp, o.out, rand));
        if (!isFinite(worst)) return Infinity;
      }
      total += worst;
    }
    return total / samples;
  }

  function evaluate(floor, s) {
    const floorOres = oresOnFloor(floor);
    if (!floorOres.length) return null;
    const count = Math.max(1, Math.round(s.ores_per_screen || 1));
    const triple = Math.min(Math.max((s.multi_rock_chance || 0) / 100, 0), 1);
    const tripleFactor = prefs.tripleExp ? 1 + 2 * triple : 1;
    const avgXp = floorOres.reduce((a, o) => a + o.xp, 0) / floorOres.length;
    const expPerFloor = count * avgXp * (s.experience_multi || 1) * tripleFactor;

    // Game speed modifiers on this floor's ores (e.g. -25%) slow everything down while they're there.
    let speed = s.game_speed_multi || 1;
    for (const o of floorOres) if (o.mod === "game speed" && o.amt) speed *= 1 + o.amt / 100;
    const scale = prefs.scaleWithSpeed ? speed : 1;

    let clear, swings = null;
    if (prefs.usePickaxe) {
      swings = swingsToClear(floorOres, count, s);
      const aps = s.pickaxe_attack_speed_per_second || 0;
      clear = aps > 0 ? swings / aps : Infinity;
    } else {
      clear = prefs.bombDelay;
    }
    let gameTime;
    if (prefs.respawnMode === "tick") gameTime = Math.max(1, Math.ceil(clear / prefs.respawnWait - 1e-9)) * prefs.respawnWait;
    else gameTime = clear + prefs.respawnWait;
    let realTime = gameTime / scale;
    const measured = parseFloat(prefs.measuredFpm);
    if (measured > 0 && floor === Math.round(s.current_floor)) realTime = 60 / measured;
    const fpm = 60 / realTime;
    return { floor, floorOres, count, avgXp, expPerFloor, speed, clear, swings, realTime, fpm, xpm: fpm * expPerFloor };
  }

  // ---------- rendering ----------
  function numberInput(key, label, step) {
    const input = el("input", { type: "number", inputmode: "decimal", step: step || "any", value: tidy(stats[key] ?? 0), id: "ce-" + key });
    input.addEventListener("input", () => { const v = parseFloat(input.value); if (isFinite(v)) { stats[key] = v; compute(); } });
    return el("label", { class: "field", for: "ce-" + key }, el("span", { text: label }), input);
  }

  function prefInput(key, label, attrs = {}) {
    const input = el("input", Object.assign({ type: "number", step: "any", value: prefs[key], id: "ce-p-" + key }, attrs));
    input.addEventListener("input", () => {
      prefs[key] = key === "measuredFpm" ? input.value : (parseFloat(input.value) || 0);
      savePrefs(); compute();
    });
    return el("label", { class: "field", for: "ce-p-" + key }, el("span", { text: label }), input);
  }

  function checkbox(key, label, onChange) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!prefs[key];
    cb.addEventListener("change", () => { prefs[key] = cb.checked; savePrefs(); if (onChange) onChange(); compute(); });
    return el("label", { class: "check" }, cb, document.createTextNode(" " + label));
  }

  function buildForm() {
    const pickBox = el("div", { class: "field-grid", id: "ce-pick" }, ...PICK_FIELDS.map(([k, l]) => numberInput(k, l)));
    pickBox.hidden = !prefs.usePickaxe;
    const mode = el("select", { id: "ce-mode" },
      el("option", { value: "after", text: "Wait starts after the floor is cleared" }),
      el("option", { value: "tick", text: "Fixed check every interval (like a bus timetable)" }));
    mode.value = prefs.respawnMode;
    mode.addEventListener("change", () => { prefs.respawnMode = mode.value; savePrefs(); compute(); });

    $("#ce-form").replaceChildren(
      el("h3", { text: "Your stats" }),
      el("p", { class: "muted small", text: "Taken from the current save. Change any value to try a what-if; it resets when you switch saves." }),
      el("div", { class: "field-grid" }, ...STAT_FIELDS.map(([k, l, st]) => numberInput(k, l, st))),
      checkbox("usePickaxe", "Use pickaxe (assumes every swing hits every ore at once)", () => { pickBox.hidden = !prefs.usePickaxe; }),
      pickBox,
      el("h3", { text: "Assumptions" }),
      el("div", { class: "field-grid" },
        el("label", { class: "field wide", for: "ce-mode" }, el("span", { text: "Respawn timing" }), mode),
        prefInput("respawnWait", "Respawn wait (game s)", { min: 0, step: 0.05 }),
        prefInput("bombDelay", "Bomb/drone clear delay (game s)", { min: 0, step: 0.05 }),
        prefInput("measuredFpm", "Measured floors/min (optional)", { min: 0, step: 0.1, placeholder: "e.g. 52" })
      ),
      checkbox("scaleWithSpeed", "Game speed also speeds up attacks and the respawn wait"),
      checkbox("tripleExp", "Triple rocks give 3× exp (the wiki only says 3× ores)")
    );
  }

  function compute() {
    const floor = Math.round(stats.current_floor || 1);
    const r = evaluate(floor, stats);
    const out = $("#ce-results");
    if (!r) { out.replaceChildren(el("p", { class: "warning", text: `No ore data for floor ${floor}.` })); $("#ce-table").replaceChildren(); return; }

    const tile = (label, value, sub) => el("div", { class: "tile" },
      el("div", { class: "t-label", text: label }), el("div", { class: "t-value", text: value }), sub ? el("div", { class: "t-sub", text: sub }) : null);
    const blocked = !isFinite(r.realTime);
    out.replaceChildren(...[
      el("div", { class: "overview" },
        tile("Exp / minute", blocked ? "—" : fmt(r.xpm)),
        tile("Exp / hour", blocked ? "—" : fmt(r.xpm * 60)),
        tile("Floors / minute", blocked ? "—" : fmt(r.fpm), `${fmt(r.realTime)} s per floor`),
        tile("Exp per floor", fmt(r.expPerFloor), `${r.count} ores × ${fmt(r.avgXp)} × ${fmt(stats.experience_multi || 1)}`),
        prefs.usePickaxe ? tile("Swings per floor", isFinite(r.swings) ? fmt(r.swings) : "—", isFinite(r.clear) ? `${fmt(r.clear)} game s to clear` : null) : null
      ),
      blocked ? el("p", { class: "warning", text: "⚠️ Your pickaxe can't break the ores on this floor (immunity or zero damage)." }) : null,
      el("p", { class: "muted small" },
        `Floor ${floor}: ${r.floorOres.map(o => `${o.name} (${fmt(o.xp)} exp${o.mod ? ", " + o.mod + (o.amt != null ? " " + o.amt + "%" : "") : ""})`).join(", ")}. ` +
        `Each is assumed equally likely to spawn. Effective game speed ${fmt(r.speed)}.` +
        (parseFloat(prefs.measuredFpm) > 0 ? " Using your measured floors/min." : ""))
    ].filter(Boolean));

    // Every floor up to the current one, so players can pick the best floor to farm.
    const rows = [];
    for (let f = 1; f <= Math.max(floor, 1); f++) {
      const e = evaluate(f, stats);
      if (e) rows.push(e);
    }
    const best = rows.reduce((a, b) => (isFinite(b.xpm) && b.xpm > (a ? a.xpm : -1) ? b : a), null);
    $("#ce-table").replaceChildren(...[
      el("h3", { text: "All floors up to yours" }),
      best ? el("p", { class: "small", text: `Best floor for exp: ${best.floor} (${fmt(best.xpm)} exp/min).` }) : null,
      el("div", { class: "table-wrap" },
        el("table", { class: "calc-table" },
          el("thead", {}, el("tr", {}, ...["Floor", "Ores", "Exp/floor", "Floors/min", "Exp/min"].map(h => el("th", { text: h })))),
          el("tbody", {}, ...rows.slice().reverse().map(e => el("tr", { class: (e === best ? "best" : "") + (e.floor === floor ? " current" : "") },
            el("td", { text: String(e.floor) }),
            el("td", { text: e.floorOres.map(o => o.name).join(", ") }),
            el("td", { text: fmt(e.expPerFloor) }),
            el("td", { text: isFinite(e.fpm) ? fmt(e.fpm) : "—" }),
            el("td", { text: isFinite(e.xpm) ? fmt(e.xpm) : "—" })
          )))
        )
      )
    ].filter(Boolean));
  }

  IOM.calcExp = {
    // Called by the app whenever the shown save/import changes.
    render(data) {
      if (!data || !data.stats) return;
      const key = JSON.stringify([data.time, data.version, data.stats.current_floor, data.stats.experience_multi, data.stats.pickaxe_damage]);
      if (key !== sourceKey) {
        sourceKey = key;
        stats = {};
        for (const [k] of STAT_FIELDS.concat(PICK_FIELDS)) stats[k] = data.stats[k];
        buildForm();
      }
      compute();
    }
  };
})();
