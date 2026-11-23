/**
 * Project history API (PostgreSQL-backed).
 * Live JalNetra → POST store → on fail GET latest from DB.
 * Same calendar day + same kml_type are not duplicated server-side.
 */

const HISTORY_BASE =
  (typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_HISTORY_API_BASE) ||
  "/api/history";

async function historyFetch(path, options = {}) {
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(json?.error || `history ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Persist a live snapshot (deduped by day + kml_type on server). */
export async function storeComponentHistory(component, payload, meta = {}) {
  return historyFetch(`/${encodeURIComponent(component)}`, {
    method: "POST",
    body: JSON.stringify({
      payload,
      endDate: meta.endDate ?? meta.end_date ?? null,
      kmlType: meta.kmlType ?? meta.kml_type ?? null,
      kmlRefs: meta.kmlRefs ?? null,
      source: meta.source ?? "jalnetra",
    }),
  });
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
