/**
 * Live Water Surface — exact footprint from uploaded water_depth (1).kml
 * (Sentinel-2 MNDWI GroundOverlay → mithi_river_water_overlay.png).
 *
 * Dense solid-quad sheet from the STRICT MNDWI mask.
 * Under-bridge gaps are sealed only where water already exists on both sides
 * inside the channel — banks are never expanded / no corridor invent.
 */
import * as THREE from "three";
import { geoToWorld } from "../geo/geoReference.js";
import { loadLiveWaterMask, LIVE_WATER_BOUNDS } from "../geo/liveWaterMask.js";
import { VISUAL_LOCK } from "../config/visualLock.js";
import {
  SURFACE_Y,
  DEPTH_LEGEND_MIN,
  DEPTH_LEGEND_MAX,
  getHydrographicColor,
  bedElevation,
} from "../scene/river.js";
import { createWaterMaterial, syncWaterMaterial } from "../scene/waterShader.js";
import { state } from "../state.js";

/**
 * @param {THREE.Scene} scene
 * @param {{
 *   dataset?: object,
 *   sharedMaterial?: THREE.ShaderMaterial,
 *   getTerrainY?: (x:number,z:number)=>number,
 *   getSurfaceY?: () => number,
 *   getVisibility?: () => boolean,
 * }} [opts]
 */
export async function addLiveWaterSurfaceLayer(scene, opts = {}) {
  const dataset = opts.dataset || null;
  const sharedMaterial = opts.sharedMaterial || null;
  const getSurfaceY = opts.getSurfaceY || (() => SURFACE_Y);

  const mask = await loadLiveWaterMask();
  if (!mask.available) {
    console.warn("[liveWaterSurface] mask unavailable — skipping live water mesh");
    return { group: null, mask, material: null, dispose() {}, setVisible() {}, refresh() {} };
  }

  const group = new THREE.Group();
  group.name = "LiveWaterSurface_Mandovi_KML";
  scene.add(group);

  const built = buildStrictKmlWaterMesh(mask, dataset, getSurfaceY(), sharedMaterial);
  if (!built) {
    console.warn("[liveWaterSurface] failed to build mesh");
    return { group, mask, material: null, dispose() {}, setVisible() {}, refresh() {} };
  }

  const { surface, bed, material, ownsMaterial } = built;
  group.add(surface);
  if (bed) {
    bed.visible = false;
    group.add(bed);
  }

  // Shared corridor material must pick up the muted Mithi palette.
  if (material?.uniforms) {
    material.uniforms.uMinDepth.value = Number.isFinite(dataset?.minDepth)
      ? dataset.minDepth
      : 0.5;
    material.uniforms.uMaxDepth.value = Number.isFinite(dataset?.maxDepth)
      ? Math.min(dataset.maxDepth, 5.0)
      : 5.0;
    syncWaterMaterial(material);
  }

  const api = {
    group,
    mask,
    material,
    surface,
    bed,
    setVisible(v) {
      group.visible = !!v;
    },
    refresh() {
      const y = getSurfaceY();
      const rise =
        (state.floodMode === "api" ? Number(state.floodRiseM) || 0 : 0) +
        (Number(state.liveStageRiseM) || 0);
      group.position.y = y - SURFACE_Y + rise;
      if (material?.uniforms) {
        if (material.uniforms.uTime) material.uniforms.uTime.value = state.elapsed || 0;
        syncWaterMaterial(material);
      }
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material && o.material !== sharedMaterial) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material.dispose?.();
        }
      });
    },
  };

  api.refresh();
  console.info("[liveWaterSurface] strict KML sheet", {
    source: mask.source,
    verts: surface?.geometry?.attributes?.position?.count,
    tris: (surface?.geometry?.index?.count || 0) / 3,
    areaHa: mask.areaHa,
    shared: !!sharedMaterial,
  });
  return api;
}

function buildStationLocator(stations) {
  if (!stations?.length) return () => ({ st: null, dist: Infinity });
  const cell = 40;
  const map = new Map();
  for (const s of stations) {
    const key = `${Math.floor(s.x / cell)},${Math.floor(s.z / cell)}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(s);
  }
  return (x, z) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = null;
    let bestD2 = Infinity;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const bucket = map.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const s of bucket) {
          const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = s;
          }
        }
      }
    }
    if (!best) {
      for (const s of stations) {
        const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = s;
        }
      }
    }
    return { st: best, dist: Math.sqrt(bestD2) };
  };
}

/**
 * Seal dry pockets under bridges / causeways when water already exists inside
 * the observed MNDWI mask on both sides. Never grows the outer shoreline onto
 * land and never invents a continuous corridor ribbon outside the mask.
 */
function sealUnderBridgeWater(bits, width, height, bounds, dataset) {
  const raw = bits;
  let m = fillEnclosedWaterHoles(raw, width, height);
  const afterHoles = countWetBits(m);
  const bridgeFill = new Uint8Array(raw.length);

  const stations = dataset?.corridor?.stations;
  let mPerPx = 2;
  if (stations?.length && bounds) {
    const { north, south, east, west } = bounds;
    const midLat = ((north + south) * 0.5 * Math.PI) / 180;
    mPerPx =
      ((east - west) * 111320 * Math.cos(midLat)) / Math.max(1, width - 1);
    const nearest = buildStationLocator(stations);
    const out = Uint8Array.from(m);
    // Cover typical Mumbai flyover / link-road deck shadows (~20–70 m).
    const search = Math.max(5, Math.min(36, Math.round(70 / Math.max(0.5, mPerPx))));
    const stride = Math.max(2, Math.floor(search / 3));

    for (let py = 0; py < height; py += stride) {
      for (let px = 0; px < width; px += stride) {
        const i = py * width + px;
        if (out[i]) continue;

        const u = px / Math.max(1, width - 1);
        const v = py / Math.max(1, height - 1);
        const lon = west + u * (east - west);
        const lat = north - v * (north - south);
        const w = geoToWorld(lon, lat, 0);
        const { st, dist } = nearest(w.x, w.z);
        if (!st) continue;

        const half = Math.max(
          8,
          Number(st.wetHalfLeft ?? st.wetHalfWidth ?? st.halfWidth) || 16,
          Number(st.wetHalfRight ?? st.wetHalfWidth ?? st.halfWidth) || 16,
        );
        // Stay well inside observed wet banks — do not invent floodplain water.
        if (dist > half * 0.95) continue;

        let left = false;
        let right = false;
        let up = false;
        let down = false;
        for (let s = 1; s <= search; s++) {
          if (px - s >= 0 && raw[py * width + (px - s)]) left = true;
          if (px + s < width && raw[py * width + (px + s)]) right = true;
          if (py - s >= 0 && raw[(py - s) * width + px]) up = true;
          if (py + s < height && raw[(py + s) * width + px]) down = true;
        }
        const crossed = (left && right) || (up && down);
        if (!crossed) {
          if (dist > half * 0.6) continue;
          let near = false;
          for (let s = 1; s <= search && !near; s++) {
            if (px - s >= 0 && raw[py * width + (px - s)]) near = true;
            else if (px + s < width && raw[py * width + (px + s)]) near = true;
            else if (py - s >= 0 && raw[(py - s) * width + px]) near = true;
            else if (py + s < height && raw[(py + s) * width + px]) near = true;
          }
          if (!near) continue;
        }

        const r = Math.max(2, Math.round(search * 0.45));
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (!raw[ni]) bridgeFill[ni] = 1;
            out[ni] = 1;
          }
        }
      }
    }
    m = out;
  }

  const beforeHole2 = Uint8Array.from(m);
  m = fillEnclosedWaterHoles(m, width, height);
  for (let i = 0; i < m.length; i++) {
    if (m[i] && !beforeHole2[i] && !raw[i]) bridgeFill[i] = 1;
  }

  // Shoreline: tight 1px. Bridge seals only near original MNDWI water.
  // No corridor continuous fill — that invented artificial river width.
  const shoreApron = dilateBits(raw, width, height, 1);
  const maxDilate = Number(VISUAL_LOCK.water?.maxDilatePx) || 28;
  const bridgeApronPx = Math.min(
    maxDilate,
    Math.max(3, Math.round(90 / Math.max(0.5, mPerPx))),
  );
  const bridgeApron = dilateBits(raw, width, height, bridgeApronPx);
  let filled = 0;
  let clamped = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || raw[i]) continue;
    const keep = shoreApron[i] || (bridgeFill[i] && bridgeApron[i]);
    if (keep) {
      filled++;
    } else {
      m[i] = 0;
      clamped++;
    }
  }

  console.info("[liveWaterSurface] under-bridge seal (no corridor invent)", {
    rawWet: countWetBits(raw),
    afterEnclosedHoles: afterHoles,
    bridgeApronPx,
    filledInside: filled,
    clampedOffApron: clamped,
    finalWet: countWetBits(m),
  });
  return m;
}

function fillEnclosedWaterHoles(src, width, height) {
  const exterior = new Uint8Array(src.length);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (src[i] || exterior[i]) return;
    exterior[i] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] || !exterior[i] ? 1 : 0;
  }
  return out;
}

/**
 * Fast morphological dilate — single pass with squared radius.
 * (Old N-pass 3×3 dilate froze the page when apronPx was ~60–120.)
 */
function dilateBits(src, width, height, radius = 1) {
  const r = Math.max(0, Math.min(48, Math.floor(radius)));
  if (r <= 0) return Uint8Array.from(src);
  if (r === 1) {
    const next = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (src[i]) {
          next[i] = 1;
          continue;
        }
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (src[ny * width + nx]) {
              next[i] = 1;
              break outer;
            }
          }
        }
      }
    }
    return next;
  }

  const next = new Uint8Array(src.length);
  const r2 = r * r;
  // Seed from wet pixels only — O(wet × r²) instead of O(W×H×r) passes.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!src[y * width + x]) continue;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      for (let ny = y0; ny <= y1; ny++) {
        const dy = ny - y;
        const dy2 = dy * dy;
        for (let nx = x0; nx <= x1; nx++) {
          const dx = nx - x;
          if (dx * dx + dy2 <= r2) next[ny * width + nx] = 1;
        }
      }
    }
  }
  return next;
}

function countWetBits(bits) {
  let n = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) n++;
  return n;
}

/**
 * Dense grid from the KML mask (+ under-bridge seals inside the channel).
 * - Full quads when all 4 corners are wet
 * - Edge triangles when exactly 3 corners are wet (true shoreline)
 * - Never invents verts on dry land outside the KML apron
 */
function buildStrictKmlWaterMesh(mask, dataset, surfaceY, sharedMaterial = null) {
  const { bounds, width, height, mask: rawBits } = mask;
  if (!rawBits || !width || !height) return null;

  // Seal bridge shadows inside existing water — colours untouched.
  const bits = sealUnderBridgeWater(
    rawBits,
    width,
    height,
    bounds || LIVE_WATER_BOUNDS,
    dataset,
  );
  // Keep shared mask in sync (terrain carve / hover use the same footprint).
  if (mask.mask) {
    mask.mask.set(bits);
    let wet = 0;
    for (let i = 0; i < bits.length; i++) if (bits[i]) wet++;
    mask.waterPixels = wet;
  }

  const step = 1;
  const cols = Math.floor((width - 1) / step) + 1;
  const rows = Math.floor((height - 1) / step) + 1;
  if (cols < 2 || rows < 2) return null;

  const { north, south, east, west } = bounds || LIVE_WATER_BOUNDS;
  const sampleWet = (col, row) => {
    const px = Math.min(width - 1, col * step);
    const py = Math.min(height - 1, row * step);
    return bits[py * width + px] === 1;
  };

  const cellKind = new Uint8Array((rows - 1) * (cols - 1));
  const needVert = new Uint8Array(cols * rows);
  let wetCells = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const w00 = sampleWet(col, row);
      const w10 = sampleWet(col + 1, row);
      const w01 = sampleWet(col, row + 1);
      const w11 = sampleWet(col + 1, row + 1);
      const n = (w00 ? 1 : 0) + (w10 ? 1 : 0) + (w01 ? 1 : 0) + (w11 ? 1 : 0);
      if (n < 3) continue;
      cellKind[row * (cols - 1) + col] = n === 4 ? 1 : 2;
      wetCells++;
      if (w00) needVert[row * cols + col] = 1;
      if (w10) needVert[row * cols + col + 1] = 1;
      if (w01) needVert[(row + 1) * cols + col] = 1;
      if (w11) needVert[(row + 1) * cols + col + 1] = 1;
    }
  }
  if (!wetCells) return null;

  const positions = [];
  const depths = [];
  const along = [];
  const across = [];
  const flow = [];
  const narrow = [];
  const widthM = [];
  const curve = [];
  const bedPos = [];
  const bedCol = [];
  const indexOf = new Int32Array(cols * rows).fill(-1);
  const tmp = new THREE.Color();
  const exag = Math.max(1, Number(state.depthExaggeration) || 1);
  const stations = dataset?.corridor?.stations || [];
  const nearestStation = buildStationLocator(stations);
  // Neutral until real depth raster stamps aDepth (no fake depth classes).
  const SHEET_DEPTH = Number.isFinite(dataset?.minDepth) ? dataset.minDepth : 1.2;

  /** Dist to dry (px) → aAcross: 0 at shoreline, 0.5 mid-channel (edge glow only). */
  const shoreDist = (px, py) => {
    const maxR = 10;
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return r;
          if (!bits[ny * width + nx]) return r;
        }
      }
    }
    return maxR;
  };

  let vi = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!needVert[row * cols + col]) continue;
      const px = Math.min(width - 1, col * step);
      const py = Math.min(height - 1, row * step);
      const u = px / Math.max(1, width - 1);
      const v = py / Math.max(1, height - 1);
      const lon = west + u * (east - west);
      const lat = north - v * (north - south);
      const w = geoToWorld(lon, lat, surfaceY);
      const near = nearestStation(w.x, w.z);
      const d = SHEET_DEPTH;
      const toDry = shoreDist(px, py);
      // Attribute only — does not expand geometry beyond the KML mask.
      const acrossVal = THREE.MathUtils.clamp(toDry / 10, 0, 1) * 0.5;

      indexOf[row * cols + col] = vi++;
      // Slightly above carved bed so terrain never peeks through the sheet.
      // Match corridor ribbon lift (SURFACE_Y + 0.55) — no extra vertical offset.
      positions.push(w.x, surfaceY + 0.55, w.z);
      depths.push(d);
      along.push(THREE.MathUtils.clamp(near.st?.t ?? u, 0, 1));
      across.push(acrossVal);
      const fx = Number(near.st?.flowX);
      const fz = Number(near.st?.flowZ);
      if (Number.isFinite(fx) && Number.isFinite(fz) && (fx || fz)) {
        const len = Math.hypot(fx, fz) || 1;
        flow.push(fx / len, fz / len);
      } else {
        flow.push(-1, 0);
      }
      narrow.push(0);
      widthM.push(Math.max(30, Number(near.st?.halfWidth) || 30) * 2);
      curve.push(0);
      const bedY = bedElevation(d, 0.5, 5.0, 0.5, Math.max(1.15, exag));
      bedPos.push(w.x, bedY, w.z);
      getHydrographicColor(d, tmp);
      bedCol.push(tmp.r, tmp.g, tmp.b);
    }
  }

  const indices = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const kind = cellKind[row * (cols - 1) + col];
      if (!kind) continue;
      const a = indexOf[row * cols + col];
      const b = indexOf[row * cols + col + 1];
      const c = indexOf[(row + 1) * cols + col];
      const d = indexOf[(row + 1) * cols + col + 1];
      if (kind === 1) {
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        indices.push(a, c, b, b, c, d);
      } else if (a >= 0 && b >= 0 && c >= 0 && d < 0) {
        indices.push(a, c, b);
      } else if (a >= 0 && b >= 0 && d >= 0 && c < 0) {
        indices.push(a, b, d);
      } else if (a >= 0 && c >= 0 && d >= 0 && b < 0) {
        indices.push(a, c, d);
      } else if (b >= 0 && c >= 0 && d >= 0 && a < 0) {
        indices.push(b, c, d);
      }
    }
  }

  if (positions.length < 9 || indices.length < 3) return null;

  // Smooth interior only — KML shoreline verts stay fixed.
  smoothInteriorOnly(positions, indices, 2, 0.3);

  const surfGeo = new THREE.BufferGeometry();
  const edgeDist = across.map((a) => Math.max(0, 0.5 - a) * 40);
  const riverDist = along.map((t) => t * 6700);
  surfGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  surfGeo.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1));
  surfGeo.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
  surfGeo.setAttribute("aAcross", new THREE.Float32BufferAttribute(across, 1));
  surfGeo.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 2));
  surfGeo.setAttribute("aNarrow", new THREE.Float32BufferAttribute(narrow, 1));
  surfGeo.setAttribute("aWidth", new THREE.Float32BufferAttribute(widthM, 1));
  surfGeo.setAttribute("aCurve", new THREE.Float32BufferAttribute(curve, 1));
  surfGeo.setAttribute("aEdgeDist", new THREE.Float32BufferAttribute(edgeDist, 1));
  surfGeo.setAttribute("aRiverDist", new THREE.Float32BufferAttribute(riverDist, 1));
  surfGeo.setIndex(indices);
  surfGeo.computeVertexNormals();

  const ownsMaterial = !sharedMaterial;
  const material =
    sharedMaterial ||
    createWaterMaterial({
      ...dataset,
      minDepth: Number.isFinite(dataset?.minDepth) ? dataset.minDepth : DEPTH_LEGEND_MIN,
      maxDepth: Number.isFinite(dataset?.maxDepth) ? dataset.maxDepth : DEPTH_LEGEND_MAX,
    });

  const surface = new THREE.Mesh(surfGeo, material);
  surface.name = "LiveWater_KML_Surface";
  surface.renderOrder = 4;
  surface.frustumCulled = false;
  if (material) {
    material.side = THREE.FrontSide;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
    material.flatShading = false;
  }
  surface.userData = {
    kind: "live_water",
    provenance: "OBSERVED",
    source: "water_depth (1).kml MNDWI",
    vertexCount: vi,
    triangleCount: indices.length / 3,
    wetCells,
  };

  const bedGeo = new THREE.BufferGeometry();
  bedGeo.setAttribute("position", new THREE.Float32BufferAttribute(bedPos, 3));
  bedGeo.setAttribute("color", new THREE.Float32BufferAttribute(bedCol, 3));
  bedGeo.setAttribute("colorDepthView", new THREE.Float32BufferAttribute(bedCol.slice(), 3));
  bedGeo.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1));
  bedGeo.setIndex(indices);
  bedGeo.computeVertexNormals();

  const bedMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.04,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.name = "LiveWater_KML_Bed";
  bed.receiveShadow = true;
  bed.renderOrder = 1;
  bed.frustumCulled = false;
  bed.visible = false;
  bed.userData = { kind: "live_water_bed", source: "water_depth (1).kml MNDWI" };

  console.info("[liveWaterSurface] strict-quad sheet", {
    verts: vi,
    tris: indices.length / 3,
    wetCells,
    step,
    cols,
    rows,
    expanded: false,
  });

  return { surface, bed, material, ownsMaterial };
}

function smoothInteriorOnly(positions, indices, iterations = 2, strength = 0.3) {
  const n = positions.length / 3;
  const edgeCount = new Map();
  const addEdge = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
  };
  for (let i = 0; i < indices.length; i += 3) {
    addEdge(indices[i], indices[i + 1]);
    addEdge(indices[i + 1], indices[i + 2]);
    addEdge(indices[i + 2], indices[i]);
  }
  const boundary = new Uint8Array(n);
  const adj = Array.from({ length: n }, () => []);
  for (const [key, count] of edgeCount) {
    const [a, b] = key.split(",").map(Number);
    adj[a].push(b);
    adj[b].push(a);
    if (count === 1) {
      boundary[a] = 1;
      boundary[b] = 1;
    }
  }
  const s = Math.max(0, Math.min(1, strength));
  for (let pass = 0; pass < iterations; pass++) {
    const nx = new Float32Array(n);
    const nz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      nx[i] = positions[i * 3];
      nz[i] = positions[i * 3 + 2];
      if (boundary[i] || !adj[i].length) continue;
      let sx = 0;
      let sz = 0;
      for (const j of adj[i]) {
        sx += positions[j * 3];
        sz += positions[j * 3 + 2];
      }
      const inv = 1 / adj[i].length;
      nx[i] = positions[i * 3] * (1 - s) + sx * inv * s;
      nz[i] = positions[i * 3 + 2] * (1 - s) + sz * inv * s;
    }
    for (let i = 0; i < n; i++) {
      if (boundary[i]) continue;
      positions[i * 3] = nx[i];
      positions[i * 3 + 2] = nz[i];
    }
  }
}
