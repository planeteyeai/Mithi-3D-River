/**
 * Always-on Mithi depth from src/data/mithi_river_depth.kml.
 * Samples the Green→Red depth GroundOverlay into corridor / live-water aDepth.
 */
import * as THREE from "three";
import { localToLonLat } from "./geoReference.js";

/** Exact LatLonBox from mithi_river_depth.kml */
export const MITHI_DEPTH_BOUNDS = {
  north: 19.08782672,
  south: 19.04514933,
  east: 72.87929619,
  west: 72.83456075,
};

/** Product depth envelope from the KML description (0.2–5.5 m). */
export const MITHI_DEPTH_MIN_M = 0.2;
export const MITHI_DEPTH_MAX_M = 5.5;

export const MITHI_DEPTH_OVERLAY_URL = "/data/mithi/mithi_river_depth_overlay.png";
export const MITHI_DEPTH_META_URL = "/data/mithi/mithi_river_water_depth.json";

/** Bright cerulean legend classes (0.2–5.5 m) — no navy/black deep. */
export const MITHI_DEPTH_CLASSES = [
  { id: "shallow", label: "Shallow (<1.5 m)", color: "#8FEAF8", range: "< 1.5 m", minDepth: 0.2, maxDepth: 1.5 },
  { id: "moderate", label: "Moderate (1.5–3.0 m)", color: "#55C4EE", range: "1.5–3.0 m", minDepth: 1.5, maxDepth: 3.0 },
  { id: "medium_deep", label: "Medium-Deep (3.0–4.5 m)", color: "#3AA0D6", range: "3.0–4.5 m", minDepth: 3.0, maxDepth: 4.5 },
  { id: "deep", label: "Deep (>4.5 m)", color: "#2B86C0", range: "> 4.5 m", minDepth: 4.5, maxDepth: 5.5 },
];

const GYOR = [
  [0x00, 0xa6, 0x51],
  [0xff, 0xff, 0x00],
  [0xff, 0xa5, 0x00],
  [0xff, 0x00, 0x00],
];

/**
 * Green→Yellow→Orange→Red pixel → depth metres.
 * @returns {number|null}
 */
export function gyorPixelToDepth(r, g, b, a, minM = MITHI_DEPTH_MIN_M, maxM = MITHI_DEPTH_MAX_M) {
  if (a < 16) return null;
  // Pure blue live-water pixels are not depth — skip.
  if (b > r + 50 && b > g + 30 && r < 70) return null;

  let bestT = 0.5;
  let bestD = Infinity;
  const steps = 48;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const f = t * (GYOR.length - 1);
    const k = Math.min(GYOR.length - 2, Math.floor(f));
    const w = f - k;
    const c0 = GYOR[k];
    const c1 = GYOR[k + 1];
    const dr = c0[0] + (c1[0] - c0[0]) * w - r;
    const dg = c0[1] + (c1[1] - c0[1]) * w - g;
    const db = c0[2] + (c1[2] - c0[2]) * w - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }

  // Fallback hue heuristic if far from ramp
  if (bestD > 90 * 90) {
    if (g >= r && g >= b) bestT = r > 40 ? 0.2 + (r / 255) * 0.25 : 0.05 + (g / 255) * 0.15;
    else if (r >= g && r >= b) bestT = 0.55 + (1 - g / 255) * 0.4;
    else bestT = 0.45;
  }

  const span = Math.max(0.05, maxM - minM);
  return minM + Math.max(0, Math.min(1, bestT)) * span;
}

/**
 * Load depth raster + bounds/meta for always-on sampling.
 */
export async function loadMithiDepthRaster() {
  let minM = MITHI_DEPTH_MIN_M;
  let maxM = MITHI_DEPTH_MAX_M;
  let bounds = { ...MITHI_DEPTH_BOUNDS };
  try {
    const meta = await fetch(MITHI_DEPTH_META_URL, { cache: "force-cache" }).then((r) =>
      r.ok ? r.json() : null,
    );
    if (meta?.bounds) bounds = { ...bounds, ...meta.bounds };
    // Prefer product range from KML description when meta still has a wider scale.
    if (Number.isFinite(meta?.minDepth) && Number.isFinite(meta?.maxDepth)) {
      // Clamp to documented product envelope when meta is the class legend (0.5–8).
      minM = Math.max(MITHI_DEPTH_MIN_M, Number(meta.minDepth));
      maxM = Math.min(MITHI_DEPTH_MAX_M, Number(meta.maxDepth));
      if (maxM - minM < 1) {
        minM = MITHI_DEPTH_MIN_M;
        maxM = MITHI_DEPTH_MAX_M;
      }
    }
  } catch {
    /* defaults */
  }

  const res = await fetch(`${MITHI_DEPTH_OVERLAY_URL}?v=mithi-depth-always-on`, {
    cache: "force-cache",
  });
  if (!res.ok) throw new Error(`depth overlay ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, width, height);

  const sampleAtLonLat = (lon, lat) => {
    const { north, south, east, west } = bounds;
    if (!(lon >= west && lon <= east && lat >= south && lat <= north)) return null;
    const u = (lon - west) / Math.max(1e-12, east - west);
    const v = (north - lat) / Math.max(1e-12, north - south);
    const ix = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const iy = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    const o = (iy * width + ix) * 4;
    return gyorPixelToDepth(data[o], data[o + 1], data[o + 2], data[o + 3], minM, maxM);
  };

  const sampleAtLocal = (x, z) => {
    try {
      const ll = localToLonLat(x, z);
      return sampleAtLonLat(ll.lon, ll.lat);
    } catch {
      return null;
    }
  };

  return {
    available: true,
    bounds,
    width,
    height,
    min_m: minM,
    max_m: maxM,
    sampleAtLonLat,
    sampleAtLocal,
    source: "mithi_river_depth.kml",
  };
}

/**
 * Write sampled depths into dataset.bathymetry + river mesh aDepth.
 * @returns {{ applied: number, depthRange: number[], source: string } | null}
 */
export function applyMithiDepthToRiver(dataset, river, sampler) {
  const bath = dataset?.bathymetry;
  if (!bath?.depths?.length || !sampler?.sampleAtLocal) return null;

  const pos = bath.positions || river?.mesh?.geometry?.attributes?.position?.array;
  const n = bath.depths.length;
  let applied = 0;
  let minD = Infinity;
  let maxD = -Infinity;

  for (let i = 0; i < n; i++) {
    const x = pos ? pos[i * 3] : null;
    const z = pos ? pos[i * 3 + 2] : null;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const d = sampler.sampleAtLocal(x, z);
    if (d == null || !Number.isFinite(d)) continue;
    bath.depths[i] = d;
    applied++;
    minD = Math.min(minD, d);
    maxD = Math.max(maxD, d);
  }

  if (applied < 8) return null;

  // Spatial smooth so depth colours don't look like hard paint polygons.
  const across = dataset.corridor?.across ?? bath.across ?? 36;
  const cols = across + 1;
  const rows = Math.floor(n / cols);
  if (rows > 2 && cols > 2) {
    const src = Float32Array.from(bath.depths);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        let sum = 0;
        let w = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (r + dy) * cols + (c + dx);
            const v = src[j];
            if (!Number.isFinite(v)) continue;
            const ww = dx === 0 && dy === 0 ? 2.2 : 1;
            sum += v * ww;
            w += ww;
          }
        }
        if (w > 0) bath.depths[i] = sum / w;
      }
    }
    // Second pass for softer seams
    const src2 = Float32Array.from(bath.depths);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        bath.depths[i] =
          (src2[i] * 2 +
            src2[i - 1] +
            src2[i + 1] +
            src2[i - cols] +
            src2[i + cols]) /
          6;
      }
    }
    minD = Infinity;
    maxD = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = bath.depths[i];
      if (!Number.isFinite(v)) continue;
      minD = Math.min(minD, v);
      maxD = Math.max(maxD, v);
    }
  }

  dataset.minDepth = minD;
  dataset.maxDepth = maxD;
  bath.minDepth = minD;
  bath.maxDepth = maxD;
  bath.source = sampler.source || "mithi_river_depth.kml";
  bath.mithiDepthApplied = true;

  // Push into river surface / bed attributes
  for (const mesh of [river?.mesh, river?.bed]) {
    const attr = mesh?.geometry?.attributes?.aDepth;
    if (!attr) continue;
    const arr = attr.array;
    const count = Math.min(arr.length, bath.depths.length);
    for (let i = 0; i < count; i++) arr[i] = bath.depths[i];
    attr.needsUpdate = true;
  }

  // Station thalweg depth for HUD / measures
  const stations = dataset.corridor?.stations || [];
  for (let s = 0; s < stations.length; s++) {
    const mid = s * cols + Math.floor((cols - 1) / 2);
    if (Number.isFinite(bath.depths[mid])) stations[s].depth = bath.depths[mid];
  }

  return {
    applied,
    depthRange: [minD, maxD],
    source: bath.source,
  };
}

/**
 * Update live-water sheet aDepth from the same sampler.
 */
export function applyMithiDepthToLiveWater(liveWaterSurface, sampler) {
  const geo = liveWaterSurface?.surface?.geometry || liveWaterSurface?.mesh?.geometry;
  const attr = geo?.attributes?.aDepth;
  const pos = geo?.attributes?.position;
  if (!attr || !pos || !sampler?.sampleAtLocal) return 0;
  const n = attr.count;
  let applied = 0;
  const fallback = Number.isFinite(sampler.min_m) ? sampler.min_m : MITHI_DEPTH_MIN_M;
  // Neighbour search so thin mask gaps still get a class colour.
  const sampleSoft = (x, z) => {
    let d = sampler.sampleAtLocal(x, z);
    if (d != null && Number.isFinite(d)) return d;
    const step = 6;
    for (const [dx, dz] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
      [step, step],
      [-step, step],
      [step, -step],
      [-step, -step],
    ]) {
      d = sampler.sampleAtLocal(x + dx, z + dz);
      if (d != null && Number.isFinite(d)) return d;
    }
    return fallback;
  };
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const d = sampleSoft(x, z);
    attr.array[i] = d;
    applied++;
  }
  // Light blur so class regions read continuous (not speckled).
  if (applied > 32) {
    const src = Float32Array.from(attr.array);
    const idx = geo.index?.array;
    if (idx?.length) {
      const acc = new Float32Array(n);
      const wts = new Float32Array(n);
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t];
        const b = idx[t + 1];
        const c = idx[t + 2];
        const avg = (src[a] + src[b] + src[c]) / 3;
        acc[a] += avg;
        acc[b] += avg;
        acc[c] += avg;
        wts[a] += 1;
        wts[b] += 1;
        wts[c] += 1;
      }
      for (let i = 0; i < n; i++) {
        if (wts[i] > 0) attr.array[i] = src[i] * 0.55 + (acc[i] / wts[i]) * 0.45;
      }
    }
  }
  if (applied) attr.needsUpdate = true;

  const bedAttr = liveWaterSurface?.bed?.geometry?.attributes?.aDepth;
  const bedPos = liveWaterSurface?.bed?.geometry?.attributes?.position;
  if (bedAttr && bedPos) {
    for (let i = 0; i < bedAttr.count; i++) {
      bedAttr.array[i] = sampleSoft(bedPos.getX(i), bedPos.getZ(i));
    }
    bedAttr.needsUpdate = true;
  }
  return applied;
}
