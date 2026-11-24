import { Router } from "express";
import {
  storeSnapshot,
  getLatest,
  listHistory,
  getById,
  listTodayLive,
  ensureTodayLiveRows,
  localTodayYmd,
} from "../historyStore.js";

export const historyRouter = Router();

/** GET /api/history/status/today — which live components are stored for today */
historyRouter.get("/status/today", async (_req, res) => {
  try {
    const status = await listTodayLive();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/history/status/ensure-today
 * Body: { components?: string[] }
 * Promotes latest live payloads into today's rows so the full day is covered.
 */
historyRouter.post("/status/ensure-today", async (req, res) => {
  try {
    const list = Array.isArray(req.body?.components) ? req.body.components : [];
    const defaults = [
      "lithology",
      "bank-erosion",
      "lulc",
      "vegetation-type",
      "vegetation-health",
      "salinity",
      "water-quality",
      "water-depth",
      "eutrophication",
      "nitrogen",
      "coliform",
      "main-bod-cod",
      "streams-bod-cod",
      "drainage",
      "fishing-point",
      "live-water",
      "silt-classification",
      "silt-volume",
    ];
    const result = await ensureTodayLiveRows(list.length ? list : defaults);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/history/:component/latest — fallback when live JalNetra fails */
historyRouter.get("/:component/latest", async (req, res) => {
  try {
    const row = await getLatest(req.params.component);
    if (!row) return res.status(404).json({ ok: false, error: "no_history" });
    res.json({
      ok: true,
      fromCache: true,
      id: row.id,
      component: row.component_type,
      dataDate: row.data_date,
      kmlType: row.kml_type,
      fingerprint: row.fingerprint,
      source: row.source,
      fetchedAt: row.fetched_at,
      payload: row.payload,
      kmlRefs: row.kml_refs,
    });
  } catch (err) {
    console.warn("[history] latest failed", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/history/:component — list (sorted, fast) */
historyRouter.get("/:component", async (req, res) => {
  try {
    const rows = await listHistory(req.params.component, {
      limit: req.query.limit,
    });
    res.json({
      ok: true,
      component: req.params.component,
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        dataDate: r.data_date,
        kmlType: r.kml_type,
        fingerprint: r.fingerprint,
        source: r.source,
        fetchedAt: r.fetched_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/history/:component/id/:id — full payload by id */
historyRouter.get("/:component/id/:id", async (req, res) => {
  try {
    const row = await getById(Number(req.params.id));
    if (!row || row.component_type !== req.params.component) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    res.json({ ok: true, row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/history/:component
 * Body: { payload, endDate?, liveDay?, kmlType?, kmlRefs?, source? }
 * Upserts one row per calendar day + kml_type (full-day live cache).
 */
historyRouter.post("/:component", async (req, res) => {
  try {
    const {
      payload,
      endDate,
      end_date,
      liveDay,
      live_day,
      kmlType,
      kml_type,
      kmlRefs,
      source,
    } = req.body || {};
    if (payload == null) {
      return res.status(400).json({ ok: false, error: "payload_required" });
    }
    const src = source || "jalnetra-live";
    const result = await storeSnapshot(req.params.component, payload, {
      // Live rows key off local calendar day so BOD/COD + suite stay "today" all day.
      liveDay:
        liveDay ||
        live_day ||
        (/jalnetra/i.test(src) ? localTodayYmd() : null),
      endDate: endDate || end_date,
      kmlType: kmlType || kml_type,
      kmlRefs,
      source: src,
    });
    res.status(result.inserted ? 201 : 200).json({ ok: true, ...result });
  } catch (err) {
    console.warn("[history] store failed", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
