// Exp calculator simulation core. No page code here, so it runs both on the page and in Web Workers
// (see sim-worker.js). Ore data (IOM.ORES, IOM.FLOOR_ORES, IOM.BOMBS) comes from ores.js.
// simulate(floor, stats, cfg): cfg holds the calculator's choices (usePickaxe, useDrones, autoBomb,
// manualBomb, manualMode, chainActive, fullBombs, simFloors), bombMults { bombName: multiplier } and
// exp { mult } for the Exp Bomb.
(function (G) {
  "use strict";
  const IOM = G.IOM;
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

  function pickOre(list, rand) {
    let r = rand();
    for (const o of list) { if ((r -= o.w) <= 0) return o; }
    return list[list.length - 1];
  }
  const bombByName = (name) => (IOM.BOMBS || []).find(b => b.name === name) || null;
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



  // Plays out cfg.simFloors floors on one floor level, jumping from event to event (pickaxe swing,
  // drone attack, bomb, respawn), and returns the averages.
  function simulate(floor, s, cfg) {
    const floorOres = oresOnFloor(floor);
    if (!floorOres.length) return null;
    const rand = rng(1000 + floor * 97);
    const count = Math.max(1, Math.min(Math.round(s.ores_per_screen || 1), ORE_LAYOUT.length));
    const expMulti = s.experience_multi || 1;   // triple rocks give 3x ores (wiki), not more exp

    let speed = s.game_speed_multi || 1;
    for (const o of floorOres) if (o.mod === "game speed" && o.amt) speed *= 1 + o.amt / 100;

    // Damage sources
    const pick = cfg.usePickaxe && (s.pickaxe_attack_speed_per_second || 0) > 0
      ? { period: 1 / s.pickaxe_attack_speed_per_second, dmg: s.pickaxe_damage || 0, chain: critChain(s, "pickaxe_"), next: 0 } : null;
    const droneN = cfg.useDrones ? Math.max(0, Math.round(s.drone_count || 0)) : 0;
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
    const exp = cfg.exp || { mult: 1 };
    const frameGame = speed / HARE_FPS;    // one rendered frame, in game seconds
    const hare = cfg.manualBomb && cfg.manualMode === "hare";
    const slots = [["auto", cfg.autoBomb, FIRE_INTERVAL], [hare ? "hare" : "slow", cfg.manualBomb, hare ? frameGame : FIRE_INTERVAL],
                   ["chain", cfg.chainActive ? "Chain Bomb" : "", FIRE_INTERVAL]]
      .map(([slot, name, interval]) => ({ slot, bomb: bombByName(name), interval }))
      .filter(x => x.bomb)
      .map(x => ({
        slot: x.slot, interval: x.interval, isExp: x.bomb.name === "Exp Bomb",
        queued: x.slot === "chain",   // an active chain keeps exploding regardless of charges
        dmg: (s.bomb_damage || 0) * ((cfg.bombMults || {})[x.bomb.name] ?? 1),
        rechargeTime: x.bomb.cd / Math.max(s.bomb_recharge_speed || 1, 1e-9),
        next: 0, charge: 0, lastT: 0
      }));
    const free = pct(s.bomb_free_chance);

    if (!pick && !drone && !slots.length) return { floor, floorOres, blocked: "Nothing is breaking ores: turn on the pickaxe, drones, or pick a bomb." };

    const target = Math.max(1, Math.round(cfg.floors || cfg.simFloors || 1000));
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
        if (!cfg.fullBombs && !b.queued) {
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

  // True when floor f and f+1 share the same two ores (the first floor of a pair).
  function firstOfPair(f) {
    const a = IOM.FLOOR_ORES && IOM.FLOOR_ORES[f], b = IOM.FLOOR_ORES && IOM.FLOOR_ORES[f + 1];
    return !!(a && b && a[0][0] === b[0][0] && a[1][0] === b[1][0]);
  }

  // Best floor for one set of stats: start at floor 1 and go up; stop once three floors in a row are at
  // least 10% below the best (never on the first floor of a pair), or at lastFloor. Returns a small summary.
  function search(s, cfg, lastFloor) {
    let best = null, sinceBest = 0;
    for (let f = 1; f <= lastFloor; f++) {
      const e = simulate(f, s, cfg);
      if (!e) continue;
      const xpm = e.blocked ? 0 : e.xpm;
      if (!best || xpm > best.xpm) { if (!e.blocked) best = { floor: e.floor, xpm: e.xpm, fpm: e.fpm }; sinceBest = 0; }
      else if (xpm <= best.xpm * 0.9) { if (++sinceBest >= 3 && !firstOfPair(f)) break; }
      else sinceBest = 0;
    }
    return { best };
  }

  G.IOMSim = { simulate, search, firstOfPair };
})(typeof self !== "undefined" ? self : window);
