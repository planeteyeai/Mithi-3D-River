/**
 * Build a Mithi River data pack from mithi_river.kml:
 * AOI copy, centerline, chainage, upstream stubs, live-water mask PNG,
 * WQ demo polygons, silt class/volume stubs, and metadata JSON.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_KML = path.join(ROOT, "mithi_river.kml");
const PUBLIC = path.join(ROOT, "public", "data", "mithi");
const EYE_DATA = path.join(ROOT, "src", "eye", "data", "mithi");
const WQ_ASSETS = path.join(ROOT, "src", "eye", "assets", "mithi-wq");
const CLASS_DIR = path.join(ROOT, "src", "data", "Classification");
const VOL_DIR = path.join(ROOT, "src", "data", "Volume");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function parseRing(text) {
  const m = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!m) throw new Error("No coordinates in KML");
  const pts = m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lon, lat] = tok.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
    })
    .filter(Boolean);
  if (pts.length < 4) throw new Error("AOI ring too small");
  const closed =
    pts[0].lon === pts[pts.length - 1].lon && pts[0].lat === pts[pts.length - 1].lat
      ? pts
      : [...pts, { ...pts[0] }];
  return closed;
}

function bbox(ring) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  return { minLon, maxLon, minLat, maxLat, west: minLon, east: maxLon, south: minLat, north: maxLat };
}

function farthestTips(ring) {
  let a = ring[0];
  let b = ring[Math.min(1, ring.length - 1)];
  let best = -1;
  const step = Math.max(1, Math.floor(ring.length / 80));
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
  // Prefer mouth (west / lower lon) as start for Mithi (flows west to Mahim Creek)
  if (a.lon > b.lon) [a, b] = [b, a];
  return [a, b];
}

function metersPerDeg(lat) {
  const lat0 = (lat * Math.PI) / 180;
  return { mLon: 111320 * Math.cos(lat0), mLat: 110540 };
}

function distM(a, b, m) {
  return Math.hypot((a.lon - b.lon) * m.mLon, (a.lat - b.lat) * m.mLat);
}

/** Approximate centerline: densified diameter then snap each sample toward ring centroid of nearby boundary. */
function buildCenterline(ring, samples = 220) {
  const [a, b] = farthestTips(ring);
  const midLat = (a.lat + b.lat) / 2;
  const m = metersPerDeg(midLat);
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    raw.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
  }
  // Pull each sample toward local medial by averaging nearest boundary points on both sides
  const refined = raw.map((p) => {
    let bestL = null;
    let bestR = null;
    let dL = Infinity;
    let dR = Infinity;
    for (const q of ring) {
      const d = distM(p, q, m);
      const cross = (q.lon - p.lon) * (b.lat - a.lat) - (q.lat - p.lat) * (b.lon - a.lon);
      if (cross >= 0 && d < dL) {
        dL = d;
        bestL = q;
      }
      if (cross < 0 && d < dR) {
        dR = d;
        bestR = q;
      }
    }
    if (bestL && bestR) {
      return { lon: (bestL.lon + bestR.lon) / 2, lat: (bestL.lat + bestR.lat) / 2 };
    }
    return p;
  });
  // Smooth
  const out = refined.map((p, i, arr) => {
    if (i === 0 || i === arr.length - 1) return p;
    const prev = arr[i - 1];
    const next = arr[i + 1];
    return {
      lon: prev.lon * 0.25 + p.lon * 0.5 + next.lon * 0.25,
      lat: prev.lat * 0.25 + p.lat * 0.5 + next.lat * 0.25,
    };
  });
  return out;
}

function chainageAlong(line, stepM = 10) {
  if (line.length < 2) return [];
  const m = metersPerDeg(line[0].lat);
  const out = [{ ...line[0], meters: 0 }];
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
        meters: out.length * stepM,
      };
      out.push(p);
      prev = p;
      seg = distM(prev, cur, m);
      acc = (out.length - 1) * stepM;
    }
    acc += distM(prev, cur, m);
    prev = cur;
  }
  return out;
}

function coordText(pts) {
  return pts.map((p) => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},0`).join(" ");
}

function kmlDocument(name, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>
${body}
</Document></kml>
`;
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

/** Solid blue water mask PNG from AOI polygon (for liveWaterMask pixel detector). */
function rasterizeWaterPng(ring, bounds, width = 1024, height = 768) {
  const { west, east, south, north } = bounds;
  const raw = Buffer.alloc((width * height * 4) + height); // filter bytes
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter none
    const lat = north - ((y + 0.5) / height) * (north - south);
    for (let x = 0; x < width; x++) {
      const lon = west + ((x + 0.5) / width) * (east - west);
      const water = pointInRing(lon, lat, ring);
      if (water) {
        raw[o++] = 30;
        raw[o++] = 90;
        raw[o++] = 220;
        raw[o++] = 220;
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
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

function sliceAlong(line, t0, t1) {
  const i0 = Math.floor(t0 * (line.length - 1));
  const i1 = Math.max(i0 + 2, Math.floor(t1 * (line.length - 1)));
  return line.slice(i0, i1 + 1);
}

function bufferPoly(line, halfM) {
  if (line.length < 2) return null;
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
    left.push({
      lon: line[i].lon + (nx * halfM) / m.mLon,
      lat: line[i].lat + (ny * halfM) / m.mLat,
    });
    right.push({
      lon: line[i].lon - (nx * halfM) / m.mLon,
      lat: line[i].lat - (ny * halfM) / m.mLat,
    });
  }
  return [...left, ...right.reverse(), { ...left[0] }];
}

function classedPolyKml(name, polys) {
  const body = polys
    .map(
      (p, i) => `<Placemark>
  <name>${p.name || `${name}-${i + 1}`}</name>
  <ExtendedData><Data name="class"><value>${p.cls}</value></Data><Data name="value"><value>${p.value}</value></Data></ExtendedData>
  <Style><PolyStyle><color>${p.color}</color><fill>1</fill><outline>0</outline></PolyStyle></Style>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>${coordText(p.ring)}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>`,
    )
    .join("\n");
  return kmlDocument(name, body);
}

function write(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  console.log("wrote", path.relative(ROOT, file), typeof content === "string" ? `(${content.length} chars)` : `(${content.length} bytes)`);
}

const aoiText = fs.readFileSync(SRC_KML, "utf8");
const ring = parseRing(aoiText);
const bounds = bbox(ring);
const pad = 0.0015;
const padded = {
  north: bounds.north + pad,
  south: bounds.south - pad,
  east: bounds.east + pad,
  west: bounds.west - pad,
};
const centerline = buildCenterline(ring, 260);
const chainage = chainageAlong(centerline, 10);
const centroid = {
  lon: (bounds.minLon + bounds.maxLon) / 2,
  lat: (bounds.minLat + bounds.maxLat) / 2,
};

ensureDir(PUBLIC);
ensureDir(path.join(PUBLIC, "WATERQ-Pollution"));
ensureDir(path.join(PUBLIC, "Ships"));
ensureDir(path.join(PUBLIC, "chainage,upstream,mainstream"));
ensureDir(EYE_DATA);
ensureDir(WQ_ASSETS);
ensureDir(CLASS_DIR);
ensureDir(VOL_DIR);

// AOI
write(path.join(PUBLIC, "mithi_river.kml"), aoiText);
write(path.join(PUBLIC, "Mithi River Kml.kml"), aoiText);
write(path.join(PUBLIC, "Mithi_River_Coordinates_Cleaned.kml"), aoiText);
write(path.join(PUBLIC, "live_water_mithi.kml"), aoiText);
write(path.join(PUBLIC, "permanent_water.kml"), aoiText);

// Main stream + chainage + upstreams
const mainBody = `<Placemark><name>Mithi Main Stem</name><LineString><coordinates>${coordText(centerline)}</coordinates></LineString></Placemark>`;
const mainKml = kmlDocument("Mithi Main Stream", mainBody);
write(path.join(EYE_DATA, "mithi_river_main_stream.kml"), mainKml);
write(path.join(PUBLIC, "chainage,upstream,mainstream", "mithi_river_main_stream.kml"), mainKml);

const chainBody = chainage
  .map((p) => {
    const label = `${Math.floor(p.meters / 1000)}+${String(p.meters % 1000).padStart(3, "0")}`;
    return `<Placemark><name>${label}</name><Point><coordinates>${p.lon.toFixed(8)},${p.lat.toFixed(8)},0</coordinates></Point></Placemark>`;
  })
  .join("\n");
const chainKml = kmlDocument("Mithi Chainage 10m", chainBody);
write(path.join(EYE_DATA, "mithi_river_chainage_10m.kml"), chainKml);
write(path.join(PUBLIC, "chainage,upstream,mainstream", "mithi_river_chainage_10m.kml"), chainKml);

// Stub joining streams near mid-corridor (Powai / airport feeder style placeholders)
const upA = sliceAlong(centerline, 0.55, 0.62).map((p, i, arr) => ({
  lon: p.lon + 0.004 + i * 0.00002,
  lat: p.lat + 0.003 - (i / arr.length) * 0.002,
}));
const upB = sliceAlong(centerline, 0.72, 0.8).map((p, i, arr) => ({
  lon: p.lon - 0.0035 - i * 0.000015,
  lat: p.lat + 0.0025 - (i / arr.length) * 0.0018,
}));
const upBody = [
  { name: "Vakola Nalla", line: upA },
  { name: "Airport Drain", line: upB },
]
  .map(
    (s) =>
      `<Placemark><name>${s.name}</name><LineString><coordinates>${coordText(s.line)}</coordinates></LineString></Placemark>`,
  )
  .join("\n");
const upKml = kmlDocument("Mithi Upstreams", upBody);
write(path.join(EYE_DATA, "mithi_river_upstreams.kml"), upKml);
write(path.join(PUBLIC, "chainage,upstream,mainstream", "mithi_river_upstreams.kml"), upKml);

write(
  path.join(EYE_DATA, "index.js"),
  `import chainageKml from "./mithi_river_chainage_10m.kml?raw";
import mainStreamKml from "./mithi_river_main_stream.kml?raw";
import upstreamsKml from "./mithi_river_upstreams.kml?raw";

export { chainageKml, mainStreamKml, upstreamsKml };
`,
);

// Live water mask
const png = rasterizeWaterPng(ring, padded, 1280, 960);
write(path.join(PUBLIC, "live_water_extent.png"), png);
write(
  path.join(PUBLIC, "live_water_extent.json"),
  JSON.stringify(
    {
      sourceKml: "public/data/mithi/live_water_mithi.kml",
      overlay: "/data/mithi/live_water_extent.png",
      bounds: padded,
      extractedBytes: png.length,
      extractedAt: new Date().toISOString(),
      river: "Mithi",
      centroid,
    },
    null,
    2,
  ),
);

// Depth / WQ metadata
const waterDepth = {
  river: "Mithi",
  bounds: padded,
  overlay: "/data/mithi/water_depth_overlay.png",
  source: "Derived corridor bathymetry from Mithi AOI KML (placeholder until survey/JalNetra)",
  minDepth: 0.6,
  maxDepth: 4.8,
  unit: "m",
  verticalDatum: "Approx. local MSL",
};
write(path.join(PUBLIC, "water_depth.json"), JSON.stringify(waterDepth, null, 2));
write(path.join(PUBLIC, "water_depth_overlay.png"), png);

const wq = {
  river: "Mithi",
  centroid,
  bounds: padded,
  summary: {
    tss_mg_l: 48,
    chlorophyll_ug_l: 12.4,
    salinity_psu: 2.1,
    ndci: 0.18,
    coliform_mpn: 2400,
    note: "Seed values for UI; replace with JalNetra / lab products when available.",
  },
};
write(path.join(PUBLIC, "water_quality.json"), JSON.stringify(wq, null, 2));

// Demo WQ class polygons along thirds of the river
const segs = [
  { t0: 0.0, t1: 0.34, half: 55 },
  { t0: 0.32, t1: 0.66, half: 45 },
  { t0: 0.64, t1: 1.0, half: 40 },
];
const tssPolys = segs.map((s, i) => ({
  name: `TSS zone ${i + 1}`,
  cls: ["low", "moderate", "high"][i],
  value: [18, 42, 78][i],
  color: ["7f00ff00", "7f00ffff", "7f0000ff"][i],
  ring: bufferPoly(sliceAlong(centerline, s.t0, s.t1), s.half),
}));
const chlPolys = segs.map((s, i) => ({
  name: `Chlorophyll zone ${i + 1}`,
  cls: ["oligotrophic", "mesotrophic", "eutrophic"][i],
  value: [4.2, 11.5, 22.0][i],
  color: ["7f88ff00", "7f00dd88", "7f0044ff"][i],
  ring: bufferPoly(sliceAlong(centerline, s.t0, s.t1), s.half * 0.9),
}));
const salPolys = segs.map((s, i) => ({
  name: `Salinity zone ${i + 1}`,
  cls: ["fresh", "brackish", "tidal"][i],
  value: [0.4, 2.2, 8.5][i],
  color: ["7fffcc88", "7fcc8844", "7f884400"][i],
  ring: bufferPoly(sliceAlong(centerline, s.t0, s.t1), s.half * 1.05),
}));

for (const [fname, polys, title] of [
  ["tss.kml", tssPolys, "Mithi TSS"],
  ["chlorophyll.kml", chlPolys, "Mithi Chlorophyll"],
  ["salinity.kml", salPolys, "Mithi Salinity"],
]) {
  const text = classedPolyKml(title, polys.filter((p) => p.ring));
  write(path.join(WQ_ASSETS, fname), text);
  write(path.join(PUBLIC, "WATERQ-Pollution", fname), text);
}
write(path.join(PUBLIC, "WATERQ-Pollution", "Mithi_Salinity_smoothed_v2.kml"), classedPolyKml("Mithi Salinity", salPolys.filter((p) => p.ring)));
write(path.join(PUBLIC, "tss.kml"), classedPolyKml("Mithi TSS", tssPolys.filter((p) => p.ring)));
write(path.join(PUBLIC, "ndci.kml"), classedPolyKml("Mithi NDCI", chlPolys.filter((p) => p.ring)));

const pollutionExtras = [
  ["eutrophication_trophic_class (1).kml", chlPolys, "Eutrophication"],
  ["nitrogen_risk_class (1).kml", tssPolys, "Nitrogen risk"],
  ["coliform_ecoli_class (1).kml", salPolys, "Coliform"],
  ["tss (1).kml", tssPolys, "TSS"],
];
for (const [fname, polys, title] of pollutionExtras) {
  write(path.join(PUBLIC, "WATERQ-Pollution", fname), classedPolyKml(title, polys.filter((p) => p.ring)));
}

// Monthly silt class / volume along AOI (replace Goa files)
const months = [
  ["jan_class_silt.kml", "Jan_vol.kml", "January"],
  ["feb_class.kml", "Feb_vol.kml", "February"],
  ["march_class.kml", "March_vol.kml", "March"],
  ["April_class.kml", "April_vol.kml", "April"],
  ["June_class.kml", "June_vol.kml", "June"],
  ["July_class.kml", "July_vol.kml", "July"],
  ["Aug_class.kml", "Aug_vol.kml", "August"],
  ["sep_class.kml", "sep_vol.kml", "September"],
  ["Oct_class.kml", "Oct_vol.kml", "October"],
];
for (const f of fs.readdirSync(CLASS_DIR)) {
  if (f.endsWith(".kml")) fs.unlinkSync(path.join(CLASS_DIR, f));
}
for (const f of fs.readdirSync(VOL_DIR)) {
  if (f.endsWith(".kml")) fs.unlinkSync(path.join(VOL_DIR, f));
}
months.forEach(([clsFile, volFile, label], mi) => {
  const shift = (mi % 3) * 0.08;
  const polys = segs.map((s, i) => ({
    name: `${label} silt ${i + 1}`,
    cls: ["deposition", "stable", "erosion"][(i + mi) % 3],
    value: [120 + mi * 8, 80 + mi * 5, 40 + mi * 3][i],
    color: ["7f3366ff", "7f66ff33", "7fff6633"][(i + mi) % 3],
    ring: bufferPoly(sliceAlong(centerline, Math.min(0.95, s.t0 + shift), Math.min(1, s.t1 + shift)), s.half * (0.85 + (mi % 4) * 0.04)),
  }));
  write(path.join(CLASS_DIR, clsFile), classedPolyKml(`${label} classification`, polys.filter((p) => p.ring)));
  write(path.join(VOL_DIR, volFile), classedPolyKml(`${label} volume`, polys.filter((p) => p.ring)));
});
write(path.join(VOL_DIR, "May_vol.kml"), classedPolyKml("May volume", tssPolys.filter((p) => p.ring)));

// Empty ship detections (no Goa vessels)
write(
  path.join(PUBLIC, "Ships", "ship_detections_empty.geojson"),
  JSON.stringify({ type: "FeatureCollection", features: [] }, null, 2),
);

// Bridges geojson for Mithi corridor (Mahim / BKC-ish crossings across AOI)
const bridges = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Mahim Causeway", bridge: "yes", highway: "primary" },
      geometry: {
        type: "LineString",
        coordinates: [
          [72.8392, 19.0489],
          [72.8418, 19.0506],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "BKC Connector Bridge", bridge: "yes", highway: "secondary" },
      geometry: {
        type: "LineString",
        coordinates: [
          [72.8625, 19.0598],
          [72.8658, 19.0614],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Kurla–Sion Link", bridge: "yes", highway: "tertiary" },
      geometry: {
        type: "LineString",
        coordinates: [
          [72.8721, 19.0712],
          [72.8746, 19.0735],
        ],
      },
    },
  ],
};
write(path.join(PUBLIC, "bridges.geojson"), JSON.stringify(bridges, null, 2));

write(
  path.join(PUBLIC, "tributaries.json"),
  JSON.stringify(
    {
      river: "Mithi",
      streams: [
        { name: "Vakola Nalla", osmId: "mithi-up-1" },
        { name: "Airport Drain", osmId: "mithi-up-2" },
      ],
    },
    null,
    2,
  ),
);

write(
  path.join(PUBLIC, "river_widths.json"),
  JSON.stringify(
    {
      river: "Mithi",
      medianWidthM: 42,
      samples: chainage.filter((_, i) => i % 20 === 0).map((p) => ({ lon: p.lon, lat: p.lat, width_m: 28 + (p.meters % 40) })),
    },
    null,
    2,
  ),
);

write(
  path.join(PUBLIC, "osm_mithi_trees.json"),
  JSON.stringify({ type: "FeatureCollection", features: [] }, null, 2),
);

write(
  path.join(ROOT, "mithi_bounds.json"),
  JSON.stringify({ bounds: padded, centroid, chainagePoints: chainage.length, centerlinePoints: centerline.length }, null, 2),
);

console.log("\nMithi pack ready", { centroid, bounds: padded, chainage: chainage.length });
