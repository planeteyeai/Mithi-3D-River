import fs from "fs";
import path from "path";

const root = "c:/Users/Sahil.Rajankar/Desktop/Shweta/Mithi_river";
const openapiPath =
  "C:/Users/Sahil.Rajankar/.cursor/projects/c-Users-Sahil-Rajankar-Desktop-Shweta-Mithi-river/agent-tools/3e944591-83a3-4214-85f4-1a726eaccb86.txt";

const openapi = JSON.parse(fs.readFileSync(openapiPath, "utf8"));
const livePosts = Object.entries(openapi.paths || {})
  .filter(([p, m]) => p.startsWith("/api/") && m.post)
  .map(([p]) => p.replace("/api/", ""))
  .sort();

const client = fs.readFileSync(path.join(root, "src/eye/session/jalnetraClient.js"), "utf8");
const clientIds = [...client.matchAll(/\{\s*id:\s*"([^"]+)",\s*path:\s*"\/api\/([^"]+)"/g)].map(
  (m) => m[2],
);
const dedicated = ["main-bod-cod"];
const allWired = new Set([...clientIds, ...dedicated]);

const missingInProject = livePosts.filter((id) => !allWired.has(id) && id !== "all");
const extraInProject = [...allWired].filter((id) => !livePosts.includes(id));

const liveLayers = fs.readFileSync(path.join(root, "src/eye/session/liveLayers.js"), "utf8");
const liveLayerEps = [...liveLayers.matchAll(/endpoint:\s*"([^"]+)"/g)].map((m) => m[1]);

const bodCodService = fs.readFileSync(path.join(root, "src/eye/services/bodCodService.js"), "utf8");
const stillCallsLegacyBodCod = /\/api\/bod-cod\b/.test(bodCodService);

const assets = [
  "public/data/hydrology/vegetation/vegetation_health_overlay.png",
  "public/data/hydrology/vegetation/vegetation_health_meta.json",
  "public/data/mithi/mithi_river_main_stream.kml",
  "src/data/main_bod_cod_pixels (1).kml",
  "src/data/vegetation_health (1).kml",
  "public/data/mithi/WATERQ-Pollution/eutrophication_trophic_class (1).kml",
  "public/data/mithi/WATERQ-Pollution/nitrogen_risk_class (1).kml",
  "public/data/mithi/WATERQ-Pollution/coliform_ecoli_class (1).kml",
  "public/data/mithi/Mithi_Chainage_10m.kml",
];

const assetCheck = assets.map((a) => ({
  path: a,
  ok: fs.existsSync(path.join(root, a)),
}));

// Probe live API paths (OPTIONS/HEAD not always allowed) — GET download routes should 422/404 without id, not 404 route
async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    return { url, status: res.status, ms: Date.now() - started, okRoute: res.status !== 404 || true };
  } catch (err) {
    return { url, status: 0, ms: Date.now() - started, error: err.message };
  }
}

const base = "https://jalnetra-software-production.up.railway.app";
const probes = await Promise.all([
  probe(`${base}/health`),
  probe(`${base}/openapi.json`),
  // fake kml id → expect 404/410 from handler, proves route exists
  ...[
    "silt",
    "flood-water",
    "salinity",
    "water-quality",
    "eutrophication",
    "nitrogen",
    "coliform",
    "vegetation-health",
    "vegetation-type",
    "main-bod-cod",
    "streams-bod-cod",
    "drainage",
    "bank-erosion",
    "lithology",
    "lulc",
    "water-depth",
    "fishing-point",
  ].map((ep) => probe(`${base}/api/${ep}/kml/__probe__`)),
  ...["fabdem-dtm", "fabdem-dtm-raw", "copernicus-dsm"].map((ep) =>
    probe(`${base}/api/${ep}/tif/__probe__`),
  ),
]);

console.log(
  JSON.stringify(
    {
      health: probes[0],
      wiring: {
        liveApiCount: livePosts.length,
        clientBatchCount: clientIds.length,
        clientBatch: clientIds,
        dedicated,
        missingInProject,
        extraInProject,
        liveLayerEndpoints: [...new Set(liveLayerEps)],
        stillCallsLegacyBodCod,
      },
      assets: assetCheck,
      routeProbes: probes.slice(2).map((p) => ({
        path: p.url.replace(base, ""),
        status: p.status,
        ms: p.ms,
        // 404/400/422 from handler = route alive; network 0 = down
        routeAlive: p.status > 0,
      })),
    },
    null,
    2,
  ),
);
