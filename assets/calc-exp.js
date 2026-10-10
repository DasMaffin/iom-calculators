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
  let DT = 0.02;                      // simulation step, game seconds (smaller when hare fires every frame)
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

    fullBombs: true,          // bombs fire every 1.25 s from stored charges; off = limited by recharge

  };
  const GENERAL = [
    ["current_floor", "Floor", 1], ["experience_multi", "Exp multi"], ["game_speed_multi", "Game speed"],
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
    ["drone_count", "Drones", 1], ["drone_damage_percent", "Damage % of pickaxe"], ["drone_attack_speed_percent", "Attack speed %"],
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
  let timer = null;

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
  const oresOnFloor = (floor) => IOM.ORES.filter(o => floor >= o.min && floor <= o.max);
  const bombByName = (name) => (IOM.BOMBS || []).find(b => b.name === name) || null;
  const bombMult = (name) => IOM.bombSetup ? IOM.bombSetup.get(name) : { mult: (rawStats && rawStats.bomb_additional_multiplier) || 1, set: false };
  const IMMUNITY = { "super crit+ only": 2, "ultra crit+ only": 3, "omega crit+ only": 4 };

  // Crit chain as cumulative tiers: [chance to reach tier, damage multiplier at tier].
  function critChain(s, prefix) {
    const c = [pct(s[prefix + "crit_chance"]), pct(s[prefix + "super_crit_chance"]), pct(s[prefix + "ultra_crit_chance"]), pct(s[prefix + "omega_crit_chance"])];
    const d = [s[prefix + "crit_damage"] || 1, s[prefix + "super_crit_damage"] || 1, s[prefix + "ultra_crit_damage"] || 1, s[prefix + "omega_crit_damage"] || 1];
    return { c, d };
  }
  // Roll one hit: returns [tier, multiplier].
  function roll(chain, rand) {
    let tier = 0, mult = 1;
    while (tier < 4 && rand() < chain.c[tier]) { mult *= chain.d[tier]; tier++; }
    return [tier, mult];
  }

  // Exp Bomb: 2x, +0.5x per Workshop "Exp Bomb Bonus" level (workshop_array[9]); golden (Storm Serpent
  // tribute 1, i.e. tribute level >= 2) triples it. All from the wiki.
  function expBombInfo(raw) {
    const lvl = raw && Array.isArray(raw.workshop_array) ? raw.workshop_array[9] || 0 : 0;
    const golden = raw && Array.isArray(raw.fishing_legendary_tribute_levels_array) && (raw.fishing_legendary_tribute_levels_array[8] || 0) >= 2;
    return { mult: (2 + 0.5 * lvl) * (golden ? 3 : 1), golden, lvl };
  }

  function simulate(floor, s, opts) {
    const floorOres = oresOnFloor(floor);
    if (!floorOres.length) return null;
    const rand = rng(1000 + floor * 97);
    const count = Math.max(1, Math.round(s.ores_per_screen || 1));
    const expMulti = s.experience_multi || 1;   // triple rocks give 3x ores (wiki), not more exp

    let speed = s.game_speed_multi || 1;
    for (const o of floorOres) if (o.mod === "game speed" && o.amt) speed *= 1 + o.amt / 100;
    const scale = speed;   // game speed scales everything equally (2x speed = 2x result)

    // Damage sources
    const pick = prefs.usePickaxe ? { aps: s.pickaxe_attack_speed_per_second || 0, dmg: s.pickaxe_damage || 0, chain: critChain(s, "pickaxe_") } : null;
    const droneN = prefs.useDrones ? Math.max(0, Math.round(s.drone_count || 0)) : 0;
    const drone = droneN ? {
      aps: DRONE_BASE_APS * (s.drone_attack_speed_percent || 0) / 100,
      dmg: (s.pickaxe_damage || 0) * (s.drone_damage_percent || 0) / 100,
      triple: pct(s.drone_triple_damage_chance), rapid: pct(s.drone_rapid_fire_chance)
    } : null;
    const bombChain = critChain(s, "bomb_");
    const exp = expBombInfo(opts.raw);
    const frameGame = speed / HARE_FPS;    // one rendered frame, in game seconds
    const hare = prefs.manualBomb && prefs.manualMode === "hare";
    DT = hare ? Math.min(0.02, frameGame / 2) : 0.02;
    const slots = [["auto", prefs.autoBomb, FIRE_INTERVAL], [hare ? "hare" : "slow", prefs.manualBomb, hare ? frameGame : FIRE_INTERVAL]]
      .map(([slot, name, interval]) => ({ slot, bomb: bombByName(name), interval }))
      .filter(x => x.bomb)
      .map(x => ({
        name: x.bomb.name,
        slot: x.slot,
        interval: x.interval,
        isExp: x.bomb.name === "Exp Bomb",
        dmg: (s.bomb_damage || 0) * bombMult(x.bomb.name).mult,
        rechargeTime: x.bomb.cd / Math.max(s.bomb_recharge_speed || 1, 1e-9),
        timer: 0, charge: 0
      }));
    const free = pct(s.bomb_free_chance);

    if (!pick && !drone && !slots.length) return { floor, floorOres, blocked: "Nothing is breaking ores: turn on the pickaxe, drones, or pick a bomb." };

    const T = opts.duration;
    let t = 0, floors = 0, expTotal = 0, expBombFloors = 0, clearTimeSum = 0;
    let ores = [], waiting = 0, floorStart = 0, floorMarked = false;
    const pending = [];   // bomb explosions: { at, dmg, isExp }
    const drones = Array.from({ length: droneN }, () => ({ timer: 0, target: -1 }));

    function spawn() {
      ores = [];
      for (let i = 0; i < count; i++) {
        const o = floorOres[Math.floor(rand() * floorOres.length)];
        ores.push({
          hp: o.mod === "health" && o.amt ? o.hp * (1 + o.amt / 100) : o.hp,
          xp: o.xp, marked: false, alive: true,
          dmgMod: o.mod === "damage" && o.amt ? Math.max(0, 1 + o.amt / 100) : 1,
          bombMod: o.mod === "bomb damage" && o.amt ? Math.max(0, 1 + o.amt / 100) : 1,
          minTier: IMMUNITY[o.mod] || 0
        });
      }
      floorStart = t; floorMarked = false;
      // Hare fires every frame, including the frame a floor appears (measured: the bomb lands on the
      // spawn frame and floors come exactly 1 game second apart).
      for (const b of slots) if (b.slot === "hare") b.timer = b.interval;
    }
    function hit(o, amount, tier) {
      if (!o.alive || tier < o.minTier || amount <= 0) return;
      o.hp -= amount;
      if (o.hp <= 0) { o.alive = false; expTotal += o.xp * expMulti * (o.marked ? exp.mult : 1); }
    }
    spawn();

    while (t < T) {
      const mining = waiting <= 0;
      if (mining) {
        if (pick && pick.aps > 0) {
          pick.timer = (pick.timer || 0) + DT * pick.aps;
          while (pick.timer >= 1) {
            pick.timer -= 1;
            for (const o of ores) { if (!o.alive) continue; const [tier, m] = roll(pick.chain, rand); hit(o, pick.dmg * m * o.dmgMod, tier); }
          }
        }
        if (drone) {
          for (const d of drones) {
            d.timer += DT * drone.aps;
            while (d.timer >= 1) {
              d.timer -= 1;
              // Each drone works on one ore at a time (the wiki doesn't describe radius or targeting).
              if (d.target < 0 || !ores[d.target].alive) {
                const taken = new Set(drones.map(x => x.target));
                d.target = ores.findIndex((o, i) => o.alive && !taken.has(i));
                if (d.target < 0) d.target = ores.findIndex(o => o.alive);
              }
              if (d.target < 0) break;
              const shots = rand() < drone.rapid ? 5 : 1;
              for (let k = 0; k < shots; k++) hit(ores[d.target], drone.dmg * (rand() < drone.triple ? 3 : 1) * ores[d.target].dmgMod, 0);
            }
          }
        }
      }
      // Bombs keep firing on their own clock, even while the next floor hasn't spawned (those are wasted).
      for (const b of slots) {
        if (!prefs.fullBombs) b.charge = Math.min(b.charge + DT / b.rechargeTime, 1);
        b.timer += DT;
        if (b.timer >= b.interval) {
          b.timer -= b.interval;
          if (prefs.fullBombs || b.charge >= 1) {
            if (!prefs.fullBombs && rand() >= free) b.charge -= 1;
            pending.push({ at: t + BOMB_DELAY, dmg: b.dmg, isExp: b.isExp });
          }
        }
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].at > t) continue;
        const p = pending.splice(i, 1)[0];
        if (waiting > 0) continue;
        for (const o of ores) {
          if (!o.alive) continue;
          if (p.isExp && !o.marked) { o.marked = true; floorMarked = true; }
          const [tier, m] = roll(bombChain, rand);
          hit(o, p.dmg * m * o.bombMod, tier);
        }
      }

      if (waiting <= 0 && ores.every(o => !o.alive)) {
        floors++; clearTimeSum += t - floorStart; if (floorMarked) expBombFloors++;
        waiting = RESPAWN_WAIT;
      }
      t += DT;
      if (waiting > 0) { waiting -= DT; if (waiting <= 0) spawn(); }
      if (opts.minFloors && floors >= opts.minFloors && t >= opts.minDuration) break;
    }

    const realMinutes = t / scale / 60;
    const fpm = floors / realMinutes, xpm = expTotal / realMinutes;
    return {
      floor, floorOres, count, speed, floors, fpm, xpm,
      expPerFloor: floors ? expTotal / floors : 0,
      clearTime: floors ? clearTimeSum / floors : Infinity,
      expBombShare: floors ? expBombFloors / floors : 0,
      exp, slots, blocked: floors === 0 ? "Not a single floor was cleared in the simulated time: the ores here are too tough for your current setup." : null
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
      el("label", { class: "field", for: "ce-" + key }, el("span", { text: label }), select), extra || null, note);
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
      el("span", { class: "mode-icon", title: "Fire Slow (turtle)", text: "🐢" }),
      el("label", { class: "switch", for: "ce-hare" }, input, el("span", { class: "slider" })),
      el("span", { class: "mode-icon", title: "Fire, held down (hare)", text: "🐇" }),
      caption);
  }

  function buildForm(raw) {
    noteUpdaters.length = 0;
    const exp = expBombInfo(raw);
    const pickBox = saveValues(PICK, "Pickaxe values from your save"); pickBox.hidden = !prefs.usePickaxe;
    const droneBox = saveValues(DRONE, "Drone values from your save"); droneBox.hidden = !prefs.useDrones;

    $("#ce-form").replaceChildren(
      el("div", { class: "calc-intro" },
        el("p", { class: "muted small", text: "Values come from the current save. Change any of them to try a what-if; nothing here is saved, and everything resets when you leave this page." }),
        el("button", { type: "button", class: "btn small", text: "↺ Reset to defaults", onclick: () => { IOM.calcExp.reset(); IOM.calcExp.render(currentData); } })),
      group("General", saveValues(GENERAL)),
      group("Pickaxe", checkbox("usePickaxe", "Use pickaxe (assumes every swing hits every ore at once)", () => { pickBox.hidden = !prefs.usePickaxe; }), pickBox),
      group("Drones",
        checkbox("useDrones", "Use drones", () => { droneBox.hidden = !prefs.useDrones; }),
        el("p", { class: "muted small", text: "Each drone works on one ore at a time and moves to the next when it breaks; travel time is ignored. The wiki doesn't give drone radius or targeting, so ores in range of a drone's splash aren't counted." }),
        droneBox),
      group("Bombs",
        bombSlot("auto", "Auto-Bomber (fires every 1.25 s)"),
        bombSlot("manual", "Manual fire", modeSwitch()),
        checkbox("fullBombs", "Assume full bombs (stored charges, so bombs fire every 1.25 s; off = only as fast as they recharge)"),
        el("p", { class: "muted small", text: `Exp Bomb: marked ores give ${fmt(exp.mult)}× exp (2× + 0.5× per Workshop “Exp Bomb Bonus” level, you have ${exp.lvl}${exp.golden ? "; golden from Storm Serpent tribute: ×3" : ""}). Bombs hit every ore on screen.` }),
        saveValues(BOMB, "Bomb values from your save")),
      group("Timing",
        el("p", { class: "muted small", text: "After a floor is cleared the next one spawns 1 game second later. Bombs hit the moment they're fired; hare even on the frame a floor appears. Auto-Bomber and Fire Slow fire every 1.25 s, so a new floor can wait up to 0.25 s for their next shot. Game speed speeds all of it up equally." }))
    );
  }

  // Recompute shortly after typing stops; the simulation takes a moment for the floor table.
  function schedule() { clearTimeout(timer); timer = setTimeout(compute, 120); }

  let rawStats = null;
  const noteUpdaters = [];
  function compute() {
    const floor = Math.round(stats.current_floor || 1);
    const r = simulate(floor, stats, { raw: rawStats, duration: 3600, minDuration: 180, minFloors: 300 });
    const out = $("#ce-results");
    if (!r) { out.replaceChildren(el("p", { class: "warning", text: `No ore data for floor ${floor}.` })); $("#ce-table").replaceChildren(); return; }
    const tile = (label, value, sub) => el("div", { class: "tile" },
      el("div", { class: "t-label", text: label }), el("div", { class: "t-value", text: value }), sub ? el("div", { class: "t-sub", text: sub }) : null);

    if (r.blocked) {
      out.replaceChildren(el("p", { class: "warning", text: "⚠️ " + r.blocked }));
    } else {
      const hasExpBomb = r.slots.some(b => b.isExp);
      out.replaceChildren(
        el("div", { class: "overview" },
          tile("Exp / minute", fmt(r.xpm)),
          tile("Exp / hour", fmt(r.xpm * 60)),
          tile("Floors / minute", fmt(r.fpm), `${fmt(60 / r.fpm)} s per floor`),
          tile("Exp per floor", fmt(r.expPerFloor), hasExpBomb ? "includes Exp Bomb marks" : `${r.count} ores × your exp multi`),
          tile("Time to clear", fmt(r.clearTime) + " s", "game seconds, before the respawn wait"),
          hasExpBomb ? tile("Floors hit by Exp Bomb", Math.round(r.expBombShare * 100) + "%", `${fmt(r.exp.mult)}× exp on those`) : null)

      );
    }

    // Walk down from your floor; stop once exp/min has dropped three floors in a row.
    const rows = [];
    let drops = 0, stoppedAt = null, prev = null;
    for (let f = floor; f >= 1; f--) {
      const e = f === floor ? r : simulate(f, stats, { raw: rawStats, duration: 600, minDuration: 60, minFloors: 60 });
      if (!e || e.blocked) continue;
      rows.push(e);
      if (prev) {
        drops = e.xpm < prev.xpm ? drops + 1 : 0;
        if (drops >= 3) { stoppedAt = f; break; }
      }
      prev = e;
    }
    const best = rows.reduce((a, b) => (b.xpm > (a ? a.xpm : -1) ? b : a), null);
    $("#ce-table").replaceChildren(
      el("h3", { text: "Floors from yours downward" }),
      best ? el("p", { class: "small", text: `Best floor for exp with this setup: ${best.floor} (${fmt(best.xpm)} exp/min).` +
        (stoppedAt ? ` Stopped at floor ${stoppedAt}: exp/min dropped three floors in a row, so lower floors aren't checked.` : "") }) : el("p", { class: "small", text: "No floor can be cleared with this setup." }),
      el("div", { class: "table-wrap" },
        el("table", { class: "calc-table" },
          el("thead", {}, el("tr", {}, ...["Floor", "Ores", "Exp/floor", "Floors/min", "Exp/min"].map(h => el("th", { text: h })))),
          el("tbody", {}, ...rows.map(e => el("tr", { class: (e === best ? "best" : "") + (e.floor === floor ? " current" : "") },
            el("td", { text: String(e.floor) }),
            el("td", { class: "ore-cell" }, ...e.floorOres.map(oreIcon)),
            el("td", { text: fmt(e.expPerFloor) }),
            el("td", { text: fmt(e.fpm) }),
            el("td", { text: fmt(e.xpm) })))))));
  }

  let currentData = null;
  IOM.calcExp = {
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
        compute();
      }
    }
  };
})();
