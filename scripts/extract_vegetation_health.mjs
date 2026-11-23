import fs from "fs";
import path from "path";

const root = "c:/Users/Sahil.Rajankar/Desktop/Shweta/Mithi_river";
const src = path.join(root, "src/data/vegetation_health (1).kml");
const t = fs.readFileSync(src, "utf8");
const hrefM = t.match(/<(?:\w+:)?href>\s*(data:image\/png;base64,[^<]+)\s*<\/(?:\w+:)?href>/i);
if (!hrefM) throw new Error("No PNG data URL in vegetation_health KML");
const b64 = hrefM[1].replace(/^data:image\/png;base64,/i, "");
const buf = Buffer.from(b64, "base64");
const outDir = path.join(root, "public/data/hydrology/vegetation");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "vegetation_health_overlay.png"), buf);

function grab(tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}>\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*<\\/(?:\\w+:)?${tag}>`, "i");
  return Number((t.match(re) || [])[1]);
}
const north = grab("north");
const south = grab("south");
const east = grab("east");
const west = grab("west");

const meta = {
  source: "src/data/vegetation_health (1).kml",
  bounds: { north, south, east, west },
  classes: [
    { id: "very_healthy", label: "Very Healthy (80-100)", color: "#006400", min: 80, max: 100 },
    { id: "healthy", label: "Healthy (65-80)", color: "#32CD32", min: 65, max: 80 },
    { id: "moderate", label: "Moderate (50-65)", color: "#FFFF00", min: 50, max: 65 },
    { id: "poor", label: "Poor (35-50)", color: "#FF8C00", min: 35, max: 50 },
    { id: "critical", label: "Critical (0-35)", color: "#FF0000", min: 0, max: 35 },
  ],
  formula: "50% NDVI · 30% NDMI · 20% EVI",
  mean_health_score: 68.4,
  vegetation_area_ha: 515.66,
};
fs.writeFileSync(path.join(outDir, "vegetation_health_meta.json"), JSON.stringify(meta, null, 2));

const slim = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>Vegetation Health Score</name>
<description>Vegetation health (50% NDVI · 30% NDMI · 20% EVI)
VEGETATION HEALTH SCORE
#006400  80-100  Very Healthy
#32CD32  65-80  Healthy
#FFFF00  50-65  Moderate
#FF8C00  35-50  Poor
#FF0000  0-35  Critical</description>
<GroundOverlay>
<name>Vegetation Health</name>
<Icon><href>/data/hydrology/vegetation/vegetation_health_overlay.png</href></Icon>
<LatLonBox>
<north>${north}</north><south>${south}</south><east>${east}</east><west>${west}</west>
</LatLonBox>
</GroundOverlay>
</Document></kml>`;
fs.writeFileSync(path.join(root, "src/data/vegetation_health.kml"), slim);
fs.writeFileSync(path.join(root, "public/data/mithi/vegetation_health.kml"), slim);
console.log({ pngBytes: buf.length, north, south, east, west });
