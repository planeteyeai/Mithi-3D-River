import fs from "node:fs";

const depth = fs.readFileSync("./src/data/water_depth (1).kml", "utf8");
const chain = fs.readFileSync("./src/data/Mithi_Chainage_10m.kml", "utf8");
const oldChain = fs.readFileSync("./src/eye/data/mithi/mithi_river_chainage_10m.kml", "utf8");
const oldDepth = fs.readFileSync("./public/data/mithi/water_depth.kml", "utf8");

console.log("=== WATER DEPTH NEW ===");
console.log("len", depth.length);
console.log("head", depth.slice(0, 1800));
const box = depth.match(/<LatLonBox>[\s\S]*?<\/LatLonBox>/i);
console.log("box", box?.[0]);
const hrefs = [...depth.matchAll(/<href>([^<]+)<\/href>/gi)].map((m) => m[1]);
console.log("hrefs", hrefs);
const names = [...depth.matchAll(/<name>([^<]*)<\/name>/gi)].slice(0, 20).map((m) => m[1]);
console.log("names", names);
console.log("has GroundOverlay", /GroundOverlay/i.test(depth));
console.log("has Polygon", /Polygon/i.test(depth));
console.log("has Point", /<Point>/i.test(depth));

console.log("\n=== WATER DEPTH OLD PUBLIC ===");
console.log("len", oldDepth.length);
console.log("head", oldDepth.slice(0, 800));
console.log("box", oldDepth.match(/<LatLonBox>[\s\S]*?<\/LatLonBox>/i)?.[0]);

function chainStats(kml, label) {
  const pts = [...kml.matchAll(/<Point>\s*<coordinates>\s*([\d.\-]+),([\d.\-]+)/gi)].map((m) => ({
    lon: +m[1],
    lat: +m[2],
  }));
  const chainNames = [...kml.matchAll(/<Placemark>\s*<name>([^<]+)<\/name>/gi)]
    .map((m) => m[1])
    .filter((n) => /^\d+\+\d+$/.test(n));
  console.log(label, {
    points: pts.length,
    chainNames: chainNames.length,
    first: { name: chainNames[0], ...pts[0] },
    last: { name: chainNames.at(-1), ...pts.at(-1) },
  });
}

console.log("\n=== CHAINAGE ===");
chainStats(chain, "NEW");
chainStats(oldChain, "OLD");
