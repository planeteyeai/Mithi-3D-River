/**
 * Default + fallback BOD/COD pixel grid for Mithi.
 *
 * Priority while sampling:
 *   1. Live JalNetra POST /api/main-bod-cod (once per page load)
 *   2. Local main_bod_cod_pixels.kml (instant until live returns)
 *   3. Legacy CSV: public/data/mithi/BOD_COD_pixelwise_latlon.csv
 */
import { interpolateChainage } from "../geo/chainage.js";
import { classFromBod } from "./bodCodService.js";
import { localToLonLat } from "../geo/geoReference.js";
import {
  getMainBodCodCache,
  sampleMainBodCodAtLonLat,
  sampleMainBodCodAtMeters,
} from "./mainBodCodService.js";
/** Exact startup default file — shown until live Landsat returns. */
import defaultMainBodCodKml from "../../data/main_bod_cod_pixels (1).kml?raw";

/** Public mirror (optional fetch fallback). */
export const BOD_COD_DEFAULT_KML_URL = "/data/mithi/main_bod_cod_pixels.kml";
export const BOD_COD_HISTORY_KML_URL =
  "/data/mithi/jalnetra-history/main-bod-cod1_21-10-2026__18-11-2026.kml";
export const STREAMS_BOD_COD_KML_URL =
  "/data/mithi/jalnetra-history/streams-bod-cod1_21-10-2026__18-11-2026.kml";
export const BOD_COD_PIXEL_CSV_URL = "/data/mithi/BOD_COD_pixelwise_latlon.csv";

/** Grid cell size in degrees (~110 m). */
const CELL = 0.001;

/** @type {Promise<{ points: Float64Array, count: number, grid: Map<string, number[]>, source: string }> | null} */
let loadPromise = null;
/** @type {{ points: Float64Array, count: number, grid: Map<string, number[]>, source: string } | null} */
let cache = null;

function cellKey(lon, lat) {
  return `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;
}

function indexPoints(vals, source) {
  const count = vals.length >> 2;
  if (!count) throw new Error(`BOD/COD ${source} has no samples`);
  const points = Float64Array.from(vals);
  const grid = new Map();
  for (let i = 0; i < count; i++) {
    const lon = points[i * 4];
    const lat = points[i * 4 + 1];
    const key = cellKey(lon, lat);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }
  return { points, count, grid, source };
}

/** Parse main_bod_cod_pixels KML placemarks → [lon,lat,bod,cod]… */
export function parseMainBodCodPixelKml(text) {
  const vals = [];
  if (!text) return vals;
  const blocks = String(text).matchAll(/<(?:\w+:)?Placemark\b[\s\S]*?<\/(?:\w+:)?Placemark>/gi);
  for (const m of blocks) {
    const b = m[0];
    let lat = Number((b.match(/Latitude:\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1]);
    let lon = Number((b.match(/Longitude:\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1]);
    let bod = Number((b.match(/BOD:\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1]);
    let cod = Number((b.match(/COD:\s*([+-]?\d+(?:\.\d+)?)/i) || [])[1]);
    if (!Number.isFinite(bod) || !Number.isFinite(cod)) {
      const named = b.match(/BOD\s*([+-]?\d+(?:\.\d+)?)\s*\|\s*COD\s*([+-]?\d+(?:\.\d+)?)/i);
      if (named) {
        bod = Number(named[1]);
        cod = Number(named[2]);
      }
    }
    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && /<(?:\w+:)?coordinates>/i.test(b)) {
      const coords = b.match(/<(?:\w+:)?coordinates>\s*([^<]+)/i);
      if (coords) {
        const nums = [...coords[1].matchAll(/([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)/g)];
        if (nums.length) {
          let sx = 0;
          let sy = 0;
          for (const c of nums) {
            sx += Number(c[1]);
            sy += Number(c[2]);
          }
          lon = sx / nums.length;
          lat = sy / nums.length;
        }
      }
    }
    if (![lat, lon, bod, cod].every(Number.isFinite)) continue;
    vals.push(lon, lat, bod, cod);
  }
  return vals;
}

function parseCsv(text) {
  const vals = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    const bod = Number(parts[2]);
    const cod = Number(parts[3]);
    if (![lat, lon, bod, cod].every(Number.isFinite)) continue;
    vals.push(lon, lat, bod, cod);
  }
  return vals;
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function publishDefaultReady() {
  document.dispatchEvent(
    new CustomEvent("bod-cod-default-ready", {
      detail: { count: cache.count, source: cache.source },
    }),
  );
}

/**
 * Load bundled src/data/main_bod_cod_pixels (1).kml at start.
 * Live /api/main-bod-cod replaces these values when the response arrives.
 */
export function ensureBodCodPixels() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // 1) Active clipped main-stream KML first, then history / bundled raw.
    const candidates = [
      BOD_COD_DEFAULT_KML_URL,
      BOD_COD_HISTORY_KML_URL,
    ];
    for (const url of candidates) {
      try {
        const text = await fetchText(url);
        const vals = parseMainBodCodPixelKml(text);
        if (!vals.length) continue;
        cache = indexPoints(vals, url.includes("streams") ? "streams-bod-cod-kml" : "default-kml");
        console.info(`[bod-cod-default] opened ${url} · ${cache.count} pixels (until live)`);
        publishDefaultReady();
        return cache;
      } catch (err) {
        console.warn("[bod-cod-default] try failed", url, err?.message || err);
      }
    }
    try {
      if (typeof defaultMainBodCodKml === "string" && defaultMainBodCodKml.length > 100) {
        const vals = parseMainBodCodPixelKml(defaultMainBodCodKml);
        cache = indexPoints(vals, "bundled-raw");
        console.info(`[bod-cod-default] bundled raw · ${cache.count} pixels`);
        publishDefaultReady();
        return cache;
      }
    } catch (err) {
      console.warn("[bod-cod-default] bundled KML failed", err?.message || err);
    }

    // 2) Legacy CSV fallback only if default KML missing.
    const text = await fetchText(BOD_COD_PIXEL_CSV_URL);
    const vals = parseCsv(text);
    cache = indexPoints(vals, "mandovi-csv");
    console.info(`[bod-cod-csv] loaded ${cache.count} pixels`);
    publishDefaultReady();
    return cache;
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

// Open default KML as soon as the module loads (before 3D / live API).
void ensureBodCodPixels().catch(() => {});

/**
 * Accurate BOD/COD at any river lon/lat:
 * inverse-distance blend of nearby default/live pixels so every click
 * on the water gets a continuous value (not only exact pixel centres).
 * @returns {{ bod: number, cod: number, distDeg2: number, source?: string, interpolated?: boolean } | null}
 */
function sampleCachedBodCodAtLonLat(lon, lat) {
  if (!cache || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const { points, grid, source } = cache;
  const cx = Math.floor(lon / CELL);
  const cy = Math.floor(lat / CELL);
  /** @type {{ i: number, d2: number }[]} */
  const near = [];
  // Search ~3 cells (~330 m) so bank / mid-channel clicks always hit neighbours.
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const bucket = grid.get(`${cx + dx}:${cy + dy}`);
      if (!bucket) continue;
      for (const i of bucket) {
        const dlon = points[i * 4] - lon;
        const dlat = points[i * 4 + 1] - lat;
        const d2 = dlon * dlon + dlat * dlat;
        near.push({ i, d2 });
      }
    }
  }
  if (!near.length) return null;
  near.sort((a, b) => a.d2 - b.d2);
  // Reject if closest pixel farther than ~1.2 km.
  if (near[0].d2 > 0.011 * 0.011) return null;

  // Exact hit on a pixel centre.
  if (near[0].d2 < 1e-14) {
    const i = near[0].i;
    return {
      bod: points[i * 4 + 2],
      cod: points[i * 4 + 3],
      distDeg2: near[0].d2,
      source: source || "default-kml",
      interpolated: false,
    };
  }

  // IDW of up to 4 nearest pixels → smooth BOD/COD across the full river.
  const k = Math.min(4, near.length);
  let wSum = 0;
  let bodSum = 0;
  let codSum = 0;
  for (let n = 0; n < k; n++) {
    const w = 1 / Math.max(near[n].d2, 1e-12);
    wSum += w;
    bodSum += points[near[n].i * 4 + 2] * w;
    codSum += points[near[n].i * 4 + 3] * w;
  }
  return {
    bod: bodSum / wSum,
    cod: codSum / wSum,
    distDeg2: near[0].d2,
    source: source || "default-kml",
    interpolated: k > 1,
  };
}

export function sampleBodCodAtLonLat(lon, lat) {
  // Live JalNetra main-bod-cod wins when the page-load fetch has returned.
  const liveLl = sampleMainBodCodAtLonLat(lon, lat);
  if (liveLl) return liveLl;
  return sampleCachedBodCodAtLonLat(lon, lat);
}

function lonLatForChainage(chainage, meters) {
  const p = interpolateChainage(chainage, meters);
  if (!p) return null;
  if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
    return { lon: p.lon, lat: p.lat, meters: p.meters, x: p.x, z: p.z };
  }
  if (Number.isFinite(p.x) && Number.isFinite(p.z)) {
    try {
      const ll = localToLonLat(p.x, p.z);
      if (Number.isFinite(ll?.lon) && Number.isFinite(ll?.lat)) {
        return { lon: ll.lon, lat: ll.lat, meters: p.meters, x: p.x, z: p.z };
      }
    } catch {
      /* geo frame not ready */
    }
  }
  return null;
}

/**
 * Sample BOD/COD at a river chainage (nearest pixel to that station).
 * @returns {{ bod: number, cod: number, meters: number, source?: string } | null}
 */
export function sampleBodCodAtChainage(chainage, meters) {
  const live = sampleMainBodCodAtMeters(meters);
  if (live) return live;
  const ll = lonLatForChainage(chainage, meters);
  if (getMainBodCodCache()?.series?.length && ll) {
    const hit = sampleMainBodCodAtLonLat(ll.lon, ll.lat);
    if (hit) return { ...hit, meters: ll.meters ?? meters };
  }
  if (ll) {
    const local = sampleCachedBodCodAtLonLat(ll.lon, ll.lat);
    if (local) {
      return {
        bod: local.bod,
        cod: local.cod,
        meters: ll.meters ?? meters,
        source: local.source,
        distDeg2: local.distDeg2,
      };
    }
  }
  if (!ll) return null;
  const hit = sampleBodCodAtLonLat(ll.lon, ll.lat);
  if (!hit) return null;
  return {
    bod: hit.bod,
    cod: hit.cod,
    meters: ll.meters ?? meters,
    source: hit.source,
    distDeg2: hit.distDeg2,
  };
}

/**
 * Build a JalNetra-compatible BOD/COD payload from the default pixel grid + chainage.
 * Used by ribbon HUD / layer when the live API is unavailable.
 */
export async function buildMandoviBodCodFromCsv(chainage) {
  await ensureBodCodPixels();
  const chain = Array.isArray(chainage) ? chainage : [];
  if (chain.length < 2) throw new Error("BOD/COD pixels need chainage geometry");

  const first = chain[0].meters ?? 0;
  const last = chain[chain.length - 1].meters ?? first;
  const stepM = 500;
  const reaches = [];
  let reachIdx = 0;
  const src = cache?.source || "default-kml";

  for (let m0 = first; m0 < last - 1; m0 += stepM) {
    const m1 = Math.min(last, m0 + stepM);
    const bods = [];
    const cods = [];
    for (let m = m0; m <= m1; m += 50) {
      const s = sampleBodCodAtChainage(chain, m);
      if (!s || !Number.isFinite(s.bod)) continue;
      bods.push(s.bod);
      if (Number.isFinite(s.cod)) cods.push(s.cod);
    }
    if (!bods.length) continue;
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const bod = mean(bods);
    const cod = cods.length ? mean(cods) : bod * 2.5;
    const cls = classFromBod(bod);
    const km0 = m0 / 1000;
    const km1 = m1 / 1000;
    reachIdx += 1;
    reaches.push({
      id: `M${String(reachIdx).padStart(2, "0")}`,
      name: `${km0.toFixed(1)}–${km1.toFixed(1)} km`,
      km: [km0, km1],
      today: {
        p10: bod * 0.92,
        p50: bod,
        p90: bod * 1.08,
        cod_p10: cod * 0.92,
        cod_p50: cod,
        cod_p90: cod * 1.08,
        cls,
        support: "sat",
        tier: "Observed",
      },
      history: {
        dates: [new Date().toISOString()],
        p10: [bod * 0.92],
        p50: [bod],
        p90: [bod * 1.08],
        cod_p10: [cod * 0.92],
        cod_p50: [cod],
        cod_p90: [cod * 1.08],
        support: ["sat"],
      },
      forecast: { dates: [], p10: [], p50: [], p90: [], cod_p10: [], cod_p50: [], cod_p90: [] },
    });
  }

  if (!reaches.length) throw new Error("BOD/COD pixels produced no reaches along chainage");

  return {
    river_name: "Mithi",
    tagline:
      src === "default-kml"
        ? "Main-stream BOD/COD pixels (clipped to Mithi)"
        : "Pixel BOD/COD survey grid",
    generated: new Date().toISOString(),
    bod_edges: [2, 3, 6, 10],
    class_colors: {
      A: "#2E7DD1",
      B: "#3AA76D",
      C: "#E3C51E",
      D: "#E08A2E",
      E: "#D14B3A",
    },
    reaches,
    alerts: [],
    _source: src,
    _viewerId: src === "default-kml" ? "main-bod-cod-default-kml" : "mandovi-pixel-csv",
  };
}

/** True when the default pixel grid is available (cached after first successful load). */
export function hasBodCodPixels() {
  return !!cache?.count;
}

export function getBodCodPixelSource() {
  return cache?.source || null;
}
