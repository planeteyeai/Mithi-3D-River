/**
 * Proximity-based important-area labels for the Mithi digital twin.
 *
 * Shows only whitelist geographical names when the navigation ground position
 * is within AREA_LABEL_SHOW_M of the area (boundary / soft footprint).
 * Camera zoom distance is ignored — only ground-plane metres matter.
 */
import * as THREE from "three";
import { state } from "../state.js";
import { SURFACE_Y } from "./river.js";
import { interpolateChainage } from "../geo/chainage.js";
import { lonLatToLocal } from "../geo/geoReference.js";
import {
  AREA_LABEL_HIDE_M,
  AREA_LABEL_SHOW_M,
  distanceToArea,
  resolveImportantAreas,
} from "./importantAreas.js";

const UPDATE_MOVE_M = 4;
const UPDATE_MIN_MS = 120;
const MAX_VISIBLE = 2;
const EDGE_PX = 10;
const LIFT_PX = 28;

/**
 * @param {object} dataset
 * @param {{ getNavPosition?: () => { x: number, z: number } | null }} [opts]
 */
export function createAreaLabels(dataset, opts = {}) {
  document.querySelectorAll(".area-label-layer").forEach((el) => el.remove());

  const layer = document.createElement("div");
  layer.className = "area-label-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  const chainage = [...(dataset.chainage || [])].sort((a, b) => (a.meters ?? 0) - (b.meters ?? 0));
  let areas = resolveImportantAreas(dataset, (lon, lat) => {
    try {
      return lonLatToLocal(lon, lat);
    } catch {
      return null;
    }
  });

  /** @type {Map<string, any>} */
  const items = new Map();

  function ensureDom(area) {
    let it = items.get(area.id);
    if (it) return it;
    const el = document.createElement("div");
    el.className = "area-label";
    el.dataset.areaId = area.id;
    el.innerHTML = `<span class="area-label__text"></span>`;
    el.querySelector(".area-label__text").textContent = area.name;
    layer.appendChild(el);
    it = {
      area,
      el,
      world: new THREE.Vector3(area.x, SURFACE_Y + 2.2, area.z),
      near: false,
      shown: false,
      geoDist: Infinity,
      w: 0,
      h: 0,
    };
    items.set(area.id, it);
    return it;
  }

  for (const a of areas) ensureDom(a);

  // Lightweight spatial hash for candidate lookup (cell ~80 m)
  const CELL = 80;
  /** @type {Map<string, string[]>} */
  let grid = new Map();

  function rebuildGrid() {
    grid = new Map();
    for (const a of areas) {
      const reach = (a.radiusM || 0) + AREA_LABEL_HIDE_M + 40;
      const i0 = Math.floor((a.x - reach) / CELL);
      const i1 = Math.floor((a.x + reach) / CELL);
      const j0 = Math.floor((a.z - reach) / CELL);
      const j1 = Math.floor((a.z + reach) / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = `${i}:${j}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(a.id);
        }
      }
    }
  }
  rebuildGrid();

  function candidatesNear(nx, nz) {
    const ids = new Set();
    const i = Math.floor(nx / CELL);
    const j = Math.floor(nz / CELL);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = grid.get(`${i + di}:${j + dj}`);
        if (list) for (const id of list) ids.add(id);
      }
    }
    // Always include all whitelist ids if grid sparse (tiny set)
    if (ids.size === 0) for (const a of areas) ids.add(a.id);
    return [...ids].map((id) => items.get(id)).filter(Boolean);
  }

  function defaultNavPosition() {
    if (typeof opts.getNavPosition === "function") {
      const p = opts.getNavPosition();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return p;
    }
    const m = state.selectedChainageMeters;
    if (Number.isFinite(m) && chainage.length) {
      const pt = interpolateChainage(chainage, m);
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.z)) return { x: pt.x, z: pt.z };
    }
    return null;
  }

  let lastNav = null;
  let lastAt = 0;
  let sizeDirty = true;
  window.addEventListener("resize", () => {
    sizeDirty = true;
  });

  const proj = new THREE.Vector3();

  function hide(it) {
    if (!it.near && !it.shown) return;
    it.near = false;
    it.shown = false;
    it.el.classList.remove("is-visible");
  }

  function updateProximity(it, nav) {
    it.geoDist = distanceToArea(nav.x, nav.z, it.area);
    if (it.geoDist <= AREA_LABEL_SHOW_M) it.near = true;
    else if (it.geoDist >= AREA_LABEL_HIDE_M) it.near = false;
    return it.near;
  }

  function update(camera, navHint = null) {
    const enabled = !!camera && !state.cinematicActive && state.showPlaceNames !== false;
    layer.hidden = !enabled;
    if (!enabled) {
      for (const it of items.values()) hide(it);
      return;
    }

    const nav = navHint && Number.isFinite(navHint.x) ? navHint : defaultNavPosition();
    if (!nav) {
      for (const it of items.values()) hide(it);
      return;
    }

    const now = performance.now();
    const moved =
      !lastNav ||
      Math.hypot(nav.x - lastNav.x, nav.z - lastNav.z) >= UPDATE_MOVE_M ||
      now - lastAt >= UPDATE_MIN_MS * 4;

    // Always allow screen placement every frame for visible ones; proximity recompute throttled
    if (moved || now - lastAt >= UPDATE_MIN_MS) {
      lastNav = { x: nav.x, z: nav.z };
      lastAt = now;
      const cands = candidatesNear(nav.x, nav.z);
      for (const it of items.values()) {
        if (!cands.includes(it)) {
          // Still update far items infrequently via hide path
          if (it.near) updateProximity(it, nav);
          if (!it.near) hide(it);
          continue;
        }
        updateProximity(it, nav);
        if (!it.near) hide(it);
      }
    }

    if (sizeDirty) {
      for (const it of items.values()) {
        it.w = it.el.offsetWidth || it.w;
        it.h = it.el.offsetHeight || it.h;
      }
      sizeDirty = [...items.values()].some((it) => !it.w);
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nearItems = [...items.values()]
      .filter((it) => it.near)
      .sort((a, b) => a.geoDist - b.geoDist || b.area.priority - a.area.priority);

    const placed = [];
    let shown = 0;
    for (const it of nearItems) {
      if (shown >= MAX_VISIBLE) {
        hide(it);
        continue;
      }
      proj.copy(it.world).project(camera);
      const ax = (proj.x * 0.5 + 0.5) * vw;
      const ay = (1 - (proj.y * 0.5 + 0.5)) * vh;
      if (proj.z > 1 || proj.z < -1 || ax < 0 || ax > vw || ay < 0 || ay > vh) {
        hide(it);
        continue;
      }
      const w = it.w || 120;
      const h = it.h || 22;
      // Prefer above anchor; fall back to slight side offsets to avoid overlap
      const slots = [
        [0, -1],
        [-0.55, -1],
        [0.55, -1],
        [0, 1],
        [-0.55, 1],
        [0.55, 1],
      ];
      let rect = null;
      for (const [fx, fy] of slots) {
        const x0 = ax - w / 2 + fx * w;
        const y0 = fy < 0 ? ay - LIFT_PX - h : ay + LIFT_PX * 0.5;
        const r = { x0, y0, x1: x0 + w, y1: y0 + h };
        if (r.x0 < EDGE_PX || r.x1 > vw - EDGE_PX || r.y0 < EDGE_PX || r.y1 > vh - EDGE_PX) continue;
        let hit = false;
        for (const o of placed) {
          if (r.x0 < o.x1 + 6 && r.x1 > o.x0 - 6 && r.y0 < o.y1 + 6 && r.y1 > o.y0 - 6) {
            hit = true;
            break;
          }
        }
        if (hit) continue;
        rect = r;
        break;
      }
      if (!rect) {
        hide(it);
        continue;
      }
      placed.push(rect);
      shown++;
      it.shown = true;
      it.el.classList.add("is-visible");
      it.el.style.transform = `translate(${Math.round(rect.x0)}px, ${Math.round(rect.y0)}px)`;
    }

    // Hide non-near
    for (const it of items.values()) {
      if (!it.near) hide(it);
    }
  }

  function refresh(newDataset) {
    const ds = newDataset || dataset;
    areas = resolveImportantAreas(ds, (lon, lat) => {
      try {
        return lonLatToLocal(lon, lat);
      } catch {
        return null;
      }
    });
    for (const it of items.values()) it.el.remove();
    items.clear();
    for (const a of areas) ensureDom(a);
    rebuildGrid();
    sizeDirty = true;
    lastNav = null;
    console.info(
      "[areaLabels] important areas:",
      areas.length,
      areas.map((a) => `${a.name} (${a.source})`),
    );
  }

  refresh(dataset);

  return {
    update,
    refresh,
    dispose() {
      layer.remove();
      items.clear();
    },
    items: () =>
      [...items.values()].map((it) => ({
        id: it.area.id,
        name: it.area.name,
        near: it.near,
        shown: it.shown,
        geoDist: it.geoDist,
      })),
  };
}
