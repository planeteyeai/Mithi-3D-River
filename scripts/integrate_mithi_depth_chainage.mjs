/**
 * Integrate user-supplied:
 *   - src/data/water_depth (1).kml  (Sentinel-2 MNDWI live water GroundOverlay)
 *   - src/data/Mithi_Chainage_10m.kml (10 m chainage along water centreline)
 * into the Mithi twin public + bundled data with correct LatLonBox coordinates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC_DEPTH = path.join(ROOT, "src/data/water_depth (1).kml");
const SRC_CHAIN = path.join(ROOT, "src/data/Mithi_Chainage_10m.kml");

const OUT_PUBLIC = path.join(ROOT, "public/data/mithi");
const OUT_BUNDLE = path.join(ROOT, "src/eye/data/mithi");
const OUT_PUBLIC_CHAIN_DIR = path.join(OUT_PUBLIC, "chainage,upstream,mainstream");

function stripNs(xml) {
  return String(xml)
    .replace(/<\/?ns\d+:/g, (m) => m.replace(/ns\d+:/, ""))
    .replace(/\sxmlns:ns\d+="[^"]*"/g, "");
}

function parseLatLonBox(kml) {
  const block = kml.match(/<LatLonBox>([\s\S]*?)<\/LatLonBox>/i)?.[1];
  if (!block) return null;
  const num = (tag) => {
    const m = block.match(new RegExp(`<${tag}>\\s*([\\d.\\-eE]+)\\s*</${tag}>`, "i"));
    return m ? Number(m[1]) : NaN;
  };
  const box = {
    north: num("north"),
    south: num("south"),
    east: num("east"),
    west: num("west"),
    rotation: num("rotation") || 0,
  };
  if (![box.north, box.south, box.east, box.west].every(Number.isFinite)) return null;
  return box;
}

function extractDataUrlPng(kml) {
  const href = kml.match(/<href>\s*(data:image\/png;base64,[A-Za-z0-9+/=\s]+)\s*<\/href>/i)?.[1];
  if (!href) return null;
  const b64 = href.replace(/^data:image\/png;base64,/i, "").replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

function chainStats(kml) {
  const pts = [...kml.matchAll(/<Point>\s*<coordinates>\s*([\d.\-]+),([\d.\-]+)/gi)].map((m) => ({
    lon: +m[1],
    lat: +m[2],
  }));
  const names = [...kml.matchAll(/<Placemark>\s*<name>([^<]+)<\/name>/gi)]
    .map((m) => m[1].trim())
    .filter((n) => /^\d+\+\d+$/.test(n));
  return {
    count: pts.length,
    first: pts[0] && { name: names[0], ...pts[0] },
    last: pts.at(-1) && { name: names.at(-1), ...pts.at(-1) },
  };
}

function writeGroundOverlayKml(box, href, name, description) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name}</name>
    <description>${description}</description>
    <GroundOverlay>
      <name>${name}</name>
      <color>ccffffff</color>
      <Icon>
        <href>${href}</href>
      </Icon>
      <LatLonBox>
        <north>${box.north}</north>
        <south>${box.south}</south>
        <east>${box.east}</east>
        <west>${box.west}</west>
        <rotation>${box.rotation || 0}</rotation>
      </LatLonBox>
    </GroundOverlay>
  </Document>
</kml>
`;
}

function main() {
  if (!fs.existsSync(SRC_DEPTH)) throw new Error(`Missing ${SRC_DEPTH}`);
  if (!fs.existsSync(SRC_CHAIN)) throw new Error(`Missing ${SRC_CHAIN}`);

  // ── Live water / depth overlay ──────────────────────────────────────────
  const rawDepth = fs.readFileSync(SRC_DEPTH, "utf8");
  const depth = stripNs(rawDepth);
  const box = parseLatLonBox(depth);
  if (!box) throw new Error("water_depth KML has no LatLonBox");
  const png = extractDataUrlPng(depth);
  if (!png?.length) throw new Error("water_depth KML has no embedded PNG");

  const desc =
    depth.match(/<description>([\s\S]*?)<\/description>/i)?.[1]?.replace(/\s+/g, " ").trim() ||
    "Sentinel-2 MNDWI live water overlay";

  fs.mkdirSync(OUT_PUBLIC, { recursive: true });
  fs.writeFileSync(path.join(OUT_PUBLIC, "water_depth_overlay.png"), png);
  fs.writeFileSync(path.join(OUT_PUBLIC, "live_water_extent.png"), png);

  const publicDepthKml = writeGroundOverlayKml(
    box,
    "/data/mithi/water_depth_overlay.png",
    "Mithi live water / depth overlay",
    desc,
  );
  fs.writeFileSync(path.join(OUT_PUBLIC, "water_depth.kml"), publicDepthKml);

  // Also write absolute-path-free copy for live water extent used by mask
  const liveWaterKml = writeGroundOverlayKml(
    box,
    "/data/mithi/live_water_extent.png",
    "Live Water - Mithi",
    desc,
  );
  fs.writeFileSync(path.join(OUT_PUBLIC, "live_water_extent.kml"), liveWaterKml);
  // Keep live_water_mithi.kml as polygon AOI if present — do not overwrite river polygon.
  // Store a companion overlay kml for hydrology UI.
  fs.writeFileSync(path.join(OUT_PUBLIC, "live_water_overlay.kml"), liveWaterKml);

  const meta = {
    river: "Mithi",
    bounds: {
      north: box.north,
      south: box.south,
      east: box.east,
      west: box.west,
      rotation: box.rotation || 0,
    },
    overlay: "/data/mithi/water_depth_overlay.png",
    source: "src/data/water_depth (1).kml — Sentinel-2 MNDWI live water GroundOverlay",
    description: desc,
    minDepth: 0.5,
    maxDepth: 5.0,
    unit: "m",
    verticalDatum: "Relative / MNDWI-derived extent (not survey bathymetry)",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_PUBLIC, "water_depth.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(OUT_PUBLIC, "live_water_extent.json"), JSON.stringify({
    river: "Mithi",
    bounds: meta.bounds,
    overlay: "/data/mithi/live_water_extent.png",
    source: meta.source,
    description: desc,
    updatedAt: meta.updatedAt,
  }, null, 2));

  console.info("[integrate] water overlay", {
    pngBytes: png.length,
    box,
    out: "public/data/mithi/water_depth_overlay.png",
  });

  // ── Chainage 10 m ───────────────────────────────────────────────────────
  const chainKml = fs.readFileSync(SRC_CHAIN, "utf8");
  if (!/<kml\b/i.test(chainKml)) throw new Error("Chainage file is not valid KML");
  const stats = chainStats(chainKml);
  if (stats.count < 10) throw new Error(`Chainage KML has too few points: ${stats.count}`);

  // Validate Mumbai/Mithi lon-lat range
  const { first, last } = stats;
  for (const p of [first, last]) {
    if (p.lon < 72.7 || p.lon > 73.1 || p.lat < 18.8 || p.lat > 19.3) {
      throw new Error(`Chainage coordinates outside Mithi AOI: ${JSON.stringify(p)}`);
    }
  }

  fs.mkdirSync(OUT_BUNDLE, { recursive: true });
  fs.mkdirSync(OUT_PUBLIC_CHAIN_DIR, { recursive: true });

  // Bundled Vite raw import path used by datasetFromKml
  fs.writeFileSync(path.join(OUT_BUNDLE, "mithi_river_chainage_10m.kml"), chainKml);
  // Public copy for reference / downloads
  fs.writeFileSync(path.join(OUT_PUBLIC_CHAIN_DIR, "mithi_river_chainage_10m.kml"), chainKml);
  fs.writeFileSync(path.join(OUT_PUBLIC, "Mithi_Chainage_10m.kml"), chainKml);

  console.info("[integrate] chainage", {
    points: stats.count,
    first: stats.first,
    last: stats.last,
    spanApproxKm: ((stats.count - 1) * 10) / 1000,
    outBundle: "src/eye/data/mithi/mithi_river_chainage_10m.kml",
    outPublic: "public/data/mithi/Mithi_Chainage_10m.kml",
  });

  console.info("[integrate] done — hard-refresh the twin to load new chainage + water overlay");
}

main();
