/**
 * Ingest real CSIA aeroway + airport buildings from OSM map API (WGS84).
 * Also downloads a wider Esri orthophoto covering the full Mithi+CSIA terrain.
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

/** Wider than prior sheet so overview camera never shows olive procedural patches. */
const SAT_BOUNDS = {
  west: 72.825,
  south: 19.035,
  east: 72.895,
  north: 19.115,
};

/** OSM map API bbox covering both runways + T1 + T2 + GA fringe. */
const OSM_BBOXES = [
  [72.845, 19.082, 72.882, 19.100],
  [72.850, 19.090, 72.882, 19.105],
  [72.848, 19.078, 72.870, 19.090],
];

function densify(coords, stepDeg = 0.0004) {
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

function parseOsmXml(xml) {
  const nodes = new Map();
  const nodeRe = /<node\s+id="(\d+)"[^>]*\slon="([^"]+)"\s+lat="([^"]+)"/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    nodes.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  // also lat before lon order
  const nodeRe2 = /<node\s+id="(\d+)"[^>]*\slat="([^"]+)"\s+lon="([^"]+)"/g;
  while ((m = nodeRe2.exec(xml))) {
    nodes.set(m[1], [Number(m[3]), Number(m[2])]);
  }

  const ways = [];
  const wayBlocks = xml.split(/<way\s+/).slice(1);
  for (const block of wayBlocks) {
    const idM = block.match(/^id="(\d+)"/);
    if (!idM) continue;
    const id = idM[1];
    const end = block.indexOf("</way>");
    const body = end >= 0 ? block.slice(0, end) : block;
    const tags = {};
    const tagRe = /<tag\s+k="([^"]+)"\s+v="([^"]*)"\s*\/>/g;
    while ((m = tagRe.exec(body))) tags[m[1]] = m[2];
    const nds = [];
    const ndRe = /<nd\s+ref="(\d+)"\s*\/>/g;
    while ((m = ndRe.exec(body))) {
      const c = nodes.get(m[1]);
      if (c) nds.push(c);
    }
    if (nds.length >= 2) ways.push({ id, tags, coordinates: nds });
  }
  return ways;
}

function aerowayWidth(kind, tags = {}) {
  const w = Number(String(tags.width || "").replace(/m$/i, ""));
  if (Number.isFinite(w) && w > 0) return w;
  if (kind === "runway") return /14|32/.test(tags.ref || "") ? 45 : 60;
  if (kind === "taxiway") return 18;
  if (kind === "apron") return 40;
  return 16;
}

function classifyBuilding(tags = {}) {
  const aero = String(tags.aeroway || "").toLowerCase();
  const b = String(tags.building || "").toLowerCase();
  const name = String(tags.name || "");
  if (aero === "hangar" || b === "hangar" || /hangar/i.test(name)) {
    return { building: "hangar", aeroway: "hangar", heightM: Number(tags.height) || 12 };
  }
  if (aero === "terminal" || b === "terminal" || /terminal/i.test(name)) {
    const h = /2|sahar/i.test(name) ? 28 : 16;
    return { building: "terminal", aeroway: "terminal", heightM: Number(tags.height) || h };
  }
  if (/transportation|warehouse|industrial|garage/.test(b) || /cargo|aviation|airport|maintenance|mro/i.test(name)) {
    return {
      building: /cargo|hangar|maintenance|mro|warehouse|industrial/i.test(`${b}${name}`) ? "hangar" : "terminal",
      aeroway: aero || null,
      heightM: Number(tags.height) || 10,
    };
  }
  return null;
}

async function fetchBbox(bbox) {
  const [w, s, e, n] = bbox;
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${w},${s},${e},${n}`;
  console.info("[osm] fetch", url);
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`OSM map ${res.status}`);
  return res.text();
}

async function buildAeroway() {
  const byId = new Map();
  for (const bbox of OSM_BBOXES) {
    try {
      const xml = await fetchBbox(bbox);
      const ways = parseOsmXml(xml);
      console.info("[osm] ways in bbox", ways.length);
      for (const way of ways) byId.set(way.id, way);
      // polite pause between map calls
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.warn("[osm] bbox failed", bbox, err.message);
    }
  }

  const aeroway = [];
  const buildings = [];
  for (const way of byId.values()) {
    const tags = way.tags || {};
    const kind = String(tags.aeroway || "").toLowerCase();
    const coords = way.coordinates;
    if (kind === "runway" || kind === "taxiway" || kind === "apron") {
      aeroway.push({
        id: way.id,
        name: tags.name || tags.ref || kind,
        ref: tags.ref || "",
        aeroway: kind,
        surface: tags.surface || "asphalt",
        widthM: aerowayWidth(kind, tags),
        designations: kind === "runway" && tags.ref?.includes("/")
          ? { start: tags.ref.split("/")[0], end: tags.ref.split("/")[1] }
          : null,
        coordinates:
          kind === "runway" || kind === "taxiway" ? densify(coords, 0.00035) : coords,
        source: "OPENSTREETMAP",
      });
      continue;
    }
    const cls = classifyBuilding(tags);
    if (cls && coords.length >= 3) {
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
    }
  }

  // Keep published AIP runway ends only if OSM returned none
  if (!aeroway.some((a) => a.aeroway === "runway")) {
    throw new Error("No OSM runways found — refusing invented layout");
  }

  // Parking stands from aeroway=parking_position if present in ways as nodes — skip if empty
  const stands = [];
  const taxiRoutes = aeroway
    .filter((a) => a.aeroway === "taxiway")
    .slice(0, 4)
    .map((a) => ({ id: `taxi-${a.id}`, coordinates: a.coordinates }));

  // Gate stands: sample points along apron rings (real apron geometry)
  for (const apron of aeroway.filter((a) => a.aeroway === "apron")) {
    const ring = apron.coordinates;
    if (ring.length < 4) continue;
    // centroid
    let sx = 0;
    let sy = 0;
    for (const [lon, lat] of ring) {
      sx += lon;
      sy += lat;
    }
    const cx = sx / ring.length;
    const cy = sy / ring.length;
    const n = /terminal 2|t2|sahar/i.test(apron.name) ? 5 : /terminal 1|t1|santacruz/i.test(apron.name) ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      // interpolate along first edge-ish offset from centroid toward ring[i]
      const [lon, lat] = ring[Math.min(i + 1, ring.length - 2)];
      stands.push({
        id: `${apron.id}-S${i + 1}`,
        lon: cx + (lon - cx) * 0.55,
        lat: cy + (lat - cy) * 0.55,
        hdg: 90,
        type: n >= 5 ? "wide" : "narrow",
      });
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: "OPENSTREETMAP",
    note: "CSIA digital twin — real OSM ways only (WGS84)",
    bounds: {
      west: 72.833,
      south: 19.078,
      east: 72.885,
      north: 19.105,
    },
    aeroway,
    buildings,
    stands,
    taxiRoutes,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "osm_mithi_aeroway.json"), JSON.stringify(payload));
  console.info("[aeroway] wrote OSM pack", {
    aeroway: aeroway.length,
    runways: aeroway.filter((a) => a.aeroway === "runway").length,
    taxiways: aeroway.filter((a) => a.aeroway === "taxiway").length,
    aprons: aeroway.filter((a) => a.aeroway === "apron").length,
    buildings: buildings.length,
    stands: stands.length,
  });
  return payload;
}

async function downloadSatellite() {
  const { west, south, east, north } = SAT_BOUNDS;
  const size = 4096;
  // Two overlapping exports stitched? Esri single export for full AOI.
  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${west},${south},${east},${north}` +
    `&bboxSR=4326&imageSR=4326&size=${size},${size}&format=jpg&f=image`;
  console.info("[sat] downloading wider Esri sheet…");
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Esri ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 8000) throw new Error("Esri export empty");
  fs.writeFileSync(path.join(OUT_DIR, "satellite_imagery.jpg"), buf);
  const meta = {
    ...SAT_BOUNDS,
    source: "Esri World Imagery",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    size,
    path: "satellite_imagery.jpg",
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "satellite_imagery_bounds.json"), JSON.stringify(meta, null, 2));
  console.info("[sat] wrote", `${(buf.length / 1e6).toFixed(2)} MB`, SAT_BOUNDS);
  return meta;
}

async function main() {
  const aero = await buildAeroway();
  await downloadSatellite();
  console.info("[done]", {
    aeroway: aero.aeroway.length,
    buildings: aero.buildings.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
