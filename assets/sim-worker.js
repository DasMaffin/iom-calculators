// Web Worker for the exp calculator: runs one floor level's simulation off the page's main thread.
// The page sends { id, floor, stats, cfg }; the worker replies { id, result }.
self.window = self;   // ores.js attaches its data to window.IOM
const v = new URL(self.location.href).searchParams.get("v") || "";
importScripts(`ores.js?v=${v}`, `sim-core.js?v=${v}`);
self.onmessage = (e) => {
  const { id, floor, stats, cfg } = e.data;
  let result = null, error = null;
  try { result = self.IOMSim.simulate(floor, stats, cfg); } catch (err) { error = String(err && err.message || err); }
  self.postMessage({ id, result, error });
};
