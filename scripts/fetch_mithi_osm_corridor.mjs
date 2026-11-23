/**
 * Fetch authentic OSM corridor data for Mithi River (Mumbai).
 * Writes:
 *  - public/data/mithi/osm_mithi_corridor.json
 *  - public/data/mithi/osm_mithi_trees.json
 *  - public/data/mithi/bridges.geojson
 *  - public/data/mithi/mithi_osm_bridges.json  (for curated 3D bridge wiring)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../public/data/mithi");

const BOUNDS = {
  west: 72.83306075355661,
  south: 19.0436493272577,
  east: 72.8807961946018,
  north: 19.0893267244805,
};

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

function wayCoords(el) {
  const geom = el.geometry || [];
  return geom
    .map((g) => [Number(g.lon), Number(g.lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function sampleTreeRow(el, spacingM = 8) {
  const geom = el.geometry || [];
  if (geom.length < 2) return [];
  const tags = el.tags || {};
  const out = [];
  let carry = 0;
  const mLon = 111320 * Math.cos((BOUNDS.south * Math.PI) / 180);
  for (let i = 1; i < geom.length; i++) {
    const a = geom[i - 1];
    const b = geom[i];
    const dx = (b.lon - a.lon) * mLon;
    const dy = (b.lat - a.lat) * 110540;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    let t = (spacingM - carry) / len;
    while (t <= 1) {
      out.push({
        id: `row_${el.id}_${out.length}`,
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
        natural: "tree",
        genus: tags.genus || null,
        species: tags.species || null,
        leaf_type: tags.leaf_type || null,
        heightM: tags.height ? Number(tags.height) : null,
        from_tree_row: true,
        source: "OPENSTREETMAP",
      });
      t += spacingM / len;
    }
    carry = (carry + len) % spacingM;
  }
  return out;
}

function classifyBridge(tags = {}) {
  const hw = tags.highway || "";
  if (tags.railway) return { bridgeType: "girder", highway: "railway", widthM: 8 };
  if (hw === "motorway" || hw === "trunk") return { bridgeType: "girder", highway: hw, widthM: 16 };
  if (hw === "primary") return { bridgeType: "girder", highway: hw, widthM: 12 };
  if (hw === "secondary") return { bridgeType: "girder", highway: hw, widthM: 10 };
  if (hw === "tertiary") return { bridgeType: "girder", highway: hw, widthM: 8 };
  if (hw === "footway" || hw === "path" || hw === "pedestrian" || hw === "cycleway") {
    return { bridgeType: "girder", highway: hw, widthM: 4 };
  }
  return { bridgeType: "girder", highway: hw || "road", widthM: 8 };
}

async function queryOnce(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchWithFallback(label, query) {
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      console.info(`[mithi-osm] ${label} try`, url);
      const data = await queryOnce(url, query);
      console.info(`[mithi-osm] ${label} ok elements=`, (data.elements || []).length);
      return data;
    } catch (err) {
      lastErr = err;
      console.warn(`[mithi-osm] ${label}`, err?.message || err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr || new Error(`${label} Overpass unavailable`);
}

function corridorQuery() {
  const b = `${BOUNDS.south},${BOUNDS.west},${BOUNDS.north},${BOUNDS.east}`;
  return `[out:json][timeout:180];
(
  way["building"](${b});
  way["highway"](${b});
  way["bridge"](${b});
  way["man_made"="bridge"](${b});
  way["landuse"~"^(forest|grass|meadow|orchard|vineyard|village_green|recreation_ground|allotments|cemetery|greenfield)$"](${b});
  way["natural"~"^(wood|scrub|wetland|grassland|tree_row)$"](${b});
  way["wetland"="mangrove"](${b});
  way["leisure"~"^(park|garden|nature_reserve)$"](${b});
  relation["wetland"="mangrove"](${b});
  relation["natural"="wetland"](${b});
  way["waterway"~"^(river|stream|canal|drain|ditch|tidal_channel)$"](${b});
  way["natural"="water"](${b});
  way["water"](${b});
  node["place"~"^(city|town|village|suburb|neighbourhood|hamlet|quarter|locality|square)$"]["name"](${b});
);
out body geom;`;
}

function treesQuery() {
  const b = `${BOUNDS.south},${BOUNDS.west},${BOUNDS.north},${BOUNDS.east}`;
  return `[out:json][timeout:90];
(
  node["natural"="tree"](${b});
  node["natural"="shrub"](${b});
  way["natural"="tree_row"](${b});
);
out body geom;`;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/m$/i, "").trim());
  return Number.isFinite(n) ? n : null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const [corridorData, treesData] = await Promise.all([
    fetchWithFallback("corridor", corridorQuery()),
    fetchWithFallback("trees", treesQuery()),
  ]);

  const buildings = [];
  const roads = [];
  const landuse = [];
  const water_features = [];
  const bridges = [];
  const places = [];
  const seenBridge = new Set();
  const seenRoad = new Set();

  for (const el of corridorData.elements || []) {
    const tags = el.tags || {};

    if (el.type === "node" && tags.place && tags.name && Number.isFinite(el.lon) && Number.isFinite(el.lat)) {
      places.push({
        id: String(el.id),
        name: tags.name.trim(),
        place: tags.place,
        lon: el.lon,
        lat: el.lat,
      });
      continue;
    }

    if (el.type !== "way") continue;
    const coords = wayCoords(el);
    if (coords.length < 2) continue;

    const isBridge = tags.bridge === "yes" || tags.man_made === "bridge" || tags.bridge === "viaduct";
    if (isBridge && coords.length >= 2) {
      const key = String(el.id);
      if (!seenBridge.has(key)) {
        seenBridge.add(key);
        const cls = classifyBridge(tags);
        bridges.push({
          id: String(el.id),
          name: tags.name || tags.ref || `Bridge ${el.id}`,
          highway: tags.highway || cls.highway || null,
          bridge: tags.bridge || "yes",
          railway: tags.railway || null,
          bridgeType: cls.bridgeType,
          widthM: cls.widthM,
          coordinates: coords,
        });
      }
    }

    if (tags.building && coords.length >= 3) {
      buildings.push({
        id: String(el.id),
        name: tags.name || "",
        building: tags.building,
        amenity: tags.amenity || null,
        levels: tags["building:levels"] || tags.levels || null,
        heightM: numOrNull(tags.height),
        coordinates: coords,
      });
      continue;
    }

    if (tags.highway && coords.length >= 2) {
      const key = String(el.id);
      if (!seenRoad.has(key)) {
        seenRoad.add(key);
        roads.push({
          id: String(el.id),
          name: tags.name || "",
          highway: tags.highway,
          bridge: tags.bridge || null,
          lanes: tags.lanes || null,
          surface: tags.surface || null,
          coordinates: coords,
        });
      }
    }

    if (
      tags.landuse ||
      tags.leisure === "park" ||
      tags.leisure === "garden" ||
      tags.leisure === "nature_reserve" ||
      /^(wood|scrub|wetland|grassland)$/.test(tags.natural || "")
    ) {
      if (coords.length >= 3) {
        landuse.push({
          id: String(el.id),
          name: tags.name || "",
          landuse: tags.landuse || null,
          leisure: tags.leisure || null,
          natural: tags.natural || null,
          wetland: tags.wetland || null,
          coordinates: coords,
        });
      }
    }

    if (tags.waterway || tags.natural === "water" || tags.water) {
      water_features.push({
        id: String(el.id),
        name: tags.name || "",
        waterway: tags.waterway || null,
        natural: tags.natural || null,
        water: tags.water || null,
        coordinates: coords,
      });
    }
  }

  // Prefer named / major bridges first for 3D curated set
  const rankedBridges = [...bridges].sort((a, b) => {
    const score = (x) => {
      let s = 0;
      if (x.name && !/^Bridge /.test(x.name)) s += 50;
      if (x.highway === "motorway" || x.highway === "trunk") s += 40;
      if (x.highway === "primary") s += 30;
      if (x.highway === "secondary") s += 20;
      if (x.highway === "tertiary") s += 10;
      if (x.railway) s += 15;
      s += Math.min(40, (x.coordinates?.length || 0));
      return s;
    };
    return score(b) - score(a);
  });

  const trees = [];
  for (const el of treesData.elements || []) {
    const tags = el.tags || {};
    if (el.type === "node" && (tags.natural === "tree" || tags.natural === "shrub")) {
      trees.push({
        id: el.id,
        lon: el.lon,
        lat: el.lat,
        natural: tags.natural,
        genus: tags.genus || null,
        species: tags.species || null,
        leaf_type: tags.leaf_type || null,
        heightM: numOrNull(tags.height),
        source: "OPENSTREETMAP",
      });
    } else if (el.type === "way" && tags.natural === "tree_row") {
      trees.push(...sampleTreeRow(el));
    }
  }

  const corridorPayload = {
    metadata: {
      source: "OpenStreetMap",
      attribution: "© OpenStreetMap contributors",
      river: "Mithi River, Mumbai, India",
      bounds: BOUNDS,
      fetchedAt: new Date().toISOString(),
      counts: {
        buildings: buildings.length,
        roads: roads.length,
        landuse: landuse.length,
        water_features: water_features.length,
        bridges: bridges.length,
        places: places.length,
      },
    },
    buildings,
    roads,
    landuse,
    water_features,
    bridges,
    places,
  };

  const treesPayload = {
    metadata: {
      source: "OpenStreetMap",
      attribution: "© OpenStreetMap contributors",
      river: "Mithi River, Mumbai, India",
      bounds: BOUNDS,
      fetchedAt: new Date().toISOString(),
      counts: { trees: trees.length },
    },
    trees,
    buildings: [],
    landuse: [],
  };

  const bridgesGeo = {
    type: "FeatureCollection",
    features: rankedBridges.map((b) => ({
      type: "Feature",
      properties: {
        osmId: b.id,
        name: b.name,
        bridge: b.bridge || "yes",
        highway: b.highway,
        railway: b.railway,
        bridgeType: b.bridgeType,
        widthM: b.widthM,
      },
      geometry: { type: "LineString", coordinates: b.coordinates },
    })),
  };

  const curated = rankedBridges.slice(0, 18).map((b, i) => ({
    id: String(900000001 + i),
    osmId: b.id,
    name: b.name,
    bridgeType: b.bridgeType,
    highway: b.highway || "road",
    widthM: b.widthM,
    lengthM: null,
    coords: b.coordinates,
  }));

  const corridorPath = path.join(OUT_DIR, "osm_mithi_corridor.json");
  const treesPath = path.join(OUT_DIR, "osm_mithi_trees.json");
  const bridgesPath = path.join(OUT_DIR, "bridges.geojson");
  const curatedPath = path.join(OUT_DIR, "mithi_osm_bridges.json");

  fs.writeFileSync(corridorPath, JSON.stringify(corridorPayload));
  fs.writeFileSync(treesPath, JSON.stringify(treesPayload));
  fs.writeFileSync(bridgesPath, JSON.stringify(bridgesGeo, null, 2));
  fs.writeFileSync(curatedPath, JSON.stringify({ bounds: BOUNDS, bridges: curated }, null, 2));

  console.info("[mithi-osm] wrote", {
    corridorPath,
    treesPath,
    bridgesPath,
    curatedPath,
    counts: corridorPayload.metadata.counts,
    trees: trees.length,
    curatedBridges: curated.map((b) => b.name),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
