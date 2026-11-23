import crypto from "crypto";
import { pool } from "./db.js";

const PROJECT_ID = process.env.MITHI_PROJECT_ID || "mithi";

/** Stable hash of payload for fingerprinting (not for uniqueness alone). */
export function fingerprintPayload(payload) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

/**
 * Infer calendar data_date + kml_type from JalNetra body / session dates.
 * Lithology is year-window → use end_date day; else today UTC.
 */
export function inferMeta(componentType, payload, opts = {}) {
  const end = opts.endDate || opts.end_date || null;
  let dataDate = end ? String(end).slice(0, 10) : null;

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
    const d = new Date();
    dataDate = d.toISOString().slice(0, 10);
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
 * Insert only if (project, component, data_date, kml_type) is new.
 * Returns { stored: boolean, row?, reason? }
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
    ON CONFLICT (project_id, component_type, data_date, kml_type) DO NOTHING
    RETURNING id, project_id, component_type, data_date, kml_type, fingerprint, fetched_at, source
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

  if (r.rowCount === 0) {
    return {
      stored: false,
      reason: "duplicate_same_day_type",
      dataDate,
      kmlType,
      fingerprint,
    };
  }
  return { stored: true, row: r.rows[0], dataDate, kmlType, fingerprint };
}

/** Latest snapshot for a component (newest data_date, then fetched_at). */
export async function getLatest(componentType) {
  const r = await pool.query(
    `
    SELECT id, project_id, component_type, data_date, kml_type, fingerprint,
           payload, kml_refs, source, fetched_at
    FROM component_history
    WHERE project_id = $1 AND component_type = $2
    ORDER BY data_date DESC, fetched_at DESC
    LIMIT 1
    `,
    [PROJECT_ID, componentType],
  );
  return r.rows[0] || null;
}

/** History list (metadata only) sorted newest first — fast listing. */
export async function listHistory(componentType, { limit = 50 } = {}) {
  const r = await pool.query(
    `
    SELECT id, component_type, data_date, kml_type, fingerprint, source, fetched_at
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
    SELECT id, project_id, component_type, data_date, kml_type, fingerprint,
           payload, kml_refs, source, fetched_at
    FROM component_history
    WHERE project_id = $1 AND id = $2
    `,
    [PROJECT_ID, id],
  );
  return r.rows[0] || null;
}
