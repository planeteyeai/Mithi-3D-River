/**
 * Restore live water geometry EXACTLY from original mithi_river.kml lat/lon.
 * No invented centerline buffers — every vertex is from the source KML.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "mithi_river.kml");
const PUBLIC = path.join(ROOT, "public", "data", "mithi");

function parseRing(text) {
  const m = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!m) throw new Error("No <coordinates> in original mithi_river.kml");
  const pts = m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lon, lat] = tok.split(",").map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      return { lon, lat };
    })
    .filter(Boolean);
  if (pts.length < 4) throw new Error("AOI ring too small");
  const closed =
    pts[0].lon === pts[pts.length - 1].lon && pts[0].lat === pts[pts.length - 1].lat
      ? pts
      : [...pts, { ...pts[0] }];
  return closed;
}

function bbox(ring, pad = 0.0004) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const p of ring) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return {
    west: west - pad,
    east: east + pad,
    south: south - pad,
    north: north + pad,
  };
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

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function rasterize(ring, bounds, width = 2048, height = 1536) {
  const { west, east, south, north } = bounds;
  const raw = Buffer.alloc(width * height * 4 + height);
  let o = 0;
  let water = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    const lat = north - ((y + 0.5) / height) * (north - south);
    for (let x = 0; x < width; x++) {
      const lon = west + ((x + 0.5) / width) * (east - west);
      if (pointInRing(lon, lat, ring)) {
        water++;
        raw[o++] = 25;
        raw[o++] = 105;
        raw[o++] = 225;
        raw[o++] = 230;
      } else {
        raw[o++] = 0;
        raw[o++] = 0;
        raw[o++] = 0;
        raw[o++] = 0;
      }
    }
  }
  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return {
    png: Buffer.concat([
      sig,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", compressed),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
    waterPixels: water,
    totalPixels: width * height,
  };
}

const originalText = fs.readFileSync(SRC, "utf8");
const ring = parseRing(originalText);
const bounds = bbox(ring);
const { png, waterPixels, totalPixels } = rasterize(ring, bounds);

fs.mkdirSync(PUBLIC, { recursive: true });
// Keep original AOI bytes verbatim for water + AOI paths
fs.writeFileSync(path.join(PUBLIC, "mithi_river.kml"), originalText);
fs.writeFileSync(path.join(PUBLIC, "Mithi River Kml.kml"), originalText);
fs.writeFileSync(path.join(PUBLIC, "Mithi_River_Coordinates_Cleaned.kml"), originalText);
fs.writeFileSync(path.join(PUBLIC, "live_water_mithi.kml"), originalText);
fs.writeFileSync(path.join(PUBLIC, "permanent_water.kml"), originalText);
fs.writeFileSync(path.join(ROOT, "mithi_river.kml"), originalText);
fs.writeFileSync(path.join(PUBLIC, "live_water_extent.png"), png);
fs.writeFileSync(path.join(PUBLIC, "water_depth_overlay.png"), png);

const meta = {
  sourceKml: "mithi_river.kml",
  overlay: "/data/mithi/live_water_extent.png",
  bounds,
  extractedBytes: png.length,
  extractedAt: new Date().toISOString(),
  river: "Mithi",
  note: "ORIGINAL mithi_river.kml polygon vertices only — no invented buffers",
  vertexCount: ring.length,
  waterCoveragePct: Number(((100 * waterPixels) / totalPixels).toFixed(3)),
  firstVertex: ring[0],
  bboxExact: {
    west: Math.min(...ring.map((p) => p.lon)),
    east: Math.max(...ring.map((p) => p.lon)),
    south: Math.min(...ring.map((p) => p.lat)),
    north: Math.max(...ring.map((p) => p.lat)),
  },
};
fs.writeFileSync(path.join(PUBLIC, "live_water_extent.json"), JSON.stringify(meta, null, 2));

// osm_water.geojson: original AOI polygon only (lat/lon rings)
const osmWater = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        name: "Mithi River",
        natural: "water",
        source: "mithi_river.kml",
        provenance: "ORIGINAL_KML_LATLON",
      },
      geometry: {
        type: "Polygon",
        coordinates: [ring.map((p) => [p.lon, p.lat])],
      },
    },
  ],
};
fs.writeFileSync(path.join(ROOT, "public", "data", "osm_water.geojson"), JSON.stringify(osmWater));

console.info("[mithi-water] restored ORIGINAL lat/lon geometry", {
  vertices: ring.length,
  bounds: meta.bboxExact,
  waterCoveragePct: meta.waterCoveragePct,
  pngBytes: png.length,
});
