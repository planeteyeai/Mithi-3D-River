/**
 * Mithi Updates asset catalogue + loader.
 * Canonical sources: src/data/Updates/original (mirrored to /data/updates for runtime).
 * Mandovi/Goa landmarks removed — only Mithi assets remain.
 */
import { loadKmlOrKmz } from "./kmlKmzParser.js";
import { geoToWorld } from "./geoReference.js";
import { auditCoordinateList } from "./coordinateValidator.js";

export const UPDATES_PUBLIC_BASE = "/data/updates";
export const UPDATES_ORIGINAL_BASE = "/data/updates/original";

/** Provenance classifications used across Updates layers. */
export const PROVENANCE = {
  OBSERVED: "OBSERVED",
  MODELLED: "MODELLED",
  DERIVED: "DERIVED",
  INTERPOLATED: "INTERPOLATED",
  RELATIVE_ESTIMATE: "RELATIVE ESTIMATE",
  SIMULATED: "SIMULATED",
  UNAVAILABLE: "UNAVAILABLE",
};

/** Goa/Mandovi landmark KMZs removed — keep empty for Mithi. */
export const LANDMARK_FILES = [];

export const LIVE_WATER_FILE = "mithi_river_water.kml";
/** Prefer Mithi water-depth overlay when present. */
export const WATER_DEPTH_FILE = "mithi_river_depth.kml";

/** Fallback LatLonBox from source KML (used if metadata fetch fails). */
export const UPDATES_OVERLAY_BOUNDS = {
  north: 19.0893267244805,
  south: 19.0436493272577,
  east: 72.8807961946018,
  west: 72.83306075355661,
};

let _cache = null;

/**
 * Load all Updates assets once. Prefer processed GeoJSON / PNG mirrors;
 * fall back to parsing original KMZ/KML when needed.
 */
export async function loadUpdatesAssets() {
  if (_cache) return _cache;

  const report = {
    imported: [],
    rejected: [],
    landmarks: [],
    liveWater: null,
    relativeDepth: null,
    metadata: null,
    coordinateAudit: null,
  };

  // Prefer processed metadata + geojson (generated offline, no Base64 re-decode)
  try {
    const metaRes = await fetch(`${UPDATES_PUBLIC_BASE}/metadata.json`);
    if (metaRes.ok) report.metadata = await metaRes.json();
  } catch (err) {
    console.warn("[updatesData] metadata.json unavailable", err?.message || err);
  }

  try {
    const geoRes = await fetch(`${UPDATES_PUBLIC_BASE}/landmarks.geojson`);
    if (geoRes.ok) {
      const gj = await geoRes.json();
      for (const f of gj.features || []) {
        const [lon, lat, elev = 0] = f.geometry?.coordinates || [];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const world = safeGeoToWorld(lon, lat, elev);
        report.landmarks.push({
          id: slugId(f.properties?.name || f.properties?.sourceFilename),
          name: f.properties?.name || "Landmark",
          lon,
          lat,
          elevation: elev || 0,
          sourceFilename: f.properties?.sourceFilename || "",
          geometryType: f.properties?.geometryType || "Point",
          provenance: f.properties?.provenance || PROVENANCE.OBSERVED,
          description: f.properties?.description || null,
          x: world?.x,
          y: world?.y,
          z: world?.z,
        });
        report.imported.push(f.properties?.sourceFilename || "landmarks.geojson");
      }
    }
  } catch (err) {
    console.warn("[updatesData] landmarks.geojson failed, falling back to KMZ", err?.message || err);
  }

  // Fill missing landmarks from original KMZ if geojson incomplete
  if (report.landmarks.length < LANDMARK_FILES.length) {
    const have = new Set(report.landmarks.map((l) => l.sourceFilename));
    for (const file of LANDMARK_FILES) {
      if (have.has(file)) continue;
      try {
        const parsed = await loadKmlOrKmz(
          `${UPDATES_ORIGINAL_BASE}/${encodeURIComponent(file)}`,
          file,
        );
        for (const pm of parsed.placemarks.filter((p) => p.geometryType === "Point")) {
          const world = safeGeoToWorld(pm.lon, pm.lat, pm.elevation || 0);
          report.landmarks.push({
            id: slugId(pm.name),
            name: pm.name,
            lon: pm.lon,
            lat: pm.lat,
            elevation: pm.elevation || 0,
            sourceFilename: file,
            geometryType: "Point",
            provenance: PROVENANCE.OBSERVED,
            description: pm.description,
            x: world?.x,
            y: world?.y,
            z: world?.z,
          });
          report.imported.push(file);
        }
      } catch (err) {
        report.rejected.push({ file, reason: String(err.message || err) });
      }
    }
  }

  // Live water + relative depth — use processed PNG + LatLonBox (no Base64 re-decode)
  const liveMeta = report.metadata?.assets?.find((a) => a.dataType === "live_water_extent");
  const depthMeta = report.metadata?.assets?.find((a) => a.dataType === "relative_water_depth");

  // Canonical Mithi live water: uploaded water_depth (1).kml (MNDWI)
  report.liveWater = {
    available: true,
    url: "/data/mithi/mithi_river_water_overlay.png",
    bounds: liveMeta?.bounds || UPDATES_OVERLAY_BOUNDS,
    name: liveMeta?.name || "Live Water - Mithi",
    description:
      liveMeta?.description ||
      "Authoritative live water from water_depth (1).kml MNDWI GroundOverlay (bright blue).",
    provenance: PROVENANCE.DERIVED,
    sourceFilename: LIVE_WATER_FILE,
    sourcePath: "src/data/water_depth (1).kml",
    observationWindow: "2026-10-13 to 2026-11-12",
    imageDate: "2026-11-07",
    kmlAreaHa: 72.48201756266876,
    note: "Remote-sensing-derived water extent from user Mithi KML — not a real-time live sensor feed.",
  };
  report.imported.push(LIVE_WATER_FILE);

  report.relativeDepth = {
    available: true,
    url: "/data/mithi/mithi_river_depth_overlay.png",
    bounds: depthMeta?.bounds || UPDATES_OVERLAY_BOUNDS,
    name: depthMeta?.name || "Water Depth - Mithi",
    description:
      depthMeta?.description ||
      "Sentinel-2 relative depth from mithi_river_depth.kml. Depth range: 0.5–8.0 m. Displayed as blue shades. Not survey-grade bathymetry.",
    provenance: PROVENANCE.RELATIVE_ESTIMATE,
    sourceFilename: WATER_DEPTH_FILE,
    sourcePath: "src/data/mithi_river_depth.kml",
    imageDate: "2026-11-12",
    analysisDate: "2026-11-16",
    depthRange: [0.5, 8.0],
    note: "RELATIVE ESTIMATE — do not treat as OBSERVED sonar / CSIR-NIO survey depth.",
  };
  report.imported.push(WATER_DEPTH_FILE);

  // Confirm processed PNG mirrors exist (avoid re-decoding multi-MB Base64 GroundOverlays).
  for (const layer of [report.liveWater, report.relativeDepth]) {
    try {
      const res = await fetch(layer.url, { method: "HEAD" });
      if (!res.ok) {
        // Fallback GET in case HEAD is blocked
        const get = await fetch(layer.url);
        if (!get.ok) throw new Error(`HTTP ${get.status}`);
      }
    } catch (err) {
      layer.available = false;
      report.rejected.push({
        file: layer.sourceFilename,
        reason: `Processed overlay image missing (${layer.url}): ${err.message || err}`,
      });
    }
  }

  report.coordinateAudit = auditCoordinateList(
    report.landmarks.map((l) => ({ lon: l.lon, lat: l.lat })),
    "PROJECT LANDMARKS",
  );

  // Deduplicate imported list
  report.imported = [...new Set(report.imported)];

  console.info("[updatesData] loaded", {
    landmarks: report.landmarks.length,
    imported: report.imported.length,
    rejected: report.rejected,
    liveWater: report.liveWater?.bounds,
    relativeDepth: report.relativeDepth?.bounds,
  });

  _cache = report;
  return report;
}

function safeGeoToWorld(lon, lat, elev = 0) {
  try {
    return geoToWorld(lon, lat, elev);
  } catch {
    return null;
  }
}

function slugId(name) {
  return String(name || "landmark")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Re-project landmarks into current local frame (call after initGeoReference).
 */
export function projectLandmarksToWorld(landmarks) {
  return (landmarks || []).map((l) => {
    const w = geoToWorld(l.lon, l.lat, l.elevation || 0);
    return { ...l, x: w.x, y: w.y, z: w.z, easting: w.easting, northing: w.northing };
  });
}
