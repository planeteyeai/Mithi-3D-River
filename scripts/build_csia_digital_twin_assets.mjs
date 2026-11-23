/**
 * Build geo-accurate CSIA digital-twin assets:
 * 1) OSM footprints (terminals / hangars / aeroway) via OpenStreetMap API
 * 2) Esri World Imagery orthophoto sheet for Mithi+CSIA AOI
 *
 * Writes:
 *   public/data/mithi/osm_mithi_aeroway.json
 *   public/data/mithi/satellite_imagery.jpg
 *   public/data/mithi/satellite_imagery_bounds.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../public/data/mithi");
const AERO_OUT = path.join(OUT_DIR, "osm_mithi_aeroway.json");
const SAT_OUT = path.join(OUT_DIR, "satellite_imagery.jpg");
const SAT_BOUNDS_OUT = path.join(OUT_DIR, "satellite_imagery_bounds.json");

/** Full Mithi corridor + CSIA (T1 Santacruz + T2 Sahar + both runways). */
const BOUNDS = {
  west: 72.83,
  south: 19.04,
  east: 72.885,
  north: 19.105,
};

/** Known CSIA OSM way IDs (OpenStreetMap © contributors). */
const OSM_WAYS = {
  // Runways
  runway_09_27: 22826690,
  runway_14_32: 22826691,
  // Terminals
  terminal_1: 61569813,
  terminal_2: 315613914,
  // GA / hangar-ish from corridor pack
  hangar_ga: 436370645,
  ga_terminal: 706495637,
};

const EXTRA_AEROWAY_QUERY_WAYS = [
  // Common CSIA taxiway / apron ways (best-effort; skip if missing)
  22826692, 22826693, 22826694, 22826695, 22826696,
  22826697, 22826698, 22826699, 22826700, 22826701,
];

function densify(coords, stepDeg = 0.00035) {
  if (!coords?.length) return [];
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    const dlon = lon1 - lon0;
    const dlat = lat1 - lat0;
    const len = Math.hypot(dlon, dlat);
    const n = Math.max(1, Math.ceil(len / stepDeg));
    for (let k = 1; k <= n; k++) out.push([lon0 + dlon * (k / n), lat0 + dlat * (k / n)]);
  }
  return out;
}

async function fetchOsmWay(id) {
  const url = `https://api.openstreetmap.org/api/0.6/way/${id}/full.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`OSM way ${id} → ${res.status}`);
  const data = await res.json();
  const way = (data.elements || []).find((e) => e.type === "way" && e.id === id);
  if (!way) throw new Error(`OSM way ${id} missing`);
  const nodes = new Map();
  for (const e of data.elements || []) {
    if (e.type === "node") nodes.set(e.id, [e.lon, e.lat]);
  }
  const coordinates = (way.nodes || [])
    .map((nid) => nodes.get(nid))
    .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  return { id: String(id), tags: way.tags || {}, coordinates };
}

function aerowayWidth(kind, tags = {}) {
  const w = Number(String(tags.width || "").replace(/m$/i, ""));
  if (Number.isFinite(w) && w > 0) return w;
  if (kind === "runway") return 60;
  if (kind === "taxiway") return 18;
  if (kind === "apron") return 40;
  return 16;
}

function classifyBuilding(tags = {}) {
  const aero = String(tags.aeroway || "").toLowerCase();
  const b = String(tags.building || "").toLowerCase();
  const name = String(tags.name || "");
  if (aero === "hangar" || b === "hangar" || /hangar/i.test(name)) {
    return { building: "hangar", aeroway: "hangar", heightM: 12 };
  }
  if (aero === "terminal" || b === "terminal" || /terminal/i.test(name)) {
    return { building: "terminal", aeroway: "terminal", heightM: /2|sahar/i.test(name) ? 28 : 16 };
  }
  if (/transportation|airport/i.test(b) || /aviation|airport/i.test(name)) {
    return { building: "terminal", aeroway: "terminal", heightM: 12 };
  }
  return { building: b || "yes", aeroway: aero || null, heightM: tags.height ? Number(tags.height) : null };
}

async function buildAerowayFromOsm() {
  const aeroway = [];
  const buildings = [];
  const seen = new Set();

  const allIds = [
    ...Object.values(OSM_WAYS),
    ...EXTRA_AEROWAY_QUERY_WAYS,
  ];

  for (const id of allIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const way = await fetchOsmWay(id);
      const tags = way.tags;
      const kind = String(tags.aeroway || "").toLowerCase();
      const coords = way.coordinates;
      if (coords.length < 2) continue;

      if (kind === "runway" || kind === "taxiway" || kind === "apron") {
        aeroway.push({
          id: way.id,
          name: tags.name || tags.ref || kind,
          aeroway: kind,
          surface: tags.surface || "asphalt",
          widthM: aerowayWidth(kind, tags),
          coordinates: kind === "runway" || kind === "taxiway" ? densify(coords, 0.0004) : coords,
          source: "OPENSTREETMAP",
        });
        console.info("[osm] aeroway", kind, way.id, tags.name || tags.ref || "");
        continue;
      }

      const cls = classifyBuilding(tags);
      if (
        cls.building === "hangar" ||
        cls.building === "terminal" ||
        kind === "hangar" ||
        kind === "terminal" ||
        /61569813|315613914|436370645|706495637/.test(String(id))
      ) {
        if (coords.length >= 3) {
          buildings.push({
            id: way.id,
            name: tags.name || "",
            building: cls.building,
            aeroway: cls.aeroway,
            amenity: tags.amenity || null,
            levels: tags["building:levels"] ? Number(tags["building:levels"]) : null,
            heightM: cls.heightM,
            coordinates: coords,
            source: "OPENSTREETMAP",
          });
          console.info("[osm] building", cls.building, way.id, tags.name || "");
        }
      }
    } catch (err) {
      console.warn("[osm] skip", id, err.message);
    }
  }

  // Guaranteed published runway centerlines if OSM ways failed
  if (!aeroway.some((a) => a.aeroway === "runway" && /09|27/i.test(a.name))) {
    aeroway.unshift({
      id: "csia-rwy-09-27",
      name: "09/27",
      aeroway: "runway",
      surface: "asphalt",
      widthM: 60,
      coordinates: densify(
        [
          [72.848, 19.0884],
          [72.8811, 19.0889],
        ],
        0.00035,
      ),
      source: "AIP_PUBLISHED",
    });
  }
  if (!aeroway.some((a) => a.aeroway === "runway" && /14|32/i.test(a.name))) {
    aeroway.push({
      id: "csia-rwy-14-32",
      name: "14/32",
      aeroway: "runway",
      surface: "asphalt",
      widthM: 45,
      coordinates: densify(
        [
          [72.8573, 19.0985],
          [72.8772, 19.0801],
        ],
        0.00035,
      ),
      source: "AIP_PUBLISHED",
    });
  }

  // GA apron near Santacruz (south fringe visible from Mithi)
  if (!aeroway.some((a) => a.aeroway === "apron")) {
    aeroway.push({
      id: "csia-apron-ga",
      name: "General Aviation Apron",
      aeroway: "apron",
      surface: "concrete",
      widthM: 80,
      coordinates: [
        [72.8594, 19.08405],
        [72.86635, 19.08425],
        [72.86645, 19.08605],
        [72.85955, 19.08585],
        [72.8594, 19.08405],
      ],
      source: "CURATED_FROM_GE_REF",
    });
  }

  // Taxi links if none from OSM
  if (!aeroway.some((a) => a.aeroway === "taxiway")) {
    aeroway.push(
      {
        id: "csia-twy-south",
        name: "South parallel taxiway",
        aeroway: "taxiway",
        surface: "asphalt",
        widthM: 23,
        coordinates: densify(
          [
            [72.8492, 19.08685],
            [72.881, 19.08735],
          ],
          0.0004,
        ),
        source: "AIP_ALIGNED",
      },
      {
        id: "csia-twy-ga-link",
        name: "GA apron link",
        aeroway: "taxiway",
        surface: "asphalt",
        widthM: 16,
        coordinates: densify(
          [
            [72.8642, 19.08885],
            [72.8645, 19.0852],
          ],
          0.00025,
        ),
        source: "AIP_ALIGNED",
      },
    );
  }

  // Ensure Terminal footprints exist even if OSM fetch failed (approximate rings from published centers)
  if (!buildings.some((b) => /terminal 1|61569813/i.test(`${b.name}${b.id}`))) {
    buildings.push({
      id: "csia-t1",
      name: "Terminal 1",
      building: "terminal",
      aeroway: "terminal",
      levels: 3,
      heightM: 16,
      // Santacruz T1 — approximate rectangle around known gate area
      coordinates: [
        [72.8542, 19.0912],
        [72.8588, 19.0914],
        [72.8589, 19.0896],
        [72.8543, 19.0894],
        [72.8542, 19.0912],
      ],
      source: "CURATED_T1_APPROX",
    });
  }
  if (!buildings.some((b) => /terminal 2|315613914|sahar/i.test(`${b.name}${b.id}`))) {
    buildings.push({
      id: "csia-t2",
      name: "Terminal 2",
      building: "terminal",
      aeroway: "terminal",
      levels: 4,
      heightM: 28,
      coordinates: [
        [72.8695, 19.0982],
        [72.8772, 19.0985],
        [72.8775, 19.0954],
        [72.8698, 19.0951],
        [72.8695, 19.0982],
      ],
      source: "CURATED_T2_APPROX",
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: "OPENSTREETMAP+AIP",
    note: "CSIA digital twin aeroway — WGS84 lon/lat, no independent rotation",
    bounds: {
      west: 72.833,
      south: 19.078,
      east: 72.885,
      north: 19.105,
    },
    aeroway,
    buildings,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(AERO_OUT, JSON.stringify(payload));
  console.info("[aeroway] wrote", AERO_OUT, {
    aeroway: aeroway.length,
    buildings: buildings.length,
  });
  return payload;
}

async function downloadSatellite() {
  const { west, south, east, north } = BOUNDS;
  // Esri World Imagery export — geographically aligned orthophoto sheet
  const size = 4096;
  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${west},${south},${east},${north}` +
    `&bboxSR=4326&imageSR=4326&size=${size},${size}&format=jpg&f=image`;

  console.info("[sat] downloading Esri World Imagery…");
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Esri export → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) throw new Error("Esri export too small / empty");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SAT_OUT, buf);
  const boundsMeta = {
    ...BOUNDS,
    source: "Esri World Imagery",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    size,
    path: "satellite_imagery.jpg",
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(SAT_BOUNDS_OUT, JSON.stringify(boundsMeta, null, 2));
  console.info("[sat] wrote", SAT_OUT, `${(buf.length / 1024 / 1024).toFixed(2)} MB`, BOUNDS);
  return boundsMeta;
}

async function main() {
  const aero = await buildAerowayFromOsm();
  let sat = null;
  try {
    sat = await downloadSatellite();
  } catch (err) {
    console.warn("[sat] download failed:", err.message);
  }
  console.info("[done]", {
    aeroway: aero.aeroway.length,
    buildings: aero.buildings.length,
    satellite: !!sat,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
