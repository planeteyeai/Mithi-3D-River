/**
 * Merge cached OSM map dump + live pack, clean false terminals, ensure RWY 09/27,
 * download tiled Esri imagery and stitch into one orthophoto sheet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../public/data/mithi");
const AERO_OUT = path.join(OUT_DIR, "osm_mithi_aeroway.json");
const CACHE_XML =
  "C:/Users/Sahil.Rajankar/.cursor/projects/c-Users-Sahil-Rajankar-Desktop-Shweta-Mithi-river/agent-tools/e47fde07-e64e-4a2d-8a0e-7502276bd595.txt";

const SAT_BOUNDS = {
  west: 72.825,
  south: 19.035,
  east: 72.895,
  north: 19.115,
};

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

function parseOsmXml(xml) {
  const nodes = new Map();
  let m;
  const nodeRe = /<node\s+([^>]+)\/>/g;
  while ((m = nodeRe.exec(xml))) {
    const attrs = m[1];
    const id = attrs.match(/id="(\d+)"/)?.[1];
    const lon = Number(attrs.match(/lon="([^"]+)"/)?.[1]);
    const lat = Number(attrs.match(/lat="([^"]+)"/)?.[1]);
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(id, [lon, lat]);
  }
  const nodeBlock = /<node\s+([^>]+)>([\s\S]*?)<\/node>/g;
  while ((m = nodeBlock.exec(xml))) {
    const attrs = m[1];
    const id = attrs.match(/id="(\d+)"/)?.[1];
    const lon = Number(attrs.match(/lon="([^"]+)"/)?.[1]);
    const lat = Number(attrs.match(/lat="([^"]+)"/)?.[1]);
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(id, [lon, lat]);
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
  if (kind === "runway") return /14|32/.test(tags.ref || tags.name || "") ? 45 : 60;
  if (kind === "taxiway") return 18;
  if (kind === "apron") return 40;
  return 16;
}

function keepBuilding(tags = {}) {
  const name = String(tags.name || "");
  const b = String(tags.building || "").toLowerCase();
  const aero = String(tags.aeroway || "").toLowerCase();
  if (/flyover|bridge|colony|hilton|hotel|metro|railway|road/i.test(name)) return null;
  if (aero === "hangar" || b === "hangar") {
    return { building: "hangar", aeroway: "hangar", heightM: Number(tags.height) || 12 };
  }
  if (aero === "terminal" || b === "terminal" || /^terminal\s*[12]/i.test(name)) {
    const h = /2|sahar/i.test(name) ? 28 : 16;
    return { building: "terminal", aeroway: "terminal", heightM: Number(tags.height) || h };
  }
  if (/cargo|maintenance|hangar|mro/i.test(name) || b === "warehouse" || b === "industrial") {
    return { building: "hangar", aeroway: "hangar", heightM: Number(tags.height) || 11 };
  }
  // Named airport complex building (not flyover)
  if (/chhatrapati shivaji|csia|airport terminal/i.test(name) && !/flyover/i.test(name)) {
    return { building: "terminal", aeroway: "terminal", heightM: 22 };
  }
  return null;
}

function waysToPack(ways) {
  const aeroway = [];
  const buildings = [];
  for (const way of ways) {
    const tags = way.tags || {};
    const kind = String(tags.aeroway || "").toLowerCase();
    const coords = way.coordinates;
    if (kind === "runway" || kind === "taxiway" || kind === "apron") {
      const ref = tags.ref || "";
      aeroway.push({
        id: way.id,
        name: tags.name || ref || kind,
        ref,
        aeroway: kind,
        surface: tags.surface || "asphalt",
        widthM: aerowayWidth(kind, tags),
        designations:
          kind === "runway" && ref.includes("/")
            ? { start: ref.split("/")[0].trim(), end: ref.split("/")[1].trim() }
            : null,
        coordinates: kind === "apron" ? coords : densify(coords, 0.00035),
        source: "OPENSTREETMAP",
      });
      continue;
    }
    const cls = keepBuilding(tags);
    if (cls && coords.length >= 3) {
      buildings.push({
        id: way.id,
        name: tags.name || "",
        building: cls.building,
        aeroway: cls.aeroway,
        levels: tags["building:levels"] ? Number(tags["building:levels"]) : null,
        heightM: cls.heightM,
        coordinates: coords,
        source: "OPENSTREETMAP",
      });
    }
  }
  return { aeroway, buildings };
}

function mergePacks(...packs) {
  const aeroway = new Map();
  const buildings = new Map();
  for (const p of packs) {
    for (const a of p.aeroway || []) aeroway.set(String(a.id), a);
    for (const b of p.buildings || []) buildings.set(String(b.id), b);
  }
  return {
    aeroway: [...aeroway.values()],
    buildings: [...buildings.values()],
  };
}

function buildStands(aeroway) {
  const stands = [];
  for (const apron of aeroway.filter((a) => a.aeroway === "apron")) {
    const ring = apron.coordinates;
    if (!ring || ring.length < 4) continue;
    let sx = 0;
    let sy = 0;
    for (const [lon, lat] of ring) {
      sx += lon;
      sy += lat;
    }
    const cx = sx / ring.length;
    const cy = sy / ring.length;
    const n = Math.min(6, Math.max(3, Math.floor(ring.length / 8)));
    for (let i = 0; i < n; i++) {
      const [lon, lat] = ring[Math.min(i + 1, ring.length - 2)];
      stands.push({
        id: `${apron.id}-S${i + 1}`,
        lon: cx + (lon - cx) * 0.5,
        lat: cy + (lat - cy) * 0.5,
        hdg: 90,
        type: n >= 5 ? "wide" : "narrow",
      });
    }
  }
  return stands;
}

async function downloadTile(west, south, east, north, size = 2048) {
  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${west},${south},${east},${north}` +
    `&bboxSR=4326&imageSR=4326&size=${size},${size}&format=jpg&f=image`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Esri ${res.status} ${west},${south}`);
  return Buffer.from(await res.arrayBuffer());
}

async function stitchSatellite() {
  // Prefer sharp if available; else keep single-tile medium AOI
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    sharp = null;
  }

  const { west, south, east, north } = SAT_BOUNDS;
  const midLon = (west + east) / 2;
  const midLat = (south + north) / 2;

  if (!sharp) {
    // Fall back: one 3072 sheet (more reliable than 4096)
    console.info("[sat] sharp unavailable — single 3072 sheet");
    const buf = await downloadTile(west, south, east, north, 3072);
    fs.writeFileSync(path.join(OUT_DIR, "satellite_imagery.jpg"), buf);
  } else {
    console.info("[sat] stitching 2x2 Esri tiles…");
    const tiles = [
      await downloadTile(west, midLat, midLon, north, 2048),
      await downloadTile(midLon, midLat, east, north, 2048),
      await downloadTile(west, south, midLon, midLat, 2048),
      await downloadTile(midLon, south, east, midLat, 2048),
    ];
    const tmp = [];
    for (let i = 0; i < 4; i++) {
      const p = path.join(OUT_DIR, `_sat_tile_${i}.jpg`);
      fs.writeFileSync(p, tiles[i]);
      tmp.push(p);
    }
    await sharp({
      create: {
        width: 4096,
        height: 4096,
        channels: 3,
        background: { r: 40, g: 50, b: 40 },
      },
    })
      .composite([
        { input: tmp[0], left: 0, top: 0 },
        { input: tmp[1], left: 2048, top: 0 },
        { input: tmp[2], left: 0, top: 2048 },
        { input: tmp[3], left: 2048, top: 2048 },
      ])
      .jpeg({ quality: 88 })
      .toFile(path.join(OUT_DIR, "satellite_imagery.jpg"));
    for (const p of tmp) fs.unlinkSync(p);
  }

  const meta = {
    ...SAT_BOUNDS,
    source: "Esri World Imagery",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    path: "satellite_imagery.jpg",
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "satellite_imagery_bounds.json"), JSON.stringify(meta, null, 2));
  const sz = fs.statSync(path.join(OUT_DIR, "satellite_imagery.jpg")).size;
  console.info("[sat] wrote", `${(sz / 1e6).toFixed(2)} MB`, SAT_BOUNDS);
}

async function main() {
  const existing = JSON.parse(fs.readFileSync(AERO_OUT, "utf8"));
  let cached = { aeroway: [], buildings: [] };
  if (fs.existsSync(CACHE_XML)) {
    console.info("[osm] parsing cached map dump…");
    const xml = fs.readFileSync(CACHE_XML, "utf8");
    cached = waysToPack(parseOsmXml(xml));
    console.info("[osm] cached", {
      aeroway: cached.aeroway.length,
      runways: cached.aeroway.filter((a) => a.aeroway === "runway").map((a) => a.ref || a.name),
      buildings: cached.buildings.length,
    });
  }

  // Re-filter existing buildings too
  const cleanedExisting = {
    aeroway: existing.aeroway || [],
    buildings: (existing.buildings || []).filter((b) => {
      const tags = { name: b.name, building: b.building, aeroway: b.aeroway };
      return !!keepBuilding(tags);
    }),
  };

  const merged = mergePacks(cached, cleanedExisting);

  // Deduplicate nearly-identical runway centerlines — keep longest per ref
  const runways = merged.aeroway.filter((a) => a.aeroway === "runway");
  const other = merged.aeroway.filter((a) => a.aeroway !== "runway");
  const byRef = new Map();
  for (const r of runways) {
    const key = (r.ref || r.name || r.id).replace(/\s/g, "");
    const prev = byRef.get(key);
    if (!prev || (r.coordinates?.length || 0) > (prev.coordinates?.length || 0)) byRef.set(key, r);
  }
  let finalRunways = [...byRef.values()];

  // Guarantee 09/27 from AIP if OSM dump still missing it
  if (!finalRunways.some((r) => /09\s*\/\s*27/.test(`${r.ref}${r.name}`))) {
    console.warn("[osm] RWY 09/27 missing from OSM pack — inserting AIP-published centerline");
    finalRunways.push({
      id: "aip-rwy-09-27",
      name: "09/27",
      ref: "09/27",
      aeroway: "runway",
      surface: "asphalt",
      widthM: 60,
      designations: { start: "09", end: "27" },
      coordinates: densify(
        [
          [72.848, 19.0884],
          [72.8811, 19.0889],
        ],
        0.00032,
      ),
      source: "AIP_PUBLISHED",
    });
  }

  const aeroway = [...finalRunways, ...other];
  // Cap taxiways for performance — keep longest / named first
  const taxi = aeroway
    .filter((a) => a.aeroway === "taxiway")
    .sort((a, b) => (b.coordinates?.length || 0) - (a.coordinates?.length || 0));
  const apron = aeroway.filter((a) => a.aeroway === "apron");
  const taxiKeep = taxi.slice(0, 120);
  const finalAeroway = [...finalRunways, ...apron, ...taxiKeep];

  const stands = buildStands(finalAeroway);
  const taxiRoutes = taxiKeep.slice(0, 5).map((a) => ({
    id: `taxi-${a.id}`,
    coordinates: a.coordinates,
  }));

  const payload = {
    generated_at: new Date().toISOString(),
    source: "OPENSTREETMAP+AIP",
    note: "CSIA digital twin — OSM ways preferred; AIP only for missing 09/27",
    bounds: { west: 72.833, south: 19.078, east: 72.885, north: 19.105 },
    aeroway: finalAeroway,
    buildings: merged.buildings,
    stands,
    taxiRoutes,
  };
  fs.writeFileSync(AERO_OUT, JSON.stringify(payload));
  console.info("[aeroway] finalized", {
    runways: finalRunways.map((r) => r.ref || r.name),
    taxiways: taxiKeep.length,
    aprons: apron.length,
    buildings: merged.buildings.length,
    stands: stands.length,
  });

  await stitchSatellite();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
