import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseChainageAnalysisKml } from "../src/eye/geo/kml.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const chainPath = path.join(root, "public/data/mithi/Mithi_Chainage_10m.kml");
const text = fs.readFileSync(chainPath, "utf8");
const parsed = parseChainageAnalysisKml(text);
if (!parsed.centerline?.length) throw new Error("No centreline in chainage KML");

const coords = parsed.centerline.map((c) => `${c.lon},${c.lat},0`).join(" ");
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mithi main stream</name>
<Placemark><name>Water channel centreline</name>
<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
</Placemark></Document></kml>
`;

const outs = [
  path.join(root, "src/eye/data/mithi/mithi_river_main_stream.kml"),
  path.join(root, "public/data/mithi/chainage,upstream,mainstream/mithi_river_main_stream.kml"),
];
for (const out of outs) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, kml);
  console.log("wrote", path.relative(root, out), "pts", parsed.centerline.length);
}
console.log("chainage", parsed.chainage[0]?.label, "→", parsed.chainage.at(-1)?.label, parsed.chainage.at(-1)?.meters, "m");
