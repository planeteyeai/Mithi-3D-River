/**
 * Rebuild Mithi live-water as a realistic channel (centerline buffer),
 * NOT the fat AOI polygon — so river banks keep buildings & vegetation.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public", "data", "mithi");
const MAIN = path.join(ROOT, "src", "eye", "data", "mithi", "mithi_river_main_stream.kml");
const WIDTHS = path.join(PUBLIC, "river_widths.json");

function parseLine(text) {
  const m = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!m) throw new Error("no coordinates");
  return m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lon, lat] = tok.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
    })
    .filter(Boolean);
}

function metersPerDeg(lat) {
  const lat0 = (lat * Math.PI) / 180;
  return { mLon: 111320 * Math.cos(lat0), mLat: 110540 };
}

function distM(a, b, m) {
  return Math.hypot((a.lon - b.lon) * m.mLon, (a.lat - b.lat) * m.mLat);
}

function resample(line, stepM = 25) {
  if (line.length < 2) return line;
  const m = metersPerDeg(line[0].lat);
  const out = [{ ...line[0] }];
  let acc = 0;
  let prev = line[0];
  for (let i = 1; i < line.length; i++) {
    const cur = line[i];
    let seg = distM(prev, cur, m);
    while (acc + seg >= out.length * stepM) {
      const need = out.length * stepM - acc;
      const t = need / Math.max(1e-9, seg);
      const p = {
        lon: prev.lon + (cur.lon - prev.lon) * t,
        lat: prev.lat + (cur.lat - prev.lat) * t,
      };
      out.push(p);
      prev = p;
      seg = distM(prev, cur, m);
      acc = (out.length - 1) * stepM;
    }
    acc += distM(prev, cur, m);
    prev = cur;
  }
  if (distM(out[out.length - 1], line[line.length - 1], m) > 2) out.push({ ...line[line.length - 1] });
  return out;
}

function halfWidthAt(i, n, widthSamples) {
  // Mithi is a narrow urban drain/river: ~20–70 m typical, wider near Mahim mouth.
  const t = i / Math.max(1, n - 1);
  let base = 28 + 18 * Math.sin(t * Math.PI); // mid-reach a bit wider
  if (t < 0.12) base = 48 + t * 80; // mouth flare toward Mahim Creek
  if (t > 0.85) base = 22; // upstream narrower
  if (widthSamples?.length) {
    const idx = Math.min(widthSamples.length - 1, Math.floor(t * widthSamples.length));
    const w = Number(widthSamples[idx]?.width_m);
    if (Number.isFinite(w)) base = Math.max(18, Math.min(70, w * 0.55));
  }
  return Math.max(16, Math.min(65, base));
}

function bufferChannel(line, widthSamples) {
  const m = metersPerDeg(line[0].lat);
  const left = [];
  const right = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    let dx = (b.lon - a.lon) * m.mLon;
    let dy = (b.lat - a.lat) * m.mLat;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy;
    const ny = dx;
    const half = halfWidthAt(i, line.length, widthSamples);
    left.push({
      lon: line[i].lon + (nx * half) / m.mLon,
      lat: line[i].lat + (ny * half) / m.mLat,
    });
    right.push({
      lon: line[i].lon - (nx * half) / m.mLon,
      lat: line[i].lat - (ny * half) / m.mLat,
    });
  }
  const ring = [...left, ...right.reverse()];
  ring.push({ ...ring[0] });
  return ring;
}

function bbox(ring, pad = 0.0008) {
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
  return { west: west - pad, east: east + pad, south: south - pad, north: north + pad };
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

function rasterizeWaterPng(ring, bounds, width = 1600, height = 1200) {
  const { west, east, south, north } = bounds;
  const raw = Buffer.alloc(width * height * 4 + height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    const lat = north - ((y + 0.5) / height) * (north - south);
    for (let x = 0; x < width; x++) {
      const lon = west + ((x + 0.5) / width) * (east - west);
      if (pointInRing(lon, lat, ring)) {
        raw[o++] = 30;
        raw[o++] = 110;
        raw[o++] = 230;
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
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function coordText(pts) {
  return pts.map((p) => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},0`).join(" ");
}

function kmlPoly(name, ring) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>
<Placemark><name>${name}</name>
<Style><LineStyle><color>ff0000ff</color></LineStyle><PolyStyle><color>9900aaff</color><fill>1</fill></PolyStyle></Style>
<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordText(ring)}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark></Document></kml>
`;
}

const line = resample(parseLine(fs.readFileSync(MAIN, "utf8")), 20);
let widthSamples = [];
try {
  widthSamples = JSON.parse(fs.readFileSync(WIDTHS, "utf8")).samples || [];
} catch {
  /* optional */
}
const ring = bufferChannel(line, widthSamples);
const bounds = bbox(ring);
const png = rasterizeWaterPng(ring, bounds, 1600, 1200);
const kml = kmlPoly("Mithi live water channel", ring);

fs.writeFileSync(path.join(PUBLIC, "live_water_mithi.kml"), kml);
fs.writeFileSync(path.join(PUBLIC, "live_water_extent.png"), png);
fs.writeFileSync(path.join(PUBLIC, "water_depth_overlay.png"), png);
fs.writeFileSync(
  path.join(PUBLIC, "live_water_extent.json"),
  JSON.stringify(
    {
      sourceKml: "public/data/mithi/live_water_mithi.kml",
      overlay: "/data/mithi/live_water_extent.png",
      bounds,
      extractedBytes: png.length,
      extractedAt: new Date().toISOString(),
      river: "Mithi",
      note: "Channel buffer from main-stem centerline (not fat AOI)",
      centerlinePoints: line.length,
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(PUBLIC, "mithi_channel_ring.kml"), kml);
fs.writeFileSync(
  path.join(PUBLIC, "mithi_channel_ring.json"),
  JSON.stringify({ bounds, ring, centerline: line }, null, 2),
);

console.info("[mithi-channel] rebuilt", {
  centerline: line.length,
  ring: ring.length,
  bounds,
  pngBytes: png.length,
});
