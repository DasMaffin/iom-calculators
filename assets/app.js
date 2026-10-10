(function () {
  "use strict";

  const THEME_KEY = "iom.theme";
  const UI_KEY = "iom.ui.v1";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  };

  // ---------- storage (browser-only, may be unavailable) ----------
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch { /* ignore */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  };

  // ---------- number formatting ----------
  const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];

  function round(n, digits = 4) {
    if (!isFinite(n)) return n;
    return Number(n.toFixed(digits));
  }

  function short(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    const abs = Math.abs(n);
    if (abs < 1000) return String(round(n, abs < 10 ? 4 : 2));
    const tier = Math.min(Math.floor(Math.log10(abs) / 3), SUFFIXES.length - 1);
    if (tier >= SUFFIXES.length - 1 && abs >= 1e36) return n.toExponential(2);
    return (n / Math.pow(1000, tier)).toFixed(2).replace(/\.?0+$/, "") + SUFFIXES[tier];
  }

  function pretty(key, n) {
    if (typeof n !== "number") return "";
    switch (IOM.kindFor(key)) {
      case "percent": return round(n, 2) + "%";
      case "multi": return "×" + short(n);
      case "seconds": return formatDuration(n);
      default: return Math.abs(n) >= 1000 ? short(n) : "";
    }
  }

  function formatDuration(sec) {
    if (!isFinite(sec)) return "";
    sec = Math.round(sec);
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
          m = Math.floor(sec % 3600 / 60), s = sec % 60;
    const parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m) parts.push(m + "m");
    if (s || !parts.length) parts.push(s + "s");
    return parts.slice(0, 2).join(" ");
  }

  // Raw-value text shown in an input: trims float noise like 1.1000000000000001.
  function rawText(n) {
    if (typeof n !== "number") return String(n);
    if (Number.isInteger(n)) return String(n);
    return String(Number(n.toPrecision(12)));
  }

  // ---------- state ----------
  let data = null;          // the full export object { time, stats, version }
  let ui = { open: {}, hideZero: true };

  try { ui = Object.assign(ui, JSON.parse(store.get(UI_KEY) || "{}")); } catch { /* ignore */ }
  const saveUi = () => store.set(UI_KEY, JSON.stringify(ui));
  // Every change autosaves into the active named save (see saves.js).
  const saveData = () => IOM.saves.update({ data });

  // ---------- import ----------
  function parseExport(text) {
    text = (text || "").trim();
    if (!text) throw new Error("Paste your exported JSON first.");
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { throw new Error("That isn't valid JSON: " + e.message); }
    // Accept either the full export or just the inner "stats" object.
    if (obj && typeof obj === "object" && !Array.isArray(obj) && !obj.stats) {
      const looksLikeStats = Object.keys(obj).some(k => /_(multi|chance|array|level)$/.test(k));
      if (looksLikeStats) obj = { stats: obj };
    }
    if (!obj || typeof obj.stats !== "object" || Array.isArray(obj.stats)) {
      throw new Error('No "stats" object found. Make sure you copied the whole export.');
    }
    return obj;
  }

  function setMsg(text, kind) {
    const m = $("#importMsg");
    m.textContent = text;
    m.className = "msg" + (kind ? " " + kind : "");
  }

  function load(obj, { persist = true, quiet = false } = {}) {
    // A downloaded file carries the marked cards too; restore them, but keep them out of the stats data.
    const { iom_cards: cards, ...exported } = obj;
    data = exported;
    if (IOM.cardsUI) {
      if (cards) IOM.cardsUI.setState(cards);
      IOM.cardsUI.syncFromExport(data.stats);
    }
    if (persist) saveData();
    render();
    const n = Object.keys(data.stats).length;
    if (!quiet) setMsg(`Imported ${n} stats${data.version ? " from " + data.version : ""}.`, "ok");
    const badge = $("#loadedBadge");
    badge.hidden = false;
    badge.textContent = `${n} stats${data.version ? " · " + data.version : ""}`;
    $("#importCard .howto").open = false;
  }

  function importText(text) {
    try { load(parseExport(text)); $("#overview").scrollIntoView({ behavior: "smooth", block: "start" }); }
    catch (e) { setMsg(e.message, "err"); }
  }

  // ---------- rendering ----------
  function isEmpty(v) {
    if (Array.isArray(v)) return v.every(x => x === 0 || x === false);
    return v === 0 || v === false;
  }

  // "time" is a spreadsheet-style serial date: days since 1899-12-30, in the player's local time.
  function exportDate(time) {
    if (typeof time !== "number" || !isFinite(time) || time <= 0) return null;
    const epoch = new Date(1899, 11, 30).getTime();
    return new Date(epoch + time * 86400000);
  }

  function parseVersion(v) {
    const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v || "").trim());
    return m ? m[1].split(".").map(Number) : null;
  }

  function compareVersions(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function renderWarnings() {
    const notes = [];
    const mine = parseVersion(data.version);
    const latest = parseVersion(IOM.LATEST_GAME_VERSION);
    if (!data.version) {
      notes.push("This export has no game version, so it may be from an old version of the game.");
    } else if (mine && latest && compareVersions(mine, latest) < 0) {
      notes.push(`Your export is from ${data.version}, but the latest known version is ${IOM.LATEST_GAME_VERSION}. Update the game and export again for accurate numbers.`);
    }
    const when = exportDate(data.time);
    if (when) {
      const days = (Date.now() - when.getTime()) / 86400000;
      if (days > IOM.STALE_EXPORT_DAYS) {
        notes.push(`This export is ${Math.floor(days)} days old (${when.toLocaleDateString()}). Export again for your current stats.`);
      }
    }
    // Positive values in this array are seconds left on an active buff (checked: 3x Vein active
    // tripled vein_spawn_rate_multi; 10x Bomb Recharge expiring cut bomb_recharge_speed by 10x).
    const buffs = data.stats.lootbug_and_elixir_uptime_array;
    const names = (IOM.ARRAY_LABELS || {}).lootbug_and_elixir_uptime_array || [];
    if (Array.isArray(buffs)) {
      const active = buffs.map((v, i) => v > 0 ? `${names[i] || "Buff #" + i} (${formatDuration(v)} left)` : null).filter(Boolean);
      if (active.length) {
        notes.push(`Active buffs: ${active.join(", ")}. Your exported stats include these temporary boosts. Export again after they run out to see your base stats.`);
      }
    }
    $("#warnings").replaceChildren(...notes.map(t => el("p", { class: "warning", role: "alert" }, "⚠️ " + t)));
    $("#warnings").hidden = notes.length === 0;
  }

  function render() {
    $("#dashboard").hidden = !data;
    if (!data) return;
    renderWarnings();
    renderOverview();
    renderSections();
    renderNotSeen();
    applyFilter();
  }

  function renderOverview() {
    const s = data.stats;
    const tiles = [];
    for (const key of IOM.HEADLINE) {
      if (!(key in s)) continue;
      const v = s[key];
      tiles.push(el("div", { class: "tile" },
        el("div", { class: "t-label", text: IOM.labelFor(key) }),
        el("div", { class: "t-value", text: IOM.kindFor(key) === "multi" ? "×" + short(v) : short(v) })
      ));
    }
    if (data.version) {
      tiles.push(el("div", { class: "tile" },
        el("div", { class: "t-label", text: "Game version" }),
        el("div", { class: "t-value", text: data.version })
      ));
    }
    const when = exportDate(data.time);
    if (when) {
      tiles.push(el("div", { class: "tile" },
        el("div", { class: "t-label", text: "Exported" }),
        el("div", { class: "t-value", text: when.toLocaleDateString() }),
        el("div", { class: "t-sub", text: when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
      ));
    }
    $("#overview").replaceChildren(...tiles);
  }

  function groupStats() {
    const groups = Object.fromEntries(IOM.SECTIONS.map(s => [s.id, []]));
    for (const key of Object.keys(data.stats).sort()) groups[IOM.sectionFor(key)].push(key);
    return groups;
  }

  function renderSections() {
    const groups = groupStats();
    const sections = [];
    const jumps = [];
    for (const sec of IOM.SECTIONS) {
      const keys = groups[sec.id];
      if (!keys.length) continue;
      const scalars = keys.filter(k => !Array.isArray(data.stats[k]));
      const arrays = keys.filter(k => Array.isArray(data.stats[k]));

      const body = el("div", { class: "section-body" });
      if (scalars.length) body.append(el("div", { class: "stat-grid" }, ...scalars.map(statRow)));
      for (const k of arrays) body.append(arrayBlock(k));

      const details = el("details", { class: "card section", id: "sec-" + sec.id, "data-section": sec.id },
        el("summary", {},
          el("h2", { text: `${sec.icon} ${sec.title}` }),
          el("span", { class: "count", text: `${keys.length}` }),
          sec.wiki ? el("a", {
            class: "wiki-link", href: "https://shminer.miraheze.org/wiki/" + sec.wiki,
            target: "_blank", rel: "noopener", text: "wiki ↗",
            onclick: (e) => e.stopPropagation()
          }) : null
        ),
        body
      );
      details.open = ui.open[sec.id] ?? (sec.id === "progress" || sec.id === "pickaxe");
      details.addEventListener("toggle", () => { ui.open[sec.id] = details.open; saveUi(); });
      sections.push(details);

      jumps.push(el("a", {
        href: "#sec-" + sec.id, text: `${sec.icon} ${sec.title}`,
        onclick: () => { details.open = true; }
      }));
    }
    $("#sections").replaceChildren(...sections);
    $("#jumpNav").replaceChildren(...jumps);
  }

  function statRow(key) {
    const v = data.stats[key];
    const row = el("div", { class: "stat" + (isEmpty(v) ? " zero" : ""), "data-key": key });
    const name = el("div", { class: "stat-name" },
      el("span", { class: "label", text: IOM.labelFor(key) }),
      el("span", { class: "key", text: key })
    );
    const valueBox = el("div", { class: "stat-value" });

    if (typeof v === "boolean") {
      const cb = el("input", { type: "checkbox", "aria-label": key });
      cb.checked = v;
      cb.addEventListener("change", () => {
        data.stats[key] = cb.checked;
        row.classList.toggle("zero", !cb.checked);
        saveData();
      });
      valueBox.append(el("label", { class: "check toggle" }, cb, document.createTextNode(v ? " yes" : " no")));
      cb.addEventListener("change", () => { cb.nextSibling.textContent = cb.checked ? " yes" : " no"; });
    } else if (typeof v === "number") {
      const input = el("input", { type: "text", inputmode: "decimal", value: rawText(v), "aria-label": key });
      const hint = el("span", { class: "pretty", text: pretty(key, v) });
      input.addEventListener("change", () => {
        const n = Number(input.value.trim());
        if (input.value.trim() === "" || !isFinite(n)) { input.classList.add("invalid"); return; }
        input.classList.remove("invalid");
        data.stats[key] = n;
        hint.textContent = pretty(key, n);
        row.classList.toggle("zero", n === 0);
        saveData();
        if (IOM.HEADLINE.includes(key)) renderOverview();
      });
      valueBox.append(input, hint);
    } else {
      // strings / objects: show as read-only JSON
      valueBox.append(el("span", { class: "pretty", text: JSON.stringify(v) }));
    }
    row.append(name, valueBox);
    return row;
  }

  function arrayBlock(key) {
    const arr = data.stats[key];
    const nonZero = arr.filter(x => x !== 0 && x !== false).length;
    const block = el("details", { class: "array-block" + (isEmpty(arr) ? " zero" : ""), "data-key": key });
    const meta = el("span", { class: "meta", text: `${nonZero}/${arr.length} set` });
    block.append(el("summary", {},
      el("span", { class: "label", text: IOM.labelFor(key) }),
      el("span", { class: "key", text: key }),
      meta
    ));
    // Build cells lazily the first time the block is opened.
    block.addEventListener("toggle", function build() {
      if (!block.open || block.querySelector(".array-grid")) return;
      const names = (IOM.ARRAY_LABELS || {})[key];
      const grid = el("div", { class: "array-grid" + (names ? " labelled" : "") });
      if (IOM.ARRAY_SOURCES && IOM.ARRAY_SOURCES[key]) {
        block.append(el("p", { class: "muted small source" },
          document.createTextNode("Names from the wiki: "),
          el("a", { href: "https://shminer.miraheze.org/wiki/" + IOM.ARRAY_SOURCES[key], target: "_blank", rel: "noopener", text: IOM.ARRAY_SOURCES[key].replace(/_/g, " ") })
        ));
      }
      arr.forEach((val, i) => {
        const cell = el("label", { class: "cell" + (val ? " nz" : "") + (val === 0 ? " zero-cell" : "") });
        const input = el("input", { type: "text", inputmode: "decimal", value: rawText(val), "aria-label": `${key}[${i}]` });
        input.addEventListener("change", () => {
          const n = Number(input.value.trim());
          if (input.value.trim() === "" || !isFinite(n)) { input.classList.add("invalid"); return; }
          input.classList.remove("invalid");
          arr[i] = n;
          cell.classList.toggle("nz", n !== 0);
          cell.classList.toggle("zero-cell", n === 0);
          meta.textContent = `${arr.filter(x => x !== 0).length}/${arr.length} set`;
          block.classList.toggle("zero", isEmpty(arr));
          saveData();
        });
        const name = names && names[i];
        if (key === "lootbug_and_elixir_uptime_array") {
          cell.title = val > 0 ? `Active, ${formatDuration(val)} left` : "Not active";
        }
        cell.append(el("span", { title: name ? `${key}[${i}]` : null }, `#${i}`, name ? el("b", { text: " " + name }) : null), input);
        grid.append(cell);
      });
      block.append(grid);
    });
    return block;
  }

  function renderNotSeen() {
    $("#notSeen").replaceChildren(...IOM.NOT_YET_SEEN.map(item =>
      el("li", {},
        el("a", { href: "https://shminer.miraheze.org/wiki/" + item.wiki, target: "_blank", rel: "noopener", text: item.name }),
        document.createTextNode(" — " + item.note)
      )
    ));
  }

  // ---------- filtering ----------
  function applyFilter() {
    const q = $("#filterInput").value.trim().toLowerCase().replace(/\s+/g, "_");
    const qLabel = $("#filterInput").value.trim().toLowerCase();
    const hideZero = $("#hideZero").checked;
    document.body.classList.toggle("hide-zero", hideZero);
    document.querySelectorAll("#sections .section").forEach(sec => {
      let visible = 0;
      sec.querySelectorAll("[data-key]").forEach(item => {
        const key = item.dataset.key;
        const label = (IOM.labelFor(key) + " " + ((IOM.ARRAY_LABELS || {})[key] || []).join(" ")).toLowerCase();
        const match = !q || key.includes(q) || label.includes(qLabel);
        const show = match && !(hideZero && item.classList.contains("zero"));
        item.hidden = !show;
        if (show) visible++;
      });
      sec.hidden = visible === 0;
      sec.querySelector(".count").textContent = String(visible);
      if (q && visible) sec.open = true;
    });
  }

  // ---------- export ----------
  // Game export plus the hand-marked cards, so a downloaded file restores both.
  function exportText() {
    const out = Object.assign({}, data);
    if (IOM.cardsUI) out.iom_cards = IOM.cardsUI.getState();
    return JSON.stringify(out, null, 2);
  }

  function download() {
    const blob = new Blob([exportText()], { type: "application/json" });
    const safeName = IOM.saves.activeName().replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "save";
    const a = el("a", { href: URL.createObjectURL(blob), download: `iom-${safeName}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  async function copy(btn) {
    try {
      await navigator.clipboard.writeText(exportText());
      flash(btn, "✓ Copied");
    } catch {
      $("#jsonInput").value = exportText();
      $("#jsonInput").select();
      flash(btn, "Copy blocked — JSON is in the box above");
    }
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1800);
  }

  // ---------- theme ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(store.get(THEME_KEY));
  $("#themeToggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    store.set(THEME_KEY, next);
  });

  // ---------- wiring ----------
  $("#importBtn").addEventListener("click", () => importText($("#jsonInput").value));

  $("#fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    $("#jsonInput").value = text;
    importText(text);
    e.target.value = "";
  });

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      $("#jsonInput").value = text;
      importText(text);
    } catch {
      setMsg("Your browser blocked clipboard access — long-press the box and paste instead.", "err");
      $("#jsonInput").focus();
    }
  });

  $("#exampleBtn").addEventListener("click", async () => {
    try {
      const res = await fetch("examples/example-export.json");
      if (!res.ok) throw new Error(res.status);
      const text = await res.text();
      $("#jsonInput").value = text;
      importText(text);
    } catch {
      setMsg("Couldn't load the example file.", "err");
    }
  });

  $("#filterInput").addEventListener("input", applyFilter);
  $("#hideZero").checked = !!ui.hideZero;
  $("#hideZero").addEventListener("change", () => { ui.hideZero = $("#hideZero").checked; saveUi(); applyFilter(); });

  const setAll = (open) => document.querySelectorAll("#sections .section").forEach(d => { d.open = open; });
  $("#expandAll").addEventListener("click", () => setAll(true));
  $("#collapseAll").addEventListener("click", () => setAll(false));

  $("#downloadBtn").addEventListener("click", download);
  $("#copyBtn").addEventListener("click", (e) => copy(e.currentTarget));
  $("#clearBtn").addEventListener("click", () => {
    if (!confirm("Remove the imported stats from this save? Your marked cards stay.")) return;
    data = null;
    IOM.saves.update({ data: null });
    $("#jsonInput").value = "";
    $("#loadedBadge").hidden = true;
    $("#importCard .howto").open = true;
    setMsg("Cleared.", "");
    render();
  });

  // Foldable panels remember whether they're open (Import starts open, Cards closed).
  document.querySelectorAll("details.fold[data-fold]").forEach(d => {
    const key = d.dataset.fold;
    if (key in (ui.folds || {})) d.open = ui.folds[key];
    d.addEventListener("toggle", () => { ui.folds = Object.assign({}, ui.folds, { [key]: d.open }); saveUi(); });
  });

  // Show a save's contents (called by saves.js on start-up and when switching saves).
  IOM.saves.init(function applySave(save) {
    if (IOM.cardsUI) IOM.cardsUI.setState(save.cards || {});
    $("#jsonInput").value = "";
    if (save.data) {
      try {
        load(parseExport(JSON.stringify(save.data)), { persist: false, quiet: true });
        setMsg(`Loaded "${save.name}".`, "ok");
        return;
      } catch { /* fall through to an empty save */ }
    }
    data = null;
    if (IOM.cardsUI) IOM.cardsUI.syncFromExport(null);
    $("#loadedBadge").hidden = true;
    $("#importCard .howto").open = true;
    setMsg(save.cards && Object.keys(save.cards).length ? `Loaded "${save.name}" (no stats imported yet).` : "", "");
    render();
  });
})();
