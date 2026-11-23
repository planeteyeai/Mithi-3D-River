/**
 * Permanent / observed water extent from the uploaded MNDWI GroundOverlay:
 *   src/data/water_depth (1).kml  →  Live Water - 2026-11-07
 *   Frequency 0.5 · Window 2026-10-13..2026-11-12 · ~72.482 ha
 *
 * Authoritative Mithi water footprint — do not invent bay / corridor polygons.
 */
import { localToLonLat } from "./geoReference.js";

/** Preferred public assets written by scripts/polygonize_mithi_water_mask.py */
export const LIVE_WATER_KML_URL = "/data/mithi/mithi_river_water.kml";
export const LIVE_WATER_KML_FALLBACK = "/data/mithi/water_depth_mndwi.kml";
export const LIVE_WATER_PNG_URL = "/data/mithi/mithi_river_water_overlay.png";
export const LIVE_WATER_META_URL = "/data/mithi/live_water_extent.json";
export const LIVE_WATER_POLYGONS_URL = "/data/mithi/mithi_mndwi_water_polygons.geojson";

/** Exact LatLonBox from the uploaded water_depth (1).kml (no pad). */
export const LIVE_WATER_BOUNDS = {
  north: 19.08782672,
  south: 19.04514933,
  east: 72.87929619,
  west: 72.83456075,
};

/** Water area stated in water_depth (1).kml description (hectares). */
export const LIVE_WATER_KML_AREA_HA = 72.48201756266876;

/**
 * Minimum overlay alpha for a pixel to count as water.
 * Calibrated on the uploaded 1497×1428 PNG: α≥77 ≈ 72.98 ha (metadata 72.482 ha).
 * Do not force the area to match by inventing geometry.
 */
export const LIVE_WATER_MIN_ALPHA = 77;

let _promise = null;

/**
 * @returns {Promise<{
 *   available: boolean,
 *   bounds: {north:number,south:number,east:number,west:number},
 *   width: number,
 *   height: number,
 *   mask: Uint8Array|null,
 *   isWaterAtLonLat:(lon:number,lat:number)=>boolean,
 *   isWaterAtLocal:(x:number,z:number)=>boolean,
 *   source: string,
 *   textureUrl: string,
 *   waterPixels?: number,
 *   areaHa?: number,
 * }>}
 */
export function loadLiveWaterMask() {
  if (!_promise) {
    _promise = decode().catch((err) => {
      console.warn("[liveWaterMask] unavailable", err?.message || err);
      _promise = null;
      return empty();
    });
  }
  return _promise;
}

async function decode() {
  let bounds = { ...LIVE_WATER_BOUNDS };
  let kmlAreaHa = LIVE_WATER_KML_AREA_HA;
  try {
    const meta = await fetch(LIVE_WATER_META_URL, { cache: "force-cache" }).then((r) =>
      r.ok ? r.json() : null,
    );
    if (meta?.bounds?.north != null) {
      bounds = {
        north: Number(meta.bounds.north),
        south: Number(meta.bounds.south),
        east: Number(meta.bounds.east),
        west: Number(meta.bounds.west),
      };
    }
    if (Number.isFinite(meta?.kmlAreaHa)) kmlAreaHa = Number(meta.kmlAreaHa);
  } catch {
    /* use LatLonBox defaults from uploaded KML */
  }

  let blob = null;
  const pngRes = await fetch(LIVE_WATER_PNG_URL, { cache: "force-cache" });
  if (pngRes.ok) {
    blob = await pngRes.blob();
  } else {
    blob =
      (await extractPngFromKml(LIVE_WATER_KML_URL)) ||
      (await extractPngFromKml(LIVE_WATER_KML_FALLBACK));
  }
  if (!blob) throw new Error("MNDWI water overlay image missing");

  const bitmap = await createImageBitmap(blob);
  // Keep native 1497×1428 — do not downsample the authoritative mask.
  const width = Math.max(1, bitmap.width);
  const height = Math.max(1, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const px = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  let waterCount = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (isLiveWaterPixel(px[p], px[p + 1], px[p + 2], px[p + 3])) {
      mask[i] = 1;
      waterCount++;
    }
  }

  // Drop tiny disconnected speckles only — keep genuine disconnected water bodies.
  const cleaned = removeSpeckles(mask, width, height, minSpecklePixels(bounds, width, height));
  waterCount = 0;
  for (let i = 0; i < cleaned.length; i++) if (cleaned[i]) waterCount++;

  const midLat = ((bounds.north + bounds.south) * 0.5 * Math.PI) / 180;
  const boxM2 =
    Math.abs(bounds.east - bounds.west) *
    111320 *
    Math.cos(midLat) *
    Math.abs(bounds.north - bounds.south) *
    110540;
  const areaHa = (boxM2 * waterCount) / cleaned.length / 10000;

  const { north, south, east, west } = bounds;
  const isWaterAtLonLat = (lon, lat) => {
    if (!(lon >= west && lon <= east && lat >= south && lat <= north)) return false;
    // Pixel-center convention: floor(u*W) matches discrete mask sampling.
    const u = (lon - west) / Math.max(1e-12, east - west);
    const v = (north - lat) / Math.max(1e-12, north - south);
    const ix = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const iy = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    return cleaned[iy * width + ix] === 1;
  };
  const isWaterAtLocal = (x, z) => {
    try {
      const ll = localToLonLat(x, z);
      return isWaterAtLonLat(ll.lon, ll.lat);
    } catch {
      return false;
    }
  };

  console.info("[liveWaterMask] ready", {
    grid: `${width}x${height}`,
    waterPixels: waterCount,
    areaHa: Number(areaHa.toFixed(2)),
    kmlAreaHa,
    minAlpha: LIVE_WATER_MIN_ALPHA,
    coveragePct: Number(((100 * waterCount) / cleaned.length).toFixed(2)),
    bounds,
    source: "water_depth (1).kml → mithi_river_water_overlay.png",
  });

  return {
    available: waterCount > 0,
    bounds,
    width,
    height,
    mask: cleaned,
    isWaterAtLonLat,
    isWaterAtLocal,
    source: "src/data/water_depth (1).kml",
    textureUrl: LIVE_WATER_PNG_URL,
    waterPixels: waterCount,
    areaHa,
    kmlAreaHa,
  };
}

async function extractPngFromKml(url) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) return null;
  const text = await res.text();
  const m = text.match(/data:image\/png;base64,([A-Za-z0-9+/=\s]+)/i);
  if (!m) return null;
  const bin = atob(m[1].replace(/\s+/g, ""));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "image/png" });
}

/**
 * Solid MNDWI water only — reject near-transparent fringe that inflated older
 * footprints (~188 ha). Threshold matches scripts/polygonize_mithi_water_mask.py.
 */
function isLiveWaterPixel(r, g, b, a) {
  if (a < LIVE_WATER_MIN_ALPHA) return false;
  if (b >= 180 && r <= 40 && g <= 60) return true;
  if (b > 120 && b >= r + 40 && b >= g + 30) return true;
  return false;
}

/** Drop components smaller than ~400 m² (noise). Keep real disconnected ponds. */
function minSpecklePixels(bounds, width, height) {
  const midLat = ((bounds.north + bounds.south) * 0.5 * Math.PI) / 180;
  const boxM2 =
    Math.abs(bounds.east - bounds.west) *
    111320 *
    Math.cos(midLat) *
    Math.abs(bounds.north - bounds.south) *
    110540;
  const pxM2 = boxM2 / Math.max(1, width * height);
  return Math.max(8, Math.round(400 / Math.max(1, pxM2)));
}

function removeSpeckles(src, width, height, minPixels) {
  const out = new Uint8Array(src.length);
  const seen = new Uint8Array(src.length);
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    if (!src[i] || seen[i]) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const x = cur % width;
      const y = (cur / width) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!src[ni] || seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (comp.length < minPixels) continue;
    for (const id of comp) out[id] = 1;
  }
  return out;
}

function empty() {
  return {
    available: false,
    bounds: { ...LIVE_WATER_BOUNDS },
    width: 0,
    height: 0,
    mask: null,
    isWaterAtLonLat: () => false,
    isWaterAtLocal: () => false,
    source: "UNAVAILABLE",
    textureUrl: LIVE_WATER_PNG_URL,
  };
}
