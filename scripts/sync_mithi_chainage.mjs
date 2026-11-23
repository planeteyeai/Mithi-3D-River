import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public/data/mithi/Mithi_Chainage_10m.kml");
const targets = [
  path.join(root, "src/eye/data/mithi/mithi_river_chainage_10m.kml"),
  path.join(root, "public/data/mithi/chainage,upstream,mainstream/mithi_river_chainage_10m.kml"),
];

const text = fs.readFileSync(src, "utf8");
if (!/<kml\b/i.test(text)) throw new Error("Source is not valid KML");
const n = [...text.matchAll(/<Placemark>\s*<name>(\d+\+\d+)<\/name>/gi)].length;
for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, text);
  console.log("wrote", path.relative(root, t), "stations≈", n);
}
console.log("source", path.relative(root, src), "bytes", text.length);
