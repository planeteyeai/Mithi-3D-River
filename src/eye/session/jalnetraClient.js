/**
 * Posts one river KML to every JalNetra endpoint.
 * Dates follow the OpenAPI contract. The end date is never today.
 *   range  flood-water — the month the user selected
 *   month  salinity, water-quality, vegetation — one full calendar month
 *   year   lithology — 1 January through the selected end date
 *   none   lulc (years 2021–2026 are fixed);
 *          silt-classification / silt-volume (monthly KMLs in the response)
 */

import { getRiverSession } from "./riverSession.js";
import {
  storeComponentHistory,
  getLatestComponentHistory,
  ensureTodayHistory,
} from "../../api/historyClient.js";
import { hydrateLocalSnapshotsIntoSession } from "./localJalnetraSnapshots.js";

/** Same-origin proxy (/jalnetra-api) — works on Vite + Vercel without CORS. */
export const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_JALNETRA_API_BASE) ||
  "/jalnetra-api";

/**
 * Components persisted to PostgreSQL history (live → store → DB fallback).
 * Geology / land-use / water-quality suite (+ related hydrology overlays).
 * Same calendar day + same kml_type never duplicates.
 */
const HISTORY_KML_TYPES = {
  // Geology
  lithology: "spectral",
  "bank-erosion": "bank_erosion",
  // Land use
  lulc: "lulc",
  "vegetation-type": "vegetation_type",
  "vegetation-health": "vegetation_health",
  "silt-classification": "silt_classification",
  "silt-volume": "silt_volume",
  silt: "silt",
  // Water quality
  salinity: "salinity",
  "water-quality": "water_quality",
  "water-depth": "water_depth",
  // Pollution suite (UI pollution_* layers)
  eutrophication: "eutrophication",
  nitrogen: "nitrogen",
  coliform: "coliform",
  "streams-bod-cod": "streams_bod_cod",
  "main-bod-cod": "main_bod_cod",
  // JalNetra /api/drainage → Geology “Joining Streams”
  drainage: "joining_stream",
  "fishing-point": "fishing_point",
  "live-water": "live_water",
};

const HISTORY_COMPONENTS = new Set(Object.keys(HISTORY_KML_TYPES));

export function historyComponentIds() {
  return [...HISTORY_COMPONENTS];
}

/**
 * Stale-while-revalidate step 1:
 *   local jalnetra-history KMLs → Postgres latest → session already has body
 * so layers paint while JalNetra live refresh runs.
 */
export async function hydrateHistoryIntoSession(session) {
  if (!session?.results) return { filled: [] };
  const filled = [];

  // 1) Local snapshot KMLs (versioned files in /data/mithi/jalnetra-history)
  try {
    const local = await hydrateLocalSnapshotsIntoSession(session);
    filled.push(...(local.filled || []));
  } catch (err) {
    console.warn("[history] local snapshots skipped:", err.message);
  }

  // 2) Postgres wins over local when present (newer live stores)
  await Promise.all(
    [...HISTORY_COMPONENTS].map(async (id) => {
      if (session.results[id] && !session.results[id]?.source?.includes?.("local")) {
        window.dispatchEvent(
          new CustomEvent("planeteye-endpoint", {
            detail: { id, ok: true, fromCache: true, hydrated: true, staleOk: true },
          }),
        );
        return;
      }
      try {
        const cached = await getLatestComponentHistory(id);
        if (!cached?.payload) {
          if (session.results[id]) {
            window.dispatchEvent(
              new CustomEvent("planeteye-endpoint", {
                detail: { id, ok: true, fromCache: true, hydrated: true, staleOk: true },
              }),
            );
          }
          return;
        }
        session.results[id] = cached.payload;
        delete session.errors?.[id];
        if (!filled.includes(id)) filled.push(id);
        window.dispatchEvent(
          new CustomEvent("planeteye-endpoint", {
            detail: {
              id,
              ok: true,
              fromCache: true,
              hydrated: true,
              dataDate: cached.dataDate,
              kmlType: cached.kmlType,
            },
          }),
        );
      } catch {
        /* history API down — keep local / session */
        if (session.results[id]) {
          window.dispatchEvent(
            new CustomEvent("planeteye-endpoint", {
              detail: { id, ok: true, fromCache: true, hydrated: true, staleOk: true },
            }),
          );
        }
      }
    }),
  );
  if (filled.length) {
    console.info("[history] hydrated:", filled.join(", "));
  }

  // Make sure BOD/COD + full suite have a jalnetra-live row for local today.
  try {
    const ensured = await ensureTodayHistory([...HISTORY_COMPONENTS]);
    if (ensured?.ensured?.length) {
      const promoted = ensured.ensured.filter((r) =>
        /promoted|updated/.test(String(r.status || "")),
      );
      if (promoted.length) {
        console.info(
          `[history] today live rows ready (${ensured.day}):`,
          promoted.map((r) => r.componentType).join(", "),
        );
      }
    }
  } catch (err) {
    console.warn("[history] ensure-today skipped:", err.message);
  }

  return { filled };
}

async function persistLiveToHistory(componentId, body, session) {
  if (!HISTORY_COMPONENTS.has(componentId) || !body) return;
  try {
    const refs = collectKmlRefs(body).slice(0, 40);
    await storeComponentHistory(componentId, body, {
      // DB day key = local today so BOD/COD + all suite stay "live" for the full day.
      liveDay: todayYmd(),
      endDate: session?.end_date || null,
      kmlType: HISTORY_KML_TYPES[componentId] || "default",
      kmlRefs: refs.length
        ? refs.map((r) => ({
            path: r.path,
            id: r.id,
            date: r.date,
            year: r.year,
            month: r.month,
            name: r.name,
          }))
        : null,
      source: "jalnetra-live",
    });
  } catch (err) {
    console.warn(`[history] store ${componentId} skipped:`, err.message);
  }
}

/** When live JalNetra fails, use newest stored row for that component. */
async function loadHistoryFallback(componentId) {
  if (!HISTORY_COMPONENTS.has(componentId)) return null;
  try {
    const cached = await getLatestComponentHistory(componentId);
    if (!cached?.payload) return null;
    console.info(
      `[history] ${componentId} using DB fallback (${cached.dataDate} / ${cached.kmlType})`,
    );
    return cached.payload;
  } catch (err) {
    console.warn(`[history] fallback ${componentId} unavailable:`, err.message);
    return null;
  }
}

/** Silt endpoints — still tracked for cache freshness (run last in boot queue). */
const SILT_PRIORITY_IDS = ["silt-classification", "silt-volume"];

/**
 * Full JalNetra production catalog (Swagger):
 * https://jalnetra-software-production.up.railway.app/docs#/
 *
 * Boot hit order (one-by-one):
 *   1. lithology → 2. bank-erosion → 3. water quality suite →
 *   4. lulc → 5. silt → then remaining layers
 *
 * Not in this batch (dedicated boot paths):
 *   - main-bod-cod  → mainBodCodService.js (every page load)
 *   - /api/all      → optional mega-batch (too heavy for UI boot)
 */
const ENDPOINTS = [
  // 1–2 Geology first
  { id: "lithology", path: "/api/lithology" },
  { id: "bank-erosion", path: "/api/bank-erosion" },
  // Fishing points early so markers can upgrade from continuous corridor fill
  { id: "fishing-point", path: "/api/fishing-point" },
  // 3 Water quality suite (one by one)
  { id: "salinity", path: "/api/salinity" },
  { id: "water-quality", path: "/api/water-quality" },
  { id: "eutrophication", path: "/api/eutrophication" },
  { id: "nitrogen", path: "/api/nitrogen" },
  { id: "coliform", path: "/api/coliform" },
  { id: "water-depth", path: "/api/water-depth" },
  // 4 Land use
  { id: "lulc", path: "/api/lulc" },
  // 5 Silt last among the priority themes
  { id: "silt-classification", path: "/api/silt-classification" },
  { id: "silt-volume", path: "/api/silt-volume" },
  { id: "silt", path: "/api/silt" },
  // Remaining layers
  { id: "vegetation-type", path: "/api/vegetation-type" },
  { id: "vegetation-health", path: "/api/vegetation-health" },
  { id: "flood-water", path: "/api/flood-water" },
  { id: "streams-bod-cod", path: "/api/streams-bod-cod" },
  { id: "drainage", path: "/api/drainage" },
  { id: "fabdem-dtm", path: "/api/fabdem-dtm" },
  { id: "fabdem-dtm-raw", path: "/api/fabdem-dtm-raw" },
  { id: "copernicus-dsm", path: "/api/copernicus-dsm" },
];

/** Latest complete calendar month as YYYY-MM (current month excluded). */
export function latestCompleteMonthId(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Sorted unique YYYY-MM keys found in a silt API body. */
export function extractSiltDateIds(body) {
  const refs = collectKmlRefs(body);
  const ids = new Set();
  for (const ref of refs) {
    const y = Number(ref.year);
    const m = Number(ref.month);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      ids.add(`${y}-${pad(m)}`);
      continue;
    }
    const raw = String(ref.date || ref.name || ref.path || "");
    const hit = raw.match(/(20\d{2})[-_/](\d{1,2})/);
    if (hit) ids.add(`${hit[1]}-${pad(Number(hit[2]))}`);
  }
  return [...ids].sort();
}

/**
 * Reuse cached silt when date list already covers the latest complete month
 * (same dates → skip API; only refetch when a newer month is missing).
 */
export function siltCacheIsFresh(endpointId) {
  const session = getRiverSession();
  const body = session?.results?.[endpointId];
  if (!body) return false;
  const stored = session.siltDateFingerprints?.[endpointId];
  const dates = stored ? String(stored).split("|").filter(Boolean) : extractSiltDateIds(body);
  if (!dates.length) return false;
  const latest = dates[dates.length - 1];
  const need = latestCompleteMonthId();
  return latest >= need;
}

export function rememberSiltDates(endpointId, body) {
  const session = getRiverSession();
  if (!session.siltDateFingerprints) session.siltDateFingerprints = {};
  const dates = extractSiltDateIds(body);
  if (dates.length) session.siltDateFingerprints[endpointId] = dates.join("|");
  return dates;
}

const TIMEOUT_MS = 300000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayYmd(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function yesterdayYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return todayYmd(d);
}

function clampEnd(ymd) {
  const end = String(ymd || "").slice(0, 10);
  const today = todayYmd();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end >= today) return yesterdayYmd();
  return end;
}

/** Full calendar month. The current month is not complete, so the previous month is used. */
function monthWindow(endDate) {
  const end = clampEnd(endDate);
  const [yStr, mStr] = end.split("-");
  let year = Number(yStr);
  let month = Number(mStr);
  const now = new Date();
  if (year === now.getFullYear() && month === now.getMonth() + 1) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  const last = new Date(year, month, 0).getDate();
  return { start_date: `${year}-${pad(month)}-01`, end_date: `${year}-${pad(month)}-${pad(last)}` };
}

/** 1 January through the selected end date. Never includes today. */
function yearWindow(endDate) {
  const end = clampEnd(endDate);
  return { start_date: `${end.slice(0, 4)}-01-01`, end_date: end };
}

function dateWindow(spec, session) {
  if (spec.when === "month") return monthWindow(session.end_date);
  if (spec.when === "year") return yearWindow(session.end_date);
  if (spec.when === "range") {
    return { start_date: session.start_date, end_date: clampEnd(session.end_date) };
  }
  return null;
}

function clipFlood(body, start, end) {
  if (!body || !Array.isArray(body.datewise)) return body;
  const today = todayYmd();
  const datewise = body.datewise.filter((scene) => {
    const d = String(scene.date || scene.post_date || scene.end_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
    return d >= start && d <= end && d < today;
  });
  return { ...body, datewise };
}

function shiftMonth(window, delta) {
  const [y, m] = window.start_date.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const last = new Date(year, month, 0).getDate();
  return { start_date: `${year}-${pad(month)}-01`, end_date: `${year}-${pad(month)}-${pad(last)}` };
}

/** Drop lines and points so the upload is a single polygon. JalNetra 404s GeometryCollection. */
export function polygonOnlyKml(text) {
  let src = String(text || "");
  if (!/<(?:\w+:)?(?:LineString|Point|MultiGeometry)\b/i.test(src)) return src;
  src = src.replace(/<Placemark\b[^>]*>[\s\S]*?<(?:\w+:)?LineString\b[\s\S]*?<\/(?:\w+:)?LineString>[\s\S]*?<\/Placemark>/gi, "");
  src = src.replace(/<Placemark\b[^>]*>[\s\S]*?<(?:\w+:)?Point\b[\s\S]*?<\/(?:\w+:)?Point>[\s\S]*?<\/Placemark>/gi, "");
  src = src.replace(/<(?:\w+:)?MultiGeometry\b[^>]*>/gi, "");
  src = src.replace(/<\/(?:\w+:)?MultiGeometry>/gi, "");
  return src;
}

/** @deprecated box AOI removed — silt uses the real river polygon like every other layer. */
export function siltAoiKml(text) {
  return polygonOnlyKml(text);
}

function uploadKmlFor(spec, session) {
  const raw = session.kmlText || "";
  // main-bod-cod needs LineString stream KML — never strip to polygon-only.
  if (spec.id === "main-bod-cod") {
    return session.mainStreamKmlText || raw;
  }
  // Always post the real river polygon KML (mithi_river.kml) — never a bbox substitute.
  return polygonOnlyKml(raw);
}

async function postEndpoint(spec, session) {
  const form = new FormData();
  const kmlText = uploadKmlFor(spec, session);
  const blob = new Blob([kmlText], { type: "application/vnd.google-earth.kml+xml" });
  form.append("kml", blob, session.filename || "mithi_river.kml");
  if (spec.id === "water-depth") {
    form.append("depth_min_m", "1.5");
    form.append("depth_max_m", "8.0");
  }
  // KML-only contract: do not attach start_date / end_date unless the OpenAPI
  // schema requires them (currently none of the boot-batch endpoints do).
  const dates = spec.when ? dateWindow(spec, session) : null;
  if (dates && spec.requireDates === true) {
    form.append("start_date", dates.start_date);
    form.append("end_date", dates.end_date);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const attempt = Number(spec.attempt || 0);
  try {
    const res = await fetch(`${API_BASE.replace(/\/$/, "")}${spec.path}`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text };
    }
    if (!res.ok) {
      const detail =
        (typeof body?.detail === "string" && body.detail) ||
        (Array.isArray(body?.detail) && body.detail.map((d) => d.msg || d).join("; ")) ||
        (typeof text === "string" && text.trim()) ||
        `HTTP ${res.status}`;
      // Silt upstream often 502s — retry a few times with backoff.
      const isSilt = SILT_PRIORITY_IDS.includes(spec.id) || spec.id === "silt";
      const maxAttempts = isSilt ? 3 : 1;
      if (res.status >= 500 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        return postEndpoint({ ...spec, attempt: attempt + 1 }, session);
      }
      throw new Error(detail);
    }
    if (spec.id === "flood-water") body = clipFlood(body, session.start_date, session.end_date);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** KML downloads for silt-* share the /api/silt/kml/{id} route. */
function downloadEndpointId(endpoint) {
  const id = String(endpoint || "");
  if (id === "silt-classification" || id === "silt-volume" || id === "silt") return "silt";
  return id;
}

export function kmlDownloadUrl(endpoint, idOrUrl) {
  if (!idOrUrl) return null;
  const s = String(idOrUrl);
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, "https://");
  // Project-local static files (jalnetra-history snapshots, /data/mithi/…)
  if (s.startsWith("/data/")) return s;
  if (s.startsWith("/")) return `${API_BASE.replace(/\/$/, "")}${s}`;
  const ep = downloadEndpointId(endpoint);
  return `${API_BASE.replace(/\/$/, "")}/api/${ep}/kml/${s}`;
}

export function tifDownloadUrl(endpoint, idOrUrl) {
  if (!idOrUrl) return null;
  const s = String(idOrUrl);
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, "https://");
  if (s.startsWith("/data/")) return s;
  if (s.startsWith("/")) return `${API_BASE.replace(/\/$/, "")}${s}`;
  return `${API_BASE.replace(/\/$/, "")}/api/${endpoint}/tif/${s}`;
}

export async function downloadText(url) {
  const res = await fetch(url, { headers: { "ngrok-skip-browser-warning": "true" } });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  return res.text();
}

function ymFromPath(path) {
  const hit = String(path || "").match(/(20\d{2})[-_/](\d{1,2})/);
  if (!hit) return { year: null, month: null };
  return { year: Number(hit[1]), month: Number(hit[2]) };
}

export function collectKmlRefs(node, acc = [], path = "") {
  if (!node || typeof node !== "object") return acc;
  const inlineKml =
    typeof node.kml === "string" && /<(?:\w+:)?kml[\s>]/i.test(node.kml)
      ? node.kml
      : typeof node.kml_text === "string" && /<(?:\w+:)?kml[\s>]/i.test(node.kml_text)
        ? node.kml_text
        : null;
  if (
    node.kml_download_url ||
    node.kml_id ||
    node.kml_url ||
    node.tif_download_url ||
    node.tif_id ||
    node.download_url ||
    inlineKml
  ) {
    const fromPath = ymFromPath(path);
    acc.push({
      path,
      url: node.kml_download_url || node.kml_url || node.tif_download_url || node.download_url || null,
      id: node.kml_id || node.tif_id || null,
      inlineKml,
      date: node.date || node.post_date || node.end_date || node.label || null,
      year: node.year ?? fromPath.year,
      month: node.month ?? fromPath.month,
      name: node.name || node.layer || node.title || path,
      categories: node.categories || node.legend || node.classes || null,
    });
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectKmlRefs(child, acc, `${path}[${i}]`));
  } else {
    for (const [key, child] of Object.entries(node)) {
      if (!child || typeof child !== "object") continue;
      if (key === "categories" || key === "legend" || key === "classes") continue;
      collectKmlRefs(child, acc, path ? `${path}.${key}` : key);
    }
  }
  return acc;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function waitForEndpoint(id, timeoutMs = 90000) {
  const session = getRiverSession();
  if (session.results[id] || session.errors[id] || session.pending[id] === false) {
    return Promise.resolve(session.results[id] || null);
  }
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (session.results[id] || session.errors[id] || session.pending[id] === false) {
        clearInterval(timer);
        clearTimeout(stop);
        resolve(session.results[id] || null);
      }
    }, 400);
    const stop = setTimeout(() => {
      clearInterval(timer);
      resolve(session.results[id] || null);
    }, timeoutMs);
  });
}

let running = null;

async function runOneEndpoint(spec, session, onProgress) {
  const hadCache = !!session.results[spec.id];
  // Any live success that replaces hydrated/local cache must rebuild overlays.
  const refreshing = hadCache;
  onProgress?.({ id: spec.id, state: "running", refreshing });
  window.dispatchEvent(
    new CustomEvent("planeteye-endpoint", {
      detail: { id: spec.id, ok: null, state: "running", refreshing },
    }),
  );
  try {
    const body = await postEndpoint(spec, session);
    // Live wins: swap over DB/session stale body.
    if (body && typeof body === "object") body._liveOnce = true;
    session.results[spec.id] = body;
    delete session.errors[spec.id];
    if (SILT_PRIORITY_IDS.includes(spec.id)) rememberSiltDates(spec.id, body);
    if (spec.id === "fishing-point") {
      const ref = collectKmlRefs(body)[0];
      const href = kmlDownloadUrl("fishing-point", ref?.url || ref?.id);
      if (href) {
        try {
          session.fishingKmlText = await downloadText(href);
        } catch (err) {
          console.warn("[fishing-point] KML download", err.message);
        }
      }
    }
    if (spec.id === "streams-bod-cod") {
      const ref = collectKmlRefs(body)[0];
      const href = kmlDownloadUrl("streams-bod-cod", ref?.url || ref?.id || body?.kml_id);
      if (href) {
        try {
          session.streamsBodCodKmlText = await downloadText(href);
        } catch (err) {
          console.warn("[streams-bod-cod] KML download", err.message);
        }
      }
    }
    await persistLiveToHistory(spec.id, body, session);
    onProgress?.({ id: spec.id, state: "ok", liveReplace: true });
    window.dispatchEvent(
      new CustomEvent("planeteye-endpoint", {
        detail: { id: spec.id, ok: true, live: true, liveReplace: true },
      }),
    );
  } catch (err) {
    // Keep showing recent DB/session data — productive fallback while live failed.
    if (hadCache) {
      onProgress?.({ id: spec.id, state: "ok", fromCache: true, refreshing });
      window.dispatchEvent(
        new CustomEvent("planeteye-endpoint", {
          detail: { id: spec.id, ok: true, fromCache: true, staleSession: true },
        }),
      );
      return;
    }
    const cached = await loadHistoryFallback(spec.id);
    if (cached) {
      session.results[spec.id] = cached;
      delete session.errors[spec.id];
      onProgress?.({ id: spec.id, state: "ok", fromCache: true });
      window.dispatchEvent(
        new CustomEvent("planeteye-endpoint", {
          detail: { id: spec.id, ok: true, fromCache: true },
        }),
      );
      return;
    }
    const message = err?.name === "AbortError" ? "Timed out" : err?.message || String(err);
    session.errors[spec.id] = message;
    onProgress?.({ id: spec.id, state: "error", message });
    window.dispatchEvent(new CustomEvent("planeteye-endpoint", { detail: { id: spec.id, ok: false, message } }));
  } finally {
    session.pending[spec.id] = false;
  }
}

/**
 * True when Postgres already has a jalnetra-live row for local today.
 * Ignores local-demo / old end-date rows so the suite can refresh into today.
 */
/** Calendar YYYY-MM-DD from API date string / Date (avoids UTC day-shift). */
function asLocalYmd(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    try {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return todayYmd(d);
    } catch {
      /* ignore */
    }
  }
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(d.getTime())) return todayYmd(d);
  } catch {
    /* ignore */
  }
  return "";
}

async function hasSameDayHistory(componentId) {
  if (!HISTORY_COMPONENTS.has(componentId)) return false;
  try {
    const cached = await getLatestComponentHistory(componentId);
    if (!cached?.payload) return false;
    const source = String(cached.source || "");
    if (!/jalnetra/i.test(source)) return false;
    return asLocalYmd(cached.dataDate) === todayYmd();
  } catch {
    return false;
  }
}

async function markSameDayCached(spec, session, onProgress) {
  // Ensure session has the today's live payload (not only a progress ping).
  if (!session.results?.[spec.id]) {
    try {
      const cached = await getLatestComponentHistory(spec.id);
      if (cached?.payload) session.results[spec.id] = cached.payload;
    } catch {
      /* keep going — UI may already be hydrated */
    }
  }
  onProgress?.({ id: spec.id, state: "ok", fromCache: true, sameDay: true });
  window.dispatchEvent(
    new CustomEvent("planeteye-endpoint", {
      detail: { id: spec.id, ok: true, fromCache: true, sameDay: true, hydrated: true },
    }),
  );
  session.pending[spec.id] = false;
}

/**
 * Same-day cache: first load of the day POSTs JalNetra + stores in Postgres.
 * Later loads on the same date reuse DB — no repeat live fetch.
 */
export function runJalNetra(onProgress) {
  if (running) return running;
  const session = getRiverSession();
  if (!session.siltDateFingerprints) session.siltDateFingerprints = {};
  // Rebuild fingerprints from saved bodies so restart reuses dates without refetch.
  for (const id of SILT_PRIORITY_IDS) {
    if (session.results?.[id] && !session.siltDateFingerprints[id]) {
      rememberSiltDates(id, session.results[id]);
    }
  }

  running = (async () => {
    const todo = [];
    for (const spec of ENDPOINTS) {
      // Already fetched+stored today → skip live JalNetra.
      if (await hasSameDayHistory(spec.id)) {
        await markSameDayCached(spec, session, onProgress);
        continue;
      }
      // Silt: skip while month coverage is still fresh.
      if (SILT_PRIORITY_IDS.includes(spec.id) && siltCacheIsFresh(spec.id)) {
        await markSameDayCached(spec, session, onProgress);
        continue;
      }
      // Non-history endpoints: keep existing session body (no day store).
      if (!HISTORY_COMPONENTS.has(spec.id) && session.results?.[spec.id]) {
        await markSameDayCached(spec, session, onProgress);
        continue;
      }
      todo.push(spec);
      session.pending[spec.id] = true;
    }
    if (!todo.length) {
      console.info("[jalnetra] all endpoints already stored for today — skipping live POSTs");
      return;
    }
    console.info(
      `[jalnetra] live POST ${todo.length}/${ENDPOINTS.length} (others reused from same-day DB)`,
      todo.map((s) => s.id).join(", "),
    );
    // Strict serial queue — one JalNetra POST finishes before the next starts.
    await mapLimit(todo, 1, (spec) => runOneEndpoint(spec, session, onProgress));
  })().finally(() => {
    running = null;
  });
  return running;
}

/** True while either silt endpoint is in flight for the active river. */
export function siltEndpointsPending() {
  const session = getRiverSession();
  return {
    classification: !!(session?.pending?.["silt-classification"] && !session?.results?.["silt-classification"]),
    volume: !!(session?.pending?.["silt-volume"] && !session?.results?.["silt-volume"]),
  };
}

export function jalnetraEndpointIds() {
  return ENDPOINTS.map((e) => e.id);
}

/**
 * On-demand POST for one endpoint (e.g. silt layers opened before the batch finishes).
 * Uses the uploaded river KML from the active session.
 * @param {string} id
 * @param {{ forceLive?: boolean }} [opts] forceLive skips same-day DB reuse when KML URLs expired
 */
export async function fetchEndpointNow(id, opts = {}) {
  const session = getRiverSession();
  if (!session?.kmlText) throw new Error("Upload a river KML before requesting JalNetra layers");
  const spec = ENDPOINTS.find((e) => e.id === id);
  if (!spec) throw new Error(`Unknown JalNetra endpoint: ${id}`);
  const forceLive = !!opts.forceLive;
  // If the live-once boot queue is already fetching this id, wait for it.
  if (session.pending?.[id]) {
    return waitForEndpoint(id, TIMEOUT_MS);
  }
  // Same calendar day already in Postgres → reuse (no second live POST), unless forceLive.
  if (!forceLive && (await hasSameDayHistory(id))) {
    if (session.results?.[id]) return session.results[id];
    const cached = await getLatestComponentHistory(id);
    if (cached?.payload) {
      session.results[id] = cached.payload;
      window.dispatchEvent(
        new CustomEvent("planeteye-endpoint", {
          detail: { id, ok: true, fromCache: true, sameDay: true },
        }),
      );
      return cached.payload;
    }
  }
  // Live result already landed this session → reuse (unless caller needs a fresh KML).
  if (!forceLive && session.results?.[id] && session.results[id]?._liveOnce) {
    return session.results[id];
  }
  session.pending[id] = true;
  try {
    const body = await postEndpoint(spec, session);
    if (body && typeof body === "object") body._liveOnce = true;
    session.results[id] = body;
    delete session.errors[id];
    if (SILT_PRIORITY_IDS.includes(id)) rememberSiltDates(id, body);
    if (id === "streams-bod-cod") {
      const ref = collectKmlRefs(body)[0];
      const href = kmlDownloadUrl("streams-bod-cod", ref?.url || ref?.id || body?.kml_id);
      if (href) {
        try {
          session.streamsBodCodKmlText = await downloadText(href);
        } catch (err) {
          console.warn("[streams-bod-cod] KML download", err.message);
        }
      }
    }
    await persistLiveToHistory(id, body, session);
    window.dispatchEvent(
      new CustomEvent("planeteye-endpoint", { detail: { id, ok: true, live: true, liveReplace: true } }),
    );
    return body;
  } catch (err) {
    const cached = await loadHistoryFallback(id);
    if (cached) {
      session.results[id] = cached;
      delete session.errors[id];
      window.dispatchEvent(
        new CustomEvent("planeteye-endpoint", { detail: { id, ok: true, fromCache: true } }),
      );
      return cached;
    }
    const message = err?.name === "AbortError" ? "Timed out" : err?.message || String(err);
    session.errors[id] = message;
    window.dispatchEvent(new CustomEvent("planeteye-endpoint", { detail: { id, ok: false, message } }));
    throw err;
  } finally {
    session.pending[id] = false;
  }
}
