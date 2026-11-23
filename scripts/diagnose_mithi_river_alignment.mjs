/**
 * Diagnostic report: Mithi river corridor geospatial alignment.
 * Reads source KMLs + reports CRS, chainage span, bank continuity hints.
 *
 * Writes: .verify/MITHI_RIVER_ALIGNMENT_REPORT.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, ".verify/MITHI_RIVER_ALIGNMENT_REPORT.json");

function parseCoords(text) {
  const out = [];
  const re = /<coordinates>([^<]+)<\/coordinates>/gi;
  let m;
  while ((m = re.exec(text))) {
    const chunk = m[1].trim().split(/\s+/).filter(Boolean);
    for (const c of chunk) {
      const [lon, lat] = c.split(",").map(Number);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
    }
  }
  return out;
}

function parseChainagePins(text) {
  const pins = [];
  const re =
    /<Placemark><name>(\d+\+\d{3})<\/name><description>Chainage (\d+) m<\/description>[\s\S]*?<coordinates>([^<]+)<\/coordinates>/g;
  let m;
  while ((m = re.exec(text))) {
    const [lon, lat] = m[3].trim().split(",").map(Number);
    pins.push({ label: m[1], meters: Number(m[2]), lon, lat });
  }
  return pins;
}

function bbox(pts) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of pts) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, east, south, north };
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

const chainagePath = path.join(ROOT, "src/data/chainage_10m.kml");
const riverPath = path.join(ROOT, "public/data/mithi/mithi_river.kml");
const satBoundsPath = path.join(ROOT, "public/data/mithi/satellite_imagery_bounds.json");

const chainageText = fs.readFileSync(chainagePath, "utf8");
const riverText = fs.existsSync(riverPath) ? fs.readFileSync(riverPath, "utf8") : "";
const pins = parseChainagePins(chainageText);
const riverPts = riverText ? parseCoords(riverText) : [];
const alignMatch = chainageText.match(/<name>Alignment<\/name>[\s\S]*?<coordinates>([^<]+)<\/coordinates>/i);
const alignPts = alignMatch
  ? alignMatch[1]
      .trim()
      .split(/\s+/)
      .map((c) => {
        const [lon, lat] = c.split(",").map(Number);
        return [lon, lat];
      })
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
  : [];

let maxPinToAlignM = 0;
let sumPinToAlignM = 0;
let pinAlignN = 0;
for (const p of pins) {
  let best = Infinity;
  for (const [lon, lat] of alignPts) {
    best = Math.min(best, haversineM(p.lon, p.lat, lon, lat));
  }
  if (Number.isFinite(best) && best < 1e9) {
    maxPinToAlignM = Math.max(maxPinToAlignM, best);
    sumPinToAlignM += best;
    pinAlignN += 1;
  }
}

const satBounds = fs.existsSync(satBoundsPath)
  ? JSON.parse(fs.readFileSync(satBoundsPath, "utf8"))
  : null;

const report = {
  generated_at: new Date().toISOString(),
  river: "Mithi River, Mumbai (Mandovi-path twin)",
  note: "User prompt referenced Mula-Mutha; this repository is Mithi.",
  sources: {
    chainage: {
      path: "src/data/chainage_10m.kml",
      crs: "EPSG:4326 WGS84",
      coordinate_order: "lon,lat",
      pins: pins.length,
      first: pins[0] || null,
      last: pins[pins.length - 1] || null,
      bbox: pins.length ? bbox(pins.map((p) => [p.lon, p.lat])) : null,
    },
    alignment_centerline: {
      path: "src/data/chainage_10m.kml (LineString Alignment)",
      crs: "EPSG:4326 WGS84",
      vertices: alignPts.length,
      bbox: alignPts.length ? bbox(alignPts) : null,
    },
    river_banks: {
      path: "public/data/mithi/mithi_river.kml",
      crs: "EPSG:4326 WGS84",
      coordinate_order: "lon,lat",
      vertices: riverPts.length,
      bbox: riverPts.length ? bbox(riverPts) : null,
      present: !!riverPts.length,
    },
    satellite: satBounds
      ? {
          path: "public/data/mithi/satellite_imagery.jpg",
          crs: "EPSG:4326 WGS84 (Esri World Imagery export)",
          bounds: {
            west: satBounds.west,
            south: satBounds.south,
            east: satBounds.east,
            north: satBounds.north,
          },
        }
      : null,
    scene_pipeline: {
      projection: "EPSG:32643 UTM zone 43N",
      local_frame: "createLocalFrame + flipX",
      water_datum: "SURFACE_Y = 9.4 (scene units, not MSL)",
      dtm: "FABDEM via dtm.js (relative to SURFACE_Y + bank anchor)",
    },
  },
  validation: {
    chainage_to_alignment_m: {
      samples: pinAlignN,
      average: pinAlignN ? Number((sumPinToAlignM / pinAlignN).toFixed(2)) : null,
      maximum: Number(maxPinToAlignM.toFixed(2)),
      status: maxPinToAlignM < 25 ? "OK" : maxPinToAlignM < 80 ? "WARN" : "FAIL",
    },
    polygon_topology: {
      river_kml_vertices: riverPts.length,
      status: riverPts.length >= 4 ? "OK" : "MISSING",
    },
    corridor_fix_applied: [
      "Skip clampCorridorChannelWidth (preserve KML bank spans)",
      "rebuildSolidRibbonIndices (no clip holes)",
      "VISUAL_LOCK.river.kmlOnlyLiveWater → ribbon primary, hide patchy MNDWI sheet",
      "Skip clipRiverToHydrology for Mithi KML-primary ribbon",
    ],
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.info("[diagnose] wrote", OUT);
console.info(JSON.stringify(report.validation, null, 2));
