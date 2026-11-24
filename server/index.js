/**
 * Mithi full-stack host (Render) + local history API.
 *
 *   GET  /api/health
 *   GET/POST /api/history/*
 *   /jalnetra-api/*  → JalNetra Railway
 *   /rivereye-api/*  → RiverEye Railway
 *   /*               → Vite dist SPA (when built)
 */
import "./loadEnv.js";
import express from "express";
import cors from "cors";
import { ensureSchema, healthCheck, pool } from "./db.js";
import { historyRouter } from "./routes/history.js";
import { mountProxies, mountSpa } from "./spaAndProxies.js";

const PORT = Number(process.env.HISTORY_API_PORT || process.env.PORT || 5181);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

/** Soft request budget — avoid hung clients holding pool connections. */
app.use((req, res, next) => {
  // Proxied satellite jobs need a longer budget than history reads.
  const isProxy =
    req.path.startsWith("/jalnetra-api") ||
    req.path.startsWith("/rivereye-api");
  const ms = isProxy
    ? Number(process.env.PROXY_REQUEST_TIMEOUT_MS) || 600_000
    : Number(process.env.HISTORY_REQUEST_TIMEOUT_MS) || 25_000;
  res.setTimeout(ms, () => {
    if (!res.headersSent) {
      res.status(504).json({ ok: false, error: "request_timeout" });
    }
  });
  next();
});

app.get("/api/health", async (_req, res) => {
  // Always 200 when the process is up so Render Docker healthchecks stay green
  // even if Postgres is still linking / waking.
  let db = false;
  let dbError = null;
  try {
    db = !!(await healthCheck());
  } catch (err) {
    dbError = err.message;
  }
  res.json({
    ok: true,
    service: "mithi-river",
    db,
    dbError,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
    spa: process.env.SERVE_SPA !== "0",
  });
});

app.use("/api/history", historyRouter);

mountProxies(app);

const spaOn = process.env.SERVE_SPA !== "0";
if (spaOn) mountSpa(app);

async function main() {
  try {
    await ensureSchema();
  } catch (err) {
    // SPA + proxies still boot; history endpoints fail until DB is reachable.
    console.warn("[mithi] DB schema deferred:", err.message);
  }
  app.listen(PORT, HOST, () => {
    console.info(`[mithi] listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[mithi] boot failed", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
