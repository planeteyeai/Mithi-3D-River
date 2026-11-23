import { lonLatToLocal, localToLonLat } from "../../geo/geoReference.js";
import { distanceToWaterEdge } from "../../geo/projectionMetrics.js";
import { SURFACE_Y, bedElevation } from "../../scene/river.js";
import { state } from "../../state.js";
import { activityLevel } from "./FishSpeciesRegistry.js";

/**
 * Project KML fishing points into existing local frame and bind to corridor/bathymetry.
 * When KML points fall outside the river AOI (or are missing), fills continuously
 * along the corridor centerline so fishing markers are always present.
 */
export function buildFishingZones(rawLocations, dataset, opts = {}) {
  const { ringLocal, corridor, points, bridges } = dataset;
  const stations = corridor?.stations || [];
  const zones = [];
  const spacingM = opts.spacingM ?? 450;

  for (const loc of rawLocations || []) {
    const p = lonLatToLocal(loc.lon, loc.lat);
    const waterDistM = distanceToWaterEdge(p.x, p.z, stations);
    const waterValid = waterDistM < 2;

    if (ringLocal?.length && !pointInRing(p.x, p.z, ringLocal)) {
      console.warn(`Fishing ${loc.id} outside KML river polygon — skipped`, loc);
      continue;
    }

    if (!waterValid) {
      console.warn(`Fishing ${loc.id} INVALID FISHING LOCATION — ${waterDistM.toFixed(1)} m from water edge`, loc);
    }

    zones.push(makeZoneFromLocal(loc, p, stations, points, bridges, dataset, waterDistM, waterValid));
  }

  if (!zones.length && stations.length) {
    const continuous = buildContinuousFishingZones(dataset, spacingM);
    console.info("Fishing zones", {
      source: "continuous-corridor",
      count: continuous.length,
      spacingM,
      ids: continuous.map((z) => z.id),
    });
    return continuous;
  }

  console.info("Fishing zones", {
    source: "Fishing_Locations.kml",
    count: zones.length,
    ids: zones.map((z) => z.id),
  });
  return zones;
}

/** Place fishing points continuously along the river centerline. */
export function buildContinuousFishingZones(dataset, spacingM = 450) {
  const stations = dataset.corridor?.stations || [];
  const points = dataset.points;
  const bridges = dataset.bridges;
  if (stations.length < 2) return [];

  const zones = [];
  let acc = 0;
  let nextAt = 0;
  let n = 1;

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    if (i > 0) {
      const prev = stations[i - 1];
      acc += Math.hypot(st.x - prev.x, st.z - prev.z);
    }
    if (acc < nextAt && i !== 0) continue;
    if (i === 0) nextAt = 0;

    // Prefer a wet pixel so FP markers never sit on dry bank / mask gaps.
    const wet = snapToLiveWater(st.x, st.z, dataset, st);
    if (!wet) {
      nextAt = acc + spacingM * 0.35;
      continue;
    }

    let lon = 0;
    let lat = 0;
    try {
      const ll = localToLonLat(wet.x, wet.z);
      lon = ll.lon;
      lat = ll.lat;
    } catch {
      /* geo frame may be mid-init */
    }

    const id = `FP-${String(n).padStart(2, "0")}`;
    const p = {
      x: wet.x,
      z: wet.z,
      easting: st.easting,
      northing: st.northing,
    };
    zones.push(
      makeZoneFromLocal(
        { id, name: id, lon, lat },
        p,
        stations,
        points,
        bridges,
        dataset,
        0,
        true,
      ),
    );
    n += 1;
    nextAt = acc + spacingM;
  }

  return zones;
}

/**
 * Snap a corridor point onto live KML water (or ring) within the channel.
 * Returns null when no water is nearby — caller skips that FP.
 */
function snapToLiveWater(x, z, dataset, st) {
  const mask = dataset?.liveWaterMask;
  const ring = dataset?.ringLocal;
  const half = Math.max(12, Number(st?.halfWidth) || 30);

  const isWet = (px, pz) => {
    if (mask?.available && mask.isWaterAtLocal) return !!mask.isWaterAtLocal(px, pz);
    if (ring?.length >= 3) return pointInRing(px, pz, ring);
    // No mask yet — treat mid-channel as wet so zones still boot.
    return true;
  };

  if (isWet(x, z)) return { x, z };

  const fx = st?.flowX || 0;
  const fz = st?.flowZ || 1;
  const fl = Math.hypot(fx, fz) || 1;
  const nx = -fz / fl;
  const nz = fx / fl;
  // Search across-channel first, then a short along-flow sweep.
  for (const along of [0, 8, -8, 16, -16, 28, -28]) {
    for (let lat = 0; lat <= half * 0.75; lat += 3) {
      for (const sign of lat === 0 ? [1] : [1, -1]) {
        const px = x + (fx / fl) * along + nx * lat * sign;
        const pz = z + (fz / fl) * along + nz * lat * sign;
        if (isWet(px, pz)) return { x: px, z: pz };
      }
    }
  }
  return null;
}

function makeZoneFromLocal(loc, p, stations, points, bridges, dataset, waterDistM, waterValid) {
  const st = nearestStation(p.x, p.z, stations);
  const depthSample = nearestDepth(p.x, p.z, points) ?? { depth: 1.8 };
  const depthM = depthSample.depth;
  const halfWidth = st?.halfWidth ?? 30;
  const radius = Math.min(60, Math.max(25, halfWidth * 0.85));
  const nearBridge = (bridges || []).some(
    (b) => Math.hypot(b.midX - p.x, b.midZ - p.z) < halfWidth + 40,
  );

  const zone = {
    id: loc.id,
    name: loc.name,
    lon: loc.lon,
    lat: loc.lat,
    easting: p.easting,
    northing: p.northing,
    x: p.x,
    z: p.z,
    flowX: st?.flowX ?? 1,
    flowZ: st?.flowZ ?? 0,
    halfWidth,
    radius,
    depthM,
    nearBridge,
    surfaceY: SURFACE_Y,
    bedY: bedElevation(depthM, dataset.minDepth, dataset.maxDepth, 0.5, state.depthExaggeration),
    activity: "Medium",
    dominant: [],
    waterDistM,
    waterValid,
    invalidReason: waterValid ? null : "INVALID FISHING LOCATION",
  };
  zone.activity = activityLevel(zone);
  return zone;
}

export function sampleDepthAt(x, z, dataset) {
  const d = nearestDepth(x, z, dataset.points);
  return d?.depth ?? 1.8;
}

export function bedYAt(x, z, dataset, exag = state.depthExaggeration) {
  const depth = sampleDepthAt(x, z, dataset);
  return bedElevation(depth, dataset.minDepth, dataset.maxDepth, 0.5, exag);
}

/**
 * Approximate animated water surface Y at a world XZ (matches water shader swell scale).
 * Does not alter river mesh — used only for fish depth placement.
 */
export function waterSurfaceYAt(x, z, time = 0) {
  const swell =
    Math.sin(x * 0.006 - time * 0.04) * 0.22 +
    Math.sin(z * 0.01 + time * 0.03) * 0.16;
  const wave = Math.sin(x * 0.025 - time * 0.45) * 0.1 + Math.sin(z * 0.03 + time * 0.2) * 0.08;
  return SURFACE_Y + swell + wave;
}

export function nearestStation(x, z, stations) {
  let best = stations[0];
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(stations.length / 240));
  for (let i = 0; i < stations.length; i += step) {
    const s = stations[i];
    const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = s;
    }
  }
  // refine locally
  const idx = stations.indexOf(best);
  for (let i = Math.max(0, idx - step); i < Math.min(stations.length, idx + step); i++) {
    const s = stations[i];
    const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = s;
    }
  }
  return best;
}

function nearestDepth(x, z, points) {
  if (!points?.length) return null;
  let best = null;
  let bestD = Infinity;
  // coarse grid hash would be better; subsample for speed
  const step = Math.max(1, Math.floor(points.length / 800));
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = p;
    }
  }
  return best;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const zi = ring[i].z;
    const xj = ring[j].x;
    const zj = ring[j].z;
    const hit = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export function lateralDistToCenterline(x, z, st) {
  return Math.abs((x - st.x) * -st.flowZ + (z - st.z) * st.flowX);
}
