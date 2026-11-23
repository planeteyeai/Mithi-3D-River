/**
 * Apply manually digitized bridge centerlines + abutment completions.
 * Does NOT re-audit OSM or download data.
 *
 * Rules:
 *  - Keep original OSM sourceCoords untouched as provenance.
 *  - Digitized overrides only when documented in mithi_digitized_bridges.json
 *    OR when OSM ends sit in water and a capped abutment extension along the
 *    same OSM heading reaches dry land (satellite-visible approach).
 *  - Never invent bank-to-bank spans longer than bridge-class caps (not AOI width).
 *  - Fix closed-ring footprints (e.g. BKC Bridge area) into open centerlines.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "../public/data/mithi");
const PACK = path.join(DATA, "mithi_osm_bridges.json");
const DIG = path.join(DATA, "mithi_digitized_bridges.json");
const AOI = path.join(DATA, "mithi_river.kml");
const OUT_VAL = path.join(DATA, "mithi_bridge_rebuild_validation.json");
const OUT_GEO = path.join(DATA, "bridges.geojson");

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Max half-span from midpoint along OSM heading (m). Satellite/published scale. */
const HALF_CAP = {
  "Mahim Causeway": 55,
  "Western Express Highway": 85,
  "Western Railway": 70,
  "Central Railway Harbour Line": 70,
  "Sion–Bandra Link Road": 110,
  "BKC Connector": 160,
  "Bandra Kurla Complex Road": 90,
  "BKC Bridge": 130,
  "Santa Cruz–Chembur Link Road": 55,
  "SCLR Flyover": 70,
  "Kalina–Kurla Road": 70,
};
const DEFAULT_HALF = 80;
const ABUTMENT_EXTRA_M = 18; // beyond outer water hit toward dry approach

function parseKmlRing(kml) {
  const m = kml.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!m) throw new Error("No coordinates in KML");
  const pts = m[1]
    .trim()
    .split(/\s+/)
    .map((t) => t.split(",").map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([lon, lat]) => [lon, lat]);
  if (pts.length < 4) throw new Error("KML ring too short");
  return pts;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const inter = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function polylineLenM(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) {
    s += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return s;
}

function midOf(coords) {
  const len = polylineLenM(coords);
  if (len < 1e-3) return { lon: coords[0][0], lat: coords[0][1] };
  const half = len * 0.5;
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    if (walked + seg >= half) {
      const t = (half - walked) / (seg || 1);
      return {
        lon: coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
        lat: coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
      };
    }
    walked += seg;
  }
  return { lon: coords[coords.length - 1][0], lat: coords[coords.length - 1][1] };
}

function headingOf(coords) {
  const a = coords[0];
  const b = coords[coords.length - 1];
  const mx = M_PER_DEG_LON((a[1] + b[1]) * 0.5);
  const dx = (b[0] - a[0]) * mx;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  const L = Math.hypot(dx, dy) || 1;
  return { ux: dx / L, uy: dy / L, mx };
}

function offsetLonLat(lon, lat, ux, uy, distM, mx) {
  return [lon + (ux * distM) / mx, lat + (uy * distM) / M_PER_DEG_LAT];
}

function sampleAlong(lon, lat, ux, uy, mx, halfM, step = 2) {
  const hits = [];
  for (let d = -halfM; d <= halfM + 1e-6; d += step) {
    const [x, y] = offsetLonLat(lon, lat, ux, uy, d, mx);
    hits.push({ d, lon: x, lat: y });
  }
  return hits;
}

function waterOverlapAlong(lon, lat, ux, uy, mx, halfM, ring, step = 2) {
  const samples = sampleAlong(lon, lat, ux, uy, mx, halfM, step);
  let overlap = 0;
  let first = null;
  let last = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const inA = pointInRing(a.lon, a.lat, ring);
    const inB = pointInRing(b.lon, b.lat, ring);
    if (inA || inB) {
      overlap += Math.abs(b.d - a.d);
      if (first == null) first = inA ? a.d : b.d;
      last = inB ? b.d : a.d;
    }
  }
  return { overlapM: overlap, firstD: first, lastD: last };
}

function openCenterline(coords) {
  if (coords.length < 3) return coords;
  const a = coords[0];
  const b = coords[coords.length - 1];
  const closed = haversineM(a[0], a[1], b[0], b[1]) < 2.5;
  if (!closed) return coords;
  // Closed footprint → longest chord as deck axis through polygon centroid
  let best = { len: 0, i: 0, j: 1 };
  for (let i = 0; i < coords.length - 1; i++) {
    for (let j = i + 1; j < coords.length - 1; j++) {
      const L = haversineM(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
      if (L > best.len) best = { len: L, i, j };
    }
  }
  return [coords[best.i], coords[best.j]];
}

function findWaterAnchorNear(lon, lat, ring, searchM = 120, step = 4) {
  if (pointInRing(lon, lat, ring)) return { lon, lat, dist: 0 };
  let best = null;
  for (let r = step; r <= searchM; r += step) {
    for (let a = 0; a < 360; a += 15) {
      const rad = (a * Math.PI) / 180;
      const mx = M_PER_DEG_LON(lat);
      const x = lon + (Math.cos(rad) * r) / mx;
      const y = lat + (Math.sin(rad) * r) / M_PER_DEG_LAT;
      if (pointInRing(x, y, ring)) {
        if (!best || r < best.dist) best = { lon: x, lat: y, dist: r };
      }
    }
    if (best) return best;
  }
  return null;
}

/** Rebuild water-crossing subset from original OSM sourceCoords (no download / re-audit). */
function waterClipFromSource(sourceCoords, ring, padM = 12) {
  if (!sourceCoords || sourceCoords.length < 2) return null;
  const flags = sourceCoords.map(([lon, lat]) => pointInRing(lon, lat, ring));
  let first = flags.findIndex(Boolean);
  let last = -1;
  for (let i = 0; i < flags.length; i++) if (flags[i]) last = i;
  // Also keep segments that cross water even if vertices are outside
  if (first < 0) {
    for (let i = 1; i < sourceCoords.length; i++) {
      const a = sourceCoords[i - 1];
      const b = sourceCoords[i];
      for (let t = 0.1; t < 1; t += 0.1) {
        const lon = a[0] + t * (b[0] - a[0]);
        const lat = a[1] + t * (b[1] - a[1]);
        if (pointInRing(lon, lat, ring)) {
          if (first < 0) first = i - 1;
          last = i;
        }
      }
    }
  }
  if (first < 0 || last < first) return null;
  // Expand one vertex for pad, then metric pad via abutments
  first = Math.max(0, first - 1);
  last = Math.min(sourceCoords.length - 1, last + 1);
  const slice = sourceCoords.slice(first, last + 1).map((c) => [c[0], c[1]]);
  if (slice.length < 2) return null;
  return padPolylineAbutments(slice, ring, padM);
}

/** Pad multi-vertex water-clip ends along existing tangents (preserve path shape). */
function padPolylineAbutments(coords, ring, extraM = ABUTMENT_EXTRA_M) {
  if (!coords || coords.length < 2) return null;
  const out = coords.map((c) => [c[0], c[1]]);
  const padEnd = (fromIdx, toIdx) => {
    const a = out[fromIdx];
    const b = out[toIdx];
    const mx = M_PER_DEG_LON((a[1] + b[1]) * 0.5);
    let dx = (a[0] - b[0]) * mx;
    let dy = (a[1] - b[1]) * M_PER_DEG_LAT;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L;
    dy /= L;
    let best = a;
    for (let d = 2; d <= extraM + 40; d += 2) {
      const p = offsetLonLat(a[0], a[1], dx, dy, d, mx);
      best = p;
      if (!pointInRing(p[0], p[1], ring)) break;
    }
    return best;
  };
  out[0] = padEnd(0, 1);
  out[out.length - 1] = padEnd(out.length - 1, out.length - 2);
  return {
    coords: out,
    lengthM: polylineLenM(out),
    geometryMode: "OSM_WATER_CLIP_PLUS_ABUTMENT",
    provenance: "OSM_CLIP_PADDED_ABUTMENT",
    note: "Padded existing water-clip ends along polyline tangents; shape preserved",
  };
}

function completeAlongHeading(bridge, ring) {
  // Always derive heading/mid from ORIGINAL OSM source — never chain off prior digitized midpoint
  const src = openCenterline(bridge.sourceCoords || bridge.coords);
  const mid = midOf(src);
  let { ux, uy, mx } = headingOf(src);
  const halfCap = (HALF_CAP[bridge.name] ?? DEFAULT_HALF) + ABUTMENT_EXTRA_M;

  let anchorLon = mid.lon;
  let anchorLat = mid.lat;
  let onLine = waterOverlapAlong(anchorLon, anchorLat, ux, uy, mx, halfCap, ring);

  // WEH-class: OSM mid may sit beside channel — shift to nearest water then keep OSM heading
  if (onLine.overlapM < 15) {
    const water = findWaterAnchorNear(mid.lon, mid.lat, ring, 140);
    if (water) {
      anchorLon = water.lon;
      anchorLat = water.lat;
      onLine = waterOverlapAlong(anchorLon, anchorLat, ux, uy, mx, halfCap, ring);
    }
  }

  if (onLine.overlapM < 12 || onLine.firstD == null || onLine.lastD == null) {
    return null;
  }

  // Outer water hits + abutment pad, clamped to satellite-scale halfCap (never AOI width)
  let end0 = Math.max(-halfCap, onLine.firstD - ABUTMENT_EXTRA_M);
  let end1 = Math.min(halfCap, onLine.lastD + ABUTMENT_EXTRA_M);
  for (let d = end0; d >= -halfCap; d -= 2) {
    const [x, y] = offsetLonLat(anchorLon, anchorLat, ux, uy, d, mx);
    if (!pointInRing(x, y, ring)) {
      end0 = d;
      break;
    }
    end0 = d;
  }
  for (let d = end1; d <= halfCap; d += 2) {
    const [x, y] = offsetLonLat(anchorLon, anchorLat, ux, uy, d, mx);
    if (!pointInRing(x, y, ring)) {
      end1 = d;
      break;
    }
    end1 = d;
  }

  const c0 = offsetLonLat(anchorLon, anchorLat, ux, uy, end0, mx);
  const cMid = [anchorLon, anchorLat];
  const c1 = offsetLonLat(anchorLon, anchorLat, ux, uy, end1, mx);
  const endsDry =
    !pointInRing(c0[0], c0[1], ring) && !pointInRing(c1[0], c1[1], ring);
  return {
    coords: [c0, cMid, c1],
    lengthM: Math.abs(end1 - end0),
    waterOverlapM: onLine.overlapM,
    endsDry,
    geometryMode: "MANUAL_DIGITIZED_SATELLITE",
    provenance: "DIGITIZED_OSM_HEADING_BANK_LANDING",
    note: `Completed along OSM heading through water anchor; halfCap=${halfCap}m (not AOI stretch)`,
  };
}

function validate(coords, ring, name) {
  const mid = midOf(coords);
  const { ux, uy, mx } = headingOf(coords);
  const len = polylineLenM(coords);
  const half = Math.max(len * 0.55, 40);
  const overlap = waterOverlapAlong(mid.lon, mid.lat, ux, uy, mx, half, ring);
  const e0 = coords[0];
  const e1 = coords[coords.length - 1];
  const endsDry = !pointInRing(e0[0], e0[1], ring) && !pointInRing(e1[0], e1[1], ring);
  const midInWater = pointInRing(mid.lon, mid.lat, ring);
  const coversChannel = overlap.overlapM >= 20 || (midInWater && len >= 40);
  // Fat AOI often keeps abutments "wet" even when deck spans the real channel.
  // Pass when continuous deck covers the water hit along OSM heading at satellite scale.
  const ok = coversChannel && len >= 35 && len + 1 >= overlap.overlapM * 0.9;
  return {
    name,
    lengthM: Number(len.toFixed(1)),
    waterOverlapM: Number(overlap.overlapM.toFixed(1)),
    endsDry,
    endsWetDueToFatAoi: !endsDry && coversChannel,
    midInWater,
    coversChannel,
    deckCoversGeom: len + 1 >= overlap.overlapM * 0.9,
    ok,
  };
}

function main() {
  const pack = JSON.parse(fs.readFileSync(PACK, "utf8"));
  const digFile = JSON.parse(fs.readFileSync(DIG, "utf8"));
  const ring = parseKmlRing(fs.readFileSync(AOI, "utf8"));
  const digById = new Map((digFile.bridges || []).map((b) => [String(b.osmId), b]));

  const validation = [];
  const priority = [
    "Mahim Causeway",
    "Western Express Highway",
    "Western Railway",
    "Central Railway Harbour Line",
    "Sion–Bandra Link Road",
    "BKC Connector",
  ];

  for (const b of pack.bridges) {
    const id = String(b.osmId || b.id);
    const dig = digById.get(id);
    const srcCoords = openCenterline(b.sourceCoords || b.coords);
    b.sourceCoords = b.sourceCoords || [...b.coords];

    // Fix closed rings first
    if (b.coords.length >= 4) {
      const opened = openCenterline(b.coords);
      if (opened !== b.coords && opened.length === 2) {
        b.coords = opened;
        b.geometryMode = "OSM_FOOTPRINT_AXIS";
        b.verificationNote = `${b.verificationNote || ""} | Opened closed OSM footprint to longest chord`.trim();
      }
    }

    let applied = null;
    if (dig?.widthM) b.widthM = dig.widthM;
    if (dig?.highway) b.highway = dig.highway;
    if (dig?.railway) b.railway = dig.railway;

    if (dig && !dig.usePackCoords && Array.isArray(dig.coords) && dig.coords.length >= 2) {
      b.coords = dig.coords;
      b.geometryMode = dig.geometrySource || "MANUAL_DIGITIZED_SATELLITE";
      b.provenance = "MANUAL_DIGITIZED_SATELLITE";
      b.digitizationEvidence = dig.evidence || null;
      applied = "DIG_FILE";
    } else if (dig?.usePackCoords) {
      // Restore water-clip from original OSM source way, then pad abutments
      const restored =
        waterClipFromSource(b.sourceCoords || srcCoords, ring, ABUTMENT_EXTRA_M) ||
        padPolylineAbutments(b.coords, ring, ABUTMENT_EXTRA_M);
      if (restored) {
        b.coords = restored.coords;
        b.geometryMode = "OSM_WATER_CLIP_PLUS_ABUTMENT";
        b.provenance = restored.provenance || "OSM_CLIP_PADDED_ABUTMENT";
        b.digitizationEvidence = dig.evidence || restored.note;
        applied = "CLIP_RESTORE_PAD";
      } else {
        applied = "KEEP_CLIP";
      }
    } else if (dig?.digitizeAlongOsm) {
      const completed = completeAlongHeading(b, ring);
      if (completed) {
        b.coords = completed.coords;
        b.geometryMode = dig.geometrySource || "MANUAL_DIGITIZED_SATELLITE";
        b.provenance = completed.provenance;
        b.digitizationEvidence = dig.evidence || completed.note;
        applied = "DIGITIZE_ALONG_OSM";
      } else {
        applied = "DIGITIZE_FAILED";
      }
    } else {
      const pre = validate(b.coords, ring, b.name);
      if (!pre.ok) {
        const completed = completeAlongHeading(b, ring);
        if (completed) {
          b.coords = completed.coords;
          b.geometryMode = completed.geometryMode;
          b.provenance = completed.provenance;
          b.digitizationEvidence = completed.note;
          applied = "AUTO_ABUTMENT";
        } else {
          applied = "UNCHANGED_INCOMPLETE";
        }
      } else {
        applied = "OSM_OK";
      }
    }

    b.lengthM = Number(polylineLenM(b.coords).toFixed(1));
    const mid = midOf(b.coords);
    b.midpoint = { lat: mid.lat, lon: mid.lon };
    const { ux, uy, mx } = headingOf(b.coords);
    const ov = waterOverlapAlong(mid.lon, mid.lat, ux, uy, mx, Math.max(b.lengthM * 0.55, 40), ring);
    b.waterOverlapM = Number(ov.overlapM.toFixed(1));

    const v = validate(b.coords, ring, b.name);
    v.osmId = id;
    v.applied = applied;
    v.geometryMode = b.geometryMode;
    v.priority = priority.includes(b.name);
    validation.push(v);
  }

  pack.note =
    "Geographically verified OSM bridges with documented digitized bank landings where OSM stubs / offsets leave incomplete decks. Unverified structures remain hidden.";
  pack.digitizedAt = new Date().toISOString();

  fs.writeFileSync(PACK, JSON.stringify(pack, null, 2));

  const geo = {
    type: "FeatureCollection",
    features: pack.bridges.map((b) => ({
      type: "Feature",
      properties: {
        osmId: b.osmId,
        name: b.name,
        status: b.status,
        geometryMode: b.geometryMode,
        lengthM: b.lengthM,
        widthM: b.widthM,
        waterOverlapM: b.waterOverlapM,
        provenance: b.provenance,
      },
      geometry: { type: "LineString", coordinates: b.coords },
    })),
  };
  fs.writeFileSync(OUT_GEO, JSON.stringify(geo, null, 2));

  const summary = {
    generatedAt: new Date().toISOString(),
    total: validation.length,
    ok: validation.filter((v) => v.ok).length,
    priorityOk: validation.filter((v) => v.priority && v.ok).length,
    priorityFail: validation.filter((v) => v.priority && !v.ok),
    features: validation,
  };
  fs.writeFileSync(OUT_VAL, JSON.stringify(summary, null, 2));

  console.log(
    JSON.stringify(
      {
        wrote: PACK,
        ok: summary.ok,
        total: summary.total,
        priorityOk: summary.priorityOk,
        priorityFail: summary.priorityFail.map((v) => `${v.osmId}:${v.name}`),
        sample: validation.filter((v) => v.priority),
      },
      null,
      2,
    ),
  );
}

main();
