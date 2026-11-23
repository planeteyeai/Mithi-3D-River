/**
 * Mithi history backend — PostgreSQL cache for JalNetra components.
 * Lithology first; schema supports all component_type values.
 *
 *   GET  /api/health
 *   GET  /api/history/:component/latest
 *   GET  /api/history/:component
 *   POST /api/history/:component
 */
import "./loadEnv.js";
import express from "express";
import cors from "cors";
import { ensureSchema, healthCheck, pool } from "./db.js";
import { historyRouter } from "./routes/history.js";

const PORT = Number(process.env.HISTORY_API_PORT || process.env.PORT || 5181);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

/** Soft request budget — avoid hung clients holding pool connections. */
app.use((req, res, next) => {
  const ms = Number(process.env.HISTORY_REQUEST_TIMEOUT_MS) || 25_000;
  res.setTimeout(ms, () => {
    if (!res.headersSent) {
      res.status(504).json({ ok: false, error: "request_timeout" });
    }
  });
  next();
});

app.get("/api/health", async (_req, res) => {
  try {
    const ok = await healthCheck();
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
    res.json({ ok, service: "mithi-history", db: !!ok, pool: poolStats });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use("/api/history", historyRouter);

async function main() {
  await ensureSchema();
  app.listen(PORT, () => {
    console.info(`[history-api] listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[history-api] boot failed", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
