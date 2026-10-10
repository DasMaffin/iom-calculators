// Web Worker for the exp calculator: runs one floor level's simulation off the page's main thread.
// The page sends { id, kind, floor | lastFloor, stats, cfg }; the worker replies { id, result }.
self.window = self;   // ores.js attaches its data to window.IOM
const v = new URL(self.location.href).searchParams.get("v") || "";
importScripts(`ores.js?v=${v}`, `sim-core.js?v=${v}`);
self.onmessage = (e) => {
  const { id, kind, floor, stats, cfg, lastFloor } = e.data;
  let result = null, error = null;
  try {
    // "search": a whole best-floor search for one set of stats (used by the contract planner);
    // otherwise one floor level.
    result = kind === "search" ? self.IOMSim.search(stats, cfg, lastFloor) : self.IOMSim.simulate(floor, stats, cfg);
  } catch (err) { error = String(err && err.message || err); }
  self.postMessage({ id, result, error });
};
