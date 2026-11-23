/**
 * Verify chainage points sit inside water_depth (1).kml permanent-water mask.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

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
  return {
    north: num("north"),
    south: num("south"),
    east: num("east"),
    west: num("west"),
  };
}

function extractPng(kml) {
  const href = kml.match(/<href>\s*(data:image\/png;base64,[A-Za-z0-9+/=\s]+)\s*<\/href>/i)?.[1];
  if (!href) return null;
  return Buffer.from(href.replace(/^data:image\/png;base64,/i, "").replace(/\s+/g, ""), "base64");
}

function isLiveWaterPixel(r, g, b, a) {
  if (a < 20) return false;
  if (b > 60 && b >= r && b >= g && (b - r >= 12 || b - g >= 8)) return true;
  if (b > 80 && g > 40 && r < 140 && b >= r * 0.9) return true;
  if (a > 160 && b > 50 && b > r && b > g * 0.85) return true;
  return false;
}

async function decodePng(buf) {
  // Prefer sharp if present; else use pngjs via dynamic import fallback with canvas-less scan
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
}

function sampleMask(mask, width, height, box, lon, lat) {
  const { north, south, east, west } = box;
  if (!(lon >= west && lon <= east && lat >= south && lat <= north)) return false;
  const u = (lon - west) / Math.max(1e-12, east - west);
  const v = (north - lat) / Math.max(1e-12, north - south);
  const ix = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
  const iy = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
  return mask[iy * width + ix] === 1;
}

async function main() {
  const depthKml = stripNs(fs.readFileSync(path.join(ROOT, "src/data/water_depth (1).kml"), "utf8"));
  const chainKml = fs.readFileSync(path.join(ROOT, "src/data/Mithi_Chainage_10m.kml"), "utf8");
  const box = parseLatLonBox(depthKml);
  const png = extractPng(depthKml);
  if (!box || !png) throw new Error("missing box/png");

  const { data, width, height } = await decodePng(png);
  const mask = new Uint8Array(width * height);
  let waterCount = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (isLiveWaterPixel(data[p], data[p + 1], data[p + 2], data[p + 3])) {
      mask[i] = 1;
      waterCount++;
    }
  }

  const pts = [...chainKml.matchAll(/<Placemark>\s*<name>(\d+\+\d+)<\/name>[\s\S]*?<coordinates>\s*([\d.\-]+),([\d.\-]+)/gi)].map(
    (m) => ({ label: m[1], lon: +m[2], lat: +m[3] }),
  );

  let inside = 0;
  const misses = [];
  for (const p of pts) {
    if (sampleMask(mask, width, height, box, p.lon, p.lat)) inside++;
    else misses.push(p);
  }

  // Also write public assets fresh
  const OUT = path.join(ROOT, "public/data/mithi");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "water_depth_overlay.png"), png);
  fs.writeFileSync(path.join(OUT, "live_water_extent.png"), png);
  fs.writeFileSync(
    path.join(OUT, "live_water_extent.json"),
    JSON.stringify(
      {
        river: "Mithi",
        bounds: { ...box, rotation: 0 },
        overlay: "/data/mithi/live_water_extent.png",
        source: "src/data/water_depth (1).kml — permanent water / MNDWI bathymetry extent",
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(OUT, "water_depth.json"),
    JSON.stringify(
      {
        river: "Mithi",
        bounds: { ...box, rotation: 0 },
        overlay: "/data/mithi/water_depth_overlay.png",
        source: "src/data/water_depth (1).kml",
        description: "Permanent water / relative bathymetry extent (Sentinel-2 MNDWI)",
        minDepth: 0.5,
        maxDepth: 5.0,
        unit: "m",
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.info(
    JSON.stringify(
      {
        box,
        pngBytes: png.length,
        grid: `${width}x${height}`,
        waterPixels: waterCount,
        coveragePct: Number(((100 * waterCount) / mask.length).toFixed(2)),
        chainagePoints: pts.length,
        insideWater: inside,
        outsideWater: misses.length,
        missSample: misses.slice(0, 8),
        first: pts[0],
        last: pts.at(-1),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
