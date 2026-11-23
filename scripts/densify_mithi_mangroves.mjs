/**
 * Densify Mithi mangrove / wetland / wood canopy from OSM landuse polygons.
 * Samples tree points only inside mapped polygons (never random scatter).
 * Culls points that fall in the Mithi water AOI.
 *
 * Writes: public/data/mithi/osm_mithi_trees.json (merged with existing OSM trees)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "../public/data/mithi");
const CORRIDOR = path.join(DATA, "osm_mithi_corridor.json");
const TREES = path.join(DATA, "osm_mithi_trees.json");
const AOI = path.join(DATA, "mithi_river.kml");

const M_PER_DEG_LAT = 110540;

function mLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

function pointInRing(lon, lat, ring) {
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

function parseAoi(kmlPath) {
  const kml = fs.readFileSync(kmlPath, "utf8");
  const m = kml.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i);
  if (!m) return [];
  return m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lon, lat] = tok.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    })
    .filter(Boolean);
}

function polygonAreaM2(coords) {
  if (coords.length < 3) return 0;
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const sx = mLon(lat0);
  let a = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const xi = (coords[i][0] - coords[0][0]) * sx;
    const yi = (coords[i][1] - coords[0][1]) * M_PER_DEG_LAT;
    const xj = (coords[j][0] - coords[0][0]) * sx;
    const yj = (coords[j][1] - coords[0][1]) * M_PER_DEG_LAT;
    a += xj * yi - xi * yj;
  }
  return Math.abs(a) * 0.5;
}

function bbox(coords) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLon, minLat, maxLon, maxLat };
}

function mulberry(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function isMangrovePoly(lu) {
  const natural = String(lu.natural || "");
  const landuse = String(lu.landuse || "");
  const wetland = String(lu.wetland || "");
  const name = String(lu.name || "");
  if (wetland === "mangrove" || /mangrove/i.test(name)) return true;
  if (natural === "wetland" || natural === "wood") return true;
  if (landuse === "forest" || landuse === "orchard") return true;
  return false;
}

function spacingFor(lu) {
  if (String(lu.wetland || "") === "mangrove" || /mangrove/i.test(lu.name || "")) return 4.2;
  if (lu.natural === "wetland") return 5.0;
  if (lu.natural === "wood" || lu.landuse === "forest") return 5.5;
  return 7.0;
}

function samplePolygon(coords, spacingM, aoi, rng, maxPts) {
  const area = polygonAreaM2(coords);
  if (area < 40) return [];
  const target = Math.min(maxPts, Math.max(6, Math.floor(area / (spacingM * spacingM))));
  const box = bbox(coords);
  const out = [];
  let attempts = 0;
  const maxAttempts = target * 40;
  while (out.length < target && attempts < maxAttempts) {
    attempts++;
    const lon = box.minLon + rng() * (box.maxLon - box.minLon);
    const lat = box.minLat + rng() * (box.maxLat - box.minLat);
    if (!pointInRing(lon, lat, coords)) continue;
    if (aoi.length && pointInRing(lon, lat, aoi)) continue;
    out.push({ lon, lat });
  }
  return out;
}

function main() {
  const corridor = JSON.parse(fs.readFileSync(CORRIDOR, "utf8"));
  const existing = fs.existsSync(TREES) ? JSON.parse(fs.readFileSync(TREES, "utf8")) : { trees: [] };
  const aoi = parseAoi(AOI);
  const rng = mulberry(0x4d1_711);

  const mapped = (existing.trees || []).filter((t) => Number.isFinite(t.lon) && Number.isFinite(t.lat));
  const densified = [];

  const polys = (corridor.landuse || []).filter(isMangrovePoly);
  let polyIdx = 0;
  for (const lu of polys) {
    const coords = lu.coordinates || [];
    if (coords.length < 3) continue;
    const spacing = spacingFor(lu);
    const mangrove = String(lu.wetland || "") === "mangrove" || /mangrove/i.test(lu.name || "") || lu.natural === "wetland";
    const samples = samplePolygon(coords, spacing, aoi, rng, mangrove ? 900 : 550);
    for (const s of samples) {
      densified.push({
        id: `mangrove_${lu.id}_${densified.length}`,
        lon: s.lon,
        lat: s.lat,
        natural: mangrove ? "wetland" : lu.natural || "wood",
        wetland: lu.wetland || (mangrove ? "mangrove" : null),
        landuse: lu.landuse || null,
        genus: mangrove ? "Avicennia" : null,
        species: mangrove ? "Avicennia marina" : null,
        leaf_type: "broadleaved",
        heightM: mangrove ? 5 + rng() * 4 : 7 + rng() * 5,
        from_mangrove_polygon: true,
        polygonId: String(lu.id),
        source: "OPENSTREETMAP_LANDCOVER_SAMPLE",
      });
    }
    polyIdx++;
  }

  // Keep original mapped nodes first; append densified canopy samples.
  const seen = new Set(mapped.map((t) => `${t.lon.toFixed(6)},${t.lat.toFixed(6)}`));
  const merged = [...mapped];
  for (const t of densified) {
    const key = `${t.lon.toFixed(6)},${t.lat.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }

  const payload = {
    metadata: {
      source: "OpenStreetMap + landcover densification inside mapped polygons",
      attribution: "© OpenStreetMap contributors",
      river: "Mithi River, Mumbai, India",
      bounds: corridor.metadata?.bounds || null,
      fetchedAt: new Date().toISOString(),
      counts: {
        mappedTrees: mapped.length,
        densifiedFromPolygons: densified.length,
        trees: merged.length,
        mangrovePolygons: polys.length,
      },
    },
    trees: merged,
    buildings: [],
    landuse: polys.map((p) => ({
      id: p.id,
      name: p.name || "",
      natural: p.natural,
      landuse: p.landuse,
      wetland: p.wetland || null,
      coordinates: p.coordinates,
    })),
  };

  fs.writeFileSync(TREES, JSON.stringify(payload));
  console.info("[mithi-mangroves]", payload.metadata.counts);
}

main();
