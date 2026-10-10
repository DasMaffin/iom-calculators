// Experience calculator: statistical exp per minute from mining, using the imported stats.
// It simulates a few game-minutes in small time steps: a floor of ores spawns, the pickaxe (optional),
// drones and bombs damage it, broken ores give exp, then the respawn wait runs and the next floor spawns.
// Known values come from the wiki (ore exp/health/modifiers, bomb cooldowns, 1.25 s Auto-Bomber/Fire Slow,
// 0.25 s bomb delay, 1 s respawn check, drone base 1.25 attacks/s). What the wiki doesn't give is either
// simplified (see notes on the page) or an assumption the player can switch.
(function () {
  "use strict";

  const PREF_KEY = "iom.calc.exp.v2";
  const FIRE_INTERVAL = 1.25;         // Auto-Bomber and Fire Slow (wiki)
  // Fire / hare fires once per rendered frame (measured in game), including the frame a floor appears.
  // Frame rate only matters when a floor needs several hare hits; assume a 30 fps phone (the slower case).
  const HARE_FPS = 30;
  const DRONE_BASE_APS = 1.25;        // drone attacks per second at 100% (wiki)
  // The next floor spawns about 1 s after the last ore breaks (wiki: the game checks once per second;
  // players see the same). Bombs hit the moment they're fired (seen in game; the wiki's 0.25 s
  // detonation delay doesn't match that).
  const RESPAWN_WAIT = 1;
  const BOMB_DELAY = 0;
  const DEFAULTS = {
    usePickaxe: false,
    useDrones: true,
    autoBomb: "",
    manualBomb: "",
    manualMode: "slow",       // "slow" = Fire Slow / turtle (every 1.25 s), "hare" = Fire held down (every frame)
    chainActive: false,
    simFloors: 1000,          // floors simulated per floor level; more = steadier averages, slower       // queued chain bombs explode one every 1.25 s; the queue size only sets how long

    fullBombs: true,          // bombs fire every 1.25 s from stored charges; off = limited by recharge

  };
  const GENERAL = [
    ["experience_multi", "Exp multi"], ["game_speed_multi", "Game speed"],
    ["ores_per_screen", "Ores on screen", 1]
  ];
  const PICK = [
    ["pickaxe_damage", "Damage"], ["pickaxe_attack_speed_per_second", "Attacks / sec"],
    ["pickaxe_crit_chance", "Crit chance %"], ["pickaxe_crit_damage", "Crit damage ×"],
    ["pickaxe_super_crit_chance", "Super crit chance %"], ["pickaxe_super_crit_damage", "Super crit damage ×"],
    ["pickaxe_ultra_crit_chance", "Ultra crit chance %"], ["pickaxe_ultra_crit_damage", "Ultra crit damage ×"],
    ["pickaxe_omega_crit_chance", "Omega crit chance %"], ["pickaxe_omega_crit_damage", "Omega crit damage ×"]
  ];
  const BOMB = [
    ["bomb_damage", "Bomb damage"], ["bomb_recharge_speed", "Recharge speed ×"], ["bomb_free_chance", "Free bomb chance %"],
    ["bomb_crit_chance", "Crit chance %"], ["bomb_crit_damage", "Crit damage ×"],
    ["bomb_super_crit_chance", "Super crit chance %"], ["bomb_super_crit_damage", "Super crit damage ×"],
    ["bomb_ultra_crit_chance", "Ultra crit chance %"], ["bomb_ultra_crit_damage", "Ultra crit damage ×"],
    ["bomb_omega_crit_chance", "Omega crit chance %"], ["bomb_omega_crit_damage", "Omega crit damage ×"]
  ];
  const DRONE = [
    ["drone_count", "Drones", 1], ["drone_damage_percent", "Damage % of pickaxe"], ["drone_attack_speed_percent", "Attack speed bonus % (+)"],
    ["drone_triple_damage_chance", "Triple damage chance %"], ["drone_rapid_fire_chance", "Rapid fire chance %"]
  ];

  const root = document.getElementById("calcExp");
  if (!root || !window.IOM || !IOM.ORES) return;

  // Nothing here is stored: values and assumptions reset when you leave the page or press Reset.
  let prefs = Object.assign({}, DEFAULTS);
  const savePrefs = () => {};
  try { localStorage.removeItem("iom.calc.exp.v1"); localStorage.removeItem(PREF_KEY); } catch { /* ignore */ }

  let stats = null;        // values the calculator uses (copied from the save, editable here)
  let sourceKey = null;

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
    for (const c of children) if (c != null && c !== false) n.append(c);
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
  const tidy = (n) => typeof n === "number" ? Number(n.toPrecision(12)) : n;
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const pct = (v) => Math.min(Math.max((v || 0) / 100, 0), 1);

  // ---------- model ----------
  // Ores on a floor with their spawn share (wiki: 80%/20% on the first floor of a pair, 50%/50% on the next).
  function oresOnFloor(floor) {
    const split = IOM.FLOOR_ORES && IOM.FLOOR_ORES[floor];
    if (split) return split.map(([name, w]) => Object.assign({ w }, IOM.ORES.find(o => o.name === name))).filter(o => o.name);
    const list = IOM.ORES.filter(o => floor >= o.min && floor <= o.max);
    return list.map(o => Object.assign({ w: 1 / list.length }, o));
  }
  // True when floor f and f+1 share the same two ores (the first floor of a pair).
  function firstOfPair(f) {
    const a = IOM.FLOOR_ORES && IOM.FLOOR_ORES[f], b = IOM.FLOOR_ORES && IOM.FLOOR_ORES[f + 1];
    return !!(a && b && a[0][0] === b[0][0] && a[1][0] === b[1][0]);
  }
  function pickOre(list, rand) {
    let r = rand();
    for (const o of list) { if ((r -= o.w) <= 0) return o; }
    return list[list.length - 1];
  }
  const bombByName = (name) => (IOM.BOMBS || []).find(b => b.name === name) || null;
  const bombMult = (name) => IOM.bombSetup ? IOM.bombSetup.get(name) : { mult: (rawStats && rawStats.bomb_additional_multiplier) || 1, set: false };
  // Ore positions with "Consistent ore position" (pixels, measured from in-game screenshots): two rows of
  // five slanting down to the right, then two more bottom-left. Drone range was measured on the same
  // screenshot: a ~168 px circle at +120% radius, so the base is 168 / 2.2 ≈ 76 px.
  const ORE_LAYOUT = [
    [220, 175], [292, 210], [362, 245], [437, 285], [510, 322],
    [217, 360], [292, 400], [365, 438], [437, 478], [510, 515],
    [220, 555], [297, 590]
  ];
  const DRONE_BASE_RADIUS = 168 / 2.2;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // Last floor of each world (wiki: Floors / Data-JSON-Zones).
  const WORLD_LAST_FLOOR = [0, 42, 72, 102, 132];
  const IMMUNITY = { "super crit+ only": 2, "ultra crit+ only": 3, "omega crit+ only": 4 };

  // Crit chain as cumulative tiers: [chance to reach tier, damage multiplier at tier].
  function critChain(s, prefix) {
    const c = [pct(s[prefix + "crit_chance"]), pct(s[prefix + "super_crit_chance"]), pct(s[prefix + "ultra_crit_chance"]), pct(s[prefix + "omega_crit_chance"])];
    const d = [s[prefix + "crit_damage"] || 1, s[prefix + "super_crit_damage"] || 1, s[prefix + "ultra_crit_damage"] || 1, s[prefix + "omega_crit_damage"] || 1];
    return { c, d };
  }
  // Roll one hit: returns the damage multiplier and leaves the crit tier reached in lastTier.
  let lastTier = 0;
  function roll(chain, rand) {
    let tier = 0, mult = 1;
    while (tier < 4 && rand() < chain.c[tier]) { mult *= chain.d[tier]; tier++; }
    lastTier = tier;
    return mult;
  }

  // Exp Bomb: 2x, +0.5x per Workshop "Exp Bomb Bonus" level (workshop_array[9]); golden (Storm Serpent
  // tribute 1, i.e. tribute level >= 2) triples it. All from the wiki.
  function expBombInfo(raw) {
    const lvl = raw && Array.isArray(raw.workshop_array) ? raw.workshop_array[9] || 0 : 0;
    const golden = raw && Array.isArray(raw.fishing_legendary_tribute_levels_array) && (raw.fishing_legendary_tribute_levels_array[8] || 0) >= 2;
    return { mult: (2 + 0.5 * lvl) * (golden ? 3 : 1), golden, lvl };
  }

  // Plays out prefs.simFloors floors on one floor level, jumping from event to event (pickaxe swing,
  // drone attack, bomb, respawn), and returns the averages.
  function simulate(floor, s, opts) {
    const floorOres = oresOnFloor(floor);
    if (!floorOres.length) return null;
    const rand = rng(1000 + floor * 97);
    const count = Math.max(1, Math.min(Math.round(s.ores_per_screen || 1), ORE_LAYOUT.length));
    const expMulti = s.experience_multi || 1;   // triple rocks give 3x ores (wiki), not more exp

    let speed = s.game_speed_multi || 1;
    for (const o of floorOres) if (o.mod === "game speed" && o.amt) speed *= 1 + o.amt / 100;

    // Damage sources
    const pick = prefs.usePickaxe && (s.pickaxe_attack_speed_per_second || 0) > 0
      ? { period: 1 / s.pickaxe_attack_speed_per_second, dmg: s.pickaxe_damage || 0, chain: critChain(s, "pickaxe_"), next: 0 } : null;
    const droneN = prefs.useDrones ? Math.max(0, Math.round(s.drone_count || 0)) : 0;
    const droneAps = DRONE_BASE_APS * (1 + (s.drone_attack_speed_percent || 0) / 100);   // shown in game as "+100%"
    const drone = droneN && droneAps > 0 ? {
      period: 1 / droneAps,
      dmg: (s.pickaxe_damage || 0) * (s.drone_damage_percent || 0) / 100,
      triple: pct(s.drone_triple_damage_chance), rapid: pct(s.drone_rapid_fire_chance),
      chain: critChain(s, "pickaxe_"),  // drones crit with the pickaxe's crit chances and damages
      radius: DRONE_BASE_RADIUS * (1 + (s.drone_radius_percent || 0) / 100)   // shown in game as "+120%"
    } : null;
    // Which ore positions each position's drone reaches (fixed layout, so worked out once).
    const reach = drone ? ORE_LAYOUT.slice(0, count).map(c => ORE_LAYOUT.slice(0, count).map((p, k) => dist(c, p) <= drone.radius ? k : -1).filter(k => k >= 0)) : null;
    const bombChain = critChain(s, "bomb_");
    const exp = expBombInfo(opts.raw);
    const frameGame = speed / HARE_FPS;    // one rendered frame, in game seconds
    const hare = prefs.manualBomb && prefs.manualMode === "hare";
    const slots = [["auto", prefs.autoBomb, FIRE_INTERVAL], [hare ? "hare" : "slow", prefs.manualBomb, hare ? frameGame : FIRE_INTERVAL],
                   ["chain", prefs.chainActive ? "Chain Bomb" : "", FIRE_INTERVAL]]
      .map(([slot, name, interval]) => ({ slot, bomb: bombByName(name), interval }))
      .filter(x => x.bomb)
      .map(x => ({
        slot: x.slot, interval: x.interval, isExp: x.bomb.name === "Exp Bomb",
        queued: x.slot === "chain",   // an active chain keeps exploding regardless of charges
        dmg: (s.bomb_damage || 0) * bombMult(x.bomb.name).mult,
        rechargeTime: x.bomb.cd / Math.max(s.bomb_recharge_speed || 1, 1e-9),
        next: 0, charge: 0, lastT: 0
      }));
    const free = pct(s.bomb_free_chance);

    if (!pick && !drone && !slots.length) return { floor, floorOres, blocked: "Nothing is breaking ores: turn on the pickaxe, drones, or pick a bomb." };

    const target = Math.max(1, Math.round(opts.floors || prefs.simFloors || 1000));
    const STUCK = 600;   // game seconds without a clear = this setup can't clear the floor
    // Very slow floors would take ages to simulate thousands of times; stop after this much work and
    // average over the floors done so far (the row then says how many).
    const MAX_EVENTS = 400000;
    let events = 0;
    let t = 0, floors = 0, expTotal = 0, expBombFloors = 0, clearTimeSum = 0;
    let ores = [], alive = 0, spawnAt = -1, floorStart = 0, floorMarked = false, lastClear = 0;
    // Drones start where they sit in game: the first and last ore, extra drones spread in between.
    const drones = Array.from({ length: droneN }, (_, i) => ({
      next: 0, target: -1, home: droneN === 1 ? 0 : Math.round(i * (count - 1) / (droneN - 1))
    }));

    function spawn() {
      ores.length = 0;
      for (let k = 0; k < count; k++) {
        const o = pickOre(floorOres, rand);
        ores.push({
          hp: o.mod === "health" && o.amt ? o.hp * (1 + o.amt / 100) : o.hp,
          xp: o.xp, marked: false, alive: true,
          dmgMod: o.mod === "damage" && o.amt ? Math.max(0, 1 + o.amt / 100) : 1,
          bombMod: o.mod === "bomb damage" && o.amt ? Math.max(0, 1 + o.amt / 100) : 1,
          minTier: IMMUNITY[o.mod] || 0
        });
      }
      alive = count; spawnAt = -1; floorStart = t; floorMarked = false;
      for (const d of drones) d.target = -1;
      // Hare fires every frame, including the frame a floor appears (measured in game).
      for (const b of slots) if (b.slot === "hare") b.next = t;
    }
    function hit(o, amount, tier) {
      if (!o.alive || tier < o.minTier || amount <= 0) return;
      o.hp -= amount;
      if (o.hp <= 0) {
        o.alive = false; alive--;
        expTotal += o.xp * expMulti * (o.marked ? exp.mult : 1);
      }
    }
    // While waiting for the next floor, attacks hit nothing: skip ahead keeping the same rhythm.
    const skipTo = (src, at) => { if (src.next < at) src.next += Math.max(1, Math.ceil((at - src.next) / src.period - 1e-9)) * src.period; };

    spawn();
    while (floors < target && events++ < MAX_EVENTS) {
      // Next event
      let nt = spawnAt >= 0 ? spawnAt : Infinity, kind = "spawn", which = null;
      if (pick && pick.next < nt) { nt = pick.next; kind = "pick"; }
      if (drone) for (const d of drones) if (d.next < nt) { nt = d.next; kind = "drone"; which = d; }
      for (const b of slots) if (b.next < nt) { nt = b.next; kind = "bomb"; which = b; }
      t = nt;
      if (t - lastClear > STUCK) break;

      if (kind === "spawn") { spawn(); continue; }
      const mining = spawnAt < 0;
      if (kind === "pick") {
        if (!mining) { skipTo(pick, spawnAt); continue; }
        pick.next += pick.period;
        for (const o of ores) if (o.alive) { const m = roll(pick.chain, rand); hit(o, pick.dmg * m * o.dmgMod, lastTier); }
      } else if (kind === "drone") {
        const d = which;
        if (!mining) { d.period = drone.period; skipTo(d, spawnAt); continue; }
        d.next += drone.period;
        // A drone sits on an ore and hits every alive ore within its radius; when that ore breaks it
        // moves to the nearest alive ore (travel time ignored: the wiki has no move speed).
        if (d.target < 0 || !ores[d.target].alive) {
          const from = ORE_LAYOUT[d.target >= 0 ? d.target : d.home];
          let bestI = -1, bestD = Infinity;
          for (let k = 0; k < count; k++) if (ores[k].alive) { const dd = dist(from, ORE_LAYOUT[k]); if (dd < bestD) { bestD = dd; bestI = k; } }
          d.target = bestI;
        }
        if (d.target >= 0) {
          const shots = rand() < drone.rapid ? 5 : 1;
          for (let n = 0; n < shots; n++) for (const k of reach[d.target]) {
            const o = ores[k];
            if (!o.alive) continue;
            const m = roll(drone.chain, rand);
            hit(o, drone.dmg * m * (rand() < drone.triple ? 3 : 1) * o.dmgMod, lastTier);
          }
        }
      } else {
        const b = which;
        b.next += b.interval;
        if (b.slot === "hare" && !mining) { b.next = spawnAt; continue; }   // next shot lands when the floor appears
        let fires = true;
        if (!prefs.fullBombs && !b.queued) {
          b.charge = Math.min(b.charge + (t - b.lastT) / b.rechargeTime, 1); b.lastT = t;
          if (b.charge >= 1) { if (rand() >= free) b.charge -= 1; } else fires = false;
        }
        // Bombs keep firing on their own clock; one fired while no floor is up is wasted.
        if (fires && mining) {
          for (const o of ores) {
            if (!o.alive) continue;
            if (b.isExp && !o.marked) { o.marked = true; floorMarked = true; }
            const m = roll(bombChain, rand);
            hit(o, b.dmg * m * o.bombMod, lastTier);
          }
        }
      }
      if (mining && alive === 0) {
        floors++; clearTimeSum += t - floorStart; if (floorMarked) expBombFloors++;
        lastClear = t; spawnAt = t + RESPAWN_WAIT;
      }
    }

    if (floors === 0) return { floor, floorOres, count, speed, floors, blocked: "Not a single floor could be cleared: the ores here are too tough for your current setup." };
    const realMinutes = t / speed / 60;   // game speed scales everything equally (2x speed = 2x result)
    return {
      floor, floorOres, count, speed, floors, events, simTime: t,
      fpm: floors / realMinutes, xpm: expTotal / realMinutes, capped: floors < target,
      expPerFloor: expTotal / floors, clearTime: clearTimeSum / floors,
      expBombShare: expBombFloors / floors, exp, slots, blocked: null
    };
  }

  // ---------- rendering ----------
  // Ore picture from the wiki; the name shows on hover, or as text if the picture can't load.
  function oreIcon(o) {
    const label = `${o.name} Ore · ${fmt(o.xp)} exp${o.mod ? " · " + o.mod + (o.amt != null ? " " + o.amt + "%" : "") : ""}`;
    const wrap = el("span", { class: "ore-icon", title: label });
    if (o.img) {
      const img = el("img", { src: o.img, alt: o.name, loading: "lazy" });
      img.addEventListener("error", () => { img.remove(); wrap.textContent = o.name; wrap.classList.add("noimg"); }, { once: true });
      wrap.append(img);
    } else { wrap.textContent = o.name; wrap.classList.add("noimg"); }
    return wrap;
  }
  function numberInput(key, label, step) {
    const input = el("input", { type: "number", inputmode: "decimal", step: step || "any", value: tidy(stats[key] ?? 0), id: "ce-" + key });
    input.addEventListener("input", () => { const v = parseFloat(input.value); if (isFinite(v)) { stats[key] = v; schedule(); } });
    return el("label", { class: "field", for: "ce-" + key }, el("span", { text: label }), input);
  }
  function prefNumber(key, label, attrs = {}) {
    const input = el("input", Object.assign({ type: "number", step: "any", value: prefs[key], id: "ce-p-" + key }, attrs));
    input.addEventListener("input", () => { prefs[key] = parseFloat(input.value) || 0; savePrefs(); schedule(); });
    return el("label", { class: "field", for: "ce-p-" + key }, el("span", { text: label }), input);
  }
  function checkbox(key, label, onChange) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!prefs[key];
    cb.addEventListener("change", () => { prefs[key] = cb.checked; savePrefs(); if (onChange) onChange(); schedule(); });
    return el("label", { class: "check" }, cb, document.createTextNode(" " + label));
  }
  function group(title, ...children) { return el("fieldset", { class: "calc-group" }, el("legend", { text: title }), ...children); }
  function fieldGrid(fields) { return el("div", { class: "field-grid" }, ...fields.map(([k, l, st]) => numberInput(k, l, st))); }
  // Values taken from the save, folded away by default so the choices above them stand out.
  function saveValues(fields, label) {
    return el("details", { class: "save-values" },
      el("summary", { class: "small", text: `${label || "Values from your save"} (${fields.length})` }),
      fieldGrid(fields));
  }
  function bombSlot(slot, label, extra) {
    const key = { auto: "autoBomb", manual: "manualBomb" }[slot];
    const select = el("select", { id: "ce-" + key },
      el("option", { value: "", text: "None" }),
      ...(IOM.BOMBS || []).map(b => el("option", { value: b.name, text: `${b.name} (${b.cd}s base)` })));
    select.value = prefs[key];
    select.addEventListener("change", () => { prefs[key] = select.value; savePrefs(); schedule(); });
    const note = el("span", { class: "muted small bomb-mult-note" });
    const showNote = () => {
      if (!select.value) { note.textContent = ""; return; }
      const m = bombMult(select.value);
      note.textContent = m.set ? `Multiplier ${fmt(m.mult)}× (from your bomb setup)`
                               : `Multiplier ${fmt(m.mult)}× is the export's shared value. Enter this bomb's real “×” under Savefiles → Bomb setup.`;
    };
    select.addEventListener("change", showNote);
    showNote();
    noteUpdaters.push(showNote);
    return el("div", { class: "bomb-slot" },
      extra || null, el("label", { class: "field", for: "ce-" + key }, el("span", { text: label }), select), note);
  }
  // Chain Bomb: while queued chain bombs remain, one explodes every 1.25 s on its own clock.
  function chainToggle() {
    const note = el("span", { class: "muted small bomb-mult-note" });
    const showNote = () => {
      if (!prefs.chainActive) { note.textContent = ""; return; }
      const m = bombMult("Chain Bomb");
      note.textContent = m.set ? `Multiplier ${fmt(m.mult)}× (from your bomb setup)`
                               : `Multiplier ${fmt(m.mult)}× is the export's shared value. Enter the Chain Bomb's real “×” under Savefiles → Bomb setup.`;
    };
    noteUpdaters.push(showNote);
    const box = el("div", { class: "bomb-slot" },
      checkbox("chainActive", "Chain Bomb active (queued chain bombs explode one every 1.25 s)", showNote), note);
    showNote();
    return box;
  }
  // Turtle (Fire Slow, every 1.25 s) / hare (Fire held down, every frame) switch, like the in-game buttons.
  function modeSwitch() {
    const input = el("input", { type: "checkbox", role: "switch", id: "ce-hare", "aria-label": "Hare mode: fire every frame" });
    input.checked = prefs.manualMode === "hare";
    const caption = el("span", { class: "muted small" });
    const sync = () => {
      caption.textContent = input.checked ? "Fire, held down: a bomb every frame" : "Fire Slow: a bomb every 1.25 s";
    };
    input.addEventListener("change", () => { prefs.manualMode = input.checked ? "hare" : "slow"; sync(); schedule(); });
    sync();
    return el("div", { class: "mode-switch" },
      el("label", { class: "switch icon-switch", for: "ce-hare", title: "Turtle: Fire Slow · Hare: Fire, held down" }, input,
        el("span", { class: "slider" },
          el("span", { class: "si si-left", text: "🐢" }),
          el("span", { class: "si si-right", text: "🐇" }))),
      caption);
  }

  function buildForm(raw) {
    noteUpdaters.length = 0;
    const exp = expBombInfo(raw);
    // Drones crit with the pickaxe's crit stats, so these values matter when either is on.
    const pickBox = saveValues(PICK, "Pickaxe values from your save (also used for drone crits)");
    const syncPick = () => { pickBox.hidden = !prefs.usePickaxe && !prefs.useDrones; };
    syncPick();
    const droneBox = saveValues(DRONE, "Drone values from your save"); droneBox.hidden = !prefs.useDrones;

    $("#ce-form").replaceChildren(
      el("div", { class: "calc-intro" },
        el("p", { class: "muted small", text: "Values come from the current save. Change any of them to try a what-if; nothing here is saved, and everything resets when you leave this page." }),
        el("button", { type: "button", class: "btn small", text: "↺ Reset to defaults", onclick: () => { IOM.calcExp.reset(); IOM.calcExp.render(currentData); } })),
      group("General", saveValues(GENERAL)),
      group("Pickaxe", checkbox("usePickaxe", "Use pickaxe (assumes every swing hits every ore at once)", syncPick), pickBox),
      group("Drones",
        checkbox("useDrones", "Use drones", () => { droneBox.hidden = !prefs.useDrones; syncPick(); }),
        el("p", { class: "muted small", text: "Each drone hits every ore within its radius (measured in game: at +120% it reaches its own ore and the nearest neighbours). When its ore breaks it moves to the nearest one; travel time is ignored. Drones crit with your pickaxe crit chances and damages." }),
        droneBox),
      group("Bombs",
        bombSlot("auto", "Auto-Bomber (fires every 1.25 s)"),
        bombSlot("manual", "Manual fire", modeSwitch()),
        chainToggle(),
        checkbox("fullBombs", "Assume full bombs (stored charges, so bombs fire every 1.25 s; off = only as fast as they recharge)"),
        el("p", { class: "muted small", text: `Exp Bomb: marked ores give ${fmt(exp.mult)}× exp (2× + 0.5× per Workshop “Exp Bomb Bonus” level, you have ${exp.lvl}${exp.golden ? "; golden from Storm Serpent tribute: ×3" : ""}). Bombs hit every ore on screen.` }),
        saveValues(BOMB, "Bomb values from your save")),
      simBar()
    );
  }

  // Settings changed: nothing recalculates until Simulate is pressed. Stop a running simulation and
  // mark any shown results as out of date.
  function schedule() {
    runId++;
    if ($("#ce-table").querySelector("table")) {
      $("#ce-stale").hidden = false;
    }
  }

  function simBar() {
    const input = el("input", { type: "number", min: "100", step: "100", value: prefs.simFloors, id: "ce-simfloors", inputmode: "numeric" });
    input.addEventListener("input", () => { const v = parseInt(input.value, 10); if (v > 0) { prefs.simFloors = v; schedule(); } });
    return el("div", { class: "sim-bar" },
      el("label", { class: "field", for: "ce-simfloors" }, el("span", { text: "Floors to simulate per floor level" }), input),
      el("button", { type: "button", class: "btn primary", text: "▶ Simulate", onclick: compute }),
      el("p", { class: "warning", id: "ce-stale", hidden: true, text: "Settings changed: press Simulate to update the results below." }));
  }

  let rawStats = null;
  const noteUpdaters = [];
  function floorTable(rows, best) {
    return el("div", { class: "table-wrap" },
      el("table", { class: "calc-table" },
        el("thead", {}, el("tr", {}, ...["Floor", "Ores", "Exp/floor", "Floors/min", "Exp/min"].map(h => el("th", { text: h })))),
        el("tbody", {}, ...rows.map(e => el("tr", { class: (e === best ? "best" : "") + (e.blocked ? " blocked" : ""),
          title: e.blocked || (e.capped ? `Slow floor: averaged over ${e.floors.toLocaleString()} simulated floors` : null) },
          el("td", { text: String(e.floor) + (e.capped ? " *" : "") }),
          el("td", { class: "ore-cell" }, ...e.floorOres.map(oreIcon)),
          el("td", { text: e.blocked ? "0" : fmt(e.expPerFloor) }),
          el("td", { text: e.blocked ? "0" : fmt(e.fpm) }),
          el("td", { text: e.blocked ? "0" : fmt(e.xpm) }))))));
  }

  let runId = 0;
  // Works through the floors one per tick so the page stays responsive; a newer run cancels this one.
  function compute() {
    const run = ++runId;
    $("#ce-stale").hidden = true;
    // Start at floor 1 and go up, tracking the best floor. Stop once three floors in a row are lower than
    // the best (by at least 10%, so near-ties don't count), or at the last floor of the unlocked worlds.
    const LOWER_BY = 0.10;
    const worlds = Math.max(1, Math.min(4, Math.round((rawStats && rawStats.worlds_unlocked) || 1)));
    const lastFloor = WORLD_LAST_FLOOR[worlds];
    const rows = [];
    let best = null, sinceBest = 0, f = 1;

    const status = el("p", { class: "muted small" });
    $("#ce-results").replaceChildren(el("h3", { text: "Best floor" }), status);
    $("#ce-table").replaceChildren();

    function step() {
      if (run !== runId) return;
      const started = performance.now();
      let done = false;
      while (!done && performance.now() - started < 40) {
        if (f > lastFloor) { done = true; break; }
        const e = simulate(f, stats, { raw: rawStats });
        if (e) {
          rows.push(e);
          const xpm = e.blocked ? 0 : e.xpm;
          if (!best || xpm > best.xpm) { if (!e.blocked) best = e; sinceBest = 0; }
          else if (xpm <= best.xpm * (1 - LOWER_BY)) {
            // Never stop on the first floor of a pair: the next floor has the same ores, with more of the
            // better one, so it's usually at least as good.
            if (++sinceBest >= 3 && !firstOfPair(f)) done = true;
          }
          else sinceBest = 0;   // about as good as the best: not "lower", keep looking
        }
        f++;
      }
      if (!done) {
        status.textContent = `Simulating ${prefs.simFloors.toLocaleString()} floors per floor level… floor ${f - 1}`;
        setTimeout(step, 0);
        return;
      }
      const shown = rows.slice().reverse();   // highest floor on top
      if (!best) {
        const why = rows.find(e => e.blocked);
        $("#ce-results").replaceChildren(el("p", { class: "warning", text: "⚠️ " + (why ? why.blocked : "No floor can be cleared with this setup.") }));
      } else {
        $("#ce-results").replaceChildren(el("h3", { text: "Best floor" }), floorTable([best], best));
      }
      $("#ce-table").replaceChildren(el("h3", { text: "All checked floors" }),
        el("p", { class: "muted small", text: `Each row is the average of ${prefs.simFloors.toLocaleString()} simulated floors.` +
          (rows.some(e => e.capped) ? " Floors marked * clear so slowly that fewer were simulated (hover for the number)." : "") }),
        floorTable(shown, best));
    }
    step();
  }

  let currentData = null;
  IOM.calcExp = {
    simulate: (floor, overrides) => simulate(floor, Object.assign({}, stats, overrides), { raw: rawStats }),   // for testing
    // Forget every what-if value and assumption; the next render starts from the save again.
    reset() { sourceKey = null; prefs = Object.assign({}, DEFAULTS); },
    // Bomb setup changed on the Savefiles page.
    refresh() { if (stats) { noteUpdaters.forEach(f => f()); schedule(); } },
    render(data) {
      currentData = data;
      if (!data || !data.stats) return;
      const key = JSON.stringify([data.time, data.version, data.stats.current_floor, data.stats.experience_multi, data.stats.pickaxe_damage]);
      if (key !== sourceKey) {
        sourceKey = key;
        rawStats = data.stats;
        stats = {};
        for (const [k] of [...GENERAL, ...PICK, ...BOMB, ...DRONE]) stats[k] = data.stats[k];
        buildForm(data.stats);
        runId++;
        $("#ce-results").replaceChildren(el("p", { class: "muted small", text: "Choose your setup, then press Simulate." }));
        $("#ce-table").replaceChildren();
      }
    }
  };
})();
