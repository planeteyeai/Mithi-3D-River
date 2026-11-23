/**
 * Resolve nalla flow direction using:
 * 1) KML/OSM direction attrs (if present)
 * 2) River bank topology at the OUTLET tip (toward confluence)
 * 3) Terrain elevation along draped path
 *
 * Joining Streams connection is OUTLET-based (not mid-path proximity):
 * a drainage counts as connected only when its downstream tip meets the
 * Mula–Mutha bank corridor within a tight gap — not merely when it runs
 * parallel or nearby somewhere along its length.
 */

/** Max outlet→bank gap (m) to count as river-connected for Joining Streams.
 *  Looser for Mithi Upstream 01–05 tips from drainage KML. */
export const RIVER_CONNECTION_THRESHOLD_M = 180;

/** Looser tip probe (m) used only to hint flow direction toward the river. */
const RIVER_FLOW_PROBE_M = 140;

/**
 * @param {{ pts: {x:number,y:number,z:number,lon?:number,lat?:number}[], meta: object, lengthM: number }} path
 * @param {{ x:number, z:number, halfWidth?:number, flowX?:number, flowZ?:number, along?:number }[]} riverStations
 */
export function resolveNallaFlow(path, riverStations) {
  const pts = path.pts;
  const meta = path.meta || {};
  const id = meta.osmId || meta.name || `nalla_${Math.random().toString(36).slice(2, 8)}`;

  const start = pts[0];
  const end = pts[pts.length - 1];
  const elevStart = start.y;
  const elevEnd = end.y;

  const attrDir = parseAttributeDirection(meta);
  // Tip-only probe (both ends) — never mid-path — for flow-direction hint
  const startProbe = bankGapAtPoint(start, riverStations);
  const endProbe = bankGapAtPoint(end, riverStations);

  let flowTowardEnd = true;
  let confidence = "unknown";
  let reason = "Flow direction unavailable";

  if (attrDir != null) {
    flowTowardEnd = attrDir;
    confidence = "attribute";
    reason = "Direction from KML/OSM attributes";
  } else if (
    startProbe &&
    endProbe &&
    (startProbe.distanceToBank < RIVER_FLOW_PROBE_M || endProbe.distanceToBank < RIVER_FLOW_PROBE_M)
  ) {
    // Outlet is the tip closer to the bank edge
    flowTowardEnd = endProbe.distanceToBank <= startProbe.distanceToBank;
    confidence = "topology";
    reason = "Flow toward nearer river-bank tip";
  } else {
    const dElev = elevStart - elevEnd;
    if (Math.abs(dElev) >= 0.35) {
      flowTowardEnd = dElev > 0;
      confidence = "terrain";
      reason = "Flow direction estimated from terrain";
    } else {
      flowTowardEnd = elevStart >= elevEnd;
      confidence = "unknown";
      reason = "Flow direction unavailable (flat / ambiguous elevation)";
    }
  }

  // Authoritative connection: OUTLET tip segment must meet the bank
  let outletHit = outletRiverConnection(pts, flowTowardEnd, riverStations, RIVER_CONNECTION_THRESHOLD_M);
  // Soft fallback: nearer tip within probe distance still counts (Mithi upstream tips)
  if (!outletHit) {
    const tipProbe = flowTowardEnd ? endProbe : startProbe;
    if (tipProbe && tipProbe.distanceToBank <= RIVER_CONNECTION_THRESHOLD_M) {
      outletHit = {
        ...tipProbe,
        distanceToBank: tipProbe.distanceToBank,
        alongM: tipProbe.alongM,
        riverChainage: tipProbe.alongM,
        bankChainage: tipProbe.alongM,
      };
    }
  }
  const streamName = String(meta.name || meta.nameEn || meta.intName || "").trim();
  const isGivenUpstream = /upstream\s*0*\d+/i.test(streamName);
  // Given drainage KML (Upstream 01–N): always treat as joining even if tip gap is large.
  let connectsToRiver = !!outletHit;
  let connection = connectsToRiver ? outletHit : null;
  if (!connectsToRiver && isGivenUpstream) {
    const tip = (flowTowardEnd ? endProbe : startProbe) || endProbe || startProbe;
    connectsToRiver = true;
    connection = tip
      ? { ...tip, distanceToBank: tip.distanceToBank ?? 0, alongM: tip.alongM, softGiven: true }
      : { softGiven: true, distanceToBank: 0 };
  }
  const distanceToRiverM = connectsToRiver
    ? connection?.distanceToBank ?? outletHit?.distanceToBank ?? null
    : (flowTowardEnd ? endProbe : startProbe)?.distanceToBank ?? null;

  return {
    id: String(id),
    // Preserve source name only; empty string when OSM/KML has no valid name
    name: streamName,
    meta,
    pts,
    lengthM: path.lengthM || pathLength(pts),
    elevStart,
    elevEnd,
    flowTowardEnd,
    flowDirectionConfidence: confidence,
    directionReason: reason,
    connectsToRiver,
    connection,
    distanceToRiverM,
    nearestChainageMeters: connection?.alongM ?? null,
    geographicNote: "Coordinates preserved from drainage KML / local frame",
  };
}

/** Named Upstream 01…N (drainage / streams BOD KML) — show even if tip-connect failed. */
export function isNamedJoiningStream(rec) {
  if (!rec) return false;
  const names = [rec.meta?.name, rec.meta?.nameEn, rec.displayName, rec.name];
  return names.some((n) => /upstream\s*0*\d+/i.test(String(n || "").trim()));
}

/** True when record is eligible for Joining Streams navigation. */
export function isRiverConnectedDrainage(rec) {
  if (!rec) return false;
  // Given demo drainages (Upstream 01–05) always eligible for Joining Streams.
  if (isNamedJoiningStream(rec)) return true;
  if (rec.connectsToRiver !== true) return false;
  if (!rec.connection?.bankPoint && !rec.connection?.riverPoint) return false;
  const gap = rec.distanceToRiverM ?? rec.connection?.distanceToBank;
  if (Number.isFinite(gap) && gap > RIVER_CONNECTION_THRESHOLD_M * 1.35) return false;
  return true;
}

/**
 * Evaluate bank-edge gap at a single local XZ point.
 * distanceToBank = 0 means on/inside the bank half-width.
 */
function bankGapAtPoint(point, stations) {
  if (!point || !stations?.length) return null;
  const hit = nearestStationXZ(point.x, point.z, stations);
  const station = stations[hit.index];
  if (!station) return null;
  const half = Math.max(8, station.halfWidth || 40);
  const fx = station.flowX ?? 0;
  const fz = station.flowZ ?? 1;
  const lx = -fz;
  const lz = fx;
  const lat = Math.abs((point.x - station.x) * lx + (point.z - station.z) * lz);
  const gap = Math.max(0, lat - half);
  const side = Math.sign((point.x - station.x) * lx + (point.z - station.z) * lz) || 1;
  return {
    nallaPoint: { x: point.x, y: point.y, z: point.z, lon: point.lon, lat: point.lat },
    riverPoint: { x: station.x, z: station.z, y: station.y },
    bankPoint: {
      x: station.x + lx * half * 0.72 * side,
      z: station.z + lz * half * 0.72 * side,
      y: point.y,
      alongM: Number.isFinite(station.along) ? station.along : null,
      stationIndex: hit.index,
    },
    distance: hit.d,
    distanceToBank: gap,
    stationIndex: hit.index,
    alongM: Number.isFinite(station.along) ? station.along : null,
    pathIndex: -1,
    confidence: gap < 12 ? "high" : gap < 22 ? "medium" : "low",
  };
}

/**
 * Connection only if the OUTLET tip (last ~12% of path toward river) meets the bank.
 * Mid-path / parallel channels that never reach the river are rejected.
 */
function outletRiverConnection(pts, flowTowardEnd, stations, thresholdM) {
  if (!stations?.length || !pts?.length) return null;
  const tipCount = Math.max(1, Math.min(10, Math.ceil(pts.length * 0.12)));
  let best = null;
  let bestGap = thresholdM;

  const consider = (p, pathIndex) => {
    const hit = bankGapAtPoint(p, stations);
    if (!hit) return;
    if (hit.distanceToBank < bestGap || (hit.distanceToBank === bestGap && best && hit.distance < best.distance)) {
      bestGap = hit.distanceToBank;
      best = {
        ...hit,
        pathIndex,
        confidence: hit.distanceToBank < thresholdM * 0.4 ? "high" : "medium",
      };
    }
  };

  if (flowTowardEnd) {
    for (let i = pts.length - tipCount; i < pts.length; i++) consider(pts[i], i);
  } else {
    for (let i = 0; i < tipCount; i++) consider(pts[i], i);
  }

  return best;
}

function parseAttributeDirection(meta) {
  const keys = ["direction", "flow", "flow_direction", "waterway:flow"];
  for (const k of keys) {
    const raw = meta[k] || meta.props?.[k];
    if (!raw) continue;
    const s = String(raw).toLowerCase();
    if (/down|forward|with|outlet|out/.test(s)) return true;
    if (/up|back|reverse|inlet|in/.test(s)) return false;
  }
  return null;
}

function nearestStationXZ(x, z, stations) {
  let bestI = 0;
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(stations.length / 500));
  for (let i = 0; i < stations.length; i += step) {
    const s = stations[i];
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  for (let i = Math.max(0, bestI - 24); i <= Math.min(stations.length - 1, bestI + 24); i++) {
    const s = stations[i];
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const s = stations[bestI];
  return { x: s.x, z: s.z, d: bestD, index: bestI };
}

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return L;
}
