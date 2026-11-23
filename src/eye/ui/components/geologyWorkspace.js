import {
  Mountain,
  Activity,
  LandPlot,
  GitBranch,
  Sun,
  Ruler,
} from "lucide";
import { lucideHtml } from "../icons.js";
import { state } from "../../state.js";
import { mountFocusThemeHud } from "../mapFocus.js";
import {
  streamBodCodFor,
  streamsBodCodMeta,
  listStreamsBodCod,
  ensureStreamsBodCod,
  getStreamsBodCodCount,
  bodLevel,
  codLevel,
  fmtMgL,
} from "../../data/streamsBodCod.js";

/** Reference lithology classes — exact percentages; colors match geology overlay raster. */
export const LITHOLOGY_CLASSES = [
  {
    id: "water",
    label: "Water",
    pct: "1.9%",
    color: "#00F0F0",
    samples: [
      [0, 248, 248],
      [0, 96, 200],
      [0, 64, 136],
    ],
  },
  {
    id: "basaltic",
    label: "Basaltic / Mafic",
    pct: "16.4%",
    color: "#880000",
    samples: [
      [136, 0, 0],
      [160, 24, 0],
      [120, 0, 0],
    ],
  },
  {
    id: "weathered",
    label: "Weathered Rock",
    pct: "11.7%",
    color: "#F88800",
    samples: [
      [248, 136, 0],
      [248, 128, 0],
      [232, 112, 0],
    ],
  },
  {
    id: "alluvial",
    label: "Alluvial / Sedimentary",
    pct: "8.2%",
    color: "#F8D000",
    samples: [
      [248, 208, 0],
      [248, 200, 0],
      [232, 200, 16],
    ],
  },
  {
    id: "ferruginous",
    label: "Ferruginous / Iron-rich",
    pct: "10.3%",
    color: "#F80000",
    samples: [
      [248, 0, 0],
      [248, 32, 0],
      [232, 0, 0],
    ],
  },
  {
    id: "clay",
    label: "Clay-rich",
    pct: "14.3%",
    color: "#9070D8",
    samples: [
      [144, 112, 216],
      [136, 112, 200],
      [128, 112, 184],
    ],
  },
  {
    id: "silica",
    label: "Silica-rich",
    pct: "34.1%",
    color: "#708090",
    samples: [
      [112, 128, 144],
      [112, 120, 152],
      [120, 120, 160],
    ],
  },
  {
    id: "mixed",
    label: "Mixed Rock-soil",
    pct: "3.0%",
    color: "#92400E",
    samples: [
      [146, 64, 14],
      [184, 56, 0],
      [120, 48, 16],
    ],
  },
];

export const GEOLOGY_MODULES = [
  { id: "vehicle", label: "Vehicle", icon: Mountain, color: "#F97316", available: false },
  { id: "spectral_lithology", label: "Spectral Lithology", icon: Activity, color: "#38BDF8", available: true },
  { id: "bank_erosion", label: "Erosion", icon: LandPlot, color: "#F08070", available: true },
  { id: "joining_streams", label: "Joining Streams", icon: GitBranch, color: "#4ADE80", available: true },
  { id: "main_stem", label: "Main Stem", icon: Sun, color: "#FACC15", available: true },
  // Same control that lived under Water Quality — depth-zone colour overlay on the river.
  { id: "bathymetry", label: "Bathymetry Colour Overlay", icon: Ruler, color: "#7DD3FC", available: true, dashboard: true },
];

/**
 * Icon-only geology HUD toolbar (reference order).
 * tip = hover/aria label only — never shown as permanent text.
 * moduleId = existing activateModule() target.
 */
const GEOLOGY_TOOLBAR = [
  { moduleId: "spectral_lithology", tip: "Spectral Lithology", name: "Lithology", icon: Activity, color: "#38BDF8" },
  { moduleId: "bank_erosion", tip: "Bank Erosion", name: "Erosion", icon: LandPlot, color: "#F08070" },
  { moduleId: "joining_streams", tip: "Joining Streams", name: "Streams", icon: GitBranch, color: "#4ADE80" },
  { moduleId: "main_stem", tip: "Main Stem", name: "Main Stem", icon: Sun, color: "#FACC15" },
  { moduleId: "bathymetry", tip: "Bathymetry Colour Overlay", name: "Bathymetry", icon: Ruler, color: "#7DD3FC" },
];

/** Exact class scale from bank erosion hotspot product (2016–2026, smoothed). */
export const BANK_EROSION_CLASSES = [
  { id: "none", label: "No erosion", color: "#90EE90", pct: "83.1%" },
  { id: "low", label: "Low erosion", color: "#FFFF00", pct: "15.5%" },
  { id: "moderate", label: "Moderate erosion", color: "#FFA500", pct: "1.4%" },
  { id: "high", label: "High erosion", color: "#FF0000", pct: "0%" },
  { id: "very_high", label: "Very high erosion", color: "#8B0000", pct: "0%" },
];

/** Depth ramp of mula_mutha_depth_blueshade_smoothed.kmz (shallow → deep). */
export const BATHYMETRY_CLASSES = [
  { id: "1.53-1.62", label: "1.53–1.62 m", color: "#ABD5F8" },
  { id: "1.62-1.72", label: "1.62–1.72 m", color: "#86A9D4" },
  { id: "1.72-1.81", label: "1.72–1.81 m", color: "#5A74AA" },
  { id: "1.81-1.91", label: "1.81–1.91 m", color: "#2F4282" },
  { id: "1.91-2.00", label: "1.91–2.00 m", color: "#06115B" },
];

export const MANDOVI_BATHYMETRY_CLASSES = [
  { id: "shallow", label: "Shallow (<1.5 m)", color: "#8FEAF8", range: "< 1.5 m" },
  { id: "moderate", label: "Moderate (1.5–3.0 m)", color: "#55C4EE", range: "1.5–3.0 m" },
  { id: "medium_deep", label: "Medium-Deep (3.0–4.5 m)", color: "#3AA0D6", range: "3.0–4.5 m" },
  { id: "deep", label: "Deep (>4.5 m)", color: "#2B86C0", range: "> 4.5 m" },
];

/**
 * Geology workspace — fixed header + module row;
 * Spectral Lithology / Bank Erosion legends dock in the left UI stack.
 * Active modules enter map-focus chrome (top chips + Back), same as Land Use.
 */
export function mountGeologyWorkspace(root) {
  const wrap = document.createElement("div");
  wrap.className = "geology-workspace";
  wrap.id = "geology-workspace";
  wrap.hidden = true;
  wrap.setAttribute("aria-label", "Geology workspace");

  const focusTheme = mountFocusThemeHud(root, {
    onBack() {
      // Focus chrome already closed — clear active module layers, keep toolbar open
      activateGen += 1;
      clearModuleLayers();
      hideAllPanels();
      setModuleActive(null, null);
    },
  });

  wrap.innerHTML = `
    <section class="geology-module-row" aria-label="Geology tools">
      <div class="geology-modules" role="toolbar" aria-label="Geology modules">
        ${GEOLOGY_TOOLBAR.map(
          (m) => `
          <button type="button" class="geology-module-btn"
            data-geo-module="${m.moduleId}"
            data-geo-key="${m.key || m.moduleId}"
            data-tip="${m.tip}"
            aria-label="${m.tip}"
            title="${m.tip}"
            aria-pressed="false"
            style="--geo-accent:${m.color}">
            <span class="geology-module-icon" style="color:${m.color}" aria-hidden="true">${lucideHtml(m.icon, { size: 26, strokeWidth: 1.75, className: "geo-mod-svg" })}</span>
            <span class="geology-module-name">${m.name || m.tip}</span>
            <span class="geology-module-dot" aria-hidden="true"></span>
          </button>`,
        ).join("")}
      </div>
      <p class="geology-api-status" hidden></p>
    </section>

    <div class="geology-content" id="geology-content" aria-live="polite">
      <section class="geology-panel geology-panel--vehicle" data-geo-panel="vehicle" hidden></section>

      <section class="geology-panel geology-panel--lithology" data-geo-panel="spectral_lithology" hidden>
        <aside class="spectral-lithology-legend geo-field-note" aria-label="Spectral lithology scale">
          <header class="geo-field-note__head">
            <strong>Spectral lithology</strong>
            <span class="spectral-lithology-legend__dot" aria-hidden="true"></span>
          </header>
          <ul class="spectral-lithology-legend__list">
            ${LITHOLOGY_CLASSES.map(
              (c) => `
              <li class="spectral-lithology-legend__row" title="${c.label}">
                <span class="spectral-lithology-legend__swatch" style="background:${c.color}"></span>
                <strong class="spectral-lithology-legend__pct">${c.pct}</strong>
                <span class="spectral-lithology-legend__label">${c.label}</span>
              </li>`,
            ).join("")}
          </ul>
        </aside>
      </section>

      <section class="geology-panel geology-panel--erosion" data-geo-panel="bank_erosion" hidden>
        <aside class="bank-erosion-legend geo-field-note" aria-label="Erosion hotspots legend">
          <header class="geo-field-note__head">
            <strong>Erosion</strong>
            <small>2016–2026</small>
          </header>
          <ul class="bank-erosion-legend__list">
            ${BANK_EROSION_CLASSES.map(
              (c) => `
              <li class="bank-erosion-legend__row" title="${c.label}">
                <span class="bank-erosion-legend__swatch" style="background:${c.color}"></span>
                <strong class="bank-erosion-legend__pct">${c.pct}</strong>
                <span class="bank-erosion-legend__label">${c.label}</span>
              </li>`,
            ).join("")}
          </ul>
        </aside>
      </section>
      <section class="geology-panel geology-panel--joining" data-geo-panel="joining_streams" hidden>
        <aside class="joining-streams-panel geo-field-note" aria-label="Joining streams">
          <header class="geo-field-note__head">
            <strong>JOINING STREAMS</strong>
            <small id="joining-stream-total">Drainage → river</small>
          </header>
          <div class="joining-streams-panel__summary" id="joining-stream-summary" aria-label="All joining streams BOD COD"></div>
          <div class="joining-streams-panel__title" id="joining-stream-title">Nearest drainage</div>
          <div class="joining-streams-panel__kv" id="joining-stream-kv">
            <div class="js-kv"><span class="js-k">Status</span><span class="js-v">Select a channel</span></div>
          </div>
          <div class="joining-streams-panel__nav" id="joining-stream-panel-nav" hidden>
            <button type="button" class="joining-streams-panel__nav-btn" id="js-panel-prev" aria-label="Previous drainage">‹</button>
            <span class="joining-streams-panel__nav-count" id="js-panel-count">0 / 0</span>
            <button type="button" class="joining-streams-panel__nav-btn" id="js-panel-next" aria-label="Next drainage">›</button>
          </div>
        </aside>
      </section>
      <section class="geology-panel geology-panel--main-stem" data-geo-panel="main_stem" hidden>
        <aside class="main-stem-panel geo-field-note geo-field-note--stem" aria-label="Main stem">
          <header class="geo-field-note__head">
            <strong>Main stem</strong>
            <small>River centerline</small>
          </header>
          <p class="geo-field-note__hint">Gold line follows the surveyed / mapped main channel.</p>
        </aside>
      </section>

      <section class="geology-panel geology-panel--bathymetry" data-geo-panel="bathymetry" hidden>
        <aside class="bathymetry-legend geo-field-note geo-field-note--bathy" aria-label="Bathymetry depth classes">
          <header class="geo-field-note__head">
            <strong>Bathymetry</strong>
            <small>Water depth</small>
          </header>
          <ul class="spectral-lithology-legend__list" id="bathy-class-list">
            ${MANDOVI_BATHYMETRY_CLASSES.map(
              (c) => `
              <li class="spectral-lithology-legend__row" title="${c.label}">
                <span class="spectral-lithology-legend__swatch" style="background:${c.color}"></span>
                <span class="spectral-lithology-legend__label">${c.label}</span>
              </li>`,
            ).join("")}
          </ul>
          <p class="geo-field-note__hint">Click anywhere on the blue river to read its water depth.</p>
        </aside>
      </section>
    </div>
  `;

  root.appendChild(wrap);

  let leftStack = document.getElementById("left-ui-stack");
  if (!leftStack) {
    leftStack = document.createElement("div");
    leftStack.id = "left-ui-stack";
    leftStack.className = "left-ui-stack";
    root.appendChild(leftStack);
  }
  const erosionPanel = wrap.querySelector(".geology-panel--erosion");
  const lithologyPanel = wrap.querySelector(".geology-panel--lithology");
  const joiningPanel = wrap.querySelector(".geology-panel--joining");
  const mainStemPanel = wrap.querySelector(".geology-panel--main-stem");
  const bathymetryPanel = wrap.querySelector(".geology-panel--bathymetry");
  function dockPanel(panel) {
    if (!panel) return;
    const river = leftStack.querySelector("#river-data-panel");
    if (river) leftStack.insertBefore(panel, river.nextSibling);
    else leftStack.appendChild(panel);
  }
  // Stack: River Data → analysis panels (all start hidden; open only via toolbar)
  dockPanel(erosionPanel);
  dockPanel(lithologyPanel);
  dockPanel(joiningPanel);
  dockPanel(mainStemPanel);
  dockPanel(bathymetryPanel);
  for (const panel of [erosionPanel, lithologyPanel, joiningPanel, mainStemPanel, bathymetryPanel]) {
    if (!panel) continue;
    panel.hidden = true;
    panel.classList.remove("is-visible", "is-leaving");
  }

  const joiningKv = wrap.querySelector("#joining-stream-kv") || joiningPanel?.querySelector("#joining-stream-kv");
  const joiningTitle = joiningPanel?.querySelector("#joining-stream-title") || document.getElementById("joining-stream-title");
  const joiningPanelNav = joiningPanel?.querySelector("#joining-stream-panel-nav") || document.getElementById("joining-stream-panel-nav");
  const joiningPanelCount = joiningPanel?.querySelector("#js-panel-count") || document.getElementById("js-panel-count");
  const joiningTotalEl = joiningPanel?.querySelector("#joining-stream-total") || document.getElementById("joining-stream-total");
  const joiningSummaryEl =
    joiningPanel?.querySelector("#joining-stream-summary") || document.getElementById("joining-stream-summary");

  function refreshJoiningSummary() {
    const navCount = Number(window.__MM_SCENE__?.getJoiningStreamCount?.() ?? 0);
    const wqStreams = listStreamsBodCod();
    const wqCount = wqStreams.length || getStreamsBodCodCount();
    if (joiningTotalEl) {
      const n = navCount || wqCount;
      joiningTotalEl.textContent = n > 0 ? `${n} joining streams` : "Drainage → river";
    }
    if (!joiningSummaryEl) return;
    if (!wqStreams.length) {
      joiningSummaryEl.innerHTML =
        `<div class="js-summary-empty">${
          streamsBodCodMeta?.source === "error"
            ? "Stream BOD/COD unavailable"
            : "Loading stream BOD/COD…"
        }</div>`;
      return;
    }
    joiningSummaryEl.innerHTML = `
      <ul class="js-summary-list">
        ${wqStreams
          .map((s) => {
            const activeName = joiningTitle?.textContent?.trim()?.toLowerCase() || "";
            const isActive = activeName && activeName === String(s.name || "").toLowerCase();
            return `<li class="js-summary-row${isActive ? " is-active" : ""}" data-stream="${s.name}">
              <span class="js-summary-name">${s.name}</span>
              <span class="js-summary-wq">
                <span class="jsl-wq" data-level="${bodLevel(s.bodMean)}">BOD <b>${fmtMgL(s.bodMean)}</b></span>
                <span class="jsl-wq" data-level="${codLevel(s.codMean)}">COD <b>${fmtMgL(s.codMean)}</b></span>
              </span>
            </li>`;
          })
          .join("")}
      </ul>`;
  }

  function waterwayTypeLabel(ww) {
    const s = String(ww || "").toLowerCase();
    if (s === "drain") return "Minor Drainage";
    if (s === "stream") return "Stream / Nullah";
    if (s === "canal") return "Canal";
    if (s === "ditch") return "Ditch";
    return ww ? String(ww) : "Minor Drainage";
  }

  function showJoiningCard(rec) {
    if (!joiningKv || !rec) return;
    const m = rec.meta || {};
    // Source name only — never invent "Unnamed …" or show D-IDs as a name
    const rawCandidates = [m.name, m.nameEn, m.intName, rec.displayName, rec.name];
    let name = "";
    for (const c of rawCandidates) {
      const s = String(c || "").trim();
      if (!s || /^unnamed\b/i.test(s)) continue;
      name = s;
      break;
    }
    if (joiningTitle) {
      joiningTitle.textContent = name;
      joiningTitle.hidden = !name;
      joiningTitle.style.display = name ? "" : "none";
    }

    const dist =
      rec.distanceToRiverM != null
        ? `${Math.round(Number(rec.distanceToRiverM) * 10) / 10} m`
        : rec.connection?.distanceToBank != null
          ? `${Math.round(Number(rec.connection.distanceToBank) * 10) / 10} m`
          : rec.connection?.distance != null
            ? `${Math.round(Number(rec.connection.distance) * 10) / 10} m`
            : "—";

    const lon =
      rec.outletLon != null && Number.isFinite(Number(rec.outletLon))
        ? Number(rec.outletLon).toFixed(6)
        : "—";
    const lat =
      rec.outletLat != null && Number.isFinite(Number(rec.outletLat))
        ? Number(rec.outletLat).toFixed(6)
        : "—";

    const rows = [
      ["Type", waterwayTypeLabel(m.waterway)],
      ["Nearest Chainage", rec.riverChainageLabel || rec.nearestChainageLabel || "—"],
      ["Distance", dist],
      ["Status", rec.connectsToRiver ? "Connected" : "Disconnected"],
      ["Lon / Lat", lon !== "—" ? `${lon}, ${lat}` : "—"],
    ];

    joiningKv.innerHTML =
      joiningBodCodHtml(rec) +
      rows
        .map(
          ([k, v]) =>
            `<div class="js-kv"><span class="js-k">${k}</span><span class="js-v">${v}</span></div>`,
        )
        .join("");

    // Mirror BOD/COD into top LIVE REACH (weather) for this stream's lat/lon.
    document.dispatchEvent(
      new CustomEvent("joining-stream-wq", { detail: { rec } }),
    );

    const total = window.__MM_SCENE__?.getJoiningStreamCount?.() ?? 0;
    const idx = rec.navigationNumber ?? (rec.navIndex ?? 0) + 1;
    if (joiningPanelNav) joiningPanelNav.hidden = total < 1;
    if (joiningPanelCount) joiningPanelCount.textContent = total ? `${idx} / ${total}` : "0 / 0";
    refreshJoiningSummary();
  }

  /** BOD / COD tiles for the selected joining stream (mg/L). */
  function joiningBodCodHtml(rec) {
    const q = streamBodCodFor(rec);
    if (!q) return "";
    const tile = (label, mean, min, max, level) => `
      <div class="js-wq-tile" data-level="${level}">
        <span class="js-wq-lab">${label}</span>
        <span class="js-wq-val">${fmtMgL(mean)}<small>mg/L</small></span>
        <span class="js-wq-range">${fmtMgL(min)}–${fmtMgL(max)}</span>
      </div>`;
    return `
      <div class="js-wq" aria-label="BOD and COD for ${q.name}">
        <div class="js-wq-head"><span>Water quality</span></div>
        <div class="js-wq-grid">
          ${tile("BOD", q.bodMean, q.bodMin, q.bodMax, bodLevel(q.bodMean))}
          ${tile("COD", q.codMean, q.codMin, q.codMax, codLevel(q.codMean))}
        </div>
      </div>`;
  }

  function clearJoiningCard() {
    if (joiningTitle) {
      joiningTitle.textContent = "";
      joiningTitle.hidden = true;
      joiningTitle.style.display = "none";
    }
    if (joiningKv) {
      joiningKv.innerHTML =
        `<div class="js-kv"><span class="js-k">Status</span><span class="js-v">Select a channel</span></div>`;
    }
    if (joiningPanelNav) joiningPanelNav.hidden = true;
    if (joiningPanelCount) joiningPanelCount.textContent = "0 / 0";
    refreshJoiningSummary();
    document.dispatchEvent(
      new CustomEvent("joining-stream-wq", { detail: { rec: null } }),
    );
  }

  document.addEventListener("streams-bod-cod-ready", () => {
    refreshJoiningSummary();
    const selected = window.__MM_SCENE__?.getSelectedJoiningStream?.();
    if (selected) showJoiningCard(selected);
  });
  joiningSummaryEl?.addEventListener("click", (e) => {
    const row = e.target?.closest?.("[data-stream]");
    if (!row) return;
    const name = row.getAttribute("data-stream");
    if (!name) return;
    window.__MM_SCENE__?.selectJoiningStreamByName?.(name);
  });
  void ensureStreamsBodCod()
    .then(() => refreshJoiningSummary())
    .catch(() => refreshJoiningSummary());

  joiningPanel?.querySelector("#js-panel-prev")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.__MM_SCENE__?.stepJoiningStream?.(-1);
  });
  joiningPanel?.querySelector("#js-panel-next")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.__MM_SCENE__?.stepJoiningStream?.(1);
  });

  window.__MM_JOINING_CARD__ = {
    show: showJoiningCard,
    clear: clearJoiningCard,
  };

  function geologyPanels() {
    const list = [...wrap.querySelectorAll(".geology-panel")];
    for (const panel of [lithologyPanel, erosionPanel, joiningPanel, mainStemPanel, bathymetryPanel]) {
      if (panel && !list.includes(panel)) list.push(panel);
    }
    // Docked panels live under #left-ui-stack — still hide them with the rest.
    document.querySelectorAll("#left-ui-stack > .geology-panel").forEach((panel) => {
      if (!list.includes(panel)) list.push(panel);
    });
    return list;
  }

  let activeModule = null;
  let activeModuleKey = null;
  let transitionTimer = 0;
  let activateGen = 0;

  function setModuleActive(id, key = null) {
    activeModule = id;
    activeModuleKey = key;
    wrap.querySelectorAll(".geology-module-btn").forEach((btn) => {
      const matchId = id != null && btn.dataset.geoModule === id;
      const matchKey = key != null ? btn.dataset.geoKey === key : true;
      const on = matchId && matchKey;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    // Keep River Data minimized while geology tools are open.
    document.dispatchEvent(
      new CustomEvent("geology-module-change", { detail: { id, key } }),
    );
  }

  function hideAllPanels() {
    if (transitionTimer) {
      window.clearTimeout(transitionTimer);
      transitionTimer = 0;
    }
    geologyPanels().forEach((panel) => {
      panel.classList.remove("is-visible", "is-leaving");
      panel.hidden = true;
    });
  }

  function showPanel(id) {
    hideAllPanels();
    const next =
      id === "bank_erosion" && erosionPanel
        ? erosionPanel
        : id === "spectral_lithology" && lithologyPanel
          ? lithologyPanel
          : id === "joining_streams" && joiningPanel
            ? joiningPanel
            : id === "main_stem" && mainStemPanel
              ? mainStemPanel
              : id === "bathymetry" && bathymetryPanel
                ? bathymetryPanel
                : wrap.querySelector(`.geology-panel[data-geo-panel="${id}"]`);
    if (!next) return;
    next.hidden = false;
    void next.offsetWidth;
    next.classList.add("is-visible");
  }

  function clearModuleLayers(exceptId = null) {
    window.__MM_SCENE__?.hideHydrology?.();
    state.hydrologyHidesWater = false;
    state.hydrologyHidesFlood = false;
    state.bankErosionMode = false;
    state.bankErosionTipActive = false;
    state.lithologyMode = false;
    state.lithologyTipActive = false;
    state.joiningStreamsMode = false;
    state.joiningStreamsTipActive = false;
    state.mainStemMode = false;
    state.bathymetryMode = false;
    root.classList.remove(
      "bank-erosion-mode",
      "lithology-mode",
      "joining-streams-mode",
      "main-stem-mode",
      "bathymetry-mode",
    );
    window.__MM_SCENE__?.clearLithologyPick?.();
    window.__MM_SCENE__?.setJoiningStreams?.(false);
    window.__MM_SCENE__?.setMainStem?.(false);
    window.__MM_SCENE__?.setBathymetry?.(false);
    window.__MM_JOINING_CARD__?.clear?.();
  }

  const geoStatus = wrap.querySelector(".geology-api-status");
  // Never show status text beside geology icons (e.g. “JalNetra is still computing…”).
  function setGeoStatus(_text) {
    if (!geoStatus) return;
    geoStatus.hidden = true;
    geoStatus.textContent = "";
  }
  setGeoStatus("");

  function apiClassesOf(result) {
    const rows = result?.legend?.classes;
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .filter((c) => c?.label)
      .map((c, i) => ({
        id: c.id || String(i + 1),
        key: String(i + 1),
        label: c.label,
        color: c.color || "#94a3b8",
        pct: c.pct || c.range || "",
      }));
  }

  function enterGeologyFocus(moduleId, result) {
    const fromApi = apiClassesOf(result);
    let classes = fromApi || [];

    if (moduleId === "bathymetry") {
      classes = fromApi?.length ? fromApi : MANDOVI_BATHYMETRY_CLASSES;
    } else if (!classes.length) {
      if (moduleId === "spectral_lithology") classes = LITHOLOGY_CLASSES;
      else if (moduleId === "bank_erosion") classes = BANK_EROSION_CLASSES;
    }
    if (classes.length) {
      focusTheme.showClasses(classes, "geology", { legendOnly: true });
    } else {
      focusTheme.hide();
    }
    positionUnderGeologyIcon();
  }

  function deactivateModule() {
    activateGen += 1;
    setGeoStatus("");
    clearModuleLayers();
    hideAllPanels();
    setModuleActive(null, null);
    focusTheme.hide();
  }

  async function activateModule(id, opts = {}) {
    document.dispatchEvent(new CustomEvent("river-measure-clear"));
    const mod = GEOLOGY_MODULES.find((m) => m.id === id);
    if (!mod) return;

    const key = opts.key ?? null;
    const allowToggle = opts.toggle !== false;
    if (allowToggle && activeModule === id && (key == null || activeModuleKey === key)) {
      deactivateModule();
      return;
    }

    const gen = ++activateGen;
    setGeoStatus("");
    if (id !== "spectral_lithology" && id !== "bank_erosion" && id !== "main_stem") {
      window.__MM_SCENE__?.hideHydrology?.();
    }
    if (id !== "bank_erosion") {
      state.bankErosionMode = false;
      state.bankErosionTipActive = false;
      root.classList.remove("bank-erosion-mode");
    }
    if (id !== "spectral_lithology") {
      state.lithologyMode = false;
      state.lithologyTipActive = false;
      root.classList.remove("lithology-mode");
      window.__MM_SCENE__?.clearLithologyPick?.();
    }
    if (id !== "joining_streams") {
      state.joiningStreamsMode = false;
      state.joiningStreamsTipActive = false;
      root.classList.remove("joining-streams-mode");
      window.__MM_SCENE__?.setJoiningStreams?.(false);
      window.__MM_JOINING_CARD__?.clear?.();
    }
    if (id !== "main_stem") {
      state.mainStemMode = false;
      root.classList.remove("main-stem-mode");
      window.__MM_SCENE__?.setMainStem?.(false);
    }
    if (id !== "bathymetry") {
      state.bathymetryMode = false;
      root.classList.remove("bathymetry-mode");
      window.__MM_SCENE__?.setBathymetry?.(false);
    }
    setModuleActive(id, key);
    showPanel(id);

    if (id === "joining_streams") {
      try {
        state.joiningStreamsMode = true;
        root.classList.add("joining-streams-mode");
        await ensureStreamsBodCod().catch(() => null);
        const result = window.__MM_SCENE__?.setJoiningStreams?.(true);
        if (gen !== activateGen) return;
        const count = Number(result?.count ?? window.__MM_SCENE__?.getJoiningStreamCount?.() ?? 0);
        const wqStreams = listStreamsBodCod();
        const wqCount = wqStreams.length || getStreamsBodCodCount();
        refreshJoiningSummary();
        // No status text beside the geology icons.
        setGeoStatus("");
        if (count >= 1) {
          // Keep overview of all Upstream 01–05 (activate already framed them).
          window.__MM_SCENE__?.overviewJoiningStreams?.();
        } else if (wqCount > 0) {
          // Tip-connect failed — still list all given Upstream BOD/COD rows.
          const first = wqStreams[0];
          if (first?.name) {
            const hit = window.__MM_SCENE__?.selectJoiningStreamByName?.(first.name);
            if (!hit) {
              showJoiningCard({
                name: first.name,
                displayName: first.name,
                meta: { name: first.name, waterway: "stream" },
                connectsToRiver: false,
                outletLon: first.lon,
                outletLat: first.lat,
              });
            }
          }
        }
        enterGeologyFocus(id);
      } catch (err) {
        state.joiningStreamsMode = false;
        root.classList.remove("joining-streams-mode");
        console.warn("[geology] Joining streams:", err);
        deactivateModule();
      }
      return;
    }

    if (id === "main_stem") {
      try {
        state.mainStemMode = true;
        root.classList.add("main-stem-mode");
        setGeoStatus("");
        const result = window.__MM_SCENE__?.setMainStem?.(true);
        if (gen !== activateGen) return;
        if (result && result.available === false) {
          state.mainStemMode = false;
          root.classList.remove("main-stem-mode");
          hideAllPanels();
          setModuleActive(null, null);
          focusTheme.hide();
          console.warn("[geology] Main stem layer unavailable", result);
        } else {
          enterGeologyFocus(id);
        }
      } catch (err) {
        state.mainStemMode = false;
        root.classList.remove("main-stem-mode");
        hideAllPanels();
        setModuleActive(null, null);
        focusTheme.hide();
        console.warn("[geology] Main stem:", err);
      }
      return;
    }

    if (id === "spectral_lithology") {
      try {
        state.lithologyMode = true;
        root.classList.add("lithology-mode");
        setGeoStatus("Fetching Spectral Lithology from JalNetra…");
        showPanel(id);
        enterGeologyFocus(id);
        let result = await window.__MM_SCENE__?.showHydrologyLayer?.("geology");
        // Retry once if Earth Engine was still pending
        if (result?.loading || result?.available === false) {
          setGeoStatus("Spectral Lithology still computing — retrying…");
          await new Promise((r) => setTimeout(r, 2500));
          result = await window.__MM_SCENE__?.showHydrologyLayer?.("geology");
        }
        if (gen !== activateGen) return;
        if (result && result.available === false) {
          setGeoStatus(
            result.reason ||
              result.message ||
              "Spectral Lithology is still loading for this river. Leave Geology open — it will appear when JalNetra returns.",
          );
          console.warn("[geology] Spectral lithology layer:", result);
        } else {
          setGeoStatus("");
          enterGeologyFocus(id, result);
        }
      } catch (err) {
        state.lithologyMode = false;
        root.classList.remove("lithology-mode");
        focusTheme.hide();
        setGeoStatus("Spectral Lithology failed to load.");
        console.warn("[geology] Spectral lithology:", err);
      }
      return;
    }

    if (id === "bank_erosion") {
      try {
        // Keep river water on — erosion drapes over the water sheet.
        state.hydrologyHidesWater = false;
        state.hydrologyHidesFlood = false;
        state.showWater = true;
        state.bankErosionMode = true;
        root.classList.add("bank-erosion-mode");
        setGeoStatus("Fetching Bank Erosion from JalNetra…");
        showPanel(id);
        enterGeologyFocus(id);
        let result = await window.__MM_SCENE__?.showHydrologyLayer?.("bank_erosion");
        if (result?.loading || result?.superseded || (!result?.available && result?.ok !== false)) {
          setGeoStatus("Bank Erosion still computing — retrying…");
          await new Promise((r) => setTimeout(r, 2500));
          result = await window.__MM_SCENE__?.showHydrologyLayer?.("bank_erosion");
        }
        if (gen !== activateGen) return;
        if (result?.available && result?.ok !== false && !result?.superseded) {
          state.hydrologyHidesWater = false;
          state.showWater = true;
          state.bankErosionMode = true;
          root.classList.add("bank-erosion-mode");
          setGeoStatus("");
          enterGeologyFocus(id, result);
        } else {
          setGeoStatus(
            result?.reason ||
              result?.message ||
              "Bank Erosion is still loading for this river. Leave Geology open — it will appear when JalNetra returns.",
          );
          console.warn("[geology] Bank erosion layer:", result);
        }
      } catch (err) {
        state.hydrologyHidesWater = false;
        state.hydrologyHidesFlood = false;
        state.bankErosionMode = false;
        state.bankErosionTipActive = false;
        root.classList.remove("bank-erosion-mode");
        focusTheme.hide();
        setGeoStatus("Bank Erosion failed to load.");
        console.warn("[geology] Bank erosion:", err);
      }
      return;
    }

    if (id === "bathymetry") {
      // Same Bathymetry Colour Overlay previously under Water Quality (depth-zone paint).
      try {
        window.__MM_SCENE__?.hideHydrology?.();
        state.bathymetryMode = true;
        root.classList.add("bathymetry-mode");
        setGeoStatus("");
        const result = window.__MM_SCENE__?.setBathymetry?.(true);
        if (gen !== activateGen) return;
        if (result?.ok === false) {
          state.bathymetryMode = false;
          root.classList.remove("bathymetry-mode");
          hideAllPanels();
          setModuleActive(null, null);
          focusTheme.hide();
          setGeoStatus(result?.message || "Bathymetry colour overlay unavailable.");
          return;
        }
        enterGeologyFocus(id, result);
        // Keep the user's current camera — do not zoom to full KML.
      } catch (err) {
        state.bathymetryMode = false;
        root.classList.remove("bathymetry-mode");
        hideAllPanels();
        setModuleActive(null, null);
        focusTheme.hide();
        window.__MM_SCENE__?.setBathymetry?.(false);
        console.warn("[geology] Bathymetry Colour Overlay:", err);
      }
      return;
    }
  }

  wrap.querySelectorAll("[data-geo-module]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void activateModule(btn.dataset.geoModule, { key: btn.dataset.geoKey || null });
      positionUnderGeologyIcon();
    });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  });

  function positionUnderGeologyIcon() {
    // Always center horizontally (Geology is first nav icon — anchoring under it shifts left)
    wrap.style.left = "50%";
    wrap.style.transform = "translateX(-50%)";
    if (state.mapFocusKind === "geology" || root.classList.contains("geology-focus")) {
      wrap.classList.add("geology-workspace--top");
      wrap.style.top = `calc(max(14px, env(safe-area-inset-top)) + 12px)`;
      return;
    }
    wrap.classList.remove("geology-workspace--top");
    wrap.style.top = "calc(max(14px, env(safe-area-inset-top)) + 62px)";
  }

  function onResize() {
    if (!wrap.hidden) positionUnderGeologyIcon();
  }

  function onFocusChange() {
    if (!wrap.hidden) positionUnderGeologyIcon();
  }

  return {
    el: wrap,
    open(moduleId = null) {
      wrap.hidden = false;
      root.classList.add("geology-open");
      positionUnderGeologyIcon();
      void wrap.offsetWidth;
      wrap.classList.add("is-open");
      window.addEventListener("resize", onResize);
      document.addEventListener("map-focus-change", onFocusChange);
      // Toolbar only — Main Stem / Bathymetry (and other) panels stay off until clicked.
      if (moduleId) void activateModule(moduleId, { toggle: false });
      else deactivateModule();
      document.dispatchEvent(
        new CustomEvent("analytics-submenu-change", { detail: { on: true, kind: "geology" } }),
      );
    },
    close() {
      wrap.classList.remove("is-open", "geology-workspace--top");
      root.classList.remove("geology-open");
      deactivateModule();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("map-focus-change", onFocusChange);
      wrap.hidden = true;
      document.dispatchEvent(
        new CustomEvent("analytics-submenu-change", { detail: { on: false, kind: "geology" } }),
      );
    },
    isOpen: () => !wrap.hidden,
    getActiveModule: () => activeModule,
    activateModule,
    reposition: positionUnderGeologyIcon,
  };
}
