/**
 * Curated CSIA / Santa Cruz aeroway fallback (no Overpass).
 * Writes public/data/mithi/osm_mithi_aeroway.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../public/data/mithi/osm_mithi_aeroway.json");

const BOUNDS = {
  west: 72.833,
  south: 19.078,
  east: 72.885,
  north: 19.0985,
};

/** densify centerline [lon,lat][] */
function densify(coords, stepDeg = 0.00035) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    const dlon = lon1 - lon0;
    const dlat = lat1 - lat0;
    const len = Math.hypot(dlon, dlat);
    const n = Math.max(1, Math.ceil(len / stepDeg));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([lon0 + dlon * t, lat0 + dlat * t]);
    }
  }
  return out;
}

function offsetLine(coords, dLon, dLat) {
  return coords.map(([lon, lat]) => [lon + dLon, lat + dLat]);
}

// Published RWY 09/27 ends (VABB)
const rwy09 = [72.848, 19.0884];
const rwy27 = [72.8811, 19.0889];
const rwy09_27 = densify([rwy09, rwy27], 0.0004);

// Published RWY 14/32 ends
const rwy14 = [72.8573, 19.0985];
const rwy32 = [72.8772, 19.0801];
const rwy14_32 = densify([rwy14, rwy32], 0.0004).filter(([, lat]) => lat <= 19.0985 && lat >= 19.078);

// Parallel taxiways south of 09/27 (GA / Kalina fringe)
const twyA = densify(offsetLine([rwy09, rwy27], 0.00015, -0.00155), 0.00045);
const twyB = densify(
  [
    [72.8592, 19.0862],
    [72.8638, 19.08635],
    [72.8675, 19.08645],
    [72.872, 19.08655],
  ],
  0.0004,
);
const twyLink = densify(
  [
    [72.8642, 19.08885],
    [72.86435, 19.0864],
    [72.8645, 19.0852],
  ],
  0.00025,
);
const twyLink2 = densify(
  [
    [72.8602, 19.0887],
    [72.8604, 19.0861],
    [72.86055, 19.08535],
  ],
  0.00025,
);

const aeroway = [
  {
    id: "csia-rwy-09-27",
    name: "09/27",
    aeroway: "runway",
    surface: "asphalt",
    widthM: 60,
    coordinates: rwy09_27,
  },
  {
    id: "csia-rwy-14-32",
    name: "14/32",
    aeroway: "runway",
    surface: "asphalt",
    widthM: 45,
    coordinates: rwy14_32,
  },
  {
    id: "csia-twy-a",
    name: "Taxiway A",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 23,
    coordinates: twyA,
  },
  {
    id: "csia-twy-b",
    name: "Taxiway B (south)",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 18,
    coordinates: twyB,
  },
  {
    id: "csia-twy-link-ga",
    name: "GA link",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 16,
    coordinates: twyLink,
  },
  {
    id: "csia-twy-link-term",
    name: "GA terminal link",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 16,
    coordinates: twyLink2,
  },
  {
    id: "csia-apron-ga",
    name: "General Aviation Apron",
    aeroway: "apron",
    surface: "concrete",
    widthM: 80,
    // closed ring for polygon fill
    coordinates: [
      [72.8594, 19.08405],
      [72.86635, 19.08425],
      [72.86645, 19.08605],
      [72.85955, 19.08585],
      [72.8594, 19.08405],
    ],
  },
  {
    id: "csia-apron-east",
    name: "East apron fringe",
    aeroway: "apron",
    surface: "concrete",
    widthM: 60,
    coordinates: [
      [72.8662, 19.0859],
      [72.8728, 19.08605],
      [72.8729, 19.08735],
      [72.8663, 19.0872],
      [72.8662, 19.0859],
    ],
  },
];

const buildings = [
  // Existing OSM hangar (kept for merge identity)
  {
    id: "436370645",
    name: "Hangar",
    building: "hangar",
    aeroway: "hangar",
    amenity: null,
    levels: 1,
    heightM: 12,
    coordinates: [
      [72.8637747, 19.0853493],
      [72.864448, 19.0853911],
      [72.8650792, 19.0854211],
      [72.8650927, 19.0851854],
      [72.8651226, 19.0847172],
      [72.865062, 19.0847131],
      [72.8638287, 19.0846317],
      [72.8637747, 19.0853493],
    ],
  },
  {
    id: "706495637",
    name: "General Aviation Terminal",
    building: "terminal",
    aeroway: "terminal",
    amenity: null,
    levels: 2,
    heightM: 11,
    coordinates: [
      [72.859818, 19.0856625],
      [72.8599817, 19.0856607],
      [72.8599763, 19.0852222],
      [72.8598127, 19.085224],
      [72.859818, 19.0856625],
    ],
  },
  // Additional GA hangar row (analyst volumes along apron)
  {
    id: "csia-hangar-02",
    name: "GA Hangar 2",
    building: "hangar",
    aeroway: "hangar",
    levels: 1,
    heightM: 11,
    coordinates: [
      [72.86155, 19.08528],
      [72.86255, 19.08532],
      [72.86258, 19.08472],
      [72.86158, 19.08468],
      [72.86155, 19.08528],
    ],
  },
  {
    id: "csia-hangar-03",
    name: "GA Hangar 3",
    building: "hangar",
    aeroway: "hangar",
    levels: 1,
    heightM: 10.5,
    coordinates: [
      [72.8627, 19.08534],
      [72.86355, 19.08537],
      [72.86358, 19.08478],
      [72.86273, 19.08475],
      [72.8627, 19.08534],
    ],
  },
  {
    id: "csia-hangar-04",
    name: "GA Hangar 4",
    building: "hangar",
    aeroway: "hangar",
    levels: 1,
    heightM: 13,
    coordinates: [
      [72.86525, 19.0854],
      [72.86635, 19.08544],
      [72.86638, 19.0847],
      [72.86528, 19.08466],
      [72.86525, 19.0854],
    ],
  },
  {
    id: "csia-ops-01",
    name: "Airport ops block",
    building: "transportation",
    aeroway: "terminal",
    levels: 2,
    heightM: 9,
    coordinates: [
      [72.86035, 19.08555],
      [72.86095, 19.08557],
      [72.86097, 19.0851],
      [72.86037, 19.08508],
      [72.86035, 19.08555],
    ],
  },
  {
    id: "csia-hangar-north",
    name: "North fringe hangar",
    building: "hangar",
    aeroway: "hangar",
    levels: 1,
    heightM: 14,
    coordinates: [
      [72.8682, 19.08755],
      [72.8696, 19.0876],
      [72.86965, 19.08685],
      [72.86825, 19.0868],
      [72.8682, 19.08755],
    ],
  },
];

const payload = {
  generated_at: new Date().toISOString(),
  source: "CURATED_CSIA_FALLBACK",
  note: "CSIA / Santa Cruz aeroway for Mithi twin (Overpass fallback)",
  bounds: BOUNDS,
  aeroway,
  buildings,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
console.info("[aeroway] wrote fallback", OUT, {
  aeroway: aeroway.length,
  buildings: buildings.length,
});
