/**
 * Apply schema.sql to DATABASE_URL (local or Render Postgres).
 *
 *   DATABASE_URL=postgres://… node server/migrate.js
 *   npm run db:migrate
 */
import "./loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = (process.env.DATABASE_URL || "").trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const needsSsl =
  /sslmode=require/i.test(url) ||
  /\.render\.com/i.test(url) ||
  process.env.PGSSLMODE === "require";

const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

const client = new Client({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 20_000,
});

try {
  await client.connect();
  await client.query(sql);
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  const count = await client.query(
    `SELECT COUNT(*)::int AS n FROM component_history`,
  );
  console.info("[migrate] ok", {
    host: url.replace(/:[^:@/]+@/, ":****@").replace(/^[^@]+@/, "***@"),
    tables: tables.rows.map((r) => r.table_name),
    component_history_rows: count.rows[0]?.n ?? 0,
  });
} catch (err) {
  console.error("[migrate] failed:", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
