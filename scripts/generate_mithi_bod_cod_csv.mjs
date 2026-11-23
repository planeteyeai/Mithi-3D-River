/**
 * Build public/data/mithi/BOD_COD_pixelwise_latlon.csv along Mithi chainage.
 * Urban Mumbai estimate grid for top-bar + river-click BOD/COD (mg/L).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KML = path.join(ROOT, "public/data/mithi/Mithi_Chainage_10m.kml");
const OUT = path.join(ROOT, "public/data/mithi/BOD_COD_pixelwise_latlon.csv");

function parseChainage(text) {
  const pts = [];
  for (const m of text.matchAll(/([0-9]+\.[0-9]+),([0-9]+\.[0-9]+)/g)) {
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < 72.8 || lon > 73.0 || lat < 19.0 || lat > 19.2) continue;
    pts.push({ lon, lat });
  }
  // Deduplicate consecutive duplicates
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.lon - p.lon, prev.lat - p.lat) < 1e-8) continue;
    out.push(p);
  }
  return out;
}

function hash01(i, j) {
  const x = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const text = fs.readFileSync(KML, "utf8");
const chain = parseChainage(text);
if (chain.length < 10) throw new Error("chainage too short");

// Resample every ~40 m along polyline (approx deg)
const spaced = [chain[0]];
let acc = 0;
for (let i = 1; i < chain.length; i++) {
  const a = spaced[spaced.length - 1];
  const b = chain[i];
  const d = Math.hypot((b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 110540);
  acc += d;
  if (acc >= 40) {
    spaced.push(b);
    acc = 0;
  }
}
if (spaced[spaced.length - 1] !== chain[chain.length - 1]) spaced.push(chain[chain.length - 1]);

const rows = ["Latitude,Longitude,BOD mg/L,COD mg/L"];
const seen = new Set();
const crossOffsetsM = [-90, -60, -30, -15, 0, 15, 30, 60, 90];

for (let i = 0; i < spaced.length; i++) {
  const p = spaced[i];
  const q = spaced[Math.min(spaced.length - 1, i + 1)];
  let fx = q.lon - p.lon;
  let fy = q.lat - p.lat;
  const flen = Math.hypot(fx, fy) || 1e-9;
  fx /= flen;
  fy /= flen;
  // Perpendicular in lon/lat (approx)
  const px = -fy;
  const py = fx;
  const t = i / Math.max(1, spaced.length - 1);
  // Mithi urban: higher BOD mid-corridor, slightly lower near mouth/upstream tips.
  const baseBod = 14 + 12 * Math.sin(t * Math.PI) + 4 * Math.sin(t * 6.2);
  const baseCod = 42 + 38 * Math.sin(t * Math.PI) + 10 * Math.sin(t * 4.1);

  for (let oi = 0; oi < crossOffsetsM.length; oi++) {
    const offM = crossOffsetsM[oi];
    const dLon = (px * offM) / (111320 * Math.cos((p.lat * Math.PI) / 180));
    const dLat = (py * offM) / 110540;
    const lat = p.lat + dLat;
    const lon = p.lon + dLon;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = hash01(i, oi);
    const acrossFade = 1 - Math.min(1, Math.abs(offM) / 110);
    const bod = Math.max(4, Math.min(48, (baseBod + (n - 0.5) * 3.5) * (0.75 + 0.35 * acrossFade)));
    const cod = Math.max(15, Math.min(140, (baseCod + (n - 0.5) * 9) * (0.75 + 0.35 * acrossFade)));
    rows.push(`${lat.toFixed(6)},${lon.toFixed(6)},${bod.toFixed(3)},${cod.toFixed(3)}`);
  }
}

fs.writeFileSync(OUT, rows.join("\n") + "\n");
console.info("[mithi-bod-cod]", { points: rows.length - 1, out: OUT });
