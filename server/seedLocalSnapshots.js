/**
 * Seed jalnetra-history KMLs into component_history as demo rows.
 * kml_type = logical name e.g. lithology1_21-10-2026|18-11-2026
 *
 *   node seedLocalSnapshots.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ensureSchema, pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(ROOT, "public", "data", "mithi", "jalnetra-history");
const PROJECT_ID = process.env.MITHI_PROJECT_ID || "mithi";

function toIsoDate(dmy) {
  const m = String(dmy || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return String(dmy || "").slice(0, 10);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function main() {
  await ensureSchema();
  const manifestPath = path.join(HISTORY_DIR, "manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest) || !manifest.length) {
    throw new Error("manifest empty");
  }

  let stored = 0;
  let updated = 0;

  for (const row of manifest) {
    const filePath = path.join(HISTORY_DIR, row.fileName);
    if (!fs.existsSync(filePath)) {
      console.warn("skip missing file", row.fileName);
      continue;
    }
    const dataDate = toIsoDate(row.endDate);
    const kmlType = row.logicalName; // visible name in DB
    const payload = {
      source: "local-demo",
      snapshot: row.logicalName,
      version: row.version,
      start_date: toIsoDate(row.startDate),
      end_date: dataDate,
      data_date: dataDate,
      kml_type: kmlType,
      name: row.logicalName,
      kml_download_url: row.url,
      kml_url: row.url,
      fileName: row.fileName,
      bytes: row.bytes,
      sourceFile: row.sourceFile,
    };
    const kmlRefs = [
      {
        path: "snapshot",
        url: row.url,
        name: row.logicalName,
        date: dataDate,
      },
    ];

    const sql = `
      INSERT INTO component_history
        (project_id, component_type, data_date, kml_type, fingerprint, payload, kml_refs, source)
      VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, $7::jsonb, $8)
      ON CONFLICT (project_id, component_type, data_date, kml_type)
      DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint,
        payload = EXCLUDED.payload,
        kml_refs = EXCLUDED.kml_refs,
        source = EXCLUDED.source,
        fetched_at = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `;
    const fingerprint = `demo:${row.logicalName}:${row.bytes}`;
    const r = await pool.query(sql, [
      PROJECT_ID,
      row.component,
      dataDate,
      kmlType,
      fingerprint,
      JSON.stringify(payload),
      JSON.stringify(kmlRefs),
      "local-demo",
    ]);
    const id = r.rows[0]?.id;
    const inserted = r.rows[0]?.inserted;
    if (inserted) stored += 1;
    else updated += 1;
    console.info(
      `${inserted ? "INSERT" : "UPDATE"} #${id}  ${row.component}  ${kmlType}`,
    );
  }

  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM component_history WHERE source = 'local-demo'`,
  );
  console.info(
    `\nDone. local-demo rows: ${count.rows[0].n} (new ${stored}, updated ${updated})`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("[seed] failed", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
