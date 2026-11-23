/**
 * BOD/COD for the uploaded river.
 * Live path: POST /api/main-bod-cod (mainBodCodService) every page load.
 * Interim: bundled main_bod_cod_pixels KML / CSV along chainage.
 * Legacy /api/bod-cod viewer is removed from JalNetra OpenAPI — do not call it.
 */
import { riverFingerprint } from "./areaLive.js";
import { buildMandoviBodCodFromCsv, ensureBodCodPixels } from "./bodCodPixelService.js";
import {
  ensureMainBodCodLive,
  getMainBodCodCache,
} from "./mainBodCodService.js";

/** Kept for callers / env compatibility. Live path is main-bod-cod. */
export const DEFAULT_BOD_COD_VIEWER_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_BOD_COD_VIEWER_ID) || "";

const VIEWER_MAP_KEY = "planeteye-bod-cod-viewers-v1";

/** In-memory full payload (history is too large for localStorage). */
let memoryCache = null;

/**
 * @param {string} [viewerId]
 * @returns {Promise<object>}
 */
function isMandoviContext() {
  try {
    if (typeof window !== "undefined" && window.__MM_DATASET__?.isMandovi) return true;
    const scene = typeof window !== "undefined" ? window.__MM_SCENE__ : null;
    if (scene?.dataset?.isMandovi) return true;
    const name = String(window.__RIVER_SESSION__?.filename || "").toLowerCase();
    if (/mandovi|mandavi/.test(name)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function mandoviChainage() {
  try {
    const ds = window.__MM_DATASET__ || window.__MM_SCENE__?.dataset;
    return ds?.chainage || [];
  } catch {
    return [];
  }
}

/** Prefer Mandovi pixel CSV when this river has that grid. */
async function tryMandoviCsv(key) {
  if (!isMandoviContext()) return null;
  const chain = mandoviChainage();
  if (chain.length < 2) return null;
  try {
    await ensureBodCodPixels();
    const data = await buildMandoviBodCodFromCsv(chain);
    memoryCache = { ...data, _viewerId: data._viewerId, _riverKey: key || "mandovi", _source: "mandovi-csv" };
    return memoryCache;
  } catch (err) {
    console.warn("[bod-cod] Mandovi CSV unavailable:", err?.message || err);
    return null;
  }
}

export async function fetchBodCodViewerData(viewerId) {
  const session = typeof window !== "undefined" ? window.__RIVER_SESSION__ : null;
  const key = riverFingerprint(session) || (isMandoviContext() ? "mithi" : "");

  if (memoryCache?.reaches?.length && (!key || memoryCache._riverKey === key)) {
    if (
      !viewerId ||
      memoryCache._viewerId === viewerId ||
      memoryCache._source === "default-kml" ||
      memoryCache._source === "bundled-raw" ||
      memoryCache._source === "mandovi-csv" ||
      memoryCache._source === "main-bod-cod"
    ) {
      return memoryCache;
    }
  } else if (memoryCache && key && memoryCache._riverKey !== key) {
    memoryCache = null;
  }

  // Prefer live JalNetra main-bod-cod (fetched once per page load).
  const liveCached = getMainBodCodCache();
  if (liveCached?.reaches?.length) {
    memoryCache = { ...liveCached, _riverKey: key || "mithi" };
    return memoryCache;
  }

  const { getMainBodCodStatus } = await import("./mainBodCodService.js");
  if (getMainBodCodStatus() !== "loading") {
    try {
      const live = await ensureMainBodCodLive({
        chainage: mandoviChainage(),
      });
      if (live?.reaches?.length) {
        memoryCache = { ...live, _riverKey: key || "mithi" };
        return memoryCache;
      }
    } catch (err) {
      console.warn("[bod-cod] main-bod-cod unavailable, falling back", err?.message || err);
    }
  }

  // Instant local pixels until live returns / if live fails.
  const local = await tryMandoviCsv(key);
  if (local?.reaches?.length) return local;

  if (!session?.kmlText || !key) {
    throw new Error("BOD/COD loads only after a river KML is uploaded");
  }

  throw new Error("BOD/COD pixels not ready yet");
}

/** Re-fetch live main-bod-cod for this river (replaces legacy viewer refresh). */
export async function refreshBodCodFromKml() {
  const session = typeof window !== "undefined" ? window.__RIVER_SESSION__ : null;
  if (!session?.kmlText) throw new Error("BOD/COD needs this river's KML");
  const key = riverFingerprint(session);
  const live = await ensureMainBodCodLive({
    chainage: mandoviChainage(),
    force: true,
  });
  if (!live?.reaches?.length) throw new Error("main-bod-cod returned no reaches");
  memoryCache = { ...live, _riverKey: key || "mithi" };
  return memoryCache;
}

function remember(data, viewerId, riverKey) {
  memoryCache = { ...data, _viewerId: viewerId, _riverKey: riverKey, _source: "live" };
  writeViewerId(riverKey, viewerId);
  return memoryCache;
}

function readViewerMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWER_MAP_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeViewerId(riverKey, id) {
  if (!riverKey || !id) return;
  try {
    const map = readViewerMap();
    map[riverKey] = id;
    localStorage.setItem(VIEWER_MAP_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota */
  }
}

/** CPCB-style BOD class from p50 + bod_edges [2,3,6,10]. */
export function classFromBod(p50, edges = [2, 3, 6, 10]) {
  const v = Number(p50);
  if (!Number.isFinite(v)) return "NA";
  const e = edges.map(Number);
  if (v <= e[0]) return "A";
  if (v <= e[1]) return "B";
  if (v <= e[2]) return "C";
  if (v <= e[3]) return "D";
  return "E";
}

export function classShortLabel(cls, labels) {
  const full = labels?.[cls] || "";
  if (cls === "A") return "Drinking";
  if (cls === "B") return "Bathing";
  if (cls === "C") return "Treatable";
  if (cls === "D") return "Fisheries";
  if (cls === "E") return "Irrigation";
  if (full) return String(full).split(/—|–|-/)[0].trim().slice(0, 18);
  return cls || "—";
}

export function formatMgL(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)} mg/L`;
}

/**
 * Unified history + forecast timeline (hourly).
 * @returns {{ dates: string[], historyCount: number, forecastCount: number }}
 */
export function buildBodCodTimeline(data) {
  const r0 = data?.reaches?.[0];
  const hist = Array.isArray(r0?.history?.dates) ? r0.history.dates : [];
  const fcst = Array.isArray(r0?.forecast?.dates) ? r0.forecast.dates : [];
  return {
    dates: [...hist, ...fcst],
    historyCount: hist.length,
    forecastCount: fcst.length,
  };
}

/**
 * Sample one reach at timeline index.
 * @returns {{ p10,p50,p90,cod_p10,cod_p50,cod_p90,cls,support,tier,kind:'history'|'forecast'|'today' }}
 */
export function sampleReachAt(reach, timeIndex, data, timeline) {
  const edges = data?.bod_edges || [2, 3, 6, 10];
  const histN = timeline?.historyCount ?? reach?.history?.dates?.length ?? 0;
  const dates = timeline?.dates || [];
  const i = Math.max(0, Math.min(dates.length - 1, Number(timeIndex) || 0));

  if (i < histN && reach?.history?.p50?.length) {
    const h = reach.history;
    const p50 = Number(h.p50[i]);
    const support = String(h.support?.[i] || "prior");
    return {
      p10: Number(h.p10?.[i]),
      p50,
      p90: Number(h.p90?.[i]),
      cod_p10: Number(h.cod_p10?.[i]),
      cod_p50: Number(h.cod_p50?.[i]),
      cod_p90: Number(h.cod_p90?.[i]),
      cls: classFromBod(p50, edges),
      support,
      tier: support === "sat" || support === "anchor" ? "Observed" : "Estimated",
      kind: "history",
      date: dates[i],
    };
  }

  const fi = i - histN;
  if (reach?.forecast?.p50?.length && fi >= 0 && fi < reach.forecast.p50.length) {
    const f = reach.forecast;
    const p50 = Number(f.p50[fi]);
    return {
      p10: Number(f.p10?.[fi]),
      p50,
      p90: Number(f.p90?.[fi]),
      cod_p10: Number(f.cod_p10?.[fi]),
      cod_p50: Number(f.cod_p50?.[fi]),
      cod_p90: Number(f.cod_p90?.[fi]),
      cls: classFromBod(p50, edges),
      support: "forecast",
      tier: "Forecast",
      kind: "forecast",
      date: dates[i],
    };
  }

  const t = reach?.today || {};
  return {
    p10: Number(t.p10),
    p50: Number(t.p50),
    p90: Number(t.p90),
    cod_p10: Number(t.cod_p10),
    cod_p50: Number(t.cod_p50),
    cod_p90: Number(t.cod_p90),
    cls: String(t.cls || classFromBod(t.p50, edges)).toUpperCase(),
    support: String(t.support || "prior"),
    tier: String(t.tier || "Estimated"),
    kind: "today",
    date: data?.generated || dates[i] || "",
  };
}

/** Snapshot all reaches at one time index (for ribbon + strip). */
export function sampleAllReachesAt(data, timeIndex, timeline) {
  const tl = timeline || buildBodCodTimeline(data);
  return (data?.reaches || []).map((r) => ({
    id: r.id,
    name: r.name,
    km: r.km,
    sample: sampleReachAt(r, timeIndex, data, tl),
  }));
}

/** Alerts for the selected calendar day (YYYY-MM-DD). */
export function alertsForDate(data, dateStr) {
  const day = String(dateStr || "").slice(0, 10);
  const list = Array.isArray(data?.alerts) ? data.alerts : [];
  if (!day) return list.slice(0, 12);
  const exact = list.filter((a) => String(a.date || "").slice(0, 10) === day);
  if (exact.length) return exact;
  // Fallback: show all (API often stamps alerts on "today" only)
  return list.slice(0, 12);
}

/** River-wide accuracy / summary for the selected hour. */
export function riverAccuracyAt(data, timeIndex, timeline) {
  const snaps = sampleAllReachesAt(data, timeIndex, timeline);
  const edges = data?.bod_edges || [2, 3, 6, 10];
  const bath = Number(edges[1]) || 3;
  const bods = snaps.map((s) => s.sample.p50).filter(Number.isFinite);
  const cods = snaps.map((s) => s.sample.cod_p50).filter(Number.isFinite);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const aboveBath = snaps.filter((s) => Number(s.sample.p50) > bath).length;
  let highest = null;
  for (const s of snaps) {
    if (!Number.isFinite(s.sample.p50)) continue;
    if (!highest || s.sample.p50 > highest.sample.p50) highest = s;
  }
  const date = snaps[0]?.sample?.date || "";
  return {
    date,
    bodMean: mean(bods),
    codMean: mean(cods),
    aboveBathing: aboveBath,
    highestId: highest?.id || "—",
    highestBod: highest?.sample?.p50,
    reachCount: snaps.length,
  };
}

/** Default time index = last history hour (today), else last date. */
export function defaultTimeIndex(timeline) {
  const n = timeline?.dates?.length || 0;
  if (!n) return 0;
  const h = timeline.historyCount || 0;
  if (h > 0) return h - 1;
  return n - 1;
}

export function formatTimelineLabel(dateStr) {
  if (!dateStr) return "—";
  const raw = String(dateStr).trim();
  // Prefer short readable: 18 Jun 2026 · 23:00
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mon = months[Number(m[2]) - 1] || m[2];
    return `${Number(m[3])} ${mon} ${m[1]} · ${m[4]}:${m[5]}`;
  }
  return raw.replace("T", " ").slice(0, 16);
}

/** Compact ends for the scrubber scale (avoid long jammed strings). */
export function formatTimelineScaleLabel(dateStr) {
  if (!dateStr) return "—";
  const m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
  return String(dateStr).replace("T", " ").slice(0, 11);
}

/** Segment fill style for end-to-end bar. */
export function supportStyle(support) {
  const s = String(support || "").toLowerCase();
  if (s === "forecast") return "forecast";
  if (s === "sat" || s === "anchor" || s === "obs" || s === "observed") return "observed";
  return "prior";
}
