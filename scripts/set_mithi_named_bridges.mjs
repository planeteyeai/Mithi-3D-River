/**
 * Align Mithi bridges to user midpoints using OSM bridge-way headings.
 * Deck always passes through the exact lat/lon midpoint.
 * Corridor pack only (no slow Overpass).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public", "data", "mithi");
const CORRIDOR = path.join(PUBLIC, "osm_mithi_corridor.json");
const AOI = path.join(PUBLIC, "mithi_river.kml");

const TARGETS = [
  { name: "Mahim Causeway", lat: 19.048256, lon: 72.838239, preferIds: ["46417981"], highway: "primary", widthM: 18, halfSpanM: 90 },
  { name: "Bridge 436692571", lat: 19.050865, lon: 72.841977, preferIds: ["436692571"], highway: "secondary", widthM: 12, halfSpanM: 90 },
  { name: "Sion–Bandra Link Road", lat: 19.051811, lon: 72.848025, preferIds: ["1488947043"], highway: "primary", widthM: 14, halfSpanM: 100 },
  { name: "BKC Connector", lat: 19.052135, lon: 72.86775, preferIds: ["746615682"], highway: "secondary", widthM: 14, halfSpanM: 110 },
  { name: "Bandra Kurla Complex Road", lat: 19.060055, lon: 72.85728, preferIds: ["1330234683"], highway: "secondary", widthM: 14, halfSpanM: 95 },
  { name: "Bandra Kurla Complex Road", lat: 19.070947, lon: 72.873403, preferIds: ["260786314"], highway: "secondary", widthM: 14, halfSpanM: 100 },
  { name: "Santa Cruz–Chembur Link Road", lat: 19.074588, lon: 72.871682, preferIds: ["1158399732"], highway: "trunk", widthM: 16, halfSpanM: 110 },
  { name: "BKC–SCLR Connector", lat: 19.074986, lon: 72.872225, preferIds: ["1562122423"], highway: "trunk", widthM: 16, halfSpanM: 120 },
  { name: "SCLR Flyover", lat: 19.073907, lon: 72.869646, preferIds: ["1122421036"], highway: "trunk", widthM: 16, halfSpanM: 120 },
  { name: "Kalina–Kurla Road", lat: 19.078809, lon: 72.876212, preferIds: ["436370623"], highway: "secondary", widthM: 12, halfSpanM: 95 },
];

function metersPerDeg(lat) {
  const lat0 = (lat * Math.PI) / 180;
  return { mLon: 111320 * Math.cos(lat0), mLat: 110540 };
}

function distM(a, b) {
  const m = metersPerDeg((a.lat + b.lat) / 2);
  return Math.hypot((a.lon - b.lon) * m.mLon, (a.lat - b.lat) * m.mLat);
}

function pathLen(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) {
    s += distM({ lon: coords[i - 1][0], lat: coords[i - 1][1] }, { lon: coords[i][0], lat: coords[i][1] });
  }
  return s;
}

function minDistToWay(mid, coords) {
  let best = Infinity;
  for (const [lon, lat] of coords) best = Math.min(best, distM(mid, { lon, lat }));
  for (let i = 1; i < coords.length; i++) {
    const p = {
      lon: (coords[i - 1][0] + coords[i][0]) / 2,
      lat: (coords[i - 1][1] + coords[i][1]) / 2,
    };
    best = Math.min(best, distM(mid, p));
  }
  return best;
}

function parseAoiRing(text) {
  const m = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  return m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lon, lat] = tok.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
    })
    .filter(Boolean);
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon;
    const yi = ring[i].lat;
    const xj = ring[j].lon;
    const yj = ring[j].lat;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Local OSM heading from the polyline segment nearest the midpoint. */
function headingNearMid(coords, mid) {
  const m = metersPerDeg(mid.lat);
  let bestD = Infinity;
  let dx = 1;
  let dy = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const ax = (a[0] - mid.lon) * m.mLon;
    const ay = (a[1] - mid.lat) * m.mLat;
    const bx = (b[0] - mid.lon) * m.mLon;
    const by = (b[1] - mid.lat) * m.mLat;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, (-ax * vx - ay * vy) / len2));
    const px = ax + t * vx;
    const py = ay + t * vy;
    const d = Math.hypot(px, py);
    if (d < bestD) {
      bestD = d;
      const segLen = Math.hypot(vx, vy) || 1;
      dx = vx / segLen;
      dy = vy / segLen;
    }
  }
  return { dx, dy, m, nearestDistM: bestD };
}

/** Distance from mid to first dry point along ±unit heading. */
function bankDist(mid, dx, dy, sign, aoi, maxM = 1200) {
  const m = metersPerDeg(mid.lat);
  let sawWater = pointInRing(mid.lon, mid.lat, aoi);
  for (let s = 5; s <= maxM; s += 5) {
    const lon = mid.lon + (sign * dx * s) / m.mLon;
    const lat = mid.lat + (sign * dy * s) / m.mLat;
    const inside = pointInRing(lon, lat, aoi);
    if (inside) sawWater = true;
    else if (sawWater) return s;
  }
  return sawWater ? maxM : 0;
}

/**
 * Pick the axis through the midpoint that actually crosses the channel.
 * Score = min(leftBank, rightBank): grazing/along-bank headings score low;
 * a true bank-to-bank heading has water on both sides.
 */
function crossingHeading(osmHeading, mid, aoi) {
  const m = osmHeading.m;
  const midInWater = pointInRing(mid.lon, mid.lat, aoi);

  const candidates = [];
  const pushCand = (dx, dy, mode) => {
    const L = bankDist(mid, dx, dy, -1, aoi);
    const R = bankDist(mid, dx, dy, 1, aoi);
    const total = L + R;
    const balance = Math.min(L, R);
    candidates.push({
      dx,
      dy,
      m,
      mode,
      L,
      R,
      total,
      balance,
      nearestDistM: osmHeading.nearestDistM,
    });
  };

  pushCand(osmHeading.dx, osmHeading.dy, "OSM_WAY");
  pushCand(-osmHeading.dy, osmHeading.dx, "OSM_PERPENDICULAR");

  if (midInWater) {
    let bestBal = { balance: -1, dx: 1, dy: 0, L: 0, R: 0 };
    for (let deg = 0; deg < 180; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = Math.cos(rad);
      const L = bankDist(mid, dx, dy, -1, aoi, 800);
      const R = bankDist(mid, dx, dy, 1, aoi, 800);
      const balance = Math.min(L, R);
      // Prefer balanced crossings; among those, prefer shorter total (true channel).
      if (
        balance > bestBal.balance + 15 ||
        (Math.abs(balance - bestBal.balance) <= 15 && L + R < bestBal.L + bestBal.R)
      ) {
        bestBal = { balance, dx, dy, L, R };
      }
    }
    if (bestBal.balance > 0) {
      pushCand(bestBal.dx, bestBal.dy, "CHANNEL_CROSS");
    }
  }

  // Highest balance wins; tie-break on shorter total width.
  candidates.sort((a, b) => b.balance - a.balance || a.total - b.total);
  return candidates[0];
}

/**
 * Deck through exact midpoint to both banks (asymmetric OK).
 * Midpoint stays the label/survey anchor; ends land past each bank.
 */
function deckThroughMidpoint(mid, heading, halfSpanM, aoi) {
  const { dx, dy, m } = heading;
  const apronM = 55;
  const maxHalf = 1200;
  let left = halfSpanM;
  let right = halfSpanM;
  if (aoi?.length) {
    const L = bankDist(mid, dx, dy, -1, aoi, maxHalf);
    const R = bankDist(mid, dx, dy, 1, aoi, maxHalf);
    if (L + R >= 40) {
      left = Math.min(maxHalf, Math.max(halfSpanM * 0.5, L) + apronM);
      right = Math.min(maxHalf, Math.max(halfSpanM * 0.5, R) + apronM);
    }
  }
  const a = {
    lon: mid.lon - (dx * left) / m.mLon,
    lat: mid.lat - (dy * left) / m.mLat,
  };
  const b = {
    lon: mid.lon + (dx * right) / m.mLon,
    lat: mid.lat + (dy * right) / m.mLat,
  };
  return [
    [a.lon, a.lat],
    [mid.lon, mid.lat],
    [b.lon, b.lat],
  ];
}

function pickWay(bridges, t, mid) {
  let best = null;
  let bestScore = -Infinity;
  for (const br of bridges || []) {
    const coords = br.coordinates || [];
    if (coords.length < 2) continue;
    const id = String(br.id);
    const d = minDistToWay(mid, coords);
    const len = pathLen(coords);
    let score = 0;
    if (t.preferIds?.includes(id)) score += 5000;
    score += Math.max(0, 250 - d);
    if (len >= 40 && len <= 400) score += 60;
    else if (len > 400 && len <= 1600) score += 20;
    else if (len > 1600) score -= 80;
    if (/metro|dahisar|mandale/i.test(br.name || "")) score -= 120;
    if (score > bestScore) {
      bestScore = score;
      best = { id, name: br.name, highway: br.highway, coords, d, len, score };
    }
  }
  return best;
}

const corridor = JSON.parse(fs.readFileSync(CORRIDOR, "utf8"));
const aoi = parseAoiRing(fs.readFileSync(AOI, "utf8"));
const curated = [];

for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  const mid = { lon: t.lon, lat: t.lat };
  const way = pickWay(corridor.bridges, t, mid);
  if (!way) {
    console.warn("MISS", t.name);
    continue;
  }
  const osmHeading = headingNearMid(way.coords, mid);
  const heading = crossingHeading(osmHeading, mid, aoi);
  const coords = deckThroughMidpoint(mid, heading, t.halfSpanM || 100, aoi);
  curated.push({
    // 91xxxxxx avoids Mandovi/Pune bridgeDimensionSource id collisions (90xxxxxx).
    id: String(910000001 + i),
    osmId: String(way.id),
    name: t.name,
    bridgeType: "girder",
    highway: t.highway || way.highway || "road",
    widthM: t.widthM,
    lengthM: Math.round(pathLen(coords)),
    midpoint: { lat: t.lat, lon: t.lon },
    coords,
    matchDistM: Math.round(way.d),
    osmWayLenM: Math.round(way.len),
    headingMode: heading.mode,
    source: "MITHI_SURVEY",
    provenance: "USER_MIDPOINT_LATLON + bank-to-bank crossing heading",
  });
  console.info(
    `✓ ${t.name} ← OSM ${way.id} (${way.name}) ${heading.mode} banks=${Math.round(heading.L)}/${Math.round(heading.R)}m deckLen=${Math.round(pathLen(coords))}m`,
  );
}

fs.writeFileSync(
  path.join(PUBLIC, "mithi_osm_bridges.json"),
  JSON.stringify({ river: "Mithi", note: "Exact midpoint decks spanning bank-to-bank", bridges: curated }, null, 2),
);
fs.writeFileSync(
  path.join(PUBLIC, "bridges.geojson"),
  JSON.stringify(
    {
      type: "FeatureCollection",
      features: curated.map((b) => ({
        type: "Feature",
        properties: {
          id: b.id,
          osmId: b.osmId,
          name: b.name,
          bridge: "yes",
          highway: b.highway,
          midpointLat: b.midpoint.lat,
          midpointLon: b.midpoint.lon,
        },
        geometry: { type: "LineString", coordinates: b.coords },
      })),
    },
    null,
    2,
  ),
);
console.info("[mithi-bridges] aligned", curated.length);
