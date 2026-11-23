/**
 * Joining-stream BOD/COD from streams_bod_cod_pixels KML.
 * - Per-stream means for list / panel summary
 * - Per-pixel samples for hover (original values; nearest match if gap)
 */
import { FRONTEND_KML } from "../session/localJalnetraSnapshots.js";

const STREAMS_KML_URLS = [
  "/data/mithi/streams_bod_cod_pixels.kml",
  FRONTEND_KML["streams-bod-cod"]?.active,
  FRONTEND_KML["streams-bod-cod"]?.history,
].filter(Boolean);

/** ~110 m grid cell */
const CELL = 0.001;
/** Reject if nearest pixel farther than ~1.2 km */
const MAX_DIST_DEG = 0.011;

/** @type {Map<string, object>} */
const byKey = new Map();
/** @type {object[]} */
let streamList = [];
/** Flat pixel store: [lon, lat, bod, cod, streamIndex]… */
/** @type {Float64Array|null} */
let pixelPoints = null;
/** @type {string[]} stream name per streamIndex */
let pixelStreamNames = [];
/** @type {Map<string, number[]>} cell → pixel indices */
let pixelGrid = new Map();

/** @type {object} */
export let streamsBodCodMeta = {
  startDate: "2026-10-21",
  endDate: "2026-11-18",
  landsatCount: null,
  s2Count: null,
  refreshedAt: null,
  source: null,
  streamCount: 0,
  pixelCount: 0,
};

/** @type {Promise<object>|null} */
let loadPromise = null;

function upsertKey(key, entry) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return;
  byKey.set(k, entry);
}

function cellKey(lon, lat) {
  return `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;
}

function rebuildIndex(streams, pixels) {
  byKey.clear();
  streamList = streams.slice().sort((a, b) => {
    const na = Number(/(\d+)/.exec(a.name || "")?.[1] || 0);
    const nb = Number(/(\d+)/.exec(b.name || "")?.[1] || 0);
    return na - nb || String(a.name).localeCompare(String(b.name));
  });
  for (const entry of streamList) {
    upsertKey(entry.name, entry);
    upsertKey(entry.id, entry);
    const num =
      /upstream\s*0*(\d+)/i.exec(entry.name || "")?.[1] ??
      /S0*(\d+)/i.exec(entry.id || "")?.[1];
    if (num) {
      upsertKey(`#${Number(num)}`, entry);
      upsertKey(`upstream ${String(num).padStart(2, "0")}`, entry);
      upsertKey(`upstream ${Number(num)}`, entry);
    }
  }
  streamsBodCodMeta.streamCount = streamList.length;
  streamsBodCodMeta.pixelCount = pixels?.count || streamList.reduce((n, s) => n + (s.pixels || 0), 0);

  pixelPoints = pixels?.points || null;
  pixelStreamNames = pixels?.streamNames || [];
  pixelGrid = pixels?.grid || new Map();
}

/**
 * Parse joining-stream BOD/COD KML → stream aggregates + raw pixel grid.
 */
export function parseStreamsBodCodKml(text) {
  /** @type {Map<string, { bod:number[], cod:number[], lons:number[], lats:number[] }>} */
  const buckets = new Map();
  /** @type {number[]} */
  const vals = [];
  /** @type {string[]} */
  const streamNames = [];
  const streamIndexByName = new Map();

  const blocks = String(text || "").matchAll(/<(?:\w+:)?Placemark\b[\s\S]*?<\/(?:\w+:)?Placemark>/gi);
  for (const m of blocks) {
    const b = m[0];
    const stream =
      (b.match(/Stream:\s*([^\r\n<]+)/i) || [])[1]?.trim() ||
      (b.match(/<(?:\w+:)?name>\s*(Upstream\s*\d+)\s*</i) || [])[1]?.trim() ||
      "";
    if (!stream) continue;
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
    if (![bod, cod].every(Number.isFinite)) continue;
    if (!buckets.has(stream)) buckets.set(stream, { bod: [], cod: [], lons: [], lats: [] });
    const bucket = buckets.get(stream);
    bucket.bod.push(bod);
    bucket.cod.push(cod);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      bucket.lons.push(lon);
      bucket.lats.push(lat);
      let si = streamIndexByName.get(stream);
      if (si == null) {
        si = streamNames.length;
        streamNames.push(stream);
        streamIndexByName.set(stream, si);
      }
      vals.push(lon, lat, bod, cod, si);
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const min = (arr) => (arr.length ? Math.min(...arr) : NaN);
  const max = (arr) => (arr.length ? Math.max(...arr) : NaN);

  const streams = [];
  for (const [name, bucket] of buckets) {
    const num = /upstream\s*0*(\d+)/i.exec(name)?.[1];
    streams.push({
      id: num ? `S${String(num).padStart(2, "0")}` : name,
      name,
      stream_id: num ? `S${String(num).padStart(2, "0")}` : name,
      stream_name: name,
      bodMean: mean(bucket.bod),
      bodMin: min(bucket.bod),
      bodMax: max(bucket.bod),
      codMean: mean(bucket.cod),
      codMin: min(bucket.cod),
      codMax: max(bucket.cod),
      pixels: bucket.bod.length,
      lon: mean(bucket.lons),
      lat: mean(bucket.lats),
    });
  }

  const count = vals.length / 5;
  const points = Float64Array.from(vals);
  const grid = new Map();
  for (let i = 0; i < count; i++) {
    const lon = points[i * 5];
    const lat = points[i * 5 + 1];
    const key = cellKey(lon, lat);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  return { streams, pixels: { points, count, grid, streamNames } };
}

function applyStreamsBodCodText(text, source) {
  const parsed = parseStreamsBodCodKml(text);
  if (!parsed.streams.length) throw new Error("no stream pixels");
  rebuildIndex(parsed.streams, parsed.pixels);
  streamsBodCodMeta = {
    ...streamsBodCodMeta,
    refreshedAt: new Date().toISOString(),
    source,
    streamCount: parsed.streams.length,
    pixelCount: parsed.pixels.count,
  };
  console.info("[streams-bod-cod] ready", {
    streams: parsed.streams.length,
    pixels: parsed.pixels.count,
    source,
  });
  if (typeof document !== "undefined") {
    document.dispatchEvent(
      new CustomEvent("streams-bod-cod-ready", {
        detail: { streams: streamList, meta: streamsBodCodMeta, live: /live|jalnetra/i.test(source) },
      }),
    );
  }
  return { streams: streamList, meta: streamsBodCodMeta };
}

/** Replace joining-stream pixels with live JalNetra KML text (once per page load). */
export function applyLiveStreamsBodCodKml(text, source = "jalnetra-live") {
  if (!text || String(text).length < 100) return null;
  return applyStreamsBodCodText(text, source);
}

export async function ensureStreamsBodCod() {
  if (streamList.length && pixelPoints) return { streams: streamList, meta: streamsBodCodMeta };
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // Prefer live KML already downloaded this session.
    const liveText =
      typeof window !== "undefined" ? window.__RIVER_SESSION__?.streamsBodCodKmlText : null;
    if (liveText) {
      try {
        return applyStreamsBodCodText(liveText, "jalnetra-live");
      } catch {
        /* fall through to bundled */
      }
    }
    let lastErr = null;
    for (const url of STREAMS_KML_URLS) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return applyStreamsBodCodText(text, url);
      } catch (err) {
        lastErr = err;
      }
    }
    loadPromise = null;
    throw lastErr || new Error("streams BOD/COD unavailable");
  })();
  return loadPromise;
}

if (typeof window !== "undefined") {
  window.addEventListener("planeteye-endpoint", (e) => {
    if (e.detail?.id !== "streams-bod-cod" || e.detail?.ok !== true || !e.detail?.live) return;
    const text = window.__RIVER_SESSION__?.streamsBodCodKmlText;
    if (!text) return;
    try {
      applyLiveStreamsBodCodKml(text, "jalnetra-live");
      loadPromise = Promise.resolve({ streams: streamList, meta: streamsBodCodMeta });
    } catch (err) {
      console.warn("[streams-bod-cod] live apply failed", err?.message || err);
    }
  });
}

export function listStreamsBodCod() {
  return streamList.slice();
}

export function getStreamsBodCodCount() {
  return streamList.length;
}

/** @returns {object|null} Stream-level aggregate for a drainage record or name */
export function streamBodCodFor(recOrName) {
  const names =
    typeof recOrName === "string"
      ? [recOrName]
      : [
          recOrName?.meta?.name,
          recOrName?.meta?.nameEn,
          recOrName?.displayName,
          recOrName?.name,
          recOrName?.stream_name,
        ];
  for (const n of names) {
    const s = String(n || "").trim();
    if (!s) continue;
    const hit = byKey.get(s.toLowerCase());
    if (hit) return hit;
    const num = /upstream\s*0*(\d+)/i.exec(s)?.[1];
    if (num && byKey.has(`#${Number(num)}`)) return byKey.get(`#${Number(num)}`);
  }
  return null;
}

function preferredStreamName(recOrName) {
  if (typeof recOrName === "string") return String(recOrName || "").trim();
  const names = [
    recOrName?.meta?.name,
    recOrName?.meta?.nameEn,
    recOrName?.displayName,
    recOrName?.name,
    recOrName?.stream_name,
  ];
  for (const n of names) {
    const s = String(n || "").trim();
    if (s && /upstream\s*0*\d+/i.test(s)) return s;
  }
  return String(names.find((n) => String(n || "").trim()) || "").trim();
}

/**
 * Original BOD/COD at a map point from joining-stream pixels.
 * Prefers same Upstream stream; if no local pixel, uses nearest matching pixel.
 * @returns {{ bod:number, cod:number, stream:string, lon:number, lat:number, matched:boolean, interpolated?:boolean }|null}
 */
export function sampleStreamBodCodAtLonLat(lon, lat, preferredStream = null) {
  if (!pixelPoints || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const want = String(preferredStream || "").trim().toLowerCase();
  const cx = Math.floor(lon / CELL);
  const cy = Math.floor(lat / CELL);
  /** @type {{ i: number, d2: number, same: boolean }[]} */
  const near = [];
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      const bucket = pixelGrid.get(`${cx + dx}:${cy + dy}`);
      if (!bucket) continue;
      for (const i of bucket) {
        const dlon = pixelPoints[i * 5] - lon;
        const dlat = pixelPoints[i * 5 + 1] - lat;
        const d2 = dlon * dlon + dlat * dlat;
        const si = pixelPoints[i * 5 + 4];
        const name = pixelStreamNames[si] || "";
        near.push({ i, d2, same: !!(want && name.toLowerCase() === want) });
      }
    }
  }
  if (!near.length) return null;

  // Prefer same-stream pixels when available
  const same = near.filter((n) => n.same).sort((a, b) => a.d2 - b.d2);
  const pool = same.length ? same : near.sort((a, b) => a.d2 - b.d2);
  if (pool[0].d2 > MAX_DIST_DEG * MAX_DIST_DEG) return null;

  // Always the original nearest pixel (never blend — keeps hover / labels matching).
  const i0 = pool[0].i;
  return {
    bod: pixelPoints[i0 * 5 + 2],
    cod: pixelPoints[i0 * 5 + 3],
    stream: pixelStreamNames[pixelPoints[i0 * 5 + 4]] || "",
    lon: pixelPoints[i0 * 5],
    lat: pixelPoints[i0 * 5 + 1],
    matched: true,
    interpolated: false,
  };
}

/** Stable mid-stream lon/lat for a joining-stream record. */
export function streamBodCodAnchorLonLat(recOrName) {
  if (typeof recOrName === "string") {
    const agg = streamBodCodFor(recOrName);
    if (Number.isFinite(agg?.lon) && Number.isFinite(agg?.lat)) {
      return { lon: agg.lon, lat: agg.lat };
    }
    return null;
  }
  const ordered = recOrName?.orderedPts?.length ? recOrName.orderedPts : recOrName?.pts;
  const mid = ordered?.[Math.floor((ordered?.length || 1) * 0.6)];
  if (Number.isFinite(mid?.lon) && Number.isFinite(mid?.lat)) {
    return { lon: mid.lon, lat: mid.lat };
  }
  if (Number.isFinite(recOrName?.outletLon) && Number.isFinite(recOrName?.outletLat)) {
    return { lon: recOrName.outletLon, lat: recOrName.outletLat };
  }
  const agg = streamBodCodFor(recOrName);
  if (Number.isFinite(agg?.lon) && Number.isFinite(agg?.lat)) {
    return { lon: agg.lon, lat: agg.lat };
  }
  return null;
}

/**
 * One shared original pixel for a stream (mid anchor).
 * Use this for labels / nav so they match each other; hover overrides with cursor point.
 */
export function streamBodCodOriginal(recOrName, lon, lat) {
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    return streamBodCodAtPoint(recOrName, lon, lat);
  }
  const anchor = streamBodCodAnchorLonLat(recOrName);
  if (anchor) return streamBodCodAtPoint(recOrName, anchor.lon, anchor.lat);
  return streamBodCodAtPoint(recOrName);
}

/**
 * Sample for a joining-stream record at optional hover lon/lat.
 * Falls back to stream mean only when no nearby pixel exists.
 */
export function streamBodCodAtPoint(recOrName, lon, lat) {
  const prefer = preferredStreamName(recOrName);
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    const hit = sampleStreamBodCodAtLonLat(lon, lat, prefer);
    if (hit) {
      return {
        name: hit.stream || prefer,
        bodMean: hit.bod,
        codMean: hit.cod,
        bod: hit.bod,
        cod: hit.cod,
        pointSample: true,
        matched: hit.matched,
        interpolated: hit.interpolated,
        lon: hit.lon,
        lat: hit.lat,
      };
    }
  }
  const agg = streamBodCodFor(recOrName || prefer);
  if (!agg) return null;
  return { ...agg, pointSample: false, matched: false };
}

/** CPCB-style bands: BOD ≤3 good, ≤6 moderate, else high. COD ≤10 / ≤30. */
export function bodLevel(v) {
  return !Number.isFinite(v) ? "na" : v <= 3 ? "good" : v <= 6 ? "moderate" : "high";
}
export function codLevel(v) {
  return !Number.isFinite(v) ? "na" : v <= 10 ? "good" : v <= 30 ? "moderate" : "high";
}

export function fmtMgL(v, digits = 1) {
  return Number.isFinite(v) ? Number(v).toFixed(digits) : "—";
}

void ensureStreamsBodCod().catch((err) => {
  console.warn("[streams-bod-cod]", err?.message || err);
  streamsBodCodMeta = { ...streamsBodCodMeta, source: "error" };
  if (typeof document !== "undefined") {
    document.dispatchEvent(
      new CustomEvent("streams-bod-cod-ready", {
        detail: { streams: [], meta: streamsBodCodMeta, error: err?.message || String(err) },
      }),
    );
  }
});
