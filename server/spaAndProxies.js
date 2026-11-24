/**
 * Production hosting helpers for Render (and local preview):
 * - reverse-proxy JalNetra / RiverEye / Overpass (same-origin, no CORS)
 * - serve Vite `dist/` + SPA fallback
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.resolve(ROOT, "dist");

const JALNETRA =
  process.env.JALNETRA_UPSTREAM ||
  "https://jalnetra-software-production.up.railway.app";
const RIVEREYE =
  process.env.RIVEREYE_UPSTREAM ||
  "https://rivereye-production.up.railway.app";

function proxy(label, target, pathRewrite) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    secure: true,
    pathRewrite,
    // BOD/COD + flood jobs can run several minutes
    timeout: 10 * 60 * 1000,
    proxyTimeout: 10 * 60 * 1000,
    on: {
      error(err, _req, res) {
        console.warn(`[proxy:${label}]`, err.message);
        if (res && !res.headersSent && typeof res.writeHead === "function") {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `${label}_gateway_timeout` }));
        }
      },
    },
  });
}

/** Mount API proxies before static/SPA handlers. */
export function mountProxies(app) {
  app.use(
    "/jalnetra-api",
    proxy("jalnetra", JALNETRA, { "^/jalnetra-api": "" }),
  );
  app.use(
    "/rivereye-api",
    proxy("rivereye", RIVEREYE, { "^/rivereye-api": "/api" }),
  );
  app.use(
    "/osm-overpass",
    proxy("osm1", "https://overpass-api.de", {
      "^/osm-overpass": "/api/interpreter",
    }),
  );
  app.use(
    "/osm-overpass-2",
    proxy("osm2", "https://overpass.kumi.systems", {
      "^/osm-overpass-2": "/api/interpreter",
    }),
  );
  app.use(
    "/osm-overpass-3",
    proxy("osm3", "https://overpass.openstreetmap.fr", {
      "^/osm-overpass-3": "/api/interpreter",
    }),
  );
}

/**
 * Serve built SPA when dist/ exists (Render full-stack / `npm run build`).
 * Returns true when static hosting is active.
 */
export function mountSpa(app) {
  const indexHtml = path.join(DIST, "index.html");
  if (!fs.existsSync(indexHtml)) {
    console.warn(`[spa] no dist at ${DIST} — API-only mode`);
    return false;
  }

  app.use(
    express.static(DIST, {
      index: false,
      maxAge: "1h",
      setHeaders(res, filePath) {
        if (/\.(glb|gltf|bin|dae)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (/\.(js|css)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (/[/\\]data[/\\]/i.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=86400");
        }
      },
    }),
  );

  // SPA fallback — keep /api, proxies, and real files untouched
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    if (
      req.path.startsWith("/jalnetra-api") ||
      req.path.startsWith("/rivereye-api") ||
      req.path.startsWith("/osm-overpass")
    ) {
      return next();
    }
    res.sendFile(indexHtml, (err) => (err ? next(err) : undefined));
  });

  console.info(`[spa] serving ${DIST}`);
  return true;
}
