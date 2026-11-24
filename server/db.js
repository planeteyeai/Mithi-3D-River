import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isProd = process.env.NODE_ENV === "production";
const LOCAL_FALLBACK = "postgresql://mithi:mithi@127.0.0.1:5433/mithi_river";

/**
 * Production (Render) MUST set DATABASE_URL to the managed Postgres URL.
 * Never silently fall back to localhost there — that causes ECONNREFUSED :5433 spam.
 */
export const dbConfigured = Boolean(
  process.env.DATABASE_URL &&
    String(process.env.DATABASE_URL).trim() &&
    !/127\.0\.0\.1|localhost/i.test(
      isProd ? process.env.DATABASE_URL : "",
    ),
);

const connectionString = (() => {
  const raw = (process.env.DATABASE_URL || "").trim();
  if (raw) {
    if (isProd && /127\.0\.0\.1|localhost/i.test(raw)) {
      console.error(
        "[db] DATABASE_URL points at localhost in production — set the Render Postgres Internal/External URL",
      );
      return null;
    }
    return raw;
  }
  if (isProd) {
    console.error(
      "[db] DATABASE_URL is missing in production — link a Render Postgres and set DATABASE_URL",
    );
    return null;
  }
  return LOCAL_FALLBACK;
})();

/** Render / managed Postgres usually require TLS. */
const needsSsl =
  !!connectionString &&
  (/sslmode=require/i.test(connectionString) ||
    /\.render\.com/i.test(connectionString) ||
    process.env.PGSSLMODE === "require");

export const pool = connectionString
  ? new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      allowExitOnIdle: true,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    })
  : null;

if (pool) {
  pool.on("error", (err) => {
    console.warn("[db] idle client error", err.message);
  });
}

let ready = null;

export async function ensureSchema() {
  if (!pool) throw new Error("database_not_configured");
  if (ready) return ready;
  ready = (async () => {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(sql);
    console.info("[db] schema ready");
  })();
  return ready;
}

export async function healthCheck() {
  if (!pool) return false;
  const r = await pool.query("SELECT 1 AS ok");
  return r.rows[0]?.ok === 1;
}
