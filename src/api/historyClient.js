/**
 * Project history API (PostgreSQL-backed).
 * Live JalNetra → POST store → on fail GET latest from DB.
 * Same calendar day + same kml_type are not duplicated server-side.
 *
 * Local: VITE_HISTORY_API_BASE=/api/history (Vite proxies to :5181).
 * Vercel: leave unset until a hosted history API exists — SPA must not hit /api/history.
 */

const HISTORY_BASE_RAW =
  typeof import.meta !== "undefined" ? import.meta.env?.VITE_HISTORY_API_BASE : undefined;
const HISTORY_BASE =
  HISTORY_BASE_RAW != null && String(HISTORY_BASE_RAW).trim() !== ""
    ? String(HISTORY_BASE_RAW).trim()
    : typeof import.meta !== "undefined" && import.meta.env?.DEV
      ? "/api/history"
      : "";

export function isHistoryApiConfigured() {
  return Boolean(HISTORY_BASE);
}

async function historyFetch(path, options = {}) {
  if (!HISTORY_BASE) {
    const err = new Error("history_api_disabled");
    err.status = 503;
    throw err;
  }
  const url = `${HISTORY_BASE.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  // Vercel SPA catch-all used to return index.html for /api/history — reject that.
  const looksHtml = /^\s*</.test(text) || /text\/html/i.test(res.headers.get("content-type") || "");
  let json = null;
  if (!looksHtml) {
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
  }
  if (looksHtml || (!res.ok && !json)) {
    const err = new Error(looksHtml ? "history_api_unavailable" : `history ${res.status}`);
    err.status = looksHtml ? 503 : res.status;
    err.body = json;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json?.error || `history ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Persist a live snapshot (upserted by calendar day + kml_type on server). */
export async function storeComponentHistory(component, payload, meta = {}) {
  return historyFetch(`/${encodeURIComponent(component)}`, {
    method: "POST",
    body: JSON.stringify({
      payload,
      liveDay: meta.liveDay ?? meta.live_day ?? null,
      endDate: meta.endDate ?? meta.end_date ?? null,
      kmlType: meta.kmlType ?? meta.kml_type ?? null,
      kmlRefs: meta.kmlRefs ?? null,
      source: meta.source ?? "jalnetra-live",
    }),
  });
}

/** Promote latest live payloads into today's DB rows (full-day coverage). */
export async function ensureTodayHistory(components) {
  return historyFetch(`/status/ensure-today`, {
    method: "POST",
    body: JSON.stringify({ components: components || undefined }),
  });
}

/** List which components already have a live row for today. */
export async function getTodayHistoryStatus() {
  return historyFetch(`/status/today`);
}

/** Latest stored row for component (API-fail fallback). */
export async function getLatestComponentHistory(component) {
  return historyFetch(`/${encodeURIComponent(component)}/latest`);
}

/** Sorted history index (no heavy payloads). */
export async function listComponentHistory(component, { limit = 50 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  return historyFetch(`/${encodeURIComponent(component)}?${q}`);
}

/**
 * Live-first with history store + DB fallback.
 * @param {string} component e.g. "lithology"
 * @param {() => Promise<{ payload: any, meta?: object }>} fetchLive
 */
export async function fetchWithHistory(component, fetchLive) {
  try {
    const live = await fetchLive();
    const payload = live?.payload ?? live;
    const meta = live?.meta ?? {};
    try {
      await storeComponentHistory(component, payload, meta);
    } catch (storeErr) {
      console.warn(
        `[history] store ${component} failed (live still used)`,
        storeErr.message
      );
    }
    return {
      ok: true,
      fromCache: false,
      payload,
      meta,
    };
  } catch (liveErr) {
    console.warn(`[history] live ${component} failed → DB fallback`, liveErr.message);
    try {
      const cached = await getLatestComponentHistory(component);
      return {
        ok: true,
        fromCache: true,
        payload: cached.payload,
        meta: {
          endDate: cached.dataDate,
          kmlType: cached.kmlType,
          source: cached.source,
          fetchedAt: cached.fetchedAt,
        },
        cacheMeta: cached,
        liveError: liveErr.message,
      };
    } catch (cacheErr) {
      const err = new Error(
        `live and history failed: ${liveErr.message}; ${cacheErr.message}`
      );
      err.liveError = liveErr;
      err.cacheError = cacheErr;
      throw err;
    }
  }
}
