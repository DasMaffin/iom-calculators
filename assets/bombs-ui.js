// Bomb setup: each bomb's damage multiplier as shown in game (the "×" next to the bomb). The export
// only has the shared part (bomb_additional_multiplier), so players enter the real values here.
// Stored in the active save.
(function () {
  "use strict";

  const root = document.getElementById("bombsCard");
  if (!root || !window.IOM || !IOM.BOMBS) return;

  let mults = {};          // { bombName: multiplier }
  let fallback = null;     // shared multiplier from the export, used when a bomb has no value

  const has = (name) => typeof mults[name] === "number" && mults[name] >= 0;

  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };

  function summary() {
    const set = IOM.BOMBS.filter(b => has(b.name)).length;
    root.querySelector("#bombSummary").textContent = `${set} of ${IOM.BOMBS.length} set`;
  }

  function render() {
    const grid = root.querySelector("#bombGrid");
    grid.replaceChildren(...IOM.BOMBS.map(b => {
      const id = "bomb-" + b.name.replace(/\W+/g, "-");
      const input = el("input", {
        type: "number", inputmode: "decimal", min: "0", step: "any", id,
        placeholder: fallback ? String(Number(fallback.toPrecision(6))) : "",
        value: has(b.name) ? String(mults[b.name]) : ""
      });
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        if (input.value.trim() !== "" && v >= 0) mults[b.name] = v; else delete mults[b.name];   // 0 is 0, empty is unset
        IOM.saves && IOM.saves.update({ bombs: mults });
        summary();
        if (IOM.calcExp && IOM.calcExp.refresh) IOM.calcExp.refresh();
      });
      return el("label", { class: "field", for: id }, el("span", { text: `${b.name} ×` }), input);
    }));
    summary();
  }

  IOM.bombSetup = {
    setState(s) { mults = (s && typeof s === "object") ? Object.assign({}, s) : {}; render(); },
    getState() { return Object.assign({}, mults); },
    setFallback(v) { fallback = v > 0 ? v : null; render(); },
    // The multiplier to use for a bomb, and whether it came from the player or the export fallback.
    get(name) { return has(name) ? { mult: mults[name], set: true } : { mult: fallback || 1, set: false }; }
  };
  render();
})();
