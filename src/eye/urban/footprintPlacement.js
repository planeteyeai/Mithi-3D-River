import { terrainHeightAt } from "../scene/terrain.js";

/**
 * Place a classified footprint into world transforms.
 * Geographic X/Z from centroid; Y from DTM under the footprint (not a global offset).
 * Scale preserves footprint W/L and classified height — mild non-uniform only.
 */
export function placementFromFootprint(metrics, classification, proto) {
  const sx = metrics.lengthM / Math.max(0.1, proto.nativeW);
  const sz = metrics.widthM / Math.max(0.1, proto.nativeD);
  // Avoid extreme squash: blend toward uniform plan scale
  const plan = (sx + sz) * 0.5;
  const planSx = THREE_CLAMP(sx, plan * 0.72, plan * 1.35);
  const planSz = THREE_CLAMP(sz, plan * 0.72, plan * 1.35);
  const sy = classification.heightM / Math.max(0.1, proto.nativeH);

  const y = sampleFootprintElevation(metrics, placementStations);
  return {
    x: metrics.centroidX,
    y,
    z: metrics.centroidZ,
    yaw: metrics.yaw,
    scaleX: planSx,
    scaleY: THREE_CLAMP(sy, 0.55, 2.8),
    scaleZ: planSz,
  };
}

/** Injected corridor stations for terrain sampling (set before placement). */
let placementStations = [];

export function setPlacementStations(stations) {
  placementStations = stations;
}

function THREE_CLAMP(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * Building base elevation from DTM under the footprint.
 * Uses the minimum of centroid + AABB corners (+ optional ring verts) so slabs
 * sit on terrain on slopes instead of floating on the mean.
 */
export function sampleFootprintElevation(metrics, stations, building = null) {
  const pts = [
    [metrics.centroidX, metrics.centroidZ],
    [metrics.aabb.minX, metrics.aabb.minZ],
    [metrics.aabb.maxX, metrics.aabb.minZ],
    [metrics.aabb.minX, metrics.aabb.maxZ],
    [metrics.aabb.maxX, metrics.aabb.maxZ],
  ];
  const verts = building?.vertices;
  if (Array.isArray(verts) && verts.length >= 3) {
    // Sample every Nth ring vertex for large footprints (airports / warehouses).
    const step = Math.max(1, Math.floor(verts.length / 12));
    for (let i = 0; i < verts.length; i += step) {
      const v = verts[i];
      if (Number.isFinite(v?.x) && Number.isFinite(v?.z)) pts.push([v.x, v.z]);
    }
  }

  let minY = Infinity;
  let sum = 0;
  let n = 0;
  for (const [x, z] of pts) {
    const y = terrainHeightAt(x, z, stations);
    if (!Number.isFinite(y)) continue;
    minY = Math.min(minY, y);
    sum += y;
    n += 1;
  }
  if (!n) return terrainHeightAt(metrics.centroidX, metrics.centroidZ, stations);
  // Bias toward min so foundations don't float; blend slightly with mean for stability.
  const mean = sum / n;
  return minY * 0.72 + mean * 0.28;
}
