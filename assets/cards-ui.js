// Card collection picker. Cards are not part of the game's stats export, so players mark them here.
// Click: set a card to the chosen level (click again to remove). Shift+click (or Range mode on touch):
// fill every card between the last clicked card and this one.
(function () {
  "use strict";

  const STORAGE_KEY = "iom.cards.v1";
  const UI_KEY = "iom.cards.ui.v1";
  const LEVELS = ["None", "Standard", "Gilded", "Polychrome", "Infernal"];
  // Categories the export does contain: these follow the import and can't be edited by hand.
  const FROM_EXPORT = { fish: "fishing_regular_card_array", legendary_fish: "fishing_legendary_card_levels_array" };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  };
  const load = (k, fallback) => { try { return Object.assign(fallback, JSON.parse(store.get(k) || "{}")); } catch { return fallback; } };

  let levels = load(STORAGE_KEY, {});          // { categoryId: { cardName: level } }
  const ui = load(UI_KEY, { open: {}, brush: 1 });
  let synced = {};                              // categoryId -> true when filled from the export
  let anchor = null;                            // { cat, index } of the last clicked card
  let rangeMode = false;

  const root = document.getElementById("cardsCard");
  if (!root || !window.IOM || !IOM.CARDS) return;

  const save = () => store.set(STORAGE_KEY, JSON.stringify(levels));
  const saveUi = () => store.set(UI_KEY, JSON.stringify(ui));
  const levelOf = (cat, name) => (levels[cat] && levels[cat][name]) || 0;

  function setLevel(cat, card, lvl) {
    lvl = Math.min(lvl, card.max);
    levels[cat] = levels[cat] || {};
    if (lvl) levels[cat][card.name] = lvl;
    else delete levels[cat][card.name];
  }

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

  function tooltip(card, lvl) {
    const lines = [`${card.name}: ${LEVELS[lvl]}`];
    card.fx.forEach((fx, i) => { if (fx) lines.push(`${LEVELS[i + 1]}: ${fx}`); });
    return lines.join("\n");
  }

  // ---------- rendering ----------
  const brushBar = root.querySelector("#cardBrush");
  const body = root.querySelector("#cardCategories");
  const summary = root.querySelector("#cardSummary");
  const rangeBtn = root.querySelector("#cardRange");

  function renderBrush() {
    brushBar.replaceChildren(...[1, 2, 3, 4, 0].map(lvl => el("button", {
      type: "button",
      class: `btn small brush lvl-${lvl}` + (ui.brush === lvl ? " active" : ""),
      "aria-pressed": String(ui.brush === lvl),
      text: lvl ? LEVELS[lvl] : "Remove",
      onclick: () => { ui.brush = lvl; saveUi(); renderBrush(); }
    })));
  }

  function tile(cat, card, index) {
    const lvl = levelOf(cat.id, card.name);
    const icon = el("img", { class: "cicon", src: card.img, alt: "", loading: "lazy", draggable: "false" });
    const name = el("span", { class: "cname", text: card.name });
    const t = el("button", {
      type: "button",
      class: `ctile lvl-${lvl}`,
      title: tooltip(card, lvl),
      "aria-label": `${card.name}, ${LEVELS[lvl]}`,
      "data-index": index
    },
      el("img", { class: "cback", src: IOM.CARD_BACKS[lvl || 1], alt: "", loading: "lazy", draggable: "false" }),
      icon, name);
    // Tiles show a framed name until the artwork loads, so they still work if the wiki's images can't.
    icon.addEventListener("load", () => t.classList.add("hasimg"), { once: true });
    icon.addEventListener("error", () => icon.remove(), { once: true });
    t.querySelector(".cback").addEventListener("error", e => e.target.remove(), { once: true });
    return t;
  }

  function counts(cat) {
    const per = [0, 0, 0, 0, 0];
    for (const c of cat.cards) per[levelOf(cat.id, c.name)]++;
    return per;
  }

  function countText(cat) {
    const per = counts(cat);
    const owned = cat.cards.length - per[0];
    const parts = [2, 3, 4].filter(l => per[l]).map(l => `${per[l]} ${LEVELS[l].toLowerCase()}`);
    return `${owned}/${cat.cards.length}` + (parts.length ? ` · ${parts.join(", ")}` : "");
  }

  function renderSummary() {
    let owned = 0, total = 0;
    for (const cat of IOM.CARDS) { total += cat.cards.length; owned += cat.cards.length - counts(cat)[0]; }
    summary.textContent = `${owned} of ${total} cards marked`;
  }

  function renderCategory(cat) {
    const grid = el("div", { class: "cgrid" + (synced[cat.id] ? " readonly" : "") },
      ...cat.cards.map((card, i) => tile(cat, card, i)));
    grid.addEventListener("mousedown", e => { if (e.shiftKey) e.preventDefault(); }); // no text selection
    grid.addEventListener("click", e => {
      const t = e.target.closest(".ctile");
      if (!t || synced[cat.id]) return;
      onCardClick(cat, Number(t.dataset.index), e.shiftKey || rangeMode);
    });
    return grid;
  }

  function render() {
    renderBrush();
    body.replaceChildren(...IOM.CARDS.map(cat => {
      const d = el("details", { class: "ccat", "data-cat": cat.id },
        el("summary", {},
          el("span", { class: "ctitle", text: cat.title }),
          el("span", { class: "ccount", text: countText(cat) }),
          synced[cat.id] ? el("span", { class: "badge", text: "from your export" }) : null,
          el("a", {
            class: "wiki-link", href: "https://shminer.miraheze.org/wiki/" + cat.wiki,
            target: "_blank", rel: "noopener", text: "wiki ↗", onclick: e => e.stopPropagation()
          })
        )
      );
      d.open = !!ui.open[cat.id];
      // Build the grid only when opened: some categories have ~80 images.
      const fill = () => { if (d.open && !d.querySelector(".cgrid")) d.append(renderCategory(cat)); };
      d.addEventListener("toggle", () => { ui.open[cat.id] = d.open; saveUi(); fill(); });
      fill();
      return d;
    }));
    renderSummary();
  }

  function refreshCategory(cat) {
    const d = body.querySelector(`[data-cat="${cat.id}"]`);
    d.querySelector(".ccount").textContent = countText(cat);
    const grid = d.querySelector(".cgrid");
    if (grid) {
      grid.querySelectorAll(".ctile").forEach(t => {
        const card = cat.cards[Number(t.dataset.index)];
        const lvl = levelOf(cat.id, card.name);
        t.className = `ctile lvl-${lvl}` + (t.classList.contains("hasimg") ? " hasimg" : "") +
          (anchor && anchor.cat === cat.id && anchor.index === Number(t.dataset.index) ? " anchor" : "");
        t.title = tooltip(card, lvl);
        t.setAttribute("aria-label", `${card.name}, ${LEVELS[lvl]}`);
        const back = t.querySelector(".cback");
        if (back) back.src = IOM.CARD_BACKS[lvl || 1];
      });
    }
    renderSummary();
  }

  // ---------- interaction ----------
  function onCardClick(cat, index, range) {
    const brush = ui.brush;
    if (range && anchor && anchor.cat === cat.id) {
      const [a, b] = anchor.index < index ? [anchor.index, index] : [index, anchor.index];
      for (let i = a; i <= b; i++) setLevel(cat.id, cat.cards[i], brush);
    } else {
      const card = cat.cards[index];
      const target = Math.min(brush, card.max);
      setLevel(cat.id, card, levelOf(cat.id, card.name) === target ? 0 : target);
    }
    const prev = anchor && anchor.cat !== cat.id ? IOM.CARDS.find(c => c.id === anchor.cat) : null;
    anchor = { cat: cat.id, index };
    save();
    refreshCategory(cat);
    if (prev) refreshCategory(prev);
  }

  rangeBtn.addEventListener("click", () => {
    rangeMode = !rangeMode;
    rangeBtn.classList.toggle("active", rangeMode);
    rangeBtn.setAttribute("aria-pressed", String(rangeMode));
  });

  // ---------- integration with the stats import ----------
  IOM.cardsUI = {
    // Fill categories the export actually contains, and lock them to the export.
    syncFromExport(stats) {
      synced = {};
      for (const [catId, key] of Object.entries(FROM_EXPORT)) {
        const arr = stats && stats[key];
        const cat = IOM.CARDS.find(c => c.id === catId);
        if (!Array.isArray(arr) || !cat) continue;
        cat.cards.forEach((card, i) => setLevel(catId, card, Math.max(0, Math.round(arr[i] || 0))));
        synced[catId] = true;
      }
      save();
      render();
    },
    getState() { return JSON.parse(JSON.stringify(levels)); },
    setState(s) { if (s && typeof s === "object") { levels = s; save(); render(); } }
  };

  render();
})();
