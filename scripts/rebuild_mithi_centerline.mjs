/**
 * Rebuild Mithi main-stem centerline from AOI polygon:
 * west (Mahim mouth) → east (upstream), midpoints between N/S banks.
 * Also regenerates chainage + channel live-water.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AOI = path.join(ROOT, "public", "data", "mithi", "mithi_river.kml");
const EYE = path.join(ROOT, "src", "eye", "data", "mithi");
const PUBLIC = path.join(ROOT, "public", "data", "mithi");

function parseRing(text) {
  const m = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  const pts = m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lon, lat] = tok.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
    })
    .filter(Boolean);
  if (pts[0].lon !== pts[pts.length - 1].lon || pts[0].lat !== pts[pts.length - 1].lat) {
    pts.push({ ...pts[0] });
  }
  return pts;
}

function metersPerDeg(lat) {
  const lat0 = (lat * Math.PI) / 180;
  return { mLon: 111320 * Math.cos(lat0), mLat: 110540 };
}

function dist2(a, b) {
  return (a.lon - b.lon) ** 2 + (a.lat - b.lat) ** 2;
}

function farthestTips(ring) {
  let a = ring[0];
  let b = ring[1];
  let best = -1;
  const step = Math.max(1, Math.floor(ring.length / 100));
  for (let i = 0; i < ring.length; i += step) {
    for (let j = i + step; j < ring.length; j += step) {
      const d = dist2(ring[i], ring[j]);
      if (d > best) {
        best = d;
        a = ring[i];
        b = ring[j];
      }
    }
  }
  // Mouth is west (smaller lon) for Mithi
  if (a.lon > b.lon) [a, b] = [b, a];
  return [a, b];
}

function buildCenterline(ring, samples = 320) {
  const [start, end] = farthestTips(ring);
  const m = metersPerDeg((start.lat + end.lat) / 2);
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    raw.push({
      lon: start.lon + (end.lon - start.lon) * t,
      lat: start.lat + (end.lat - start.lat) * t,
    });
  }
  // Axis from start→end
  const ax = end.lon - start.lon;
  const ay = end.lat - start.lat;
  const refined = raw.map((p) => {
    let bestL = null;
    let bestR = null;
    let dL = Infinity;
    let dR = Infinity;
    for (const q of ring) {
      const d = Math.hypot((q.lon - p.lon) * m.mLon, (q.lat - p.lat) * m.mLat);
      const cross = (q.lon - p.lon) * ay - (q.lat - p.lat) * ax;
      if (cross >= 0 && d < dL) {
        dL = d;
        bestL = q;
      }
      if (cross < 0 && d < dR) {
        dR = d;
        bestR = q;
      }
    }
    if (bestL && bestR) return { lon: (bestL.lon + bestR.lon) / 2, lat: (bestL.lat + bestR.lat) / 2 };
    return p;
  });
  // Smooth 3x
  let cur = refined;
  for (let pass = 0; pass < 3; pass++) {
    cur = cur.map((p, i, arr) => {
      if (i === 0 || i === arr.length - 1) return p;
      const a = arr[i - 1];
      const b = arr[i + 1];
      return { lon: a.lon * 0.25 + p.lon * 0.5 + b.lon * 0.25, lat: a.lat * 0.25 + p.lat * 0.5 + b.lat * 0.25 };
    });
  }
  // Force endpoints to tips
  cur[0] = { ...start };
  cur[cur.length - 1] = { ...end };
  return cur;
}

function chainageAlong(line, stepM = 10) {
  const m = metersPerDeg(line[0].lat);
  const out = [{ ...line[0], meters: 0 }];
  let acc = 0;
  let prev = line[0];
  for (let i = 1; i < line.length; i++) {
    const cur = line[i];
    let seg = Math.hypot((cur.lon - prev.lon) * m.mLon, (cur.lat - prev.lat) * m.mLat);
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
      seg = Math.hypot((cur.lon - prev.lon) * m.mLon, (cur.lat - prev.lat) * m.mLat);
      acc = (out.length - 1) * stepM;
    }
    acc += Math.hypot((cur.lon - prev.lon) * m.mLon, (cur.lat - prev.lat) * m.mLat);
    prev = cur;
  }
  return out;
}

function coordText(pts) {
  return pts.map((p) => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},0`).join(" ");
}

function kmlDoc(name, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>
${body}
</Document></kml>
`;
}

const ring = parseRing(fs.readFileSync(AOI, "utf8"));
const centerline = buildCenterline(ring, 360);
const chainage = chainageAlong(centerline, 10);

const mainKml = kmlDoc(
  "Mithi Main Stream",
  `<Placemark><name>River Centerline</name><LineString><coordinates>${coordText(centerline)}</coordinates></LineString></Placemark>`,
);
const chainBody = chainage
  .map((p) => {
    const label = `${Math.floor(p.meters / 1000)}+${String(p.meters % 1000).padStart(3, "0")}`;
    return `<Placemark><name>${label}</name><Point><coordinates>${p.lon.toFixed(8)},${p.lat.toFixed(8)},0</coordinates></Point></Placemark>`;
  })
  .join("\n");
const chainKml = kmlDoc("Mithi Chainage 10m", chainBody);

fs.mkdirSync(EYE, { recursive: true });
fs.writeFileSync(path.join(EYE, "mithi_river_main_stream.kml"), mainKml);
fs.writeFileSync(path.join(EYE, "mithi_river_chainage_10m.kml"), chainKml);
fs.writeFileSync(path.join(PUBLIC, "chainage,upstream,mainstream", "mithi_river_main_stream.kml"), mainKml);
fs.writeFileSync(path.join(PUBLIC, "chainage,upstream,mainstream", "mithi_river_chainage_10m.kml"), chainKml);

console.info("[mithi-centerline]", {
  tips: [centerline[0], centerline.at(-1)],
  points: centerline.length,
  chainage: chainage.length,
  lengthM: chainage.at(-1)?.meters,
});

const water = spawnSync(process.execPath, [path.join(__dirname, "rebuild_mithi_channel_water.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(water.status || 0);
