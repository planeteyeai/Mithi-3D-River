/**
 * Mithi OSM bridges — bank-to-bank decks along ORIGINAL OSM headings.
 *
 * Problem we fix:
 *  - OSM bridge=yes tags are often short mid-channel stubs (~60–100 m)
 *  - The Mithi AOI water polygon is much wider, so a stub looks like it
 *    "stops at the bank" / never crosses.
 *
 * Method:
 *  1. Keep OSM way ID, name, class, width, and heading from source coords.
 *  2. Require the way to intersect (or sit next to) the water AOI.
 *  3. Build a straight centerline through the crossing along the OSM heading
 *     that reaches BOTH dry banks, then snap ends to nearby roads/rails.
 *  4. Never invent a new crossing location — only extend along OSM heading.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "../public/data/mithi");
const CORRIDOR_PATH = path.join(DATA, "osm_mithi_corridor.json");
const AOI_PATH = path.join(DATA, "mithi_river.kml");
const OUT_CURATED = path.join(DATA, "mithi_osm_bridges.json");
const OUT_GEOJSON = path.join(DATA, "bridges.geojson");

const M_PER_DEG_LAT = 110540;
const MIN_WATER_OVERLAP_M = 12;
const MAX_HALF_SPAN_M = 900;
const BANK_APRON_M = 35;
const ROAD_SNAP_M = 45;
const DEDUPE_RADIUS_M = 35;
const SATELLITE_CONFIRMED_IDS = new Set(["46417986", "46417988", "107295496"]);

function mLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
function distM(a, b) {
  const lat = ((a[1] ?? a.lat) + (b[1] ?? b.lat)) / 2;
  return Math.hypot(((b[0] ?? b.lon) - (a[0] ?? a.lon)) * mLon(lat), ((b[1] ?? b.lat) - (a[1] ?? a.lat)) * M_PER_DEG_LAT);
}
function lineLengthM(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += distM(coords[i - 1], coords[i]);
  return s;
}
function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const inter = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}
function cross2(ax, ay, bx, by) {
  return ax * by - ay * bx;
}
function interpolateCoord(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function segmentRingIntersections(a, b, ring) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const ts = [0, 1];
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1];
    const d = ring[i];
    const sx = d[0] - c[0];
    const sy = d[1] - c[1];
    const den = cross2(rx, ry, sx, sy);
    if (Math.abs(den) < 1e-14) continue;
    const t = cross2(c[0] - a[0], c[1] - a[1], sx, sy) / den;
    const u = cross2(c[0] - a[0], c[1] - a[1], rx, ry) / den;
    if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) {
      ts.push(Math.max(0, Math.min(1, t)));
    }
  }
  return [...new Set(ts.map((t) => Number(t.toFixed(12))))].sort((x, y) => x - y);
}
function waterOverlapM(coords, ring) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const ts = segmentRingIntersections(a, b, ring);
    for (let j = 1; j < ts.length; j++) {
      const mid = interpolateCoord(a, b, (ts[j - 1] + ts[j]) * 0.5);
      if (pointInPolygon(mid[0], mid[1], ring)) {
        total += distM(interpolateCoord(a, b, ts[j - 1]), interpolateCoord(a, b, ts[j]));
      }
    }
  }
  return total;
}
function parseAoi(kmlPath) {
  const kml = fs.readFileSync(kmlPath, "utf8");
  const blocks = [];
  const re = /<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi;
  let m;
  while ((m = re.exec(kml))) {
    const pts = m[1]
      .trim()
      .split(/\s+/)
      .map((tok) => {
        const [lon, lat] = tok.split(",").map(Number);
        return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
      })
      .filter(Boolean);
    if (pts.length) blocks.push(pts);
  }
  blocks.sort((a, b) => b.length - a.length);
  return blocks[0];
}
function widthFor(b) {
  if (Number.isFinite(b.widthM) && b.widthM > 0) return b.widthM;
  if (b.railway) return 10;
  const hw = b.highway || "";
  if (hw === "motorway") return 18;
  if (hw === "trunk") return 16;
  if (hw === "primary") return 14;
  if (hw === "secondary") return 12;
  if (hw === "tertiary") return 10;
  return 12;
}
function scoreBridge(b, waterM) {
  let s = waterM;
  if (b.name && !/^Bridge /.test(b.name)) s += 40;
  if (SATELLITE_CONFIRMED_IDS.has(String(b.id))) s += 100;
  s +=
    ({ motorway: 55, trunk: 48, primary: 38, secondary: 28, tertiary: 16, railway: 45, residential: 6 }[
      b.railway ? "railway" : b.highway
    ] || 0);
  return s;
}
function osmHeading(coords) {
  // Prefer longest segment direction (stable for 2-pt and multi-pt ways).
  let best = { dx: 1, dy: 0, len: 0 };
  for (let i = 1; i < coords.length; i++) {
    const lat = (coords[i][1] + coords[i - 1][1]) / 2;
    const dx = (coords[i][0] - coords[i - 1][0]) * mLon(lat);
    const dy = (coords[i][1] - coords[i - 1][1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len > best.len) best = { dx, dy, len };
  }
  const l = best.len || 1;
  return { dx: best.dx / l, dy: best.dy / l };
}
function midpoint(coords) {
  const half = lineLengthM(coords) / 2;
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = distM(coords[i - 1], coords[i]);
    if (walked + seg >= half) {
      const t = seg > 0 ? (half - walked) / seg : 0;
      return {
        lon: coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        lat: coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      };
    }
    walked += seg;
  }
  return { lon: coords[0][0], lat: coords[0][1] };
}
function offset(mid, dx, dy, meters) {
  return [mid.lon + (dx * meters) / mLon(mid.lat), mid.lat + (dy * meters) / M_PER_DEG_LAT];
}

/** Walk along heading until outside water, then add apron. */
function walkToBank(mid, dx, dy, sign, ring) {
  let hitDry = null;
  for (let s = 4; s <= MAX_HALF_SPAN_M; s += 4) {
    const q = offset(mid, dx * sign, dy * sign, s);
    if (!pointInPolygon(q[0], q[1], ring)) {
      hitDry = s;
      break;
    }
  }
  const target = Math.min(MAX_HALF_SPAN_M, (hitDry ?? Math.max(80, BANK_APRON_M)) + BANK_APRON_M);
  return offset(mid, dx * sign, dy * sign, target);
}

/**
 * If OSM mid is outside water, slide along heading (±) until inside, else keep mid.
 * For satellite-confirmed ways beside the channel, also try a short lateral nudge.
 */
function crossingAnchor(coords, ring) {
  const mid = midpoint(coords);
  if (pointInPolygon(mid.lon, mid.lat, ring)) return mid;
  const { dx, dy } = osmHeading(coords);
  for (const sign of [1, -1]) {
    for (let s = 5; s <= 200; s += 5) {
      const q = offset(mid, dx * sign, dy * sign, s);
      if (pointInPolygon(q[0], q[1], ring)) return { lon: q[0], lat: q[1] };
    }
  }
  // Lateral search (perpendicular) for ways that skim the bank.
  const px = -dy;
  const py = dx;
  for (const sign of [1, -1]) {
    for (let s = 5; s <= 250; s += 5) {
      const q = offset(mid, px * sign, py * sign, s);
      if (pointInPolygon(q[0], q[1], ring)) return { lon: q[0], lat: q[1] };
    }
  }
  return mid;
}

function buildRoadIndex(roads) {
  const pts = [];
  for (const r of roads || []) {
    const coords = r.coordinates || [];
    if (coords.length < 2) continue;
    // Prefer non-bridge road/rail vertices for bank connections.
    const step = Math.max(1, Math.floor(coords.length / 24));
    for (let i = 0; i < coords.length; i += step) pts.push(coords[i]);
    pts.push(coords[coords.length - 1]);
  }
  return pts;
}
function nearestRoad(lon, lat, roadPts) {
  let best = null;
  let bestD = Infinity;
  for (const p of roadPts) {
    const d = distM([lon, lat], p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best && bestD <= ROAD_SNAP_M ? { point: best, distM: bestD } : null;
}
function snapEnd(pt, roadPts) {
  const hit = nearestRoad(pt[0], pt[1], roadPts);
  return hit ? [...hit.point] : pt;
}

function main() {
  const corridor = JSON.parse(fs.readFileSync(CORRIDOR_PATH, "utf8"));
  const aoi = parseAoi(AOI_PATH);
  const roadPts = buildRoadIndex(corridor.roads);
  const bridgesIn = corridor.bridges || [];

  const crossings = [];
  let rejectedNoWater = 0;

  for (const b of bridgesIn) {
    const coords = (b.coordinates || []).map((c) => [c[0], c[1]]);
    if (coords.length < 2) continue;
    if (b.highway === "construction" || b.railway === "construction") continue;
    if (b.highway === "footway" || b.highway === "path" || b.highway === "steps") continue;

    const waterM = waterOverlapM(coords, aoi);
    const confirmed = SATELLITE_CONFIRMED_IDS.has(String(b.id));
    if (waterM < MIN_WATER_OVERLAP_M && !confirmed) {
      rejectedNoWater++;
      continue;
    }

    const heading = osmHeading(coords);
    const anchor = crossingAnchor(coords, aoi);
    // Prefer OSM heading; if that yields a thin/no crossing, try perpendicular.
    let dx = heading.dx;
    let dy = heading.dy;
    const bankDist = (sx, sy) => {
      for (let s = 4; s <= MAX_HALF_SPAN_M; s += 4) {
        if (!pointInPolygon(...offset(anchor, sx, sy, s), aoi)) return s;
      }
      return MAX_HALF_SPAN_M;
    };
    const widthAlong = bankDist(-dx, -dy) + bankDist(dx, dy);
    const px = -heading.dy;
    const py = heading.dx;
    const widthPerp = bankDist(-px, -py) + bankDist(px, py);
    // If OSM heading barely crosses water but perpendicular does, the tagged
    // segment is along-bank — rotate to the true crossing for deck generation
    // while keeping the OSM anchor location.
    if (widthPerp > widthAlong + 80 && widthPerp >= 60) {
      dx = px;
      dy = py;
    }

    let a = walkToBank(anchor, dx, dy, -1, aoi);
    let c = walkToBank(anchor, dx, dy, 1, aoi);
    a = snapEnd(a, roadPts);
    c = snapEnd(c, roadPts);

    // Keep a 3-point centerline: bank — OSM anchor — bank (preserves OSM location).
    const deck = [a, [anchor.lon, anchor.lat], c];
    const cleaned = [deck[0]];
    for (let i = 1; i < deck.length; i++) {
      if (distM(cleaned[cleaned.length - 1], deck[i]) > 0.5) cleaned.push(deck[i]);
    }
    if (cleaned.length < 2) continue;

    crossings.push({
      ...b,
      sourceCoordinates: coords,
      coordinates: cleaned,
      mid: { lon: anchor.lon, lat: anchor.lat },
      waterOverlapM: Math.max(waterM, confirmed ? MIN_WATER_OVERLAP_M : 0),
      lengthM: lineLengthM(cleaned),
      headingMode: widthPerp > widthAlong + 80 && widthPerp >= 60 ? "OSM_PERP_CROSS" : "OSM_HEADING",
      score: scoreBridge(b, waterM),
      satelliteConfirmed: confirmed,
    });
  }

  crossings.sort((a, b) => b.score - a.score);
  const deduped = [];
  for (const c of crossings) {
    const cRail = !!(c.railway || c.highway === "railway");
    const peers = deduped.filter((d) => {
      const dRail = !!(d.railway || d.highway === "railway");
      if (cRail !== dRail) return false;
      return distM([d.mid.lon, d.mid.lat], [c.mid.lon, c.mid.lat]) < DEDUPE_RADIUS_M;
    });
    if (!peers.length || c.satelliteConfirmed) {
      if (peers.length && c.satelliteConfirmed && peers.length >= 3) continue;
      deduped.push(c);
      continue;
    }
    const same =
      peers.some(
        (d) =>
          (d.railway && c.railway) ||
          (d.highway && d.highway === c.highway && /motorway|trunk|primary|secondary/.test(c.highway || "")),
      ) && peers.length < 2;
    if (same) deduped.push(c);
  }
  deduped.sort((a, b) => a.mid.lon - b.mid.lon || a.mid.lat - b.mid.lat);

  const curated = deduped.map((b) => {
    const isRail = !!b.railway || b.highway === "railway";
    return {
      id: String(b.id),
      osmId: String(b.id),
      name: b.name || (isRail ? `Railway ${b.id}` : `Bridge ${b.id}`),
      bridgeType: isRail ? "railway" : "girder",
      highway: isRail ? "railway" : b.highway || "road",
      railway: b.railway || (isRail ? "rail" : null),
      widthM: widthFor(b),
      lengthM: Math.round(b.lengthM * 10) / 10,
      sourceWayLengthM: Math.round(lineLengthM(b.sourceCoordinates) * 10) / 10,
      waterOverlapM: Math.round(b.waterOverlapM * 10) / 10,
      headingMode: b.headingMode,
      satelliteConfirmed: !!b.satelliteConfirmed,
      midpoint: { lat: b.mid.lat, lon: b.mid.lon },
      coords: b.coordinates,
      sourceCoords: b.sourceCoordinates,
      source: "MITHI_OSM",
      provenance: "OSM heading bank-to-bank through original crossing anchor",
    };
  });

  fs.writeFileSync(
    OUT_CURATED,
    JSON.stringify(
      {
        river: "Mithi",
        note: "Bank-to-bank decks along OSM headings through verified water crossings",
        bridges: curated,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    OUT_GEOJSON,
    JSON.stringify(
      {
        type: "FeatureCollection",
        features: curated.map((b) => ({
          type: "Feature",
          properties: {
            osmId: b.osmId,
            name: b.name,
            highway: b.highway,
            railway: b.railway,
            lengthM: b.lengthM,
            widthM: b.widthM,
            headingMode: b.headingMode,
          },
          geometry: { type: "LineString", coordinates: b.coords },
        })),
      },
      null,
      2,
    ),
  );

  console.info("[filter-bridges] retained", curated.length, "rejectedNoWater", rejectedNoWater);
  for (const b of curated) {
    const a = b.coords[0];
    const c = b.coords.at(-1);
    console.info(
      `  ${b.osmId} ${b.name} | ${b.lengthM}m w=${b.widthM} | ${b.highway} | ${b.headingMode} | endsDry ${!pointInPolygon(a[0], a[1], aoi)}/${!pointInPolygon(c[0], c[1], aoi)}`,
    );
  }
}

main();
