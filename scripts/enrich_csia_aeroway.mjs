/**
 * Enrich CSIA aeroway pack with AIP runway geometry + GA hangars / cargo /
 * maintenance footprints aligned to published lon/lat (no invented rotation).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../public/data/mithi/osm_mithi_aeroway.json");

function densify(coords, stepDeg = 0.00035) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    const dlon = lon1 - lon0;
    const dlat = lat1 - lat0;
    const len = Math.hypot(dlon, dlat);
    const n = Math.max(1, Math.ceil(len / stepDeg));
    for (let k = 1; k <= n; k++) out.push([lon0 + dlon * (k / n), lat0 + dlat * (k / n)]);
  }
  return out;
}

function offset(coords, dLon, dLat) {
  return coords.map(([lon, lat]) => [lon + dLon, lat + dLat]);
}

const rwy09_27 = densify(
  [
    [72.848, 19.0884],
    [72.8811, 19.0889],
  ],
  0.00032,
);
const rwy14_32 = densify(
  [
    [72.8573, 19.0985],
    [72.8772, 19.0801],
  ],
  0.00032,
);

const aeroway = [
  {
    id: "csia-rwy-09-27",
    name: "09/27",
    ref: "09/27",
    aeroway: "runway",
    surface: "asphalt",
    widthM: 60,
    designations: { start: "09", end: "27" },
    coordinates: rwy09_27,
    source: "AIP_PUBLISHED",
  },
  {
    id: "csia-rwy-14-32",
    name: "14/32",
    ref: "14/32",
    aeroway: "runway",
    surface: "asphalt",
    widthM: 45,
    designations: { start: "14", end: "32" },
    coordinates: rwy14_32,
    source: "AIP_PUBLISHED",
  },
  {
    id: "csia-twy-parallel-s",
    name: "Taxiway parallel south",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 23,
    coordinates: densify(offset([[72.849, 19.0884], [72.8805, 19.0889]], 0.0001, -0.00155), 0.0004),
    source: "AIP_ALIGNED",
  },
  {
    id: "csia-twy-parallel-n",
    name: "Taxiway parallel north",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 23,
    coordinates: densify(offset([[72.8495, 19.0884], [72.8798, 19.0889]], 0.00005, 0.00135), 0.0004),
    source: "AIP_ALIGNED",
  },
  {
    id: "csia-twy-ga-link",
    name: "GA apron link",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 16,
    coordinates: densify(
      [
        [72.8642, 19.08885],
        [72.8645, 19.0852],
      ],
      0.00022,
    ),
    source: "AIP_ALIGNED",
  },
  {
    id: "csia-twy-t1-link",
    name: "T1 apron link",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 18,
    coordinates: densify(
      [
        [72.8565, 19.08855],
        [72.8562, 19.0904],
      ],
      0.0002,
    ),
    source: "AIP_ALIGNED",
  },
  {
    id: "csia-twy-t2-link",
    name: "T2 apron link",
    aeroway: "taxiway",
    surface: "asphalt",
    widthM: 20,
    coordinates: densify(
      [
        [72.8735, 19.0892],
        [72.8738, 19.0958],
      ],
      0.00022,
    ),
    source: "AIP_ALIGNED",
  },
  {
    id: "csia-apron-ga",
    name: "General Aviation Apron",
    aeroway: "apron",
    surface: "concrete",
    widthM: 80,
    coordinates: [
      [72.8594, 19.08405],
      [72.86635, 19.08425],
      [72.86645, 19.08605],
      [72.85955, 19.08585],
      [72.8594, 19.08405],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-apron-t1",
    name: "Terminal 1 Apron",
    aeroway: "apron",
    surface: "concrete",
    widthM: 100,
    coordinates: [
      [72.8538, 19.0892],
      [72.8592, 19.08945],
      [72.8594, 19.09155],
      [72.854, 19.0913],
      [72.8538, 19.0892],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-apron-t2",
    name: "Terminal 2 Apron",
    aeroway: "apron",
    surface: "concrete",
    widthM: 120,
    coordinates: [
      [72.8692, 19.0948],
      [72.878, 19.0952],
      [72.8782, 19.0986],
      [72.8694, 19.0982],
      [72.8692, 19.0948],
    ],
    source: "GE_ALIGNED",
  },
];

const buildings = [
  {
    id: "csia-t1",
    name: "Terminal 1",
    building: "terminal",
    aeroway: "terminal",
    levels: 3,
    heightM: 16,
    coordinates: [
      [72.8542, 19.0912],
      [72.8588, 19.0914],
      [72.8589, 19.0896],
      [72.8543, 19.0894],
      [72.8542, 19.0912],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-t2",
    name: "Terminal 2",
    building: "terminal",
    aeroway: "terminal",
    levels: 4,
    heightM: 28,
    coordinates: [
      [72.8695, 19.0982],
      [72.8772, 19.0985],
      [72.8775, 19.0954],
      [72.8698, 19.0951],
      [72.8695, 19.0982],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "706495637",
    name: "General Aviation Terminal",
    building: "terminal",
    aeroway: "terminal",
    levels: 2,
    heightM: 11,
    coordinates: [
      [72.859818, 19.0856625],
      [72.8599817, 19.0856607],
      [72.8599763, 19.0852222],
      [72.8598127, 19.085224],
      [72.859818, 19.0856625],
    ],
    source: "OPENSTREETMAP",
  },
  {
    id: "436370645",
    name: "Hangar",
    building: "hangar",
    aeroway: "hangar",
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
    source: "OPENSTREETMAP",
  },
  {
    id: "csia-hangar-02",
    name: "GA Hangar 2",
    building: "hangar",
    aeroway: "hangar",
    heightM: 11,
    coordinates: [
      [72.86155, 19.08528],
      [72.86255, 19.08532],
      [72.86258, 19.08472],
      [72.86158, 19.08468],
      [72.86155, 19.08528],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-hangar-03",
    name: "GA Hangar 3",
    building: "hangar",
    aeroway: "hangar",
    heightM: 10.5,
    coordinates: [
      [72.8627, 19.08534],
      [72.86355, 19.08537],
      [72.86358, 19.08478],
      [72.86273, 19.08475],
      [72.8627, 19.08534],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-hangar-04",
    name: "GA Hangar 4",
    building: "hangar",
    aeroway: "hangar",
    heightM: 13,
    coordinates: [
      [72.86525, 19.0854],
      [72.86635, 19.08544],
      [72.86638, 19.0847],
      [72.86528, 19.08466],
      [72.86525, 19.0854],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-cargo-01",
    name: "Cargo complex",
    building: "hangar",
    aeroway: "hangar",
    heightM: 14,
    coordinates: [
      [72.8674, 19.0862],
      [72.8692, 19.0863],
      [72.8693, 19.0852],
      [72.8675, 19.0851],
      [72.8674, 19.0862],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-mro-01",
    name: "Maintenance hangar",
    building: "hangar",
    aeroway: "hangar",
    heightM: 16,
    coordinates: [
      [72.8682, 19.08755],
      [72.8698, 19.08762],
      [72.86985, 19.0867],
      [72.86825, 19.08663],
      [72.8682, 19.08755],
    ],
    source: "GE_ALIGNED",
  },
  {
    id: "csia-admin-01",
    name: "Airport administration",
    building: "terminal",
    aeroway: "terminal",
    heightM: 12,
    coordinates: [
      [72.86035, 19.08555],
      [72.86095, 19.08557],
      [72.86097, 19.0851],
      [72.86037, 19.08508],
      [72.86035, 19.08555],
    ],
    source: "GE_ALIGNED",
  },
];

/** Gate / stand parking positions for ops layer (WGS84). */
const stands = [
  // T1 apron
  { id: "T1-G1", lon: 72.8552, lat: 19.0902, hdg: 90, type: "narrow" },
  { id: "T1-G2", lon: 72.8562, lat: 19.09025, hdg: 90, type: "narrow" },
  { id: "T1-G3", lon: 72.8572, lat: 19.0903, hdg: 90, type: "narrow" },
  { id: "T1-G4", lon: 72.8582, lat: 19.09035, hdg: 90, type: "narrow" },
  // GA apron
  { id: "GA-01", lon: 72.8612, lat: 19.0851, hdg: 0, type: "ga" },
  { id: "GA-02", lon: 72.8624, lat: 19.08515, hdg: 0, type: "ga" },
  { id: "GA-03", lon: 72.8636, lat: 19.0852, hdg: 0, type: "ga" },
  { id: "GA-04", lon: 72.865, lat: 19.08525, hdg: 0, type: "ga" },
  // T2 apron
  { id: "T2-G1", lon: 72.871, lat: 19.0964, hdg: 180, type: "wide" },
  { id: "T2-G2", lon: 72.8724, lat: 19.0965, hdg: 180, type: "wide" },
  { id: "T2-G3", lon: 72.8738, lat: 19.09655, hdg: 180, type: "wide" },
  { id: "T2-G4", lon: 72.8752, lat: 19.0966, hdg: 180, type: "wide" },
  { id: "T2-G5", lon: 72.8764, lat: 19.09665, hdg: 180, type: "narrow" },
];

/** Slow taxi paths along taxiways (lon/lat polylines). */
const taxiRoutes = [
  {
    id: "taxi-south",
    coordinates: densify(offset([[72.85, 19.0884], [72.878, 19.0889]], 0.0001, -0.00155), 0.0005),
  },
  {
    id: "taxi-ga",
    coordinates: densify(
      [
        [72.8642, 19.08885],
        [72.8645, 19.0854],
      ],
      0.0003,
    ),
  },
];

const payload = {
  generated_at: new Date().toISOString(),
  source: "AIP+GE_ALIGNED+OSM",
  note: "CSIA digital twin — WGS84 only, no independent rotation",
  bounds: { west: 72.833, south: 19.078, east: 72.885, north: 19.105 },
  aeroway,
  buildings,
  stands,
  taxiRoutes,
};

fs.writeFileSync(OUT, JSON.stringify(payload));
console.info("[enrich] wrote", OUT, {
  aeroway: aeroway.length,
  buildings: buildings.length,
  stands: stands.length,
});
