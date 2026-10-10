// Named saves, kept in this browser's local storage. A save holds the imported stats export and the
// hand-marked cards. Every change autosaves into the active save.
// (Cookies would be too small: one save is ~20 KB and browsers cap a cookie at ~4 KB.)
(function () {
  "use strict";

  const KEY = "iom.saves.v1";
  const LEGACY_STATS = "iom.stats.v1";
  const LEGACY_CARDS = "iom.cards.v1";

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };

  let db = { activeId: null, saves: {} };   // saves: { id: { name, created, updated, data, cards } }
  let apply = () => {};                      // set by the app: shows a save's contents on the page
  let applying = false;                      // ignore autosave writes while a save is being shown

  const $ = (s) => document.querySelector(s);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const active = () => db.saves[db.activeId] || null;

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

  function persist() {
    const ok = ls.set(KEY, JSON.stringify(db));
    const status = $("#saveStatus");
    if (status) {
      status.textContent = ok ? `Autosaved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                              : "Can't save in this browser (private mode or storage full)";
      status.classList.toggle("err", !ok);
    }
    return ok;
  }

  function create(name, contents = {}) {
    const id = newId();
    const now = Date.now();
    db.saves[id] = { name: name || "My save", created: now, updated: now, data: null, cards: {}, bombs: {}, ...contents };
    db.activeId = id;
    return db.saves[id];
  }

  function uniqueName(base) {
    const names = new Set(Object.values(db.saves).map(s => s.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
  }

  function describe(s) {
    const parts = [];
    const st = s.data && s.data.stats;
    if (st) {
      if (st.obelisk_level != null) parts.push(`Obelisk ${st.obelisk_level}`);
      if (s.data.version) parts.push(s.data.version);
    } else {
      parts.push("no stats imported");
    }
    const cards = Object.values(s.cards || {}).reduce((n, cat) => n + Object.keys(cat || {}).length, 0);
    parts.push(`${cards} card${cards === 1 ? "" : "s"}`);
    parts.push(`saved ${new Date(s.updated).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`);
    return parts.join(" · ");
  }

  // ---------- UI ----------
  function render() {
    const cur = active();
    const nameInput = $("#saveName");
    if (document.activeElement !== nameInput) nameInput.value = cur ? cur.name : "";

    const list = Object.entries(db.saves).sort((a, b) => b[1].updated - a[1].updated);
    $("#saveList").replaceChildren(...list.map(([id, s]) => {
      const isActive = id === db.activeId;
      return el("li", {
        class: "save-item" + (isActive ? " active" : ""),
        onclick: (e) => { if (!isActive && !e.target.closest("button")) switchTo(id); }
      },
        el("div", { class: "save-info" },
          el("span", { class: "save-name", text: s.name }),
          isActive ? el("span", { class: "badge", text: "current" }) : null,
          el("span", { class: "muted small save-meta", text: describe(s) })
        ),
        el("div", { class: "save-actions" },
          isActive ? null : el("button", { type: "button", class: "btn small", text: "Load", onclick: () => switchTo(id) }),
          el("button", {
            type: "button", class: "btn small danger", text: "Delete",
            onclick: () => remove(id)
          })
        )
      );
    }));
    $("#saveCount").textContent = `${list.length} save${list.length === 1 ? "" : "s"}`;
  }

  function show(save) {
    applying = true;
    try { apply(save); } finally { applying = false; }
    render();
  }

  function switchTo(id) {
    if (!db.saves[id]) return;
    db.activeId = id;
    persist();
    show(db.saves[id]);
  }

  function remove(id) {
    const s = db.saves[id];
    if (!s || !confirm(`Delete the save "${s.name}"? This can't be undone.`)) return;
    delete db.saves[id];
    if (db.activeId === id) {
      const next = Object.entries(db.saves).sort((a, b) => b[1].updated - a[1].updated)[0];
      if (next) db.activeId = next[0];
      else create("My save");
      persist();
      show(active());
    } else {
      persist();
      render();
    }
  }

  function wire() {
    $("#saveName").addEventListener("input", (e) => {
      const cur = active();
      if (!cur) return;
      cur.name = e.target.value.trim() || "Unnamed save";
      cur.updated = Date.now();
      persist();
      render();
    });
    $("#saveNew").addEventListener("click", () => {
      const name = prompt("Name for the new, empty save:", uniqueName("New save"));
      if (name == null) return;
      create(uniqueName(name.trim() || "New save"));
      persist();
      show(active());
      $("#saveName").focus();
    });
    $("#saveCopy").addEventListener("click", () => {
      const cur = active();
      if (!cur) return;
      const name = prompt("Name for the copy:", uniqueName(cur.name + " copy"));
      if (name == null) return;
      create(uniqueName(name.trim() || cur.name + " copy"), JSON.parse(JSON.stringify({ data: cur.data, cards: cur.cards, bombs: cur.bombs || {} })));
      persist();
      show(active());
    });
  }

  // ---------- API used by the page ----------
  IOM.saves = {
    // Autosave a change (stats and/or cards) into the active save.
    update(patch) {
      if (applying) return;
      const cur = active() || create("My save");
      Object.assign(cur, JSON.parse(JSON.stringify(patch)));
      cur.updated = Date.now();
      persist();
      render();
    },
    activeName() { const cur = active(); return cur ? cur.name : "save"; },
    // Load storage (migrating the older single-save keys), then show the active save.
    init(applyFn) {
      apply = applyFn;
      try { Object.assign(db, JSON.parse(ls.get(KEY) || "{}")); } catch { /* start fresh */ }
      if (!Object.keys(db.saves).length) {
        let data = null, cards = {};
        try { data = JSON.parse(ls.get(LEGACY_STATS) || "null"); } catch { /* ignore */ }
        try { cards = JSON.parse(ls.get(LEGACY_CARDS) || "{}"); } catch { /* ignore */ }
        create("My save", { data, cards });
        if (persist()) { ls.del(LEGACY_STATS); ls.del(LEGACY_CARDS); }
      }
      if (!active()) db.activeId = Object.keys(db.saves)[0];
      wire();
      show(active());
    }
  };
})();
