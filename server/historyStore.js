import crypto from "crypto";
import { pool } from "./db.js";

const PROJECT_ID = process.env.MITHI_PROJECT_ID || "mithi";

/** Stable hash of payload for fingerprinting (not for uniqueness alone). */
export function fingerprintPayload(payload) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

/** Local calendar YYYY-MM-DD (IST-friendly for Mithi twin). */
export function localTodayYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Normalize pg DATE / ISO timestamps to YYYY-MM-DD without UTC day-shift.
 * DATE '2026-11-24' must never serialize as 2026-11-23T18:30:00.000Z → "2026-11-23".
 */
export function asYmd(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const s = value.trim();
    // Plain calendar day from Postgres to_char / liveDay — trust as-is.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // ISO datetime → local calendar (IST: 23T18:30Z === 24 local).
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return localTodayYmd(d);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return localTodayYmd(value);
  }
  try {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return localTodayYmd(d);
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Infer calendar data_date + kml_type from JalNetra body / session dates.
 * Live stores use the local calendar day so one row covers the full day.
 */
export function inferMeta(componentType, payload, opts = {}) {
  // Live day key wins — JalNetra window end_date stays inside payload.
  const liveDay = opts.liveDay || opts.live_day || null;
  const end = opts.endDate || opts.end_date || null;
  let dataDate = liveDay
    ? String(liveDay).slice(0, 10)
    : end
      ? String(end).slice(0, 10)
      : null;

  if (!dataDate && payload && typeof payload === "object") {
    const cand =
      payload.data_date ||
      payload.date ||
      payload.end_date ||
      payload.year ||
      null;
    if (cand) {
      if (/^\d{4}$/.test(String(cand))) dataDate = `${cand}-12-31`;
      else dataDate = String(cand).slice(0, 10);
    }
  }
  if (!dataDate || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate)) {
    dataDate = localTodayYmd();
  }

  // kml_type: layer subtype so two different KML kinds on same day stay distinct,
  // but identical type+day never duplicates.
  const DEFAULT_KML = {
    lithology: "spectral",
    "bank-erosion": "bank_erosion",
    lulc: "lulc",
    "vegetation-type": "vegetation_type",
    "vegetation-health": "vegetation_health",
    salinity: "salinity",
    "water-quality": "water_quality",
    "water-depth": "water_depth",
    eutrophication: "eutrophication",
    nitrogen: "nitrogen",
    coliform: "coliform",
    "streams-bod-cod": "streams_bod_cod",
    "main-bod-cod": "main_bod_cod",
    drainage: "joining_stream", // Geology → Joining Streams
    "fishing-point": "fishing_point",
    "live-water": "live_water",
  };

  let kmlType = opts.kmlType || opts.kml_type || DEFAULT_KML[componentType] || "default";
  if (payload?.product) kmlType = String(payload.product);
  if (payload?.layer) kmlType = String(payload.layer);

  return { dataDate, kmlType };
}

/**
 * Upsert one live/demo snapshot for (project, component, data_date, kml_type).
 * Same calendar day keeps a single row that updates for the full day.
 */
export async function storeSnapshot(componentType, payload, opts = {}) {
  const { dataDate, kmlType } = inferMeta(componentType, payload, opts);
  const fingerprint = fingerprintPayload(payload);
  const kmlRefs = opts.kmlRefs ?? null;
  const source = opts.source || "jalnetra-live";

  const sql = `
    INSERT INTO component_history
      (project_id, component_type, data_date, kml_type, fingerprint, payload, kml_refs, source)
    VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, $7::jsonb, $8)
    ON CONFLICT (project_id, component_type, data_date, kml_type) DO UPDATE SET
      fingerprint = EXCLUDED.fingerprint,
      payload = EXCLUDED.payload,
      kml_refs = EXCLUDED.kml_refs,
      source = EXCLUDED.source,
      fetched_at = NOW()
    RETURNING id, project_id, component_type, data_date, kml_type, fingerprint, fetched_at, source,
      (xmax = 0) AS inserted
  `;

  const r = await pool.query(sql, [
    PROJECT_ID,
    componentType,
    dataDate,
    kmlType,
    fingerprint,
    JSON.stringify(payload ?? {}),
    kmlRefs ? JSON.stringify(kmlRefs) : null,
    source,
  ]);

  const row = r.rows[0];
  const inserted = !!row?.inserted;
  if (row) row.data_date = asYmd(row.data_date) || dataDate;
  return {
    stored: true,
    inserted,
    updated: !inserted,
    row,
    dataDate,
    kmlType,
    fingerprint,
  };
}

/** Latest snapshot — prefer jalnetra-live over local-demo on the same day. */
export async function getLatest(componentType) {
  const r = await pool.query(
    `
    SELECT id, project_id, component_type,
           to_char(data_date, 'YYYY-MM-DD') AS data_date,
           kml_type, fingerprint,
           payload, kml_refs, source, fetched_at
    FROM component_history
    WHERE project_id = $1 AND component_type = $2
    ORDER BY data_date DESC,
      CASE WHEN source ILIKE 'jalnetra%' THEN 0 ELSE 1 END,
      fetched_at DESC
    LIMIT 1
    `,
    [PROJECT_ID, componentType],
  );
  return r.rows[0] || null;
}

/** All live rows for the local calendar day (full-day status). */
export async function listTodayLive(day = localTodayYmd()) {
  const r = await pool.query(
    `
    SELECT DISTINCT ON (component_type)
      id, component_type,
      to_char(data_date, 'YYYY-MM-DD') AS data_date,
      kml_type, source, fetched_at,
      pg_column_size(payload) AS payload_bytes
    FROM component_history
    WHERE project_id = $1
      AND data_date = $2::date
      AND source ILIKE 'jalnetra%'
    ORDER BY component_type, fetched_at DESC
    `,
    [PROJECT_ID, day],
  );
  return { day, count: r.rows.length, items: r.rows };
}

/**
 * Ensure every known component has a jalnetra-live row for today by copying
 * the newest prior live payload when today's row is missing.
 */
export async function ensureTodayLiveRows(componentTypes = []) {
  const day = localTodayYmd();
  const ensured = [];
  for (const componentType of componentTypes) {
    const existing = await pool.query(
      `
      SELECT id FROM component_history
      WHERE project_id = $1 AND component_type = $2 AND data_date = $3::date
        AND source ILIKE 'jalnetra%'
      LIMIT 1
      `,
      [PROJECT_ID, componentType, day],
    );
    if (existing.rowCount) {
      ensured.push({ componentType, status: "already_today" });
      continue;
    }
    const latest = await getLatest(componentType);
    if (!latest?.payload) {
      ensured.push({ componentType, status: "no_source" });
      continue;
    }
    const kmlType =
      /jalnetra/i.test(String(latest.source || "")) && latest.kml_type
        ? latest.kml_type
        : String(latest.kml_type || "default").replace(/1_.*$/, "").replace(/\|.*/, "") ||
          "default";
    // Prefer canonical live kml types (not demo logical names)
    const liveKml =
      {
        lithology: "spectral",
        "bank-erosion": "bank_erosion",
        lulc: "lulc",
        "vegetation-type": "vegetation_type",
        "vegetation-health": "vegetation_health",
        salinity: "salinity",
        "water-quality": "water_quality",
        "water-depth": "water_depth",
        eutrophication: "eutrophication",
        nitrogen: "nitrogen",
        coliform: "coliform",
        "streams-bod-cod": "streams_bod_cod",
        "main-bod-cod": "main_bod_cod",
        drainage: "joining_stream",
        "fishing-point": "fishing_point",
        "live-water": "live_water",
        "silt-classification": "silt_classification",
        "silt-volume": "silt_volume",
      }[componentType] || kmlType;

    const result = await storeSnapshot(componentType, latest.payload, {
      liveDay: day,
      kmlType: liveKml,
      kmlRefs: latest.kml_refs,
      source: "jalnetra-live",
    });
    ensured.push({
      componentType,
      status: result.inserted ? "promoted_today" : "updated_today",
      dataDate: day,
      from: latest.data_date,
    });
  }
  return { day, ensured };
}

/** History list (metadata only) sorted newest first — fast listing. */
export async function listHistory(componentType, { limit = 50 } = {}) {
  const r = await pool.query(
    `
    SELECT id, component_type,
           to_char(data_date, 'YYYY-MM-DD') AS data_date,
           kml_type, fingerprint, source, fetched_at
    FROM component_history
    WHERE project_id = $1 AND component_type = $2
    ORDER BY data_date DESC, fetched_at DESC
    LIMIT $3
    `,
    [PROJECT_ID, componentType, Math.min(200, Math.max(1, Number(limit) || 50))],
  );
  return r.rows;
}

export async function getById(id) {
  const r = await pool.query(
    `
    SELECT id, project_id, component_type,
           to_char(data_date, 'YYYY-MM-DD') AS data_date,
           kml_type, fingerprint,
           payload, kml_refs, source, fetched_at
    FROM component_history
    WHERE project_id = $1 AND id = $2
    `,
    [PROJECT_ID, id],
  );
  return r.rows[0] || null;
}
