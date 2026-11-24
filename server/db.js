import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://mithi:mithi@127.0.0.1:5433/mithi_river";

/** Render / managed Postgres usually require TLS. */
const needsSsl =
  /sslmode=require/i.test(connectionString) ||
  /\.render\.com/i.test(connectionString) ||
  process.env.PGSSLMODE === "require";

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  allowExitOnIdle: true,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on("error", (err) => {
  console.warn("[db] idle client error", err.message);
});

let ready = null;

export async function ensureSchema() {
  if (ready) return ready;
  ready = (async () => {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(sql);
    console.info("[db] schema ready");
  })();
  return ready;
}

export async function healthCheck() {
  const r = await pool.query("SELECT 1 AS ok");
  return r.rows[0]?.ok === 1;
}
