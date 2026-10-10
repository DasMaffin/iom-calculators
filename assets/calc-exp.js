// Experience calculator: statistical exp per minute from mining, using the imported stats.
// It simulates a few game-minutes in small time steps: a floor of ores spawns, the pickaxe (optional),
// drones and bombs damage it, broken ores give exp, then the respawn wait runs and the next floor spawns.
// Known values come from the wiki (ore exp/health/modifiers, bomb cooldowns, 1.25 s Auto-Bomber/Fire Slow,
// 0.25 s bomb delay, 1 s respawn check, drone base 1.25 attacks/s). What the wiki doesn't give is either
// simplified (see notes on the page) or an assumption the player can switch.
(function () {
  "use strict";

  const PREF_KEY = "iom.calc.exp.v2";
  const DEFAULTS = {
    usePickaxe: false,
    useDrones: true,
    autoBomb: "",
    manualBomb: "",
    manualMode: "slow",       // "slow" = Fire Slow / turtle (every 1.25 s), "hare" = Fire held down (every frame)
    chainActive: false,
    simFloors: 1000,
    planBy: "gain",           // contract planner ranking: "gain" (highest exp/min) or "perPoint"          // floors simulated per floor level; more = steadier averages, slower       // queued chain bombs explode one every 1.25 s; the queue size only sets how long

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

  // ---------- model (the simulation itself is in sim-core.js) ----------
  // True when floor f and f+1 share the same two ores (the first floor of a pair).
  function firstOfPair(f) {
    const a = IOM.FLOOR_ORES && IOM.FLOOR_ORES[f], b = IOM.FLOOR_ORES && IOM.FLOOR_ORES[f + 1];
    return !!(a && b && a[0][0] === b[0][0] && a[1][0] === b[1][0]);
  }
  // Last floor of each world (wiki: Floors / Data-JSON-Zones).
  const WORLD_LAST_FLOOR = [0, 42, 72, 102, 132];

  const bombMult = (name) => IOM.bombSetup ? IOM.bombSetup.get(name) : { mult: (rawStats && rawStats.bomb_additional_multiplier) || 1, set: false };

  // Exp Bomb: 2x, +0.5x per Workshop "Exp Bomb Bonus" level (workshop_array[9]); golden (Storm Serpent
  // tribute 1, i.e. tribute level >= 2) triples it. All from the wiki.
  function expBombInfo(raw) {
    const lvl = raw && Array.isArray(raw.workshop_array) ? raw.workshop_array[9] || 0 : 0;
    const golden = raw && Array.isArray(raw.fishing_legendary_tribute_levels_array) && (raw.fishing_legendary_tribute_levels_array[8] || 0) >= 2;
    return { mult: (2 + 0.5 * lvl) * (golden ? 3 : 1), golden, lvl };
  }

  // What the simulation needs besides the stats (plain data, so it can be sent to a worker).
  function simConfig() {
    const bombMults = {};
    for (const b of IOM.BOMBS || []) bombMults[b.name] = bombMult(b.name).mult;
    return {
      usePickaxe: prefs.usePickaxe, useDrones: prefs.useDrones, autoBomb: prefs.autoBomb, manualBomb: prefs.manualBomb,
      manualMode: prefs.manualMode, chainActive: prefs.chainActive, fullBombs: prefs.fullBombs, simFloors: prefs.simFloors,
      bombMults, exp: expBombInfo(rawStats)
    };
  }
  const simulate = (floor, s) => IOMSim.simulate(floor, s, simConfig());   // on the page (tests, fallback)

  // Worker pool: floors are independent, so several are simulated at once on different CPU cores.
  const VERSION = ((document.querySelector('script[src*="calc-exp.js"]') || {}).src || "").split("v=")[1] || "";
  let pool = null;
  function getPool() {
    if (pool !== null) return pool;
    pool = false;
    try {
      const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
      const workers = [];
      for (let i = 0; i < n; i++) workers.push(new Worker(`assets/sim-worker.js?v=${VERSION}`));
      const pending = new Map();
      let nextId = 1;
      workers.forEach(w => {
        w.onmessage = (e) => { const job = pending.get(e.data.id); if (!job) return; pending.delete(e.data.id); w.busy = false;
          e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data.result); drain(); };
        w.onerror = () => { pool = false; };
      });
      const queue = [];
      function drain() {
        for (const w of workers) {
          if (w.busy || !queue.length) continue;
          const job = queue.shift(); w.busy = true; pending.set(job.id, job);
          w.postMessage({ id: job.id, floor: job.floor, stats: job.stats, cfg: job.cfg });
        }
      }
      pool = {
        size: n,
        run(floor, stats, cfg) { return new Promise((resolve, reject) => { queue.push({ id: nextId++, floor, stats, cfg, resolve, reject }); drain(); }); },
        clear() { queue.length = 0; }
      };
    } catch { pool = false; }
    return pool;
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
    buildPlanner();
  }

  // Settings changed: nothing recalculates until Simulate is pressed. Stop a running simulation and
  // mark any shown results as out of date.
  function schedule() {
    runId++;
    if ($("#ce-table").querySelector("table")) {
      $("#ce-stale").hidden = false;
    }
  }

  function buildPlanner() {
    // The planner's answer appears under the Simulate row; its controls live in that row (see simBar).
    $("#ce-planner").replaceChildren(el("div", { id: "ce-plan" }));
  }
  function planControls() {
    const by = el("select", { id: "ce-planby" },
      el("option", { value: "gain", text: "Highest exp/min" }),
      el("option", { value: "perPoint", text: "Most exp/min per contract point" }));
    by.value = prefs.planBy;
    by.addEventListener("change", () => { prefs.planBy = by.value; });
    return el("div", { class: "plan-controls" },
      el("label", { class: "field", for: "ce-planby" }, el("span", { text: "Contract planner: best means" }), by),
      el("button", { type: "button", class: "btn", text: "📜 Plan contract upgrade",
        title: "Simulate each contract upgrade one level higher (with any earlier upgrades it needs) and suggest the best one",
        onclick: planContracts }));
  }
  function simBar() {
    const input = el("input", { type: "number", min: "100", step: "100", value: prefs.simFloors, id: "ce-simfloors", inputmode: "numeric" });
    input.addEventListener("input", () => { const v = parseInt(input.value, 10); if (v > 0) { prefs.simFloors = v; schedule(); } });
    return el("div", { class: "sim-bar" },
      el("label", { class: "field", for: "ce-simfloors" }, el("span", { text: "Floors to simulate per floor level" }), input),
      el("button", { type: "button", class: "btn primary", text: "▶ Simulate", onclick: compute }),
      planControls(),
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
  // Finds the best floor for a set of stats: start at floor 1 and go up, tracking the best floor; stop once
  // three floors in a row are lower than the best (by at least 10%, so near-ties don't count), or at the last
  // floor of the unlocked worlds. Works in small chunks so the page stays responsive.
  function searchFloors(statsObj, run, onProgress) {
    const LOWER_BY = 0.10;
    const worlds = Math.max(1, Math.min(4, Math.round((rawStats && rawStats.worlds_unlocked) || 1)));
    const lastFloor = WORLD_LAST_FLOOR[worlds];
    const cfg = simConfig();
    const rows = [];
    let best = null, sinceBest = 0, done = false;
    // Feed one result at a time in floor order and apply the stopping rule.
    function take(e, f) {
      if (done || !e) return;
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
    const workers = getPool();
    return new Promise((resolve, reject) => {
      let f = 1;
      if (workers) {
        // Simulate a batch of floors in parallel, then apply them in order; repeat until the rule stops.
        const batch = () => {
          if (run !== runId) { workers.clear(); reject(new Error("cancelled")); return; }
          if (done || f > lastFloor) { resolve({ rows, best }); return; }
          const floors = [];
          for (let k = 0; k < workers.size && f <= lastFloor; k++) floors.push(f++);
          Promise.all(floors.map(fl => workers.run(fl, statsObj, cfg))).then(results => {
            if (run !== runId) { reject(new Error("cancelled")); return; }
            results.forEach((e, k) => take(e, floors[k]));
            if (onProgress) onProgress(floors[floors.length - 1]);
            batch();
          }, reject);
        };
        batch();
        return;
      }
      // No workers (e.g. the page was opened as a file): run here in small chunks.
      const step = () => {
        if (run !== runId) { reject(new Error("cancelled")); return; }
        const started = performance.now();
        while (!done && f <= lastFloor && performance.now() - started < 40) { take(IOMSim.simulate(f, statsObj, cfg), f); f++; }
        if (done || f > lastFloor) resolve({ rows, best });
        else { if (onProgress) onProgress(f - 1); setTimeout(step, 0); }
      };
      step();
    });
  }

  function compute() {
    const run = ++runId;
    $("#ce-stale").hidden = true;
    const status = el("p", { class: "muted small" });
    $("#ce-results").replaceChildren(el("h3", { text: "Best floor" }), status);
    $("#ce-table").replaceChildren();
    searchFloors(stats, run, f => { status.textContent = `Simulating ${prefs.simFloors.toLocaleString()} floors per floor level… floor ${f}`; })
      .then(({ rows, best }) => {
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
      }, () => {});
  }

  // ---------- contract upgrade planner ----------
  // What one more level of a contract upgrade does to the stats the simulation uses. Bonuses within the
  // contract menu add up, so going from level L to L+1 multiplies by (1 + b(L+1)) / (1 + bL).
  const addPct = (b) => (s, key, L) => { s[key] = (s[key] || 0) * (1 + b * (L + 1)) / (1 + b * L); };
  const CONTRACT_EFFECTS = {
    2: (s) => { s.pickaxe_super_crit_chance = (s.pickaxe_super_crit_chance || 0) + 2; },
    3: (s, L) => addPct(0.03)(s, "bomb_recharge_speed", L),
    4: (s, L) => addPct(0.10)(s, "experience_multi", L),
    5: (s, L) => addPct(0.08)(s, "pickaxe_crit_damage", L),
    6: (s, L) => addPct(0.15)(s, "pickaxe_damage", L),
    13: (s) => { s.pickaxe_ultra_crit_chance = (s.pickaxe_ultra_crit_chance || 0) + 1; s.bomb_ultra_crit_chance = (s.bomb_ultra_crit_chance || 0) + 1; },
    17: (s, L) => addPct(0.01)(s, "game_speed_multi", L),
    22: (s) => { s.pickaxe_omega_crit_chance = (s.pickaxe_omega_crit_chance || 0) + 2; s.bomb_omega_crit_chance = (s.bomb_omega_crit_chance || 0) + 2; },
    23: (s) => { s.pickaxe_damage = (s.pickaxe_damage || 0) * 1.08; s.bomb_damage = (s.bomb_damage || 0) * 1.08; }
  };
  // Contract points for level n (1-based) of an upgrade, after the save's contract upgrade cost reduction.
  function contractCost(c, n) {
    const raw = c.cost.type === "linear" ? c.cost.base + c.cost.scale * (n - 1) : c.cost.base * Math.pow(c.cost.scale, n - 1);
    const reduction = (rawStats && rawStats.contract_upgrade_cost_reduction) || 1;
    return Math.max(1, Math.round(Math.round(raw) * reduction));
  }
  // Every upgrade one level higher; locked ones bring the earlier upgrades they need (each to level 1).
  function contractPackages() {
    const C = IOM.CONTRACTS || [];
    const levels = C.map((_, i) => Math.round(((rawStats && rawStats.contracts_array) || [])[i] || 0));
    const worlds = Math.round((rawStats && rawStats.worlds_unlocked) || 1);
    const cap = Math.round((rawStats && rawStats.contract_cap_increase) || 0);
    const out = [];
    C.forEach((c, i) => {
      if (c.world > worlds || levels[i] >= c.max + cap) return;
      const steps = [];
      for (let j = 0; j < i; j++) if (levels[j] === 0) steps.push({ i: j, from: 0 });
      steps.push({ i, from: levels[i] });
      out.push({
        target: i, steps,
        cost: steps.reduce((sum, st) => sum + contractCost(C[st.i], st.from + 1), 0),
        affectsExp: steps.some(st => CONTRACT_EFFECTS[st.i])
      });
    });
    return { packages: out, levels };
  }

  // The player bought a package: write the new levels into the save, apply their effects to the saved
  // stats (so the next simulation starts from there), then plan the next upgrade.
  function markBought(p) {
    if (!currentData || !currentData.stats) return;
    const raw = currentData.stats;
    const arr = Array.isArray(raw.contracts_array) ? raw.contracts_array : (raw.contracts_array = []);
    for (const step of p.steps) {
      const eff = CONTRACT_EFFECTS[step.i];
      if (eff) { eff(raw, step.from); eff(stats, step.from); }
      arr[step.i] = (arr[step.i] || 0) + 1;
    }
    rawStats = raw;
    sourceKey = keyFor(currentData);   // same save, just updated: keep the calculator's settings
    if (IOM.saves) IOM.saves.update({ data: currentData });
    planContracts();
  }

  function planContracts() {
    const run = ++runId;
    const C = IOM.CONTRACTS || [];
    const box = $("#ce-plan");
    const status = el("p", { class: "muted small" });
    box.replaceChildren(status);
    const { packages, levels } = contractPackages();
    const sims = packages.filter(p => p.affectsExp);
    const results = [];
    let k = 0;
    const next = () => {
      if (k === 0) status.textContent = "Simulating your current setup…";
      const p = k === 0 ? null : sims[k - 1];
      const st = Object.assign({}, stats);
      if (p) for (const step of p.steps) if (CONTRACT_EFFECTS[step.i]) CONTRACT_EFFECTS[step.i](st, step.from);
      return searchFloors(st, run, f => {
        status.textContent = (p ? `Simulating ${C[p.target].name} (${k} of ${sims.length})` : "Simulating your current setup") + `… floor ${f}`;
      }).then(r => { results.push({ p, best: r.best }); k++; return k <= sims.length ? next() : null; });
    };
    next().then(() => {
      const base = results[0].best ? results[0].best.xpm : 0;
      const rows = results.slice(1).map(r => {
        const xpm = r.best ? r.best.xpm : 0;
        // Gains below zero are simulation noise (the upgrade changes nothing here): count them as 0.
        const gain = Math.max(0, xpm - base);
        return { p: r.p, best: r.best, gain, perPoint: gain / r.p.cost };
      });
      const key = prefs.planBy === "perPoint" ? "perPoint" : "gain";
      rows.sort((a, b) => b[key] - a[key]);
      const top = rows[0];
      const pct = (g) => base > 0 ? ` (+${(g / base * 100).toFixed(1)}%)` : "";
      const needsOf = (p) => p.steps.slice(0, -1).map(st => C[st.i].name);
      const levelText = (p) => `${levels[p.target]} → ${levels[p.target] + 1}`;
      const noEffect = packages.filter(p => !p.affectsExp && p.steps.length === 1).map(p => C[p.target].name);
      let pick;
      if (top && top[key] > 0) {
        const needs = needsOf(top.p);
        pick = el("div", { class: "plan-pick" },
          el("p", {}, "👉 Buy next: ", el("b", { text: `${C[top.p.target].name} ${levelText(top.p)}` }),
            ` · ${top.p.cost.toLocaleString()} contract points · +${fmt(top.gain)} exp/min${pct(top.gain)} `,
            el("button", { type: "button", class: "btn small primary", text: "✓ Bought", title: "Write these levels into the save and plan the next upgrade", onclick: () => markBought(top.p) })),
          needs.length ? el("details", { class: "small" },
            el("summary", { text: `Also buys the ${needs.length} upgrade${needs.length === 1 ? "" : "s"} it needs first (1 level each)` }),
            el("p", { class: "muted", text: needs.join(", ") })) : null);
      } else {
        pick = el("p", { class: "warning", text: "None of the available contract upgrades raises your exp/min with this setup." });
      }
      box.replaceChildren(
        pick,
        el("h3", { text: "All options right now, best first" }),
        el("p", { class: "muted small", text: `Each row is one alternative you could buy instead: one more level of that upgrade (plus any locked upgrades before it), and the exp/min you'd get. It's not a buying order: after you buy one, the rest change, so press ✓ Bought to re-rank. Now: ${fmt(base)} exp/min.` }),
        el("div", { class: "table-wrap" },
          el("table", { class: "calc-table" },
            el("thead", {}, el("tr", {}, ...["#", "If you buy", "Needs first", "Points", "Exp/min after", "Gain", "Gain/point"].map(h => el("th", { text: h })))),
            el("tbody", {}, ...rows.map((r, idx) => {
              const needs = needsOf(r.p);
              return el("tr", { class: r === top && r[key] > 0 ? "best" : "" },
                el("td", { text: String(idx + 1) }),
                el("td", { text: `${C[r.p.target].name} ${levelText(r.p)}` }),
                el("td", { text: needs.length ? `${needs.length} upgrade${needs.length === 1 ? "" : "s"}` : "—", title: needs.length ? needs.join(", ") : null, class: needs.length ? "has-tip" : null }),
                el("td", { text: r.p.cost.toLocaleString() }),
                el("td", { text: r.best ? fmt(r.best.xpm) : "0" }),
                el("td", { text: r.gain > 0 ? "+" + fmt(r.gain) + pct(r.gain) : "≈ 0" }),
                el("td", { text: r.gain > 0 ? fmt(r.perPoint) : "≈ 0" }));
            })))),
        noEffect.length ? el("p", { class: "muted small", text: `No effect on exp: ${noEffect.join(", ")}.` }) : null
      );
    }, () => {});
  }

  let currentData = null;
  const keyFor = (data) => JSON.stringify([data.time, data.version, data.stats.current_floor, data.stats.experience_multi, data.stats.pickaxe_damage, data.stats.game_speed_multi]);
  IOM.calcExp = {
    simulate: (floor, overrides) => simulate(floor, Object.assign({}, stats, overrides)),   // for testing
    // Forget every what-if value and assumption; the next render starts from the save again.
    reset() { sourceKey = null; prefs = Object.assign({}, DEFAULTS); },
    // Bomb setup changed on the Savefiles page.
    refresh() { if (stats) { noteUpdaters.forEach(f => f()); schedule(); } },
    render(data) {
      currentData = data;
      if (!data || !data.stats) return;
      const key = keyFor(data);
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
