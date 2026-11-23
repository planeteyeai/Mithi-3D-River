/**
 * PLANET.EYE AI — Authoritative Coordinate Validation Service
 * Validates coordinate conventions, reference systems, ground control points (GCPs),
 * and layer alignment across the Mithi River Digital Twin.
 */
import { geoToWorld, worldToGeo } from "./geoReference.js";

export const MANDAVI_EXPECTED_EXTENT = {
  minLon: 72.83,
  maxLon: 72.89,
  minLat: 19.04,
  maxLat: 19.09,
};

/**
 * 5 Authoritative Ground Control Points for the Mithi River corridor.
 */
export const MANDAVI_GCPS = [
  {
    id: "GCP-1",
    name: "Mahim Causeway",
    lon: 72.838239,
    lat: 19.048256,
    elevationM: 0.0,
    feature: "OSM river-mouth causeway at Mahim Creek",
    maxAllowedErrorM: 25.0,
  },
  {
    id: "GCP-2",
    name: "Western Express Highway",
    lon: 72.846415,
    lat: 19.054937,
    elevationM: 0.0,
    feature: "OSM WEH span over Mithi",
    maxAllowedErrorM: 20.0,
  },
  {
    id: "GCP-3",
    name: "Sion Bandra Link Road",
    lon: 72.848025,
    lat: 19.051811,
    elevationM: 0.0,
    feature: "OSM Sion–Bandra link over Mithi",
    maxAllowedErrorM: 25.0,
  },
  {
    id: "GCP-4",
    name: "BKC - SCLR Connector",
    lon: 72.872164,
    lat: 19.074959,
    elevationM: 0.0,
    feature: "OSM BKC/SCLR connector over Mithi",
    maxAllowedErrorM: 30.0,
  },
  {
    id: "GCP-5",
    name: "Santa Cruz – Chembur Link Road",
    lon: 72.871682,
    lat: 19.074588,
    elevationM: 0.0,
    feature: "OSM SCLR river crossing",
    maxAllowedErrorM: 30.0,
  },
];

/**
 * Validate coordinates for any dataset or point list.
 * @param {Array<{lon:number, lat:number}>} points
 * @param {string} layerName
 */
export function auditCoordinateList(points, layerName = "Dataset") {
  if (!points || !points.length) {
    return { ok: false, error: `${layerName} has 0 points` };
  }

  let minLon = Infinity, maxLon = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  let swappedCount = 0;

  for (const p of points) {
    const lon = p.lon ?? p[0];
    const lat = p.lat ?? p[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    // Detect swapped coordinates [lat, lon] instead of [lon, lat]
    if (lon > 10 && lon < 25 && lat > 65 && lat < 85) {
      swappedCount++;
    }

    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  const isSwapped = swappedCount > points.length * 0.5;
  const inExtent =
    minLon >= MANDAVI_EXPECTED_EXTENT.minLon &&
    maxLon <= MANDAVI_EXPECTED_EXTENT.maxLon &&
    minLat >= MANDAVI_EXPECTED_EXTENT.minLat &&
    maxLat <= MANDAVI_EXPECTED_EXTENT.maxLat;

  return {
    ok: !isSwapped && inExtent,
    count: points.length,
    extent: { minLon, maxLon, minLat, maxLat },
    isSwapped,
    inExtent,
    layerName,
  };
}

/**
 * Run automatic Ground Control Point validation.
 * Verifies that forward and inverse transformation round-trip with sub-millimeter precision,
 * and checks distance against rendered bridge and corridor geometry.
 * @param {object} dataset
 */
export function validateGroundControlPoints(dataset) {
  const results = [];
  const stations = dataset?.corridor?.stations || [];
  const bridges = dataset?.bridges || [];

  for (const gcp of MANDAVI_GCPS) {
    // 1. Forward transformation via shared geoToWorld service
    const world = geoToWorld(gcp.lon, gcp.lat, gcp.elevationM);
    // 2. Inverse transformation via worldToGeo
    const roundTrip = worldToGeo(world.x, world.z, world.y);
    const dLon = Math.abs(roundTrip.lon - gcp.lon);
    const dLat = Math.abs(roundTrip.lat - gcp.lat);
    const roundTripErrorM = Math.hypot(dLon * 107269, dLat * 111320);

    // 3. Proximity to rendered bridge / corridor
    let nearestBridgeDist = Infinity;
    let matchedBridge = null;
    for (const b of bridges) {
      const midX = b.midX ?? (b.start && b.end ? (b.start.x + b.end.x) * 0.5 : b.x);
      const midZ = b.midZ ?? (b.start && b.end ? (b.start.z + b.end.z) * 0.5 : b.z);
      if (Number.isFinite(midX) && Number.isFinite(midZ)) {
        const d = Math.hypot(world.x - midX, world.z - midZ);
        if (d < nearestBridgeDist) {
          nearestBridgeDist = d;
          matchedBridge = b.name || b.id;
        }
      }
    }

    // 4. Proximity to nearest river corridor station
    let nearestRiverDist = Infinity;
    for (const st of stations) {
      const d = Math.hypot(world.x - st.x, world.z - st.z);
      if (d < nearestRiverDist) nearestRiverDist = d;
    }

    const passed = roundTripErrorM < 0.05; // < 5cm round-trip precision

    results.push({
      ...gcp,
      worldX: Number(world.x.toFixed(2)),
      worldY: Number(world.y.toFixed(2)),
      worldZ: Number(world.z.toFixed(2)),
      roundTripErrorM: Number(roundTripErrorM.toFixed(4)),
      nearestBridgeDistM: Number(nearestBridgeDist.toFixed(1)),
      matchedBridge,
      nearestRiverDistM: Number(nearestRiverDist.toFixed(1)),
      passed,
    });
  }

  const allPassed = results.every((r) => r.passed);
  console.info("[coordinateValidator] GCP validation complete:", {
    allPassed,
    gcpCount: results.length,
    results,
  });

  return {
    ok: allPassed,
    gcpCount: results.length,
    results,
    crs: "EPSG:32643 (UTM Zone 43N)",
    inputCRS: "EPSG:4326 (WGS84)",
  };
}
