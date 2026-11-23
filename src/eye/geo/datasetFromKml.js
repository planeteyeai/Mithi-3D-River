/**
 * Build the RIVEREYE scene dataset from one uploaded river KML.
 * A line is buffered into a corridor polygon. A polygon is used as the river AOI.
 */

import {
  parseKmlGeometry,
  parsePointPlacemarksKml,
  parseChainageAnalysisKml,
  parseDrainageKml,
} from "./kml.js";
import { nearestChainage } from "./chainage.js";
import { lonLatToUtm } from "./projection.js";
import { initGeoReference, getGeoReference } from "./geoReference.js";
import {
  buildCorridorFromKml,
  syncRibbonPositionsFromStations,
  rebuildSolidRibbonIndices,
  clampCorridorChannelWidth,
} from "./corridor.js";
import { emptyOsmContext } from "./osmContext.js";
import { loadLiveOsm } from "./osmLive.js";
import { loadOsmBridges } from "./osmBridges.js";
import { resolveTreeHeight } from "./heightResolve.js";
import {
  computeActiveSceneBounds,
  computeKmlOverviewBounds,
  computeSceneBounds,
} from "./sceneBounds.js";
import { resolveRiverDestinations } from "./areaGeocoding.js";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isMandoviSource(prepared, ring) {
  // Curated river-pack path (shared by Mandovi + Mithi). Keep symbol for downstream UI gates.
  const name = `${prepared?.riverName || ""} ${prepared?.filename || ""}`.toLowerCase();
  if (name.includes("mithi") || name.includes("mandovi") || name.includes("mandavi")) return true;
  // Legacy Mandovi heuristic (Goa latitude). Mumbai/Mithi is ~19°N and must not fall through.
  return Boolean(ring?.[0]?.lat && ring[0].lat < 17);
}

async function loadMandoviReferenceKmls() {
  const textByKey = await import("../data/mithi/index.js");
  for (const [key, text] of Object.entries(textByKey)) {
    if (typeof text !== "string" || !/<kml\b/i.test(text)) {
      throw new Error(`Bundled Mithi reference is not valid KML: ${key}`);
    }
  }

  // ONLY source: src/data/chainage_10m.kml (Vite raw import — no public/fallback chainage)
  const chainageText = textByKey.chainageKml;
  const chainageSource = "src/data/chainage_10m.kml";
  if (typeof chainageText !== "string" || !/<kml\b/i.test(chainageText)) {
    throw new Error("Missing src/data/chainage_10m.kml");
  }

  const parsedChainage = parseChainageAnalysisKml(chainageText);
  if (!parsedChainage.chainage.length) {
    throw new Error("src/data/chainage_10m.kml contains no named chainage points");
  }

  // Corridor follows the water-channel centreline from the same chainage KML when present.
  let mainCenterline =
    parsedChainage.centerline?.length >= 2
      ? parsedChainage.centerline.map((c) => ({ lon: c.lon, lat: c.lat }))
      : null;
  let mainStemKml = chainageText;

  if (!mainCenterline) {
    const mainFeatures = parseDrainageKml(textByKey.mainStreamKml);
    const mainFeature = mainFeatures
      .filter((feature) => feature.coordinates?.length >= 2)
      .sort((a, b) => b.coordinates.length - a.coordinates.length)[0];
    if (!mainFeature) throw new Error("Mithi main stream KML contains no usable line");
    mainCenterline = mainFeature.coordinates.slice();
    mainStemKml = textByKey.mainStreamKml;
  }

  const chainageStart = parsedChainage.chainage[0];
  const chainageEnd = parsedChainage.chainage[parsedChainage.chainage.length - 1];
  // Orient centreline so index 0 is near chainage 0+000
  if (
    coordinateDistanceSquared(mainCenterline.at(-1), chainageStart) <
    coordinateDistanceSquared(mainCenterline[0], chainageStart)
  ) {
    mainCenterline.reverse();
  }

  // Joining Streams = given Upstream 01–05. Prefer bundled raw (no HTTP cache),
  // then public drainage / history KML. Never keep legacy Vakola/Airport stubs.
  const toUpstreamFeatures = (text, idPrefix) =>
    parseDrainageKml(text)
      .filter((feature) => feature.coordinates?.length >= 2)
      .map((feature, index) => ({
        name: String(feature.name || `Upstream ${String(index + 1).padStart(2, "0")}`).trim(),
        waterway: "stream",
        osmId: feature.osmId || `${idPrefix}-${index + 1}`,
        vertices: feature.coordinates.map(({ lon, lat }) => ({ lon, lat })),
      }));

  let upstreams = toUpstreamFeatures(textByKey.upstreamsKml, "mithi-joining");
  let upstreamsSource = "src/eye/data/mithi/mithi_river_upstreams.kml";
  const hasGivenUpstreams = upstreams.some((u) => /upstream\s*0*\d+/i.test(u.name));
  if (!hasGivenUpstreams) {
    upstreams = [];
    const joiningKmlUrls = [
      "/data/mithi/drainage.kml",
      "/data/mithi/jalnetra-history/joining-stream1_21-10-2026__18-11-2026.kml",
    ];
    for (const url of joiningKmlUrls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const text = await res.text();
        if (!/<kml\b/i.test(text)) continue;
        const parsed = toUpstreamFeatures(text, "mithi-joining");
        if (parsed.some((u) => /upstream\s*0*\d+/i.test(u.name))) {
          upstreams = parsed;
          upstreamsSource = url;
          break;
        }
      } catch {
        /* try next */
      }
    }
  }
  if (!upstreams.length) throw new Error("Mithi upstream KML contains no usable joining streams");
  // Drop legacy demo stubs if mixed with given Upstream pack
  if (upstreams.some((u) => /upstream\s*0*\d+/i.test(u.name))) {
    upstreams = upstreams.filter((u) => /upstream\s*0*\d+/i.test(u.name));
  }

  console.info("[mithi-kml] chainage + centreline locked", {
    source: chainageSource,
    chainagePoints: parsedChainage.chainage.length,
    chainageIntervalM: parsedChainage.intervalM,
    first: chainageStart,
    last: chainageEnd,
    mainStreamPoints: mainCenterline.length,
    joiningStreamPaths: upstreams.length,
    joiningStreamSource: upstreamsSource,
    joiningStreamNames: upstreams.map((u) => u.name),
  });
  return {
    chainage: parsedChainage.chainage,
    chainageIntervalM: parsedChainage.intervalM || 10,
    mainCenterline,
    mainStemKml,
    upstreams,
    chainageSource,
  };
}

function coordinateDistanceSquared(a, b) {
  return (Number(a.lon) - Number(b.lon)) ** 2 + (Number(a.lat) - Number(b.lat)) ** 2;
}

export function riverNameFromKml(text, filename) {
  const names = [...String(text).matchAll(/<name>\s*([^<]+?)\s*<\/name>/gi)].map((m) => m[1].trim());
  const skip = /^(polygon|linestring|path|untitled|layer|document|folder|style|track)$/i;
  const named = names.find((n) => n && !skip.test(n) && n.length < 80);
  if (named) return named.replace(/\s+/g, " ");
  return String(filename || "River")
    .replace(/\.kml$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "River";
}

function longestLine(lines) {
  let best = null;
  let bestLen = 0;
  for (const line of lines || []) {
    if (line.length > bestLen) {
      best = line;
      bestLen = line.length;
    }
  }
  return best;
}

function lineStringsOnly(text) {
  const lines = [];
  const blocks = [...String(text).matchAll(/<(?:\w+:)?LineString[\s\S]*?<\/(?:\w+:)?LineString>/gi)];
  for (const block of blocks) {
    const coords = [...block[0].matchAll(/<(?:\w+:)?coordinates>([\s\S]*?)<\/(?:\w+:)?coordinates>/gi)];
    for (const c of coords) {
      const pts = c[1].trim().split(/\s+/).map((tok) => {
        const [lon, lat] = tok.split(",").map(Number);
        return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
      }).filter(Boolean);
      if (pts.length >= 2) lines.push(pts);
    }
  }
  return longestLine(lines);
}

function largestPolygon(polygons) {
  let best = null;
  let bestN = 0;
  for (const ring of polygons || []) {
    if (ring.length > bestN) {
      best = ring;
      bestN = ring.length;
    }
  }
  return best;
}

function bufferLine(line, halfM) {
  const lat0 = line[0].lat * Math.PI / 180;
  const mLon = 111320 * Math.cos(lat0);
  const mLat = 110540;
  const xy = line.map((p) => ({ x: p.lon * mLon, y: p.lat * mLat }));
  const left = [];
  const right = [];
  for (let i = 0; i < xy.length; i++) {
    const a = xy[Math.max(0, i - 1)];
    const b = xy[Math.min(xy.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy;
    const ny = dx;
    left.push({ lon: (xy[i].x + nx * halfM) / mLon, lat: (xy[i].y + ny * halfM) / mLat });
    right.push({ lon: (xy[i].x - nx * halfM) / mLon, lat: (xy[i].y - ny * halfM) / mLat });
  }
  return [...left, ...right.reverse(), { ...left[0] }];
}

function ringAreaKm2(ring) {
  if (!ring || ring.length < 4) return 50;
  const lat0 = ring[0].lat * Math.PI / 180;
  const mLon = 111320 * Math.cos(lat0);
  const mLat = 110540;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.lon * mLon * b.lat * mLat - b.lon * mLon * a.lat * mLat;
  }
  return Math.abs(sum) / 2 / 1e6;
}

function centroidOf(ring) {
  let lon = 0;
  let lat = 0;
  const n = Math.max(1, ring.length - 1);
  for (let i = 0; i < n; i++) {
    lon += ring[i].lon;
    lat += ring[i].lat;
  }
  return { lon: lon / n, lat: lat / n };
}

function thinPoints(pts, maxPts) {
  const clean = (pts || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (clean.length <= maxPts) return clean;
  const step = (clean.length - 1) / (maxPts - 1);
  const out = [];
  for (let i = 0; i < maxPts; i++) out.push(clean[Math.round(i * step)]);
  return out;
}

function coordText(pts) {
  return pts.map((p) => `${Number(p.lon).toFixed(6)},${Number(p.lat).toFixed(6)},0`).join(" ");
}

function farthestTips(ring) {
  let a = ring[0];
  let b = ring[Math.min(1, ring.length - 1)];
  let best = -1;
  const step = Math.max(1, Math.floor(ring.length / 60));
  for (let i = 0; i < ring.length; i += step) {
    for (let j = i + step; j < ring.length; j += step) {
      const d = (ring[i].lon - ring[j].lon) ** 2 + (ring[i].lat - ring[j].lat) ** 2;
      if (d > best) {
        best = d;
        a = ring[i];
        b = ring[j];
      }
    }
  }
  return [a, b];
}

/** One Polygon only. A line plus a polygon is a GeometryCollection, which JalNetra rejects. */
function apiKml(name, _line, ring) {
  const ringPts = thinPoints(ring, 600);
  const closed = ringPts[0].lon === ringPts[ringPts.length - 1].lon && ringPts[0].lat === ringPts[ringPts.length - 1].lat
    ? ringPts
    : [...ringPts, ringPts[0]];
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>
<Placemark><name>${esc(name)}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordText(closed)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`;
}

/** KML text the APIs receive: keep the real river polygon KML (never a bbox substitute). */
export function prepareRiverUpload(kmlText, filename) {
  const riverName = riverNameFromKml(kmlText, filename);
  const providedPlaces = parsePointPlacemarksKml(kmlText)
    .filter((place) => place.name && place.name.trim());
  const geom = parseKmlGeometry(kmlText);
  const line = lineStringsOnly(kmlText);
  let ring = largestPolygon(geom.polygons);
  if (!ring && line?.length >= 2) ring = bufferLine(line, 80);
  if (!ring || ring.length < 4) {
    throw new Error("The KML needs a river polygon or a line with at least two points.");
  }
  const closed = ring[0].lon === ring[ring.length - 1].lon && ring[0].lat === ring[ring.length - 1].lat
    ? ring
    : [...ring, { ...ring[0] }];
  const stem = line?.length >= 2 ? line : null;
  // Prefer the uploaded river outline as-is. Only synthesize a polygon when the
  // source was a bare centerline (no Polygon) — never replace with a box AOI.
  const hasSourcePolygon = /<(?:\w+:)?Polygon\b/i.test(String(kmlText || ""));
  const uploadKml = hasSourcePolygon
    ? String(kmlText)
    : apiKml(riverName, stem, closed);
  return {
    riverName,
    providedPlaces,
    filename: filename || "mithi_river.kml",
    kmlText: uploadKml,
    mainStemKml: `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>${coordText(thinPoints(stem?.length >= 2 ? stem : farthestTips(closed), 400))}</coordinates></LineString></Placemark></Document></kml>`,
    ring: closed,
    line: stem,
    centroid: centroidOf(closed),
    catchmentKm2: Math.min(8000, Math.max(30, ringAreaKm2(closed) * 12)),
  };
}

export async function buildDatasetFromKml(prepared, onProgress) {
  onProgress?.(0.2, "Building the river corridor…");
  const ring = prepared.ring;
  const isMandovi = isMandoviSource(prepared, ring);
  const mandoviSources = isMandovi ? await loadMandoviReferenceKmls() : null;
  const ringUtm = ring.map((c) => {
    const u = lonLatToUtm(c.lon, c.lat);
    return { ...c, easting: u.easting, northing: u.northing };
  });
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of ring) {
    minLon = Math.min(minLon, c.lon);
    maxLon = Math.max(maxLon, c.lon);
    minLat = Math.min(minLat, c.lat);
    maxLat = Math.max(maxLat, c.lat);
  }
  const origin = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
  initGeoReference(origin, ringUtm);
  const frame = getGeoReference().frame;
  const mandoviDrainage = mandoviSources?.upstreams.map((feature) => ({
    ...feature,
    vertices: feature.vertices.map(({ lon, lat }) => {
      const utm = lonLatToUtm(lon, lat);
      const local = frame.toLocal(utm.easting, utm.northing);
      return { lon, lat, x: local.x, z: local.z };
    }),
  })) || [];

  // Joining Streams geometry = Upstream pack only (already projected below).
  // Keep every MultiGeometry LineString (branches).
  const mergedDrainage = [];
  const seenKeys = new Set();
  for (const feat of mandoviDrainage) {
    if (!/upstream\s*0*\d+/i.test(String(feat.name || ""))) continue;
    const a = feat.vertices?.[0];
    const b = feat.vertices?.[feat.vertices.length - 1];
    const key = [
      String(feat.name || "").toLowerCase(),
      String(feat.waterway || "stream").toLowerCase(),
      a?.lon,
      a?.lat,
      b?.lon,
      b?.lat,
      feat.vertices?.length || 0,
    ].join("::");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    mergedDrainage.push(feat);
  }
  console.info("[joining-streams] drainage paths ready", {
    total: mergedDrainage.length,
    names: [...new Set(mergedDrainage.map((d) => d.name))],
    source: mandoviSources?.chainageSource,
  });
  if (!mergedDrainage.length) {
    console.warn("[joining-streams] Upstream 01–05 missing from drainage pack");
  }

  const ringLocal = ringUtm.map((c) => {
    const loc = frame.toLocal(c.easting, c.northing);
    return { ...c, x: loc.x, z: loc.z };
  });

  const sourceLine = mandoviSources?.mainCenterline || prepared.line;
  let centerlineLocal = null;
  if (sourceLine?.length >= 2) {
    centerlineLocal = sourceLine.map((c) => {
      const u = lonLatToUtm(c.lon, c.lat);
      const loc = frame.toLocal(u.easting, u.northing);
      return { lon: c.lon, lat: c.lat, easting: u.easting, northing: u.northing, x: loc.x, z: loc.z };
    });
  }

  onProgress?.(0.45, "Shaping the water surface…");
  const corridor = buildCorridorFromKml(ringLocal, [], {
    across: 36,
    nStations: 480,
    centerlineLocal,
    // Mithi permanent-water channel (water_depth KML) — not Goa survey depths.
    shallowChannel: isMandovi,
  });
  // Mithi visual twin: clamp fat AOI bank rays to a real channel scale (matches
  // reference olive-DTM scene — narrow continuous ribbon, no oversized triangles).
  if (isMandovi && corridor.stations?.length) {
    clampCorridorChannelWidth(corridor.stations, {
      minHalf: 10,
      maxHalf: 48,
      mouthMaxHalf: 70,
      mouthMeters: 900,
    });
    syncRibbonPositionsFromStations(corridor);
    const solidTris = rebuildSolidRibbonIndices(corridor);
    console.info("[mithi-kml] clamped solid corridor ribbon", {
      stations: corridor.stations.length,
      solidTris,
      medianHalf: medianHalfWidth(corridor.stations),
    });
  }

  const chainage = [];
  let meters = 0;
  const stations = corridor.stations || [];
  for (let i = 0; i < stations.length; i++) {
    if (i > 0) {
      meters += Math.hypot(stations[i].x - stations[i - 1].x, stations[i].z - stations[i - 1].z);
    }
    const ll = frame.toLonLat(stations[i].x, stations[i].z);
    const u = lonLatToUtm(ll.lon, ll.lat);
    const m = Math.round(meters);
    const width = Math.hypot(
      (stations[i].rightX ?? stations[i].x) - (stations[i].leftX ?? stations[i].x),
      (stations[i].rightZ ?? stations[i].z) - (stations[i].leftZ ?? stations[i].z),
    );
    chainage.push({
      lon: ll.lon,
      lat: ll.lat,
      easting: u.easting,
      northing: u.northing,
      x: stations[i].x,
      z: stations[i].z,
      meters: m,
      chainage_m: m,
      width_m: Math.max(8, width || 40),
      label: `${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, "0")}`,
      major: m % 500 < 20,
    });
  }

  let chainageIntervalM = chainage.length > 1
    ? Math.max(1, chainage[1].meters - chainage[0].meters)
    : 10;
  if (mandoviSources?.chainage.length) {
    // Hard replace — do not keep corridor-derived 15 km chainage.
    const exactChainage = mandoviSources.chainage.map((point) => {
      const utm = lonLatToUtm(point.lon, point.lat);
      const local = frame.toLocal(utm.easting, utm.northing);
      const near = nearestChainage(local.x, local.z, chainage);
      const m = Number(point.meters) || 0;
      return {
        lon: point.lon,
        lat: point.lat,
        x: local.x,
        z: local.z,
        easting: utm.easting,
        northing: utm.northing,
        meters: m,
        chainage_m: m,
        label: point.label || `${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, "0")}`,
        major: !!point.major || m % 1000 === 0,
        width_m: near?.width_m || 40,
        source: mandoviSources.chainageSource || "chainage_10m.kml",
      };
    });
    chainage.splice(0, chainage.length, ...exactChainage);
    chainageIntervalM = mandoviSources.chainageIntervalM || 10;
    for (const station of stations) {
      const exact = nearestChainage(station.x, station.z, chainage);
      if (!exact) continue;
      station.meters = exact.meters;
      station.chainage_m = exact.meters;
      station.label = exact.label;
    }
    console.info("[mithi-kml] dataset.chainage replaced", {
      count: chainage.length,
      first: chainage[0]?.label,
      last: chainage[chainage.length - 1]?.label,
      maxM: chainage[chainage.length - 1]?.meters,
      source: mandoviSources.chainageSource,
    });
  }

  const providedDestinations = (prepared.providedPlaces || []).map((place) => {
    const utm = lonLatToUtm(place.lon, place.lat);
    const local = frame.toLocal(utm.easting, utm.northing);
    const near = nearestChainage(local.x, local.z, chainage);
    return {
      id: `kml-place-${place.id}`,
      name: place.name,
      lon: place.lon,
      lat: place.lat,
      x: local.x,
      z: local.z,
      meters: near?.meters ?? 0,
      chainage_m: near?.meters ?? 0,
    };
  });

  const points = [];
  let minDepth = Infinity;
  let maxDepth = 0;
  for (const s of stations) {
    const bankDepth = 0.85 + 0.35 * Math.sin((s.t || 0) * Math.PI * 4);
    for (const u of [0.08, 0.25, 0.5, 0.75, 0.92]) {
      const x = s.leftX + (s.rightX - s.leftX) * u;
      const z = s.leftZ + (s.rightZ - s.leftZ) * u;
      const ll = frame.toLonLat(x, z);
      const utm = lonLatToUtm(ll.lon, ll.lat);
      const bankDist = Math.abs(u * 2 - 1);
      const bankFactor = 1.0 - Math.pow(bankDist, 1.7);
      const depth = Number((bankDepth + ((s.depth || 11.8) - bankDepth) * Math.max(0, bankFactor)).toFixed(2));
      minDepth = Math.min(minDepth, depth);
      maxDepth = Math.max(maxDepth, depth);
      points.push({
        id: points.length,
        lat: ll.lat,
        lon: ll.lon,
        depth,
        easting: utm.easting,
        northing: utm.northing,
        x,
        z,
      });
    }
  }
  if (isMandovi) {
    // Matches mithi_river_depth.kml product envelope (0.2–5.5 m).
    minDepth = Math.min(minDepth, 0.2);
    maxDepth = Math.min(Math.max(maxDepth, 2.5), 5.5);
  } else {
    minDepth = Math.min(minDepth, 0.8);
    maxDepth = Math.max(maxDepth, 16.5);
  }

  const bathymetry = {
    positions: corridor.positions,
    depths: corridor.depths,
    alongT: corridor.alongT,
    acrossU: corridor.acrossU,
    flow: corridor.flow,
    narrow: corridor.narrow,
    widthM: corridor.widthM,
    curve: corridor.curve,
    exact: corridor.exact,
    indices: corridor.indices,
    boundary: corridor.boundary,
    source: isMandovi
      ? "src/data/water_depth (1).kml — permanent water / MNDWI relative bathymetry"
      : "CSIR-NIO Mandovi Geophysical & Bathymetric Survey (August 2021)",
    verticalDatum: isMandovi
      ? "Relative / MNDWI-derived permanent water extent"
      : "Chart Datum (CD) / MSL (Mormugao Port Baseline)",
    count: corridor.depths?.length || 0,
    bounds: corridor.bounds,
    minDepth,
    maxDepth,
  };

  const osm = { ...emptyOsmContext(), loaded: false };
  let bridges = [];
  if (isMandovi) {
    const MANDOVI_BRIDGES_DEF = await loadMithiOsmBridgeDefs();
    bridges = MANDOVI_BRIDGES_DEF.map((def) => projectCuratedBridge(def, frame, corridor));
    console.info("[mithi] curated OSM bridges active:", bridges.length, bridges.map((b) => b.fullName));
  }

  const partial = { ringLocal, corridor, osm, bridges };
  const sceneBounds = computeSceneBounds(partial);
  const kmlOverviewBounds = computeKmlOverviewBounds(partial);
  const activeSceneBounds = computeActiveSceneBounds(partial);

  onProgress?.(0.7, "Resolving local geographical areas & landmarks...");

  const ds = {
    lite: false,
    points,
    minDepth: Number.isFinite(minDepth) ? minDepth : 0.4,
    maxDepth: maxDepth || 2.2,
    frame,
    ringLocal,
    ringGeo: ring,
    centerlineLocal,
    chainage,
    chainageIntervalM,
    corridor,
    bathymetry,
    bridges,
    osm,
    overlay: null,
    validation: { ok: true, issues: [] },
    sceneBounds,
    kmlOverviewBounds,
    activeSceneBounds,
    dtm: null,
    destinations: [],
    providedDestinations,
    fishingLocationsRaw: [],
    fishingZones: [],
    drainage: mergedDrainage,
    riverName: prepared.riverName || "River",
    mainStemKml: mandoviSources?.mainStemKml || prepared.mainStemKml || "",
    depthOverlay: isMandovi
      ? {
          url: "/data/mithi/mithi_river_depth_overlay.png",
          kmlUrl: "/data/mithi/mithi_river_depth.kml",
          legendUrl: "/data/mithi/mithi_river_water_depth.json",
          // LatLonBox from src/data/mithi_river_depth.kml
          north: 19.08782672,
          south: 19.04514933,
          east: 72.87929619,
          west: 72.83456075,
          minDepth: 0.2,
          maxDepth: 5.5,
          source: "src/data/mithi_river_depth.kml",
          provenance: "RELATIVE ESTIMATE · band-ratio depth 0.2–5.5 m",
          remapToHydroBlues: false,
          remapToLegendClasses: true,
          sourceIsGyor: true,
        }
      : null,
    isMandovi,
    isMulaMutha: !isMandovi,
    loadOsmLater: async () => {
      if (isMandovi) {
        try {
          const res = await fetch("/data/mithi/osm_mithi_corridor.json");
          if (res.ok) {
            const data = await res.json();
            
            // 1. Process verified OSM buildings & houses
            const buildings = [];
            const buildingIds = new Set();
            for (const b of data.buildings || []) {
              if (!b.coordinates || b.coordinates.length < 3) continue;
              const verts = [];
              let sumX = 0, sumZ = 0;
              for (const [lon, lat] of b.coordinates) {
                const u = lonLatToUtm(lon, lat);
                const loc = frame.toLocal(u.easting, u.northing);
                verts.push({ x: loc.x, z: loc.z, lon, lat });
                sumX += loc.x;
                sumZ += loc.z;
              }
              const midX = sumX / verts.length;
              const midZ = sumZ / verts.length;
              buildingIds.add(String(b.id));
              buildings.push({
                id: b.id,
                name: b.name || "",
                building: b.building || "yes",
                amenity: b.amenity,
                levels: b.levels ? Number(b.levels) : null,
                heightM: b.heightM ? Number(b.heightM) : null,
                vertices: verts,
                midX,
                midZ,
                source: "OPENSTREETMAP",
              });
            }

            // 2. Process verified OSM roads & streets
            const roads = [];
            const roadIds = new Set();
            for (const r of data.roads || []) {
              if (!r.coordinates || r.coordinates.length < 2) continue;
              const verts = [];
              let sumX = 0, sumZ = 0;
              let lengthM = 0;
              for (let i = 0; i < r.coordinates.length; i++) {
                const [lon, lat] = r.coordinates[i];
                const u = lonLatToUtm(lon, lat);
                const loc = frame.toLocal(u.easting, u.northing);
                verts.push({ x: loc.x, z: loc.z, lon, lat });
                sumX += loc.x;
                sumZ += loc.z;
                if (i > 0) {
                  lengthM += Math.hypot(loc.x - verts[i - 1].x, loc.z - verts[i - 1].z);
                }
              }
              const midX = sumX / verts.length;
              const midZ = sumZ / verts.length;
              const hw = r.highway || "residential";
              const widthM = hw === "trunk" ? 12 : hw === "primary" ? 10 : hw === "secondary" ? 8.5 : hw === "tertiary" ? 7 : 5.5;
              roadIds.add(String(r.id));
              roads.push({
                id: r.id,
                name: r.name || "",
                highway: hw,
                bridge: r.bridge,
                surface: r.surface,
                lanes: r.lanes,
                widthM,
                vertices: verts,
                lengthM,
                midX,
                midZ,
                source: "OPENSTREETMAP",
              });
            }

            // 3. Process verified OSM landuse & natural areas
            const green = [];
            const greenIds = new Set();
            for (const lu of data.landuse || []) {
              if (!lu.coordinates || lu.coordinates.length < 3) continue;
              const verts = [];
              let sumX = 0, sumZ = 0;
              for (const [lon, lat] of lu.coordinates) {
                const u = lonLatToUtm(lon, lat);
                const loc = frame.toLocal(u.easting, u.northing);
                verts.push({ x: loc.x, z: loc.z, lon, lat });
                sumX += loc.x;
                sumZ += loc.z;
              }
              greenIds.add(String(lu.id));
              green.push({
                id: lu.id,
                name: lu.name || "",
                landuse: lu.landuse,
                leisure: lu.leisure,
                natural: lu.natural,
                wetland: lu.wetland || null,
                vertices: verts,
                midX: sumX / verts.length,
                midZ: sumZ / verts.length,
                source: "OPENSTREETMAP",
              });
            }

            // 4. Process settlements and places
            const places = [];
            for (const p of data.places || []) {
              if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
              const u = lonLatToUtm(p.lon, p.lat);
              const loc = frame.toLocal(u.easting, u.northing);
              places.push({
                id: p.id,
                name: p.name,
                place: p.place,
                lon: p.lon,
                lat: p.lat,
                x: loc.x,
                z: loc.z,
              });
            }

            // 5. Bundled OSM trees (offline). Do NOT await live Overpass here —
            // that blocked vegetation for minutes and left the layer empty.
            const trees = await loadMandoviBundledTrees(frame);

            // 6. CSIA / Santa Cruz aeroway (runways, taxiways, aprons + hangars).
            const aeroway = [];
            let stands = [];
            let taxiRoutes = [];
            try {
              const aeroRes = await fetch("/data/mithi/osm_mithi_aeroway.json");
              if (aeroRes.ok) {
                const aeroData = await aeroRes.json();
                stands = Array.isArray(aeroData.stands) ? aeroData.stands : [];
                taxiRoutes = Array.isArray(aeroData.taxiRoutes) ? aeroData.taxiRoutes : [];
                for (const a of aeroData.aeroway || []) {
                  if (!a.coordinates || a.coordinates.length < 2) continue;
                  const verts = [];
                  let sumX = 0;
                  let sumZ = 0;
                  for (const [lon, lat] of a.coordinates) {
                    const u = lonLatToUtm(lon, lat);
                    const loc = frame.toLocal(u.easting, u.northing);
                    verts.push({ x: loc.x, z: loc.z, lon, lat });
                    sumX += loc.x;
                    sumZ += loc.z;
                  }
                  aeroway.push({
                    id: a.id,
                    name: a.name || "",
                    ref: a.ref || a.name || "",
                    aeroway: a.aeroway || "taxiway",
                    surface: a.surface || "asphalt",
                    widthM: a.widthM != null ? Number(a.widthM) : null,
                    designations: a.designations || null,
                    vertices: verts,
                    midX: sumX / verts.length,
                    midZ: sumZ / verts.length,
                    source: a.source || aeroData.source || "AEROWAY",
                  });
                }
                for (const b of aeroData.buildings || []) {
                  if (!b.coordinates || b.coordinates.length < 3) continue;
                  const id = String(b.id);
                  if (buildingIds.has(id)) {
                    // Upgrade typology on the corridor footprint if already present.
                    const existing = buildings.find((x) => String(x.id) === id);
                    if (existing) {
                      existing.building = b.building || existing.building;
                      existing.aeroway = b.aeroway || existing.aeroway || null;
                      existing.name = b.name || existing.name;
                      if (b.heightM != null) existing.heightM = Number(b.heightM);
                      if (b.levels != null) existing.levels = Number(b.levels);
                    }
                    continue;
                  }
                  const verts = [];
                  let sumX = 0;
                  let sumZ = 0;
                  for (const [lon, lat] of b.coordinates) {
                    const u = lonLatToUtm(lon, lat);
                    const loc = frame.toLocal(u.easting, u.northing);
                    verts.push({ x: loc.x, z: loc.z, lon, lat });
                    sumX += loc.x;
                    sumZ += loc.z;
                  }
                  buildingIds.add(id);
                  buildings.push({
                    id: b.id,
                    name: b.name || "",
                    building: b.building || "hangar",
                    aeroway: b.aeroway || null,
                    amenity: b.amenity,
                    levels: b.levels != null ? Number(b.levels) : null,
                    heightM: b.heightM != null ? Number(b.heightM) : null,
                    vertices: verts,
                    midX: sumX / verts.length,
                    midZ: sumZ / verts.length,
                    source: aeroData.source || "AEROWAY",
                  });
                }
              }
            } catch (aeroErr) {
              console.warn("[mithi] aeroway pack skipped:", aeroErr?.message || aeroErr);
            }

            // Empty stub packs should not block live Overpass.
            if (!buildings.length && !roads.length && !green.length) {
              throw new Error("osm_mithi_corridor.json has no buildings/roads/landuse");
            }

            // Promote OSM places into destinations for labels / chainage HUD.
            if (places.length) {
              const mapped = places.map((p) => ({
                id: p.id,
                name: p.name,
                lon: p.lon,
                lat: p.lat,
                x: p.x,
                z: p.z,
                meters: nearestChainage(p.x, p.z, chainage)?.meters ?? 0,
                chainage_m: nearestChainage(p.x, p.z, chainage)?.meters ?? 0,
              }));
              ds.destinations = mapped;
              try {
                document.dispatchEvent(new CustomEvent("river-destinations-updated", { detail: mapped }));
              } catch {
                /* not in browser */
              }
            }

            console.info("[mithi] Loaded authentic OSM corridor data:", {
              buildings: buildings.length,
              roads: roads.length,
              green: green.length,
              trees: trees.length,
              places: places.length,
              aeroway: aeroway.length,
              stands: stands.length,
              bridges: (ds.bridges || []).length,
            });

            const osmResult = {
              loaded: true,
              bridges: ds.bridges || [],
              roads,
              buildings,
              green,
              vegetation: green,
              trees,
              places,
              aeroway,
              stands,
              taxiRoutes,
              source: "OpenStreetMap © contributors",
              alignment: { ok: true, medianDistM: 0 },
            };

            // Skip live Overpass when local Mithi packs are populated.
            return osmResult;
          }
        } catch (err) {
          console.warn("[mithi] Failed to load osm_mithi_corridor.json:", err);
        }

        // Fallback: live Overpass for the full Mithi KML corridor
        try {
          const live = await loadLiveOsm(
            frame,
            corridor,
            prepared.line?.length >= 2 ? prepared.line : ring,
            { maxDist: 2800, buildingMaxDist: 2600, treeCap: 12000, tileCount: 36 },
          );
          // Never replace curated Mithi/Mandovi survey bridges with live OSM stubs.
          const hasCurated =
            (ds.bridges || []).some((b) =>
              b.source === "MANDOVI_SURVEY" ||
              b.source === "MITHI_SURVEY" ||
              b.source === "MITHI_OSM",
            ) ||
            (ds.bridges || []).some((b) => {
              const id = String(b.id || "");
              return id.startsWith("900000") || id.startsWith("910000");
            });
          if (live?.bridges?.length && !hasCurated) {
            ds.bridges = live.bridges;
          }
          if (live?.places?.length && !(ds.destinations || []).length) {
            ds.destinations = live.places.map((p) => ({
              ...p,
              meters: nearestChainage(p.x, p.z, chainage)?.meters ?? 0,
              chainage_m: nearestChainage(p.x, p.z, chainage)?.meters ?? 0,
            }));
          }
          return { ...live, loaded: true, bridges: ds.bridges || live.bridges || [] };
        } catch (liveErr) {
          console.warn("[mithi] live OSM fallback failed:", liveErr?.message || liveErr);
        }

        return {
          loaded: true,
          bridges: ds.bridges || [],
          roads: [],
          buildings: [],
          trees: [],
          green: [],
        };
      }
      const liveOsm = await loadLiveOsm(frame, corridor, prepared.line?.length >= 2 ? prepared.line : ring);
      if (liveOsm?.bridges?.length && (!ds.bridges || ds.bridges.length === 0)) {
        ds.bridges = liveOsm.bridges;
      }
      return liveOsm;
    },
  };

  try {
    await resolveRiverDestinations(ds);
  } catch (err) {
    console.warn("[geocoding] could not resolve local areas:", err);
  }

  return ds;
}

function medianHalfWidth(stations = []) {
  const vals = stations
    .map((s) => Number(s?.halfWidth) || 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  return vals[Math.floor(vals.length / 2)];
}

async function loadMithiOsmBridgeDefs() {
  const res = await fetch("/data/mithi/mithi_osm_bridges.json");
  if (!res.ok) throw new Error(`Failed to load Mithi OSM bridge spans (${res.status})`);
  const data = await res.json();
  const defs = (data.bridges || [])
    .filter((b) => Array.isArray(b.coords) && b.coords.length >= 2)
    .filter((b) => {
      const status = String(b.status || "EXISTING").toUpperCase();
      // Default scene: only geographically verified completed infrastructure.
      return status === "EXISTING";
    })
    .map((b) => ({
      id: String(b.osmId || b.id),
      name: b.name || `Bridge ${b.osmId || b.id}`,
      bridgeType: b.bridgeType || "girder",
      highway: b.highway || "road",
      railway: b.railway || null,
      widthM: Number(b.widthM) || null,
      status: b.status || "EXISTING",
      verificationNote: b.verificationNote || null,
      // OSM centerline, water-clip, or documented digitized bank landings.
      coords: b.coords?.length >= 2 ? b.coords : b.sourceCoords,
      sourceCoords: b.sourceCoords || null,
      midpoint: b.midpoint || null,
      geometryMode: b.geometryMode || null,
      provenance: b.provenance || null,
      digitizationEvidence: b.digitizationEvidence || null,
    }));
  if (!defs.length) throw new Error("Mithi OSM bridge data contains no EXISTING channel crossings.");
  console.info(
    "[mithi] EXISTING bridges loaded:",
    defs.length,
    defs.map((d) => `${d.id}:${d.name}`),
  );
  return defs;
}

function projectCuratedBridge(def, frame, corridor) {
  const u0 = lonLatToUtm(def.coords[0][0], def.coords[0][1]);
  const u1 = lonLatToUtm(def.coords[def.coords.length - 1][0], def.coords[def.coords.length - 1][1]);
  const start = frame.toLocal(u0.easting, u0.northing);
  const end = frame.toLocal(u1.easting, u1.northing);
  const vertices = def.coords.map(([lon, lat]) => {
    const u = lonLatToUtm(lon, lat);
    return frame.toLocal(u.easting, u.northing);
  });

  let polylineLengthM = 0;
  for (let i = 1; i < vertices.length; i++) {
    polylineLengthM += Math.hypot(vertices[i].x - vertices[i - 1].x, vertices[i].z - vertices[i - 1].z);
  }
  const lengthM = polylineLengthM > 0 ? polylineLengthM : Math.hypot(end.x - start.x, end.z - start.z);

  // Prefer explicit user/OSM midpoint lat-lon so labels & decks sit on the crossing.
  let midX;
  let midZ;
  if (Number.isFinite(def.midpoint?.lon) && Number.isFinite(def.midpoint?.lat)) {
    const um = lonLatToUtm(def.midpoint.lon, def.midpoint.lat);
    const lm = frame.toLocal(um.easting, um.northing);
    midX = lm.x;
    midZ = lm.z;
  } else {
    midX = (start.x + end.x) * 0.5;
    midZ = (start.z + end.z) * 0.5;
    if (vertices.length > 2) {
      const halfD = lengthM * 0.5;
      let accum = 0;
      for (let i = 1; i < vertices.length; i++) {
        const segD = Math.hypot(vertices[i].x - vertices[i - 1].x, vertices[i].z - vertices[i - 1].z);
        if (accum + segD >= halfD) {
          const frac = (halfD - accum) / (segD || 1);
          midX = vertices[i - 1].x + frac * (vertices[i].x - vertices[i - 1].x);
          midZ = vertices[i - 1].z + frac * (vertices[i].z - vertices[i - 1].z);
          break;
        }
        accum += segD;
      }
    }
  }

  let bestSt = corridor.stations[0];
  let bestD = Infinity;
  for (const st of corridor.stations) {
    const d = Math.hypot(st.x - midX, st.z - midZ);
    if (d < bestD) {
      bestD = d;
      bestSt = st;
    }
  }
  const chMeters = bestSt?.meters || 0;
  const chLabel = `${Math.floor(chMeters / 1000)}+${String(Math.round(chMeters % 1000)).padStart(3, "0")}`;
  return {
    id: def.id,
    name: def.name,
    fullName: def.name,
    osmName: def.name,
    bridgeType: def.bridgeType,
    highway: def.highway,
    widthM: def.widthM,
    start,
    end,
    vertices,
    lengthM,
    midX,
    midZ,
    highway: def.highway || "road",
    railway: def.railway || null,
    status: def.status || "EXISTING",
    verificationNote: def.verificationNote || null,
    chainage_m: chMeters,
    chainageLabel: chLabel,
    source: "MITHI_OSM",
    provenance: def.provenance || "ORIGINAL_OSM_CENTERLINE",
    geometryMode: def.geometryMode || null,
    digitizationEvidence: def.digitizationEvidence || null,
  };
}

/** Optional offline trees bundle from scripts/fetch_mithi_osm_corridor.mjs */
async function loadMandoviBundledTrees(frame) {
  try {
    const res = await fetch("/data/mithi/osm_mithi_trees.json");
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const t of data.trees || []) {
      if (!Number.isFinite(t.lon) || !Number.isFinite(t.lat)) continue;
      const u = lonLatToUtm(t.lon, t.lat);
      const loc = frame.toLocal(u.easting, u.northing);
      const seed = Number(t.id) || out.length;
      const resolved = resolveTreeHeight(
        { height: t.heightM, tree_height: t.heightM, genus: t.genus, species: t.species },
        seed,
      );
      out.push({
        id: t.id,
        x: loc.x,
        z: loc.z,
        lon: t.lon,
        lat: t.lat,
        tree_height: resolved.height,
        height_source: resolved.height_source,
        genus: t.genus || null,
        species: t.species || null,
        leaf_type: t.leaf_type || null,
        natural: t.natural || "tree",
        wetland: t.wetland || null,
        landuse: t.landuse || null,
        from_tree_row: !!t.from_tree_row,
        from_mangrove_polygon: !!t.from_mangrove_polygon,
        source: t.source || "OPENSTREETMAP",
      });
    }
    // Merge extra green polygons from the trees bundle into caller via side channel? No —
    // only trees here; landuse merge happens in loadOsmLater if we extend later.
    console.info("[mandovi] bundled OSM trees:", out.length);
    return out;
  } catch {
    return [];
  }
}
