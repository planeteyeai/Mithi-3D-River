/**
 * Local JalNetra KML snapshots (until live API replaces them).
 * Files: public/data/mithi/jalnetra-history/
 * Logical names: lithology1_21-10-2026|18-11-2026
 * On disk Windows uses "__" instead of "|".
 *
 * drainage = Geology Joining Streams
 */

const MANIFEST_URL = "/data/mithi/jalnetra-history/manifest.json";

/**
 * Stable frontend paths for every demo KML (history + active aliases).
 * Prefer `history` for versioned demos; `active` for loaders that already use short paths.
 */
export const FRONTEND_KML = {
  lithology: {
    history: "/data/mithi/jalnetra-history/lithology1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/lithology.kml",
    logicalName: "lithology1_21-10-2026|18-11-2026",
  },
  "vegetation-health": {
    history: "/data/mithi/jalnetra-history/vegetation-health1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/vegetation_health.kml",
    logicalName: "vegetation-health1_21-10-2026|18-11-2026",
  },
  "water-depth": {
    history: "/data/mithi/jalnetra-history/water-depth1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/mithi_river_depth.kml",
    logicalName: "water-depth1_21-10-2026|18-11-2026",
  },
  "live-water": {
    history: "/data/mithi/jalnetra-history/live-water1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/mithi_river_water.kml",
    logicalName: "live-water1_21-10-2026|18-11-2026",
  },
  "main-bod-cod": {
    history: "/data/mithi/jalnetra-history/main-bod-cod1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/main_bod_cod_pixels.kml",
    logicalName: "main-bod-cod1_21-10-2026|18-11-2026",
  },
  "streams-bod-cod": {
    history: "/data/mithi/jalnetra-history/streams-bod-cod1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/streams_bod_cod_pixels.kml",
    logicalName: "streams-bod-cod1_21-10-2026|18-11-2026",
  },
  // JalNetra drainage → Joining Streams
  drainage: {
    history: "/data/mithi/jalnetra-history/joining-stream1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/drainage.kml",
    logicalName: "joining-stream1_21-10-2026|18-11-2026",
    displayName: "Joining Streams",
  },
  "bank-erosion": {
    history: "/data/mithi/jalnetra-history/bank-erosion1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/bank_erosion_hotspots_2016_2026.kml",
    logicalName: "bank-erosion1_21-10-2026|18-11-2026",
  },
  salinity: {
    history: "/data/mithi/jalnetra-history/salinity1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/WATERQ-Pollution/salinity.kml",
    logicalName: "salinity1_21-10-2026|18-11-2026",
  },
  "water-quality": {
    history: "/data/mithi/jalnetra-history/water-quality1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/water_quality.kml",
    logicalName: "water-quality1_21-10-2026|18-11-2026",
  },
  "fishing-point": {
    history: "/data/mithi/jalnetra-history/fishing-point1_21-10-2026__18-11-2026.kml",
    active: "/data/mithi/fishing_points.kml",
    logicalName: "fishing-point1_21-10-2026|18-11-2026",
  },
};

/** @type {Promise<object[]>|null} */
let manifestPromise = null;

export function localKmlUrl(componentId, prefer = "history") {
  const row = FRONTEND_KML[componentId];
  if (!row) return null;
  if (prefer === "active") return row.active || row.history;
  return row.history || row.active;
}

export function allFrontendKmlUrls() {
  return Object.fromEntries(
    Object.entries(FRONTEND_KML).map(([id, row]) => [
      id,
      { url: row.history || row.active, active: row.active, logicalName: row.logicalName },
    ]),
  );
}

export async function loadJalnetraHistoryManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: "no-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        const raw = await res.text();
        return JSON.parse(raw.replace(/^\uFEFF/, ""));
      })
      .catch((err) => {
        console.warn("[jalnetra-history] manifest unavailable:", err.message);
        manifestPromise = null;
        return [];
      });
  }
  const rows = await manifestPromise;
  return Array.isArray(rows) ? rows : [];
}

/** Latest snapshot row for a component (highest version). */
export async function getLocalSnapshot(componentId) {
  const rows = await loadJalnetraHistoryManifest();
  const matches = rows
    .filter((r) => r.component === componentId)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
  if (matches[0]) return matches[0];
  // Manifest miss → still expose hardcoded FRONTEND_KML
  const fb = FRONTEND_KML[componentId];
  if (!fb) return null;
  return {
    component: componentId,
    version: 1,
    logicalName: fb.logicalName,
    url: fb.history || fb.active,
    fileName: (fb.history || fb.active || "").split("/").pop(),
    startDate: "21-10-2026",
    endDate: "18-11-2026",
  };
}

/**
 * Shape a session payload so collectKmlRefs / liveLayers can resolve the local KML.
 */
export function snapshotToPayload(row) {
  if (!row?.url) return null;
  const endIso = toIsoDate(row.endDate);
  return {
    source: "local-snapshot",
    snapshot: row.logicalName,
    version: row.version,
    start_date: toIsoDate(row.startDate),
    end_date: endIso,
    data_date: endIso,
    kml_type: row.logicalName || row.component,
    name: row.logicalName,
    kml_download_url: row.url,
    kml_url: row.url,
  };
}

function toIsoDate(dmy) {
  const m = String(dmy || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return String(dmy || "").slice(0, 10);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Fill session gaps from local snapshot KMLs (before/alongside Postgres). */
export async function hydrateLocalSnapshotsIntoSession(session) {
  if (!session?.results) return { filled: [] };
  const filled = [];

  // Prefer hardcoded FRONTEND_KML so frontend works even if manifest fetch fails.
  for (const [component, row] of Object.entries(FRONTEND_KML)) {
    if (session.results[component]) continue;
    const payload = snapshotToPayload({
      component,
      version: 1,
      logicalName: row.logicalName,
      url: row.history || row.active,
      startDate: "21-10-2026",
      endDate: "18-11-2026",
    });
    if (!payload) continue;
    session.results[component] = payload;
    delete session.errors?.[component];
    filled.push(component);
    window.dispatchEvent(
      new CustomEvent("planeteye-endpoint", {
        detail: {
          id: component,
          ok: true,
          fromCache: true,
          hydrated: true,
          localSnapshot: row.logicalName,
        },
      }),
    );
  }

  if (filled.length) {
    console.info("[jalnetra-history] frontend KMLs ready:", filled.join(", "));
  }
  return { filled };
}
