import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "mandovi", "mula_mutha"]);
const EXTS = new Set([".js", ".mjs", ".css", ".html", ".json", ".md", ".txt", ".example", ""]);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else {
      const ext = path.extname(p).toLowerCase();
      if (EXTS.has(ext) || name === "Dockerfile" || name === "nginx.conf") out.push(p);
    }
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, "src")),
  path.join(ROOT, "index.html"),
  path.join(ROOT, "package.json"),
  path.join(ROOT, "vite.config.js"),
  path.join(ROOT, "vercel.json"),
  path.join(ROOT, "docker-compose.yml"),
  path.join(ROOT, "nginx.conf"),
  path.join(ROOT, ".env.example"),
  path.join(ROOT, ".env.production"),
].filter((p) => fs.existsSync(p));

function transform(text, file) {
  let next = text;
  next = next.split("/data/mandovi/").join("/data/mithi/");
  next = next.split("public/data/mandovi/").join("public/data/mithi/");
  next = next.split("live_water_mandavi.kml").join("live_water_mithi.kml");
  next = next.split("mandovi_river.kml").join("mithi_river.kml");
  next = next.split("Mandavi River AOI.kml").join("mithi_river.kml");
  next = next.split("Mandovi_River_Coordinates_Cleaned.kml").join("Mithi_River_Coordinates_Cleaned.kml");
  next = next.split("Mandavi River Kml.kml").join("Mithi River Kml.kml");
  next = next.split("osm_mandovi_corridor.json").join("osm_mithi_corridor.json");
  next = next.split("osm_mandovi_trees.json").join("osm_mithi_trees.json");
  next = next.split("Mandovi_Salinity_smoothed_v2.kml").join("Mithi_Salinity_smoothed_v2.kml");
  next = next.split("assets/mandovi-wq").join("assets/mithi-wq");
  next = next.split("eye/data/mandovi").join("eye/data/mithi");
  next = next.split("../data/mandovi/index.js").join("../data/mithi/index.js");
  next = next.split("planet-eye-mandovi").join("planet-eye-mithi");
  next = next.split("mandavi-river").join("mithi-river");

  next = next.replace(/Mandovi River Intelligence Digital Twin/g, "Mithi River Intelligence Digital Twin");
  next = next.replace(/Mandovi River Intelligence Platform/g, "Mithi River Intelligence Platform");
  next = next.replace(/MANDOVI RIVER INTELLIGENCE/g, "MITHI RIVER INTELLIGENCE");
  next = next.replace(/MANDOVI RIVER 3D/g, "MITHI RIVER 3D");
  next = next.replace(/MANDOVI RIVER/g, "MITHI RIVER");
  next = next.replace(/Mandovi River/g, "Mithi River");
  next = next.replace(/Mandavi River/g, "Mithi River");
  next = next.replace(/Mandovi estuary/g, "Mithi corridor");
  next = next.replace(/Mandovi NDCI/g, "Mithi NDCI");
  next = next.replace(/Mandovi smoothed/g, "Mithi smoothed");
  next = next.replace(/Mandovi Sentinel/g, "Mithi Sentinel");
  next = next.replace(/Mandovi KML/g, "Mithi KML");
  next = next.replace(/Monthly Mandovi/g, "Monthly Mithi");
  next = next.replace(/Bundled Mandovi/g, "Bundled Mithi");
  next = next.replace(/high-resolution Mandovi/g, "high-resolution Mithi");
  next = next.replace(/prebundled high-res Mandovi/g, "prebundled high-res Mithi");
  next = next.replace(/Panaji, Goa/g, "Mumbai, Maharashtra");
  next = next.replace(/West Coast India · Mandovi River, Goa/g, "West Coast India · Mithi River, Mumbai");
  next = next.replace(/Moored · Mandovi \(casino berth\)/g, "Moored · Mithi (harbour berth)");

  // Keep code identifiers like isMandovi for curated-pack behavior, but fix user-facing leftovers.
  if (file.endsWith("index.html") || file.endsWith("projectIdentity.js") || file.endsWith("package.json")) {
    next = next.replace(/Mandovi/g, "Mithi").replace(/Mandavi/g, "Mithi").replace(/MANDOVI/g, "MITHI");
  }
  return next;
}

let changed = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const next = transform(text, file);
  if (next !== text) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`rebranded ${changed}/${files.length} files`);
