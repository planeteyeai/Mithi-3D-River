/**
 * Live main-stem BOD/COD from JalNetra.
 * POST /api/main-bod-cod  (upload stream KML → daily BOD/COD @ 10 m chainage)
 * Docs: https://jalnetra-software-production.up.railway.app/docs#/default/main_bod_cod_api_main_bod_cod_post
 *
 * Every page load posts fresh — no localStorage of values.
 * Gaps between samples are filled by neighbour average along chainage.
 */
import { interpolateChainage } from "../geo/chainage.js";
import { localToLonLat } from "../geo/geoReference.js";
import {
  storeComponentHistory,
  getLatestComponentHistory,
} from "../../api/historyClient.js";

/** CPCB-style class from BOD (avoid circular import with bodCodService). */
function classFromBod(p50, edges = [2, 3, 6, 10]) {
  const v = Number(p50);
  if (!Number.isFinite(v)) return "NA";
  if (v <= edges[0]) return "A";
  if (v <= edges[1]) return "B";
  if (v <= edges[2]) return "C";
  if (v <= edges[3]) return "D";
  return "E";
}

export const MAIN_BOD_COD_URL =
  ((typeof import.meta !== "undefined" && import.meta.env?.VITE_JALNETRA_API_BASE) ||
    "/jalnetra-api") + "/api/main-bod-cod";

/** Main-stream LineString KML for Mithi (preferred upload). */
export const MITHI_MAIN_STREAM_KML_URL = "/data/mithi/mithi_river_main_stream.kml";

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // Landsat job can take several minutes

/** @type {Promise<object|null>|null} */
let loadPromise = null;
/** @type {object|null} */
let cache = null;
/** @type {'idle'|'loading'|'ready'|'error'} */
let status = "idle";

export function getMainBodCodStatus() {
  return status;
}

export function getMainBodCodCache() {
  return cache;
}

function isSameDayStamp(isoOrDate) {
  if (!isoOrDate) return false;
  const d = String(isoOrDate).slice(0, 10);
  const local = new Date();
  const todayLocal = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  const todayUtc = new Date().toISOString().slice(0, 10);
  return d === todayLocal || d === todayUtc;
}

/**
 * Kick off (or await) main-bod-cod for this browser session.
 * Same calendar day: reuse Postgres (no repeat JalNetra POST).
 * First load of the day: live POST → store in DB.
 */
export function ensureMainBodCodLive(opts = {}) {
  if (cache && !opts.force) return Promise.resolve(cache);
  if (loadPromise && !opts.force) return loadPromise;
  status = "loading";
  document.dispatchEvent(new CustomEvent("main-bod-cod-status", { detail: { status } }));
  loadPromise = (async () => {
    // Same-day DB hit → skip live entirely.
    if (!opts.force) {
      try {
        const cached = await getLatestComponentHistory("main-bod-cod");
        if (
          cached?.payload &&
          (isSameDayStamp(cached.dataDate) || isSameDayStamp(cached.fetchedAt))
        ) {
          const normalized = normalizeMainBodCod(cached.payload, opts.chainage);
          normalized.source = "main-bod-cod-history";
          normalized._source = "history-same-day";
          cache = normalized;
          status = "ready";
          document.dispatchEvent(
            new CustomEvent("main-bod-cod-ready", { detail: normalized }),
          );
          document.dispatchEvent(
            new CustomEvent("main-bod-cod-status", {
              detail: { status, summary: normalized.summary, fromCache: true, sameDay: true },
            }),
          );
          console.info("[main-bod-cod] same-day DB reuse", {
            dataDate: cached.dataDate,
            points: normalized.series?.length || 0,
          });
          return normalized;
        }
      } catch (cacheErr) {
        console.warn("[main-bod-cod] same-day lookup skipped:", cacheErr.message);
      }
    }

    try {
      const raw = await postMainBodCod(opts);
      const normalized = normalizeMainBodCod(raw, opts.chainage);
      cache = normalized;
      status = "ready";
      try {
        await storeComponentHistory("main-bod-cod", raw, {
          endDate: new Date().toISOString().slice(0, 10),
          kmlType: "main_bod_cod",
          source: "jalnetra-live",
        });
      } catch (storeErr) {
        console.warn("[main-bod-cod] history store skipped:", storeErr.message);
      }
      document.dispatchEvent(
        new CustomEvent("main-bod-cod-ready", { detail: normalized }),
      );
      document.dispatchEvent(
        new CustomEvent("main-bod-cod-status", { detail: { status, summary: normalized.summary } }),
      );
      console.info("[main-bod-cod] live ready", {
        points: normalized.series?.length || 0,
        streams: normalized.streams?.length || 0,
        source: normalized.source,
      });
      return normalized;
    } catch (err) {
      // Live failed → newest Postgres snapshot for pollution BOD/COD
      try {
        const cached = await getLatestComponentHistory("main-bod-cod");
        if (cached?.payload) {
          const normalized = normalizeMainBodCod(cached.payload, opts.chainage);
          normalized.source = "main-bod-cod-history";
          normalized._source = "history";
          cache = normalized;
          status = "ready";
          document.dispatchEvent(
            new CustomEvent("main-bod-cod-ready", { detail: normalized }),
          );
          document.dispatchEvent(
            new CustomEvent("main-bod-cod-status", {
              detail: { status, summary: normalized.summary, fromCache: true },
            }),
          );
          console.info("[main-bod-cod] using DB fallback", {
            dataDate: cached.dataDate,
            points: normalized.series?.length || 0,
          });
          return normalized;
        }
      } catch (cacheErr) {
        console.warn("[main-bod-cod] history fallback unavailable:", cacheErr.message);
      }
      status = "error";
      document.dispatchEvent(
        new CustomEvent("main-bod-cod-status", {
          detail: { status, error: err?.message || String(err) },
        }),
      );
      console.warn("[main-bod-cod] failed", err?.message || err);
      throw err;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

async function resolveUploadKml(opts = {}) {
  // Prefer explicit main-stream LineString KML (API contract).
  const candidates = [
    opts.kmlUrl,
    MITHI_MAIN_STREAM_KML_URL,
    "/data/mithi/mithi_river_main_stream.kml",
  ].filter(Boolean);
  for (const url of candidates) {
    try {
      const res = await fetch(encodeURI(url), { cache: "force-cache" });
      if (!res.ok) continue;
      const text = await res.text();
      if (text && /LineString/i.test(text)) {
        return { text, filename: "mithi_river_main_stream.kml" };
      }
    } catch {
      /* try next */
    }
  }
  const session = typeof window !== "undefined" ? window.__RIVER_SESSION__ : null;
  if (session?.mainStreamKmlText && /LineString/i.test(session.mainStreamKmlText)) {
    return {
      text: session.mainStreamKmlText,
      filename: "mithi_river_main_stream.kml",
    };
  }
  if (session?.kmlText && /LineString/i.test(session.kmlText)) {
    return { text: session.kmlText, filename: session.filename || "mithi_river.kml" };
  }
  throw new Error("No Mithi stream KML available for main-bod-cod");
}

async function postMainBodCod(opts = {}) {
  const { text, filename } = await resolveUploadKml(opts);
  const form = new FormData();
  form.append(
    "kml",
    new Blob([text], { type: "application/vnd.google-earth.kml+xml" }),
    filename,
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
  const t0 = performance.now?.() || Date.now();
  try {
    const res = await fetch(MAIN_BOD_COD_URL, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
      headers: { "ngrok-skip-browser-warning": "true" },
      cache: "no-store",
    });
    const bodyText = await res.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = { detail: bodyText };
    }
    if (!res.ok) {
      const detail =
        (typeof body?.detail === "string" && body.detail) ||
        (Array.isArray(body?.detail) && body.detail.map((d) => d.msg || d).join("; ")) ||
        `HTTP ${res.status}`;
      throw new Error(detail);
    }
    console.info("[main-bod-cod] POST ok", {
      ms: Math.round((performance.now?.() || Date.now()) - t0),
      keys: body && typeof body === "object" ? Object.keys(body) : [],
    });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten API payload → sorted chainage series + JalNetra-style reaches for HUD.
 */
export function normalizeMainBodCod(raw, chainage) {
  const points = extractRawPoints(raw);
  const chain = Array.isArray(chainage) && chainage.length ? chainage : getChainage();
  const snapped = snapAndFillSeries(points, chain);
  const filled = interpolateGaps(snapped);
  const streams = extractStreamSummaries(raw);
  const reaches = buildReachesFromSeries(filled);
  return {
    source: "main-bod-cod",
    fetchedAt: new Date().toISOString(),
    raw,
    streams,
    series: filled,
    reaches,
    bod_edges: [2, 3, 6, 10],
    summary: {
      n: filled.length,
      bodMean: meanOf(filled.map((p) => p.bod)),
      bodMin: minOf(filled.map((p) => p.bod)),
      bodMax: maxOf(filled.map((p) => p.bod)),
      codMean: meanOf(filled.map((p) => p.cod)),
      codMin: minOf(filled.map((p) => p.cod)),
      codMax: maxOf(filled.map((p) => p.cod)),
    },
    _viewerId: "main-bod-cod",
    _source: "main-bod-cod",
  };
}

function getChainage() {
  try {
    return window.__MM_DATASET__?.chainage || window.__MM_SCENE__?.dataset?.chainage || [];
  } catch {
    return [];
  }
}

/** Pull {meters?, lon, lat, bod, cod, date?} from many possible shapes. */
function extractRawPoints(raw) {
  const out = [];
  if (!raw || typeof raw !== "object") return out;

  const push = (row) => {
    if (!row || typeof row !== "object") return;
    const bod = num(
      row.bod ??
        row.BOD ??
        row.bod_mg_l ??
        row.bod_mgl ??
        row.bod_mean ??
        row.p50 ??
        row.bod_p50,
    );
    const cod = num(
      row.cod ??
        row.COD ??
        row.cod_mg_l ??
        row.cod_mgl ??
        row.cod_mean ??
        row.cod_p50,
    );
    if (!Number.isFinite(bod) && !Number.isFinite(cod)) return;
    const lon = num(row.lon ?? row.longitude ?? row.Longitude ?? row.lng ?? row.x);
    const lat = num(row.lat ?? row.latitude ?? row.Latitude ?? row.y);
    const meters = num(
      row.chainage_m ??
        row.chainageM ??
        row.meters ??
        row.m ??
        row.chainage ??
        row.distance_m ??
        row.dist_m,
    );
    out.push({
      meters: Number.isFinite(meters) ? meters : null,
      lon: Number.isFinite(lon) ? lon : null,
      lat: Number.isFinite(lat) ? lat : null,
      bod: Number.isFinite(bod) ? bod : null,
      cod: Number.isFinite(cod) ? cod : null,
      date: row.date || row.acq_date || row.acquisition_date || null,
    });
  };

  const visit = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      // Parallel arrays?
      if (node.length && typeof node[0] === "number") return;
      for (const item of node) {
        if (item && typeof item === "object") {
          if (
            "bod" in item ||
            "BOD" in item ||
            "cod" in item ||
            "COD" in item ||
            "bod_mg_l" in item ||
            "p50" in item
          ) {
            push(item);
          } else {
            visit(item, depth + 1);
          }
        }
      }
      return;
    }
    if (typeof node !== "object") return;

    // Columnar: { chainage_m:[], lat:[], lon:[], bod:[], cod:[] }
    const cols = pickColumnar(node);
    if (cols) {
      for (let i = 0; i < cols.n; i++) {
        push({
          chainage_m: cols.m?.[i],
          lat: cols.lat?.[i],
          lon: cols.lon?.[i],
          bod: cols.bod?.[i],
          cod: cols.cod?.[i],
          date: cols.date?.[i],
        });
      }
    }

    for (const key of [
      "series",
      "chainage",
      "chainage_series",
      "daily_chainage",
      "daily",
      "by_date",
      "days",
      "points",
      "samples",
      "records",
      "rows",
      "data",
      "values",
      "main",
      "stream",
      "streams",
      "reaches",
      "results",
      "pixels",
      "latest",
    ]) {
      if (node[key] != null) visit(node[key], depth + 1);
    }

    // Date-keyed maps: { "2024-01-15": [ {...}, ... ] }
    for (const [k, v] of Object.entries(node)) {
      if (/^\d{4}-\d{2}-\d{2}/.test(k) && (Array.isArray(v) || (v && typeof v === "object"))) {
        visit(v, depth + 1);
      }
    }
  };

  visit(raw);
  // Prefer latest acquisition day when many dates present.
  if (out.length > 2) {
    const withDate = out.filter((p) => p.date);
    if (withDate.length > out.length * 0.4) {
      const dates = [...new Set(withDate.map((p) => String(p.date).slice(0, 10)))].sort();
      const latest = dates[dates.length - 1];
      if (latest) {
        const latestPts = out.filter((p) => !p.date || String(p.date).slice(0, 10) === latest);
        if (latestPts.length >= 2) return latestPts;
      }
    }
  }
  return out;
}

function pickColumnar(node) {
  const m = asNumArr(node.chainage_m || node.meters || node.chainage || node.m);
  const lat = asNumArr(node.lat || node.latitude || node.Latitude);
  const lon = asNumArr(node.lon || node.longitude || node.Longitude || node.lng);
  const bod = asNumArr(node.bod || node.BOD || node.bod_mg_l || node.p50);
  const cod = asNumArr(node.cod || node.COD || node.cod_mg_l || node.cod_p50);
  const date = Array.isArray(node.date || node.dates) ? node.date || node.dates : null;
  const n = Math.max(m?.length || 0, lat?.length || 0, lon?.length || 0, bod?.length || 0, cod?.length || 0);
  if (n < 2) return null;
  if (!(bod?.length || cod?.length)) return null;
  return { n, m, lat, lon, bod, cod, date };
}

function asNumArr(v) {
  if (!Array.isArray(v) || !v.length) return null;
  if (typeof v[0] === "number" || (typeof v[0] === "string" && Number.isFinite(Number(v[0])))) {
    return v.map((x) => Number(x));
  }
  return null;
}

function extractStreamSummaries(raw) {
  const list = [];
  const streams = raw?.streams || raw?.results?.streams || raw?.data?.streams;
  if (Array.isArray(streams)) {
    for (const s of streams) {
      list.push({
        name: s.name || s.stream_name || s.id || "stream",
        bodMean: num(s.bod_mean ?? s.mean_bod ?? s.bodMean),
        bodMin: num(s.bod_min ?? s.min_bod ?? s.bodMin),
        bodMax: num(s.bod_max ?? s.max_bod ?? s.bodMax),
        codMean: num(s.cod_mean ?? s.mean_cod ?? s.codMean),
        codMin: num(s.cod_min ?? s.min_cod ?? s.codMin),
        codMax: num(s.cod_max ?? s.max_cod ?? s.codMax),
      });
    }
  }
  return list;
}

/**
 * Snap API samples onto project chainage (10 m) using meters or nearest lat/lon.
 */
function snapAndFillSeries(points, chain) {
  if (!chain?.length) {
    return points
      .filter((p) => Number.isFinite(p.meters) || (Number.isFinite(p.lon) && Number.isFinite(p.lat)))
      .map((p) => ({ ...p, meters: p.meters ?? 0 }))
      .sort((a, b) => a.meters - b.meters);
  }

  /** @type {Map<number, {bod:number[], cod:number[], lon:number, lat:number, date:any}>} */
  const buckets = new Map();
  const first = Number(chain[0].meters) || 0;
  const last = Number(chain[chain.length - 1].meters) || first;

  for (const p of points) {
    let meters = p.meters;
    if (!Number.isFinite(meters) && Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
      meters = nearestChainageMeters(chain, p.lon, p.lat);
    }
    if (!Number.isFinite(meters)) continue;
    meters = Math.round(meters / 10) * 10;
    if (meters < first - 20 || meters > last + 20) continue;
    meters = Math.max(first, Math.min(last, meters));
    let b = buckets.get(meters);
    if (!b) {
      const ll = lonLatAt(chain, meters) || { lon: p.lon, lat: p.lat };
      b = { bod: [], cod: [], lon: ll.lon, lat: ll.lat, date: p.date };
      buckets.set(meters, b);
    }
    if (Number.isFinite(p.bod)) b.bod.push(p.bod);
    if (Number.isFinite(p.cod)) b.cod.push(p.cod);
    if (p.date) b.date = p.date;
  }

  const series = [];
  for (const [meters, b] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
    series.push({
      meters,
      lon: b.lon,
      lat: b.lat,
      bod: b.bod.length ? avg(b.bod) : null,
      cod: b.cod.length ? avg(b.cod) : null,
      date: b.date,
      observed: true,
    });
  }
  return series;
}

/**
 * Fill missing BOD/COD between observed points by linear neighbour average
 * so the full river water has a continuous value (full chainage span when known).
 */
export function interpolateGaps(series) {
  if (!series?.length) return [];
  const sorted = [...series].sort((a, b) => a.meters - b.meters);
  const chain = getChainage();
  let first = sorted[0].meters;
  let last = sorted[sorted.length - 1].meters;
  if (chain.length >= 2) {
    const c0 = Number(chain[0].meters);
    const c1 = Number(chain[chain.length - 1].meters);
    if (Number.isFinite(c0) && Number.isFinite(c1)) {
      first = Math.min(first, Math.min(c0, c1));
      last = Math.max(last, Math.max(c0, c1));
    }
  }
  first = Math.round(first / 10) * 10;
  last = Math.round(last / 10) * 10;
  const byM = new Map(sorted.map((p) => [Math.round(p.meters / 10) * 10, p]));

  // Full 10 m grid along the river; gaps get neighbour averages.
  const filled = [];
  for (let m = first; m <= last; m += 10) {
    const hit = byM.get(m);
    filled.push(
      hit
        ? { ...hit, meters: m }
        : {
            meters: m,
            lon: null,
            lat: null,
            bod: null,
            cod: null,
            date: null,
            observed: false,
          },
    );
  }

  fillChannel(filled, "bod");
  fillChannel(filled, "cod");

  for (const p of filled) {
    if ((!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) && chain.length) {
      const ll = lonLatAt(chain, p.meters);
      if (ll) {
        p.lon = ll.lon;
        p.lat = ll.lat;
      }
    }
  }
  return filled;
}

function fillChannel(arr, key) {
  const n = arr.length;
  let i = 0;
  while (i < n) {
    if (Number.isFinite(arr[i][key])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !Number.isFinite(arr[j][key])) j++;
    const left = i > 0 ? arr[i - 1][key] : null;
    const right = j < n ? arr[j][key] : null;
    for (let k = i; k < j; k++) {
      if (Number.isFinite(left) && Number.isFinite(right)) {
        const t = (k - i + 1) / (j - i + 1);
        arr[k][key] = left * (1 - t) + right * t;
        arr[k].interpolated = true;
      } else if (Number.isFinite(left)) {
        arr[k][key] = left;
        arr[k].interpolated = true;
      } else if (Number.isFinite(right)) {
        arr[k][key] = right;
        arr[k].interpolated = true;
      }
    }
    i = j;
  }
}

function buildReachesFromSeries(series) {
  if (!series.length) return [];
  const step = 500;
  const first = series[0].meters;
  const last = series[series.length - 1].meters;
  const reaches = [];
  let idx = 0;
  for (let m0 = first; m0 < last; m0 += step) {
    const m1 = Math.min(last, m0 + step);
    const slice = series.filter((p) => p.meters >= m0 && p.meters <= m1);
    const bods = slice.map((p) => p.bod).filter(Number.isFinite);
    const cods = slice.map((p) => p.cod).filter(Number.isFinite);
    if (!bods.length && !cods.length) continue;
    const p50 = avg(bods);
    const cod50 = avg(cods);
    const mid = slice[Math.floor(slice.length / 2)] || slice[0];
    reaches.push({
      id: `mithi-r${idx}`,
      name: `CH ${(m0 / 1000).toFixed(2)}–${(m1 / 1000).toFixed(2)} km`,
      km: [m0 / 1000, m1 / 1000],
      chainage_m: [m0, m1],
      lon: mid?.lon,
      lat: mid?.lat,
      today: {
        p10: minOf(bods),
        p50,
        p90: maxOf(bods),
        cod_p10: minOf(cods),
        cod_p50: cod50,
        cod_p90: maxOf(cods),
        cls: classFromBod(p50),
      },
      history: { dates: [], p50: [], cod_p50: [], support: [] },
      forecast: { dates: [], p50: [], cod_p50: [] },
    });
    idx++;
  }
  return reaches;
}

/** Sample live series at chainage meters (after neighbour-average fill). */
export function sampleMainBodCodAtMeters(meters) {
  const series = cache?.series;
  if (!series?.length || !Number.isFinite(meters)) return null;
  const m = Math.round(meters / 10) * 10;
  let best = null;
  let bestD = Infinity;
  for (const p of series) {
    const d = Math.abs(p.meters - m);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > 80) return null;
  if (!Number.isFinite(best.bod) && !Number.isFinite(best.cod)) return null;
  return {
    bod: best.bod,
    cod: best.cod,
    meters: best.meters,
    lon: best.lon,
    lat: best.lat,
    interpolated: !!best.interpolated,
    source: "main-bod-cod",
  };
}

export function sampleMainBodCodAtLonLat(lon, lat) {
  const series = cache?.series;
  if (!series?.length || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  let best = null;
  let bestD = Infinity;
  for (const p of series) {
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    const d = (p.lon - lon) ** 2 + (p.lat - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > 0.01 * 0.01) return null;
  if (!Number.isFinite(best.bod) && !Number.isFinite(best.cod)) return null;
  return {
    bod: best.bod,
    cod: best.cod,
    meters: best.meters,
    lon: best.lon,
    lat: best.lat,
    interpolated: !!best.interpolated,
    source: "main-bod-cod",
    distDeg2: bestD,
  };
}

function lonLatAt(chain, meters) {
  const p = interpolateChainage(chain, meters);
  if (!p) return null;
  if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) return { lon: p.lon, lat: p.lat };
  if (Number.isFinite(p.x) && Number.isFinite(p.z)) {
    try {
      const ll = localToLonLat(p.x, p.z);
      if (Number.isFinite(ll?.lon) && Number.isFinite(ll?.lat)) return { lon: ll.lon, lat: ll.lat };
    } catch {
      /* geo not ready */
    }
  }
  return null;
}

function nearestChainageMeters(chain, lon, lat) {
  let bestM = null;
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(chain.length / 800));
  for (let i = 0; i < chain.length; i += step) {
    const p = chain[i];
    let plon = p.lon;
    let plat = p.lat;
    if (!Number.isFinite(plon) || !Number.isFinite(plat)) {
      try {
        const ll = localToLonLat(p.x, p.z);
        plon = ll.lon;
        plat = ll.lat;
      } catch {
        continue;
      }
    }
    const d = (plon - lon) ** 2 + (plat - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      bestM = p.meters;
    }
  }
  return bestM;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function meanOf(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? avg(v) : null;
}
function minOf(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? Math.min(...v) : null;
}
function maxOf(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? Math.max(...v) : null;
}
