/**
 * Hydrology thematic overlays for MULA-MUTHA-3D.
 * Ground overlays (geology, bank_erosion) + Salinity polygons.
 * Land Use / WQ / Pollution / AQI are config-only unavailable — no fake data.
 *
 * Self-contained under /data/hydrology — no runtime dependency on Shweta_River-2.0.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { lonLatToLocal, localToLonLat } from "../geo/geoReference.js";
import { parseClassedPolygonKml } from "../geo/kml.js";
import { overlayBoxToLocalBounds } from "../utils/floodGeometry.js";
import { terrainHeightAt } from "./terrain.js";
import { SURFACE_Y } from "./river.js";
import { applyDrapeDepth } from "./drapeDepth.js";
import { createPollutionGarbageLayer } from "./pollutionGarbageLayer.js";
/** Bundled asset — Vite always serves this (public/data new files can 404 as HTML). */
import bankErosionOverlayUrl from "../assets/hydrology/bank_erosion_overlay.png";
import bankErosionLegendUrl from "../assets/hydrology/bank_erosion_legend.png";
/** Mandovi WQ KMLs — bundled so they never 404 as HTML from public/. */
import mandoviTssKmlUrl from "../assets/mithi-wq/tss.kml?url";
import mandoviChlorophyllKmlUrl from "../assets/mithi-wq/chlorophyll.kml?url";
/** Mandovi salinity smoothed classes — same KML as Google Earth “Mandovi Salinity (smoothed classes)”. */
import mandoviSalinityKmlUrl from "../assets/mithi-wq/salinity.kml?url";
import { LITHOLOGY_CLASSES } from "../ui/components/geologyWorkspace.js";
import {
  createBankErosionMaterial,
  updateBankErosionMaterial,
} from "./hydrology/bankErosionMaterial.js";
import {
  classRepresentativeValue,
  formatWqValue,
  WQ_LAYER_SCHEMES,
  CHLOROPHYLL_CLASSES,
  SALINITY_CLASSES,
  TSS_CLASSES,
} from "../geo/waterQualityClasses.js";
import {
  ensureLiveOverlay,
  liveLayerDef,
  maskOverlayImageToRiverAoi,
  parseOverlayKml,
} from "../session/liveLayers.js";

const CLASSIFICATION_KMLS = import.meta.glob("../../data/Classification/*.kml", {
  eager: true,
  query: "?url",
  import: "default",
});
const VOLUME_KMLS = import.meta.glob("../../data/Volume/*.kml", {
  eager: true,
  query: "?url",
  import: "default",
});

const CONFIG_URL = "/data/hydrology/hydrologyConfig.json";
const CONFIG_VERSION = 39; // salinity LatLonBox + pollution polygons + Mithi LULC bounds
const siltGroundOverlayCache = new Map();

const POLYGON_LAYER_IDS = new Set([
  "water_quality_ndwi",
  "water_quality_wst",
  "pollution_eutrophication",
  "pollution_nitrogen",
  "pollution_coliform",
  "landuse_lulc",
]);

const DRAPED_CLASS_LAYER_IDS = new Set([
  "geology",
  "bank_erosion",
  "vegetation_extent",
  "vegetation_health",
  "water_depth",
  "water_quality_tss",
  "water_quality_ndci",
  "salinity",
]);

/** Exact Mithi LatLonBox from JalNetra / WATERQ salinity + water-depth KMLs (no pad). */
const MITHI_CORRIDOR_BOUNDS = {
  north: 19.08782672,
  south: 19.04514933,
  east: 72.87929619,
  west: 72.83456075,
};

/** @deprecated alias — historical Mandovi name; values are Mithi. */
const MANDOVI_POLLUTION_BOUNDS = { ...MITHI_CORRIDOR_BOUNDS };

/** True if LatLonBox centroid sits on the Mithi corridor (not Mula–Mutha / Mandovi). */
function isMithiLatLonBox(bounds) {
  if (!bounds) return false;
  const n = Number(bounds.north);
  const s = Number(bounds.south);
  const e = Number(bounds.east);
  const w = Number(bounds.west);
  if (![n, s, e, w].every(Number.isFinite) || e <= w || n <= s) return false;
  const midLat = (n + s) / 2;
  const midLon = (e + w) / 2;
  return midLat > 18.95 && midLat < 19.2 && midLon > 72.75 && midLon < 73.05;
}

/** Google Earth class rasters use their LatLonBox directly, never a river-paste ribbon. */
function isMandoviFlatRaster(id) {
  return (
    id === "salinity" ||
    id === "water_quality_tss" ||
    id === "water_quality_ndci"
  );
}

/**
 * All JalNetra GroundOverlays (including bank erosion) keep their true LatLonBox.
 * Remapping erosion onto a twin ribbon made it look different from the KML in Earth.
 */
function usesRiverCorridorPaste(_id) {
  return false;
}

function usesExactGroundOverlayFootprint(id) {
  return (
    id === "water_depth" ||
    id === "geology" ||
    id === "bank_erosion" ||
    id === "vegetation_extent" ||
    id === "vegetation_health" ||
    id === "landuse_lulc" ||
    id === "silt_classification" ||
    id === "silt_volume_surface" ||
    id === "salinity" ||
    isMandoviFlatRaster(id) ||
    String(id || "").startsWith("water_quality_") ||
    String(id || "").startsWith("pollution_") ||
    DRAPED_CLASS_LAYER_IDS.has(id)
  );
}

/** Always show the LatLonBox GroundOverlay; hide any legacy corridor paste. */
function showExactOverlayFootprint(slot, _id = null) {
  if (!slot?.mesh && !slot?.paste) return;
  if (slot.mesh) slot.mesh.visible = true;
  if (slot.paste) slot.paste.visible = false;
}

const EUTROPHICATION_CLASSES = [
  { id: "oligo", label: "Oligotrophic", range: "< 2.6 µg/L", color: "#2c7bb6" },
  { id: "meso", label: "Mesotrophic", range: "2.6–7.3 µg/L", color: "#abd9e9" },
  { id: "eutro", label: "Eutrophic", range: "7.3–56 µg/L", color: "#fdae61" },
  { id: "hyper", label: "Hypereutrophic", range: "> 56 µg/L", color: "#d7191c" },
];

const NITROGEN_RISK_CLASSES = [
  { id: "low", label: "Low", color: "#1a9641" },
  { id: "moderate", label: "Moderate", color: "#ffffbf" },
  { id: "high", label: "High", color: "#d7191c" },
];

const COLIFORM_CLASSES = [
  { id: "good", label: "Good", range: "≤ 250 CFU/100 ml", color: "#2c7bb6" },
  { id: "moderate", label: "Moderate", range: "260–500", color: "#91cf60" },
  { id: "high", label: "High", range: "500–2000", color: "#fdae61" },
  { id: "highly_risk", label: "Highly risk", range: "> 2000", color: "#d7191c" },
];

const VEGETATION_EXTENT_CLASSES = [
  { id: "non_vegetation", label: "Non-Vegetation", color: "#A9A9A9" },
  { id: "trees", label: "Trees", color: "#228B22" },
  { id: "shrub", label: "Shrub / Scrub", color: "#9ACD32" },
  { id: "grass", label: "Grass / Herbaceous", color: "#90EE90" },
  { id: "mixed", label: "Mixed / Diverse", color: "#8A2BE2" },
];

const LULC_LEGEND = [
  { label: "Forest", color: "#006400" },
  { label: "Crop Land", color: "#E6A23C" },
  { label: "Barren Land", color: "#A9A9A9" },
  { label: "Water Bodies", color: "#2196F3" },
  { label: "Settlements", color: "#C62828" },
];

/** 2021–2025 KMZ raster class codes (baked into overlay PNG). */
const LULC_CLASSES = [
  { id: "class_0", kmlClass: "Class 0", label: "Forest", color: "#006400" },
  { id: "class_1", kmlClass: "Class 1", label: "Crop Land", color: "#E6A23C" },
  { id: "class_2", kmlClass: "Class 2", label: "Barren Land", color: "#A9A9A9" },
  { id: "class_3", kmlClass: "Class 3", label: "Water Bodies", color: "#2196F3" },
  { id: "class_4", kmlClass: "Class 4", label: "Settlements", color: "#C62828" },
];

/**
 * 2026 vector KML uses a different Class index → meaning than the KMZ rasters.
 * Native KML colors: 0 blue, 1 red, 2 green, 3 gold, 4 brown.
 * Reference: green = forest / class 2, red = settlements.
 */
const LULC_CLASSES_2026 = [
  { id: "class_0", kmlClass: "Class 0", label: "Water Bodies", color: "#2196F3" },
  { id: "class_1", kmlClass: "Class 1", label: "Settlements", color: "#C62828" },
  { id: "class_2", kmlClass: "Class 2", label: "Forest", color: "#006400" },
  { id: "class_3", kmlClass: "Class 3", label: "Crop Land", color: "#E6A23C" },
  { id: "class_4", kmlClass: "Class 4", label: "Barren Land", color: "#A9A9A9" },
];

/** Offline LULC years — Mithi LatLonBox only (never Mula–Mutha / Pune). */
const LULC_YEARS = [2021, 2022, 2023, 2024, 2025, 2026].map((year) => ({
  year,
  type: "groundOverlay",
  overlay: `/data/hydrology/lulc/${year}/overlay.png`,
  bounds: { ...MITHI_CORRIDOR_BOUNDS },
}));

export const SILT_CLASS_BOUNDS = { ...MITHI_CORRIDOR_BOUNDS };

/** Mandovi silt classification palette (matches Classification/*.kml descriptions). */
export const SILT_CLASS_CLASSES = [
  { id: "low", label: "Low", color: "#00FF00", kmlClass: "stable" },
  { id: "moderate", label: "Moderate", color: "#FFFF00", kmlClass: "deposition" },
  { id: "high", label: "High", color: "#FFA500" },
  { id: "very_high", label: "Very High", color: "#FF0000", kmlClass: "erosion" },
];

const SILT_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function localKmlPeriods(assets, manifest, kind) {
  return manifest.flatMap(([file, month]) => {
    const kml = Object.entries(assets).find(([path]) => path.endsWith(`/${file}`))?.[1];
    // Local Classification/Volume packs are polygon KMLs (Mithi lon/lat rings), not GroundOverlays.
    return kml ? [{
      id: `2026-${String(month).padStart(2, "0")}`,
      label: `${SILT_MONTHS[month - 1].slice(0, 3)} 2026`,
      year: 2026,
      month,
      type: "kmlPolygons",
      data: kml,
      kml,
      expectedTitle: `Silt ${kind} — ${SILT_MONTHS[month - 1]} 2026`,
    }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// These manifests intentionally list only KMLs whose embedded titles match the folder,
// type, and month. The two September-named files contain unrelated duplicate KML content.
export const SILT_CLASS_PERIODS = localKmlPeriods(CLASSIFICATION_KMLS, [
  ["jan_class_silt.kml", 1], ["feb_class.kml", 2], ["march_class.kml", 3],
  ["April_class.kml", 4], ["June_class.kml", 6], ["July_class.kml", 7],
  ["Aug_class.kml", 8], ["Oct_class.kml", 10],
], "Classification");

/** Continuous silt volume surface (YlOrBr, fixed 0–96.37 scale). Same LatLonBox as classification. */
const SILT_VOLUME_BOUNDS = { ...SILT_CLASS_BOUNDS };

/** Continuous silt volume ramp (YlOrBr). `value` is the scale endpoint for hover sampling. */
export const SILT_VOLUME_MAX = 96.37;
const SILT_VOLUME_CLASSES = [
  { id: "v0", label: "0 m³", color: "#FFFFE5", value: 0, tag: "low", unit: "m³", kmlClass: "stable" },
  { id: "v25", label: "24.1 m³", color: "#FEC44F", value: SILT_VOLUME_MAX * 0.25, tag: "", unit: "m³" },
  { id: "v50", label: "48.2 m³", color: "#FE9929", value: SILT_VOLUME_MAX * 0.5, tag: "", unit: "m³", kmlClass: "deposition" },
  { id: "v75", label: "72.3 m³", color: "#D95F0E", value: SILT_VOLUME_MAX * 0.75, tag: "", unit: "m³", kmlClass: "moderate" },
  { id: "v100", label: "96.37 m³", color: "#662506", value: SILT_VOLUME_MAX, tag: "high", unit: "m³", kmlClass: "erosion" },
  { id: "low", label: "Low", color: "#FFFFE5", value: 0, unit: "m³", kmlClass: "low" },
  { id: "high", label: "High", color: "#662506", value: SILT_VOLUME_MAX, unit: "m³", kmlClass: "high" },
];

export const SILT_VOLUME_PERIODS = [
  ...localKmlPeriods(VOLUME_KMLS, [
    ["Jan_vol.kml", 1], ["Feb_vol.kml", 2], ["March_vol.kml", 3],
    ["April_vol.kml", 4], ["May_vol.kml", 5], ["June_vol.kml", 6],
    ["July_vol.kml", 7], ["Aug_vol.kml", 8], ["Oct_vol.kml", 10],
  ], "Volume Surface"),
];

async function loadSiltKmlGroundOverlay(period) {
  // Live JalNetra periods already carry overlay/bounds — no local KML parse needed.
  if (!period?.kml) return null;
  if (period.overlay && period.bounds) return null;
  const key = String(period.kml);
  if (!siltGroundOverlayCache.has(key)) {
    const pending = (async () => {
      const res = await fetch(key);
      if (!res.ok) throw new Error(`Could not load monthly silt KML (${res.status})`);
      const text = await res.text();
      // Do not enforce embedded <name> titles — folder filenames / JalNetra labels vary.
      const parsed = parseOverlayKml(text, key);
      if (!parsed.ground) throw new Error(`Monthly KML has no usable image and LatLonBox (${period.id})`);
      return parsed;
    })();
    siltGroundOverlayCache.set(key, pending);
    pending.catch(() => siltGroundOverlayCache.delete(key));
  }
  return siltGroundOverlayCache.get(key);
}

/** Hardcoded fallbacks so Bank Erosion / Silt / Chlorophyll work even if an old config is cached. */
const BUILTIN_LAYER_DEFS = {
  water_quality_ndci: {
    id: "water_quality_ndci",
    name: "Chlorophyll-a",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    kmlUrl: mandoviChlorophyllKmlUrl,
    bounds: { ...MANDOVI_POLLUTION_BOUNDS },
    overlay: "",
    opacity: 0.92,
    gridSegments: 144,
    liftM: 0.85,
    flipU: false,
    flipV: true,
    legendTitle: "Chlorophyll-a",
    legendSubtitle: "2 classes · Mithi NDCI proxy",
    unit: "NDCI",
    classes: CHLOROPHYLL_CLASSES,
    legendClasses: CHLOROPHYLL_CLASSES,
    renderType: "terrainDrapedTexture",
  },
  salinity: {
    id: "salinity",
    name: "SALINITY",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    /** Prefer LatLonBox GroundOverlay so the raster hugs the river KML mask. */
    kmlUrl: "/data/mithi/jalnetra-history/salinity1_21-10-2026__18-11-2026.kml",
    kmlUrlFallbacks: [
      "/data/mithi/WATERQ-Pollution/salinity.kml",
      mandoviSalinityKmlUrl,
    ],
    /** Coarse zone polygons only if GroundOverlay image is missing. */
    data: "/data/mithi/WATERQ-Pollution/Mithi_Salinity_smoothed_v2.kml",
    dataFallbacks: [
      "/data/mithi/WATERQ-Pollution/Mithi_Salinity_smoothed_v2.kml",
      mandoviSalinityKmlUrl,
    ],
    source: "salinity1_21-10-2026|18-11-2026",
    opacity: 0.95,
    liftM: 1.1,
    gridSegments: 144,
    flipU: false,
    flipV: true,
    bounds: { ...MITHI_CORRIDOR_BOUNDS },
    overlay: "",
    legendTitle: "Salinity",
    legendSubtitle: "PSU classes · Mithi LatLonBox",
    unit: "PSU",
    classes: SALINITY_CLASSES,
    legendClasses: SALINITY_CLASSES,
    renderType: "terrainDrapedTexture",
  },
  water_quality_tss: {
    id: "water_quality_tss",
    name: "TSS",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    kmlUrl: "/data/mithi/jalnetra-history/water-quality1_21-10-2026__18-11-2026.kml",
    kmlUrlFallbacks: [
      "/data/mithi/water_quality.kml",
      mandoviTssKmlUrl,
    ],
    bounds: { ...MANDOVI_POLLUTION_BOUNDS },
    overlay: "",
    opacity: 0.92,
    gridSegments: 144,
    liftM: 0.85,
    flipU: false,
    flipV: true,
    legendTitle: "TSS",
    legendSubtitle: "3 classes · Mithi Sentinel-2 proxy",
    unit: "Index",
    classes: TSS_CLASSES,
    legendClasses: TSS_CLASSES,
    renderType: "terrainDrapedTexture",
  },
  geology: {
    id: "geology",
    name: "SPECTRAL LITHOLOGY",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    kmlUrl: "/data/mithi/jalnetra-history/lithology1_21-10-2026__18-11-2026.kml",
    kmlUrlFallbacks: ["/data/mithi/lithology.kml"],
    overlay: "",
    opacity: 0.88,
    gridSegments: 144,
    liftM: 1.8,
    flipU: false,
    flipV: true,
    renderType: "terrainDrapedTexture",
    legendTitle: "Spectral Lithology",
    legendSubtitle: "lithology1_21-10-2026|18-11-2026",
    source: "lithology1_21-10-2026|18-11-2026",
  },
  water_depth: {
    id: "water_depth",
    name: "WATER DEPTH",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    bounds: {
      north: 19.08782672,
      south: 19.04514933,
      east: 72.87929619,
      west: 72.83456075,
    },
    kmlUrl: "/data/mithi/jalnetra-history/water-depth1_21-10-2026__18-11-2026.kml",
    overlay: "/data/mithi/mithi_river_depth_overlay.png",
    meta: "/data/mithi/mithi_river_water_depth.json",
    source: "water-depth1_21-10-2026|18-11-2026",
    opacity: 0.95,
    gridSegments: 128,
    liftM: 0.65,
    flipU: false,
    flipV: true,
    legendTitle: "Water Depth / Bathymetry",
    legendSubtitle: "src/data/mithi_river_depth.kml · blue depth classes",
    unit: "m",
    classes: [
      { id: "shallow", label: "Shallow (<1.5 m)", range: "< 1.5 m", color: "#8FEAF8", minDepth: 0.2, maxDepth: 1.5 },
      { id: "moderate", label: "Moderate (1.5–3.0 m)", range: "1.5–3.0 m", color: "#55C4EE", minDepth: 1.5, maxDepth: 3.0 },
      { id: "medium_deep", label: "Medium-Deep (3.0–4.5 m)", range: "3.0–4.5 m", color: "#3AA0D6", minDepth: 3.0, maxDepth: 4.5 },
      { id: "deep", label: "Deep (>4.5 m)", range: "> 4.5 m", color: "#2B86C0", minDepth: 4.5, maxDepth: 5.5 },
    ],
    legendClasses: [
      { id: "shallow", label: "Shallow (<1.5 m)", range: "< 1.5 m", color: "#8FEAF8" },
      { id: "moderate", label: "Moderate (1.5–3.0 m)", range: "1.5–3.0 m", color: "#55C4EE" },
      { id: "medium_deep", label: "Medium-Deep (3.0–4.5 m)", range: "3.0–4.5 m", color: "#3AA0D6" },
      { id: "deep", label: "Deep (>4.5 m)", range: "> 4.5 m", color: "#2B86C0" },
    ],
    renderType: "terrainDrapedTexture",
  },
  bank_erosion: {
    id: "bank_erosion",
    name: "BANK EROSION HOTSPOTS",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    bounds: {
      north: 18.54742583968735,
      south: 18.520745875749,
      east: 73.9935113006977,
      west: 73.85472158930123,
    },
    kmlUrl: "/data/mithi/jalnetra-history/bank-erosion1_21-10-2026__18-11-2026.kml",
    overlay: bankErosionOverlayUrl,
    legend: bankErosionLegendUrl,
    meta: "/data/hydrology/bank_erosion/meta.json",
    source: "bank-erosion1_21-10-2026|18-11-2026",
    opacity: 0.78,
    gridSegments: 144,
    liftM: 1.6,
    flipU: false,
    flipV: true,
    renderType: "terrainDrapedTexture",
    legendTitle: "Bank erosion hotspots",
    legendSubtitle: "2016–2026 smoothed continuous overlay.",
    legendClasses: [
      { id: "none", label: "No erosion", color: "#90EE90", pct: "83.1%" },
      { id: "low", label: "Low erosion", color: "#FFFF00", pct: "15.5%" },
      { id: "moderate", label: "Moderate erosion", color: "#FFA500", pct: "1.4%" },
      { id: "high", label: "High erosion", color: "#FF0000", pct: "0%" },
      { id: "very_high", label: "Very high erosion", color: "#8B0000", pct: "0%" },
    ],
  },
  silt_classification: {
    id: "silt_classification",
    name: "SILT CLASSIFICATION",
    available: true,
    type: "siltClassificationPeriods",
    crs: "EPSG:4326",
    defaultPeriod: SILT_CLASS_PERIODS.at(-1)?.id,
    opacity: 1,
    liftM: 1.4,
    gridSegments: 128,
    legendTitle: "Silt Classification",
    legendSubtitle: "Monthly Mithi KML timeline · Jan–Apr, Jun–Aug, Oct 2026 (May/Sep unavailable)",
    source: "src/data/Classification/*.kml",
    bounds: SILT_CLASS_BOUNDS,
    classes: SILT_CLASS_CLASSES,
    periods: SILT_CLASS_PERIODS,
    renderType: "terrainDrapedSiltClassification",
  },
  silt_volume_surface: {
    id: "silt_volume_surface",
    name: "SILT VOLUME SURFACE",
    available: true,
    type: "siltVolumePeriods",
    crs: "EPSG:4326",
    defaultPeriod: SILT_VOLUME_PERIODS.at(-1)?.id,
    opacity: 1,
    liftM: 1.5,
    gridSegments: 128,
    legendTitle: "Silt Volume Surface",
    legendSubtitle: "Relative silt index · fixed 0–96.37 · assumed 1 m layer, not surveyed sediment volume · Jan–Aug, Oct 2026",
    source: "src/data/Volume/*.kml",
    bounds: SILT_VOLUME_BOUNDS,
    classes: SILT_VOLUME_CLASSES,
    periods: SILT_VOLUME_PERIODS,
    renderType: "terrainDrapedSiltVolume",
  },
  vegetation_extent: {
    id: "vegetation_extent",
    name: "VEGETATION TYPE",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    bounds: { ...MITHI_CORRIDOR_BOUNDS },
    overlay: "/data/hydrology/vegetation/vegetation_type_overlay.png?v=19",
    meta: "/data/hydrology/vegetation/vegetation_type_meta.json",
    source: "JalNetra /api/vegetation-type · Mithi river KML AOI",
    // Slightly softer so grown 3D trees/grass read clearly on top
    opacity: 0.58,
    gridSegments: 128,
    liftM: 1.1,
    flipU: false,
    flipV: true,
    renderType: "terrainDrapedTexture",
    legendTitle: "Vegetation Type",
    legendSubtitle: "Mithi LatLonBox · JalNetra vegetation-type",
    legendClasses: VEGETATION_EXTENT_CLASSES,
  },
  vegetation_health: {
    id: "vegetation_health",
    name: "VEGETATION CLASSIFICATION",
    available: true,
    type: "groundOverlay",
    crs: "EPSG:4326",
    bounds: {
      north: 19.10610744,
      south: 19.02674113,
      east: 72.89905415,
      west: 72.81483231,
    },
    kmlUrl: "/data/mithi/jalnetra-history/vegetation-health1_21-10-2026__18-11-2026.kml",
    overlay: "/data/hydrology/vegetation/vegetation_health_overlay.png?v=20",
    meta: "/data/hydrology/vegetation/vegetation_health_meta.json",
    source: "vegetation-health1_21-10-2026|18-11-2026",
    opacity: 0.72,
    gridSegments: 128,
    liftM: 1.15,
    flipU: false,
    flipV: true,
    renderType: "terrainDrapedTexture",
    legendTitle: "Vegetation Classification",
    legendSubtitle: "50% NDVI · 30% NDMI · 20% EVI · Mithi LatLonBox",
    legendClasses: [
      { id: "very_healthy", label: "Very Healthy (80–100)", color: "#006400" },
      { id: "healthy", label: "Healthy (65–80)", color: "#32CD32" },
      { id: "moderate", label: "Moderate (50–65)", color: "#FFFF00" },
      { id: "poor", label: "Poor (35–50)", color: "#FF8C00" },
      { id: "critical", label: "Critical (0–35)", color: "#FF0000" },
    ],
  },
  pollution_eutrophication: {
    id: "pollution_eutrophication",
    name: "EUTROPHICATION",
    available: true,
    type: "kmlPolygons",
    crs: "EPSG:4326",
    data: "/data/mithi/WATERQ-Pollution/eutrophication_trophic_class%20(1).kml",
    dataFallbacks: [
      "/data/mithi/WATERQ-Pollution/eutrophication_trophic_class (1).kml",
    ],
    bounds: { ...MITHI_CORRIDOR_BOUNDS },
    opacity: 0.88,
    liftM: 1.05,
    waterSurface: true,
    legendTitle: "Eutrophication",
    legendSubtitle: "Trophic class · Mithi corridor polygons",
    unit: "µg/L",
    classes: EUTROPHICATION_CLASSES,
    legendClasses: EUTROPHICATION_CLASSES,
    renderType: "waterSurfacePolygons",
  },
  pollution_nitrogen: {
    id: "pollution_nitrogen",
    name: "NITROGEN",
    available: true,
    type: "kmlPolygons",
    crs: "EPSG:4326",
    data: "/data/mithi/WATERQ-Pollution/nitrogen_risk_class%20(1).kml",
    dataFallbacks: [
      "/data/mithi/WATERQ-Pollution/nitrogen_risk_class (1).kml",
    ],
    bounds: { ...MITHI_CORRIDOR_BOUNDS },
    opacity: 0.88,
    liftM: 1.05,
    waterSurface: true,
    legendTitle: "Nitrogen",
    legendSubtitle: "Risk class · Mithi corridor polygons",
    unit: "",
    classes: NITROGEN_RISK_CLASSES,
    legendClasses: NITROGEN_RISK_CLASSES,
    renderType: "waterSurfacePolygons",
  },
  pollution_coliform: {
    id: "pollution_coliform",
    name: "COLIFORM",
    available: true,
    type: "kmlPolygons",
    crs: "EPSG:4326",
    data: "/data/mithi/WATERQ-Pollution/coliform_ecoli_class%20(1).kml",
    dataFallbacks: [
      "/data/mithi/WATERQ-Pollution/coliform_ecoli_class (1).kml",
    ],
    bounds: { ...MITHI_CORRIDOR_BOUNDS },
    opacity: 0.88,
    liftM: 1.05,
    waterSurface: true,
    legendTitle: "Coliform",
    legendSubtitle: "Class polygons · Mithi corridor",
    classes: COLIFORM_CLASSES,
    legendClasses: COLIFORM_CLASSES,
    renderType: "waterSurfacePolygons",
  },
  landuse_lulc: {
    id: "landuse_lulc",
    name: "LULC",
    available: true,
    type: "lulcYears",
    crs: "EPSG:4326",
    years: LULC_YEARS,
    defaultYear: 2026,
    bounds: { ...MITHI_CORRIDOR_BOUNDS },
    opacity: 0.82,
    liftM: 0.45,
    gridSegments: 112,
    flipU: false,
    flipV: true,
    legendTitle: "LULC",
    legendSubtitle: "Mithi land cover",
    legendClasses: LULC_LEGEND,
    classes: LULC_CLASSES,
    renderType: "terrainDrapedTexture",
  },
};

const CLASS_COLOR = {
  Low: "#2ECC71",
  Moderate: "#F39C12",
  High: "#E74C3C",
  "Very Low": "#0000FF",
  "Very High": "#FF0000",
  "Very Low Salinity": "#0000FF",
  "Low Salinity": "#00BFFF",
  "Moderate Salinity": "#00FF00",
  "High Salinity": "#FFFF00",
  "Very High Salinity": "#FF0000",
};

/**
 * @param {object} dataset
 */
export function createHydrologyLayer(dataset) {
  const group = new THREE.Group();
  group.name = "hydrology";
  group.visible = false;

  const stations = dataset?.corridor?.stations || [];
  /** @type {object|null} */
  let config = null;
  /** @type {string|null} */
  let activeId = null;
  /** Bumps on every show/hide so a slow load cannot overwrite a newer selection. */
  let showSeq = 0;
  /** Last UI-requested layer id (survives showSeq races for draped overlays). */
  let pendingShowId = null;

  const drapedOverlays = {
    geology: { mesh: null, loaded: false, loading: null, sampler: null },
    bank_erosion: { mesh: null, loaded: false, loading: null, sampler: null },
    landuse_lulc: { mesh: null, loaded: false, loading: null, sampler: null },
    silt_classification: { mesh: null, loaded: false, loading: null, sampler: null },
    silt_volume_surface: { mesh: null, loaded: false, loading: null, sampler: null },
    water_depth: { mesh: null, loaded: false, loading: null, sampler: null },
    water_quality_tss: { mesh: null, loaded: false, loading: null, sampler: null },
    water_quality_ndci: { mesh: null, loaded: false, loading: null, sampler: null },
    vegetation_extent: { mesh: null, loaded: false, loading: null, sampler: null },
    vegetation_health: { mesh: null, loaded: false, loading: null, sampler: null },
    pollution_eutrophication: { mesh: null, loaded: false, loading: null, sampler: null },
    pollution_nitrogen: { mesh: null, loaded: false, loading: null, sampler: null },
    pollution_coliform: { mesh: null, loaded: false, loading: null, sampler: null },
  };
  /** @deprecated alias — keep older references working during loadGeology */
  const geology = drapedOverlays.geology;
  /** Active LULC year (2021–2026). */
  let lulcYear = 2026;
  /** Active silt classification period id (YYYY-MM). Default = most recent. */
  let siltClassPeriod = SILT_CLASS_PERIODS[SILT_CLASS_PERIODS.length - 1].id;
  let siltVolumePeriod = SILT_VOLUME_PERIODS[SILT_VOLUME_PERIODS.length - 1].id;
  /** Detected garbage pins (pollution layer). */
  const pollutionGarbage = createPollutionGarbageLayer({ stations });
  group.add(pollutionGarbage);
  /** Classed polygon layers (salinity + water-quality metrics). */
  const polygonLayers = Object.create(null);

  function polygonSlot(id) {
    if (!polygonLayers[id]) {
      polygonLayers[id] = {
        root: null,
        loaded: false,
        loading: null,
        featureIndex: [],
        meshes: [],
      };
    }
    return polygonLayers[id];
  }
  function mergeBuiltinLayers(cfg) {
    if (!cfg || !Array.isArray(cfg.layers)) {
      return { version: CONFIG_VERSION, layers: Object.values(BUILTIN_LAYER_DEFS) };
    }
    const byId = new Map(cfg.layers.map((l) => [l.id, l]));
    for (const [id, def] of Object.entries(BUILTIN_LAYER_DEFS)) {
      // Always prefer bundled overlay URLs for bank_erosion (public/data may 404 as HTML)
      byId.set(id, { ...(byId.get(id) || {}), ...def });
    }
    return { ...cfg, layers: [...byId.values()] };
  }

  async function ensureConfig() {
    if (config) return config;
    const fallback = { version: CONFIG_VERSION, layers: Object.values(BUILTIN_LAYER_DEFS) };
    try {
      const url = `${CONFIG_URL}?v=${CONFIG_VERSION}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store" });
      if (!res.ok) throw new Error(`Hydrology config unavailable (${res.status})`);
      const text = await res.text();
      if (text.trimStart().startsWith("<")) throw new Error("Hydrology config was not JSON");
      config = mergeBuiltinLayers(JSON.parse(text));
    } catch (err) {
      console.warn("[hydrology] using built-in layer definitions", err);
      config = fallback;
    }
    return config;
  }

  function layerDef(id) {
    const live = liveLayerDef(id);
    const session = typeof window !== "undefined" ? window.__RIVER_SESSION__ : null;
    const hasRiverKml = !!(session?.kmlText);
    const lat = Number(session?.centroid?.lat);
    const lon = Number(session?.centroid?.lon);
    const onMandoviAoi =
      !hasRiverKml ||
      (Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= MANDOVI_POLLUTION_BOUNDS.south - 0.08 &&
        lat <= MANDOVI_POLLUTION_BOUNDS.north + 0.08 &&
        lon >= MANDOVI_POLLUTION_BOUNDS.west - 0.08 &&
        lon <= MANDOVI_POLLUTION_BOUNDS.east + 0.08);
    // Live JalNetra overlay always wins when ready (silt / pollution / vegetation / WQ…).
    // Bundled KMLs below stay as fallback while live is pending.
    void onMandoviAoi;
    if (live) {
      // Offline AABB paint must not beat bundled Mithi Classification/Volume polygon KMLs.
      if (
        live.offlinePreview &&
        (id === "silt_classification" || id === "silt_volume_surface") &&
        live.preferBuiltinPolygons
      ) {
        const builtin = BUILTIN_LAYER_DEFS[id];
        if (Array.isArray(builtin?.periods) && builtin.periods.length) {
          return {
            ...builtin,
            available: true,
            offlinePreview: true,
            legendSubtitle:
              id === "silt_volume_surface"
                ? "Mithi river KML months · awaiting JalNetra verification"
                : "Mithi river KML months · awaiting JalNetra classification",
          };
        }
      }
      return live;
    }
    // Geography-specific builtins (Pune silt, etc.) must never paint over another river's KML.
    const riverScoped = new Set([
      "silt_classification",
      "silt_volume_surface",
      "landuse_lulc",
      "salinity",
      "vegetation_extent",
      "vegetation_health",
      "bank_erosion",
      "geology",
      "water_quality_tss",
      "water_quality_ndci",
      "water_quality_ndwi",
      "water_quality_wst",
    ]);
    if (hasRiverKml && id !== "water_depth") {
      const endpointId =
        id === "silt_classification"
          ? "silt-classification"
          : id === "silt_volume_surface"
            ? "silt-volume"
            : id === "landuse_lulc"
              ? "lulc"
              : id === "vegetation_extent"
                ? "vegetation-type"
                : id === "vegetation_health"
                  ? "vegetation-health"
                  : id.replace(/_/g, "-");
      const err =
        session.errors?.[id] ||
        session.errors?.[endpointId] ||
        (id === "silt_classification" ? session.errors?.silt : null);
      // Silt uses liveLayers offline preview when JalNetra is slow — do not hard-block here.
      // Mandovi WQ KMLs (TSS / Chlorophyll / Salinity) ship in WATERQ-Pollution — always allow builtins.
      if (
        id === "silt_classification" ||
        id === "silt_volume_surface" ||
        id === "salinity" ||
        id === "water_quality_tss" ||
        id === "water_quality_ndci" ||
        id === "pollution_eutrophication" ||
        id === "pollution_nitrogen" ||
        id === "pollution_coliform" ||
        id === "landuse_lulc" ||
        id === "vegetation_health" ||
        id === "vegetation_extent" ||
        id === "geology" ||
        id === "bank_erosion"
      ) {
        // Geology / erosion: prefer live JalNetra; if still pending, keep loading
        // (do not hard-block with DATA UNAVAILABLE while Earth Engine runs).
        if ((id === "geology" || id === "bank_erosion") && !live) {
          const ep = id === "geology" ? "lithology" : "bank-erosion";
          const pending = !!(session.pending?.[ep]);
          if (pending || !err) {
            return {
              id,
              available: false,
              name: id,
              loading: true,
              unavailableLabel: pending ? "LOADING…" : "DATA UNAVAILABLE",
              reason: pending
                ? "JalNetra is still computing this layer for the river…"
                : err || "JalNetra has not returned this layer for the uploaded river yet.",
            };
          }
        }
        // fall through to BUILTIN_LAYER_DEFS (local KML / PNG until live arrives)
      } else if (err || riverScoped.has(id)) {
        return {
          id,
          available: false,
          name: id,
          unavailableLabel: "DATA UNAVAILABLE",
          reason: err || "JalNetra has not returned this layer for the uploaded river yet.",
        };
      }
    }
    const fromConfig = config?.layers?.find((l) => l.id === id);
    const builtin = BUILTIN_LAYER_DEFS[id];
    let def = fromConfig && builtin ? { ...fromConfig, ...builtin } : fromConfig || builtin || null;
    const scheme = WQ_LAYER_SCHEMES[id];
    if (def && scheme) {
      def = {
        ...def,
        classes: scheme.classes,
        unit: scheme.unit,
        legendTitle: scheme.title,
        legendSubtitle: scheme.subtitle,
      };
    }
    return def;
  }

  function clearActiveMeshes() {
    for (const slot of Object.values(drapedOverlays)) {
      if (slot.mesh) slot.mesh.visible = false;
      if (slot.paste) slot.paste.visible = false;
    }
    for (const slot of Object.values(polygonLayers)) {
      if (slot.root) slot.root.visible = false;
    }
    pollutionGarbage.userData?.setVisible?.(false);
  }

  function disposeObject(obj) {
    if (!obj) return;
    obj.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          m.map?.dispose?.();
          m.dispose?.();
        }
      }
    });
  }

  /**
   * Terrain-draped GroundOverlay (LatLonBox → subdivided grid).
   * Used for geology + bank_erosion KMZ extracts — accurate lon/lat placement.
   */
  async function loadDrapedOverlay(def) {
    const id = def.id;
    if (!drapedOverlays[id]) {
      drapedOverlays[id] = { mesh: null, loaded: false, loading: null, sampler: null };
    }
    const slot = drapedOverlays[id];
    if (!slot) throw new Error(`No draped overlay slot for ${id}`);

    const GEO_UV_VERSION = CONFIG_VERSION;
    // Wait out in-flight loads so year/period switches don't keep the previous overlay.
    while (slot.loading) {
      await slot.loading.catch(() => {});
    }

      const wantsExactFootprint = usesExactGroundOverlayFootprint(id);
      const wantsFlatPollution = isMandoviFlatRaster(id);
      const wantsFlatJalNetra =
        id === "geology" || id === "bank_erosion" || wantsFlatPollution;
    if (
      slot.loaded &&
      (slot.mesh?.userData?.geoUvVersion !== GEO_UV_VERSION ||
        slot.mesh?.userData?.overlayUrl !== def.overlay ||
        (wantsFlatJalNetra && !slot.mesh?.userData?.flatGroundOverlay) ||
        (!!slot.paste && wantsExactFootprint))
    ) {
      group.remove(slot.mesh);
      disposeObject(slot.mesh);
      if (slot.paste) {
        group.remove(slot.paste);
        disposeObject(slot.paste);
        slot.paste = null;
      }
      slot.mesh = null;
      slot.loaded = false;
      slot.sampler = null;
    }
    // Force silt samplers to rebuild when overlay URL is unchanged but
    // sampler code / PNG content changed (same public path).
    if (
      slot.loaded &&
      (id === "silt_classification" || id === "silt_volume_surface") &&
      slot.sampler?.kind !== id
    ) {
      slot.sampler = null;
    }
    if (slot.loaded) {
      if (slot.paste) {
        group.remove(slot.paste);
        disposeObject(slot.paste);
        slot.paste = null;
      }
      if (id === "bank_erosion" && !slot.sampler) {
        slot.sampler = await createBankErosionSampler(def).catch(() => null);
      }
      if (id === "geology" && !slot.sampler) {
        slot.sampler = await createGeologySampler(def).catch(() => null);
      }
      if (
        (id === "landuse_lulc" ||
          id === "silt_classification" ||
          id === "silt_volume_surface" ||
          id === "water_depth" ||
          id === "vegetation_extent" ||
          id === "vegetation_health") &&
        (!slot.sampler ||
          ((id === "landuse_lulc" ||
            id === "silt_classification" ||
            id === "vegetation_extent" ||
            id === "vegetation_health") &&
            !slot.sampler.coverageByLabel))
      ) {
        slot.sampler = await createLandUseSampler(def, id).catch((err) => {
          console.warn(`[${id}] hover sampler unavailable`, err);
          return null;
        });
      }
      return;
    }
    if (slot.loading) return slot.loading;

    slot.loading = (async () => {
      const box = def.bounds;
      const west = Number(box.west);
      const east = Number(box.east);
      const north = Number(box.north);
      const south = Number(box.south);
      if (![west, east, north, south].every(Number.isFinite) || east === west || north === south) {
        throw new Error(`${id} LatLonBox bounds are invalid`);
      }

      const bounds = overlayBoxToLocalBounds(box);
      const lift = Number(def.liftM) || 0.35;
      const opacity = Number(def.opacity) ?? 0.78;
      const isPollutionOverlay = isMandoviFlatRaster(id);
      // JalNetra lithology + bank-erosion KMLs are Google Earth GroundOverlays
      // (LatLonBox + masked PNG). Show them flat + nearest — same as the
      // kml_download_url file opened in Earth. Do not remap onto a river ribbon.
      const isExactJalNetraGroundOverlay =
        isPollutionOverlay ||
        id === "salinity" ||
        id === "geology" ||
        id === "bank_erosion";

      const mesh = isExactJalNetraGroundOverlay
        ? await buildFlatGroundOverlayMesh({
            id,
            bounds,
            west,
            east,
            north,
            south,
            overlayUrl: def.overlay,
            opacity:
              id === "bank_erosion"
                ? Math.min(0.85, Math.max(0.62, opacity))
                : Math.min(1, Math.max(0.92, opacity)),
            lift: Math.max(
              lift,
              id === "bank_erosion" ? 1.6 : id === "geology" ? 1.8 : 2.8,
            ),
            version: GEO_UV_VERSION,
            nearest: true,
            preserveMask: true,
          })
        : await buildDrapedGridMesh({
            id,
            def: {
              ...def,
              flipU: false,
              flipV: true,
              gridSegments:
                id === "landuse_lulc" ||
                id === "silt_classification" ||
                id === "silt_volume_surface" ||
                id === "water_depth" ||
                id === "vegetation_extent" ||
                id === "vegetation_health"
                  ? Math.max(112, Number(def.gridSegments) || 128)
                  : def.gridSegments,
            },
            bounds,
            west,
            east,
            north,
            south,
            stations,
            lift,
            opacity: id === "water_depth" ? 1 : opacity,
            version: GEO_UV_VERSION,
            nearest:
              id === "landuse_lulc" ||
              id === "silt_classification" ||
              id === "vegetation_extent" ||
              id === "vegetation_health",
            highContrast:
              id === "landuse_lulc" ||
              id === "silt_classification" ||
              id === "silt_volume_surface" ||
              id === "water_depth",
            animateBankErosion: false,
            upsampleMinEdge: 0,
            preserveMask: true,
          });

      group.add(mesh);
      slot.mesh = mesh;
      slot.loaded = true;
      if (slot.paste) {
        group.remove(slot.paste);
        slot.paste.geometry?.dispose?.();
        if (slot.paste.material) {
          slot.paste.material.map = null;
          slot.paste.material.dispose();
        }
        slot.paste = null;
      }
      // No corridor paste — bank erosion uses the JalNetra LatLonBox mesh above.
      if (id === "bank_erosion") {
        try {
          slot.sampler = await createBankErosionSampler(def);
        } catch (err) {
          console.warn("[bank_erosion] hover sampler unavailable", err);
          slot.sampler = null;
        }
      }
      if (id === "geology") {
        try {
          slot.sampler = await createGeologySampler(def);
        } catch (err) {
          console.warn("[geology] click sampler unavailable", err);
          slot.sampler = null;
        }
      }
      if (
        id === "landuse_lulc" ||
        id === "silt_classification" ||
        id === "silt_volume_surface" ||
        id === "vegetation_extent" ||
        id === "vegetation_health"
      ) {
        try {
          slot.sampler = await createLandUseSampler(def, id);
        } catch (err) {
          console.warn(`[${id}] hover sampler unavailable`, err);
          slot.sampler = null;
        }
      }
    })()
      .catch((err) => {
        throw err;
      })
      .finally(() => {
        slot.loading = null;
      });

    return slot.loading;
  }

  /** @deprecated use loadDrapedOverlay */
  async function loadGeology(def) {
    return loadDrapedOverlay(def);
  }

  /**
   * Classed polygons (GeoJSON or KML) → terrain-draped meshes merged by class.
   * Used for salinity + TSS / NDWI / NDCI / WST water-quality KMLs.
   */
  async function loadClassedPolygons(def) {
    const id = def.id;
    const slot = polygonSlot(id);
    const schemaKey = JSON.stringify({
      v: CONFIG_VERSION,
      dataUrl: String(def.data || ""),
      waterSurface: !!def.waterSurface,
      rasterize: !!def.rasterizeWaterOverlay,
      liftM: Number(def.liftM) || 0,
      opacity: Number(def.opacity) || 0,
      classes: (def.classes || []).map((c) => [c.kmlClass || c.id, c.label, c.color, c.range]),
    });
    if (slot.loaded && slot.schemaKey !== schemaKey) {
      if (slot.root) {
        group.remove(slot.root);
        disposeObject(slot.root);
      }
      slot.root = null;
      slot.meshes = [];
      slot.featureIndex = [];
      slot.loaded = false;
      slot.loading = null;
    }
    if (slot.loaded) return;
    if (slot.loading) return slot.loading;

    slot.loading = (async () => {
      const primaryUrl = String(def.data || "");
      const candidateUrls = [
        primaryUrl,
        ...(Array.isArray(def.dataFallbacks) ? def.dataFallbacks : []),
      ].filter(Boolean);
      if (!candidateUrls.length) throw new Error(`${id} has no data URL`);

      const lift = Number(def.liftM) || 0.35;
      const opacity = Number(def.opacity) ?? 0.65;

      /** @type {{ class_label:string, class?:string, range?:string|null, name?:string|null, description?:string|null, color?:string|null, coordinates?:{lon:number,lat:number}[], geometry?:object }[]} */
      let rawFeatures = [];
      let dataUrl = primaryUrl;
      let lastFetchErr = null;

      for (const candidate of [...new Set(candidateUrls)]) {
        try {
          const isKml =
            /\.kml(\?|$)/i.test(candidate) ||
            candidate.startsWith("blob:") ||
            candidate.includes("/assets/");
          if (isKml || candidate.endsWith(".kml")) {
            const fetchUrl =
              /^(data:|blob:)/i.test(candidate) || candidate.includes("?")
                ? candidate
                : `${candidate}?v=${CONFIG_VERSION}`;
            const res = await fetch(fetchUrl, {
              signal: AbortSignal.timeout(90000),
              cache: "no-store",
            });
            if (!res.ok) throw new Error(`${id} KML unavailable (${res.status})`);
            const text = await res.text();
            if (/^\s*<!DOCTYPE html/i.test(text) || /^\s*<html/i.test(text)) {
              throw new Error(`${id} KML URL returned HTML — check public/data path`);
            }
            rawFeatures = text.trimStart().startsWith("{")
              ? featuresFromGeoJson(text)
              : parseClassedPolygonKml(text);
            if (!rawFeatures.length) throw new Error(`${id}: no polygons parsed from ${candidate}`);
            dataUrl = candidate;
            lastFetchErr = null;
            break;
          }
          const res = await fetch(candidate, { signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw new Error(`${id} data unavailable (${res.status})`);
          const gj = await res.json();
          rawFeatures = (gj.features || []).map((f, fi) => {
            const props = f.properties || {};
            return {
              id: fi,
              class_label: props.class_label || stripRange(props.class) || "Unknown",
              class: props.class || props.class_label || null,
              range: props.range || null,
              name: props.name || null,
              description: props.description || null,
              color: normalizeHex(props.color),
              geometry: f.geometry,
            };
          });
          if (!rawFeatures.length) throw new Error(`${id}: no features in ${candidate}`);
          dataUrl = candidate;
          lastFetchErr = null;
          break;
        } catch (err) {
          lastFetchErr = err;
          rawFeatures = [];
        }
      }
      if (!rawFeatures.length) {
        throw lastFetchErr || new Error(`${id}: no polygons parsed`);
      }

      const buckets = new Map();
      for (const c of def.classes || []) {
        buckets.set(c.label, {
          geos: [],
          color: c.color,
          label: c.label,
          range: c.range || null,
        });
      }

      const featureIndex = [];
      for (let fi = 0; fi < rawFeatures.length; fi++) {
        const f = rawFeatures[fi];
        const meta = resolveClassMeta(def, f.class_label || "Unknown", f);
        const label = meta.label;
        const color = meta.color;
        if (!buckets.has(label)) {
          buckets.set(label, {
            geos: [],
            color,
            label,
            range: meta.range || null,
          });
        } else if (meta.color && buckets.get(label).color !== meta.color) {
          buckets.get(label).color = meta.color;
        }
        if (meta.range && !buckets.get(label).range) {
          buckets.get(label).range = meta.range;
        }
        const rings = f.coordinates?.length
          ? [f.coordinates]
          : ringsOf(f.geometry);
        if (!rings.length) continue;
        for (const ring of rings) {
          const verts = lonLatRingToLocalVerts(ring);
          if (!verts || verts.length < 3) continue;
          // Always build class meshes for water-surface layers (Google Earth look).
          // Raster sheet is an extra fill so overview still reads if some rings fail.
          const geo = def.waterSurface
            ? polygonToWaterSurfaceGeometry(verts, lift)
            : def.rasterizeWaterOverlay
              ? null
              : polygonToTerrainGeometry(verts, stations, lift);
          if (geo) buckets.get(label).geos.push(geo);

          let cx = 0;
          let cz = 0;
          for (const v of verts) {
            cx += v.x;
            cz += v.z;
          }
          cx /= verts.length;
          cz /= verts.length;
          featureIndex.push({
            id: fi,
            class_label: label,
            class: label,
            sourceClass: f.class_label || null,
            range: meta.range || buckets.get(label).range || null,
            unit: meta.unit || def.unit || null,
            value: meta.value ?? null,
            valueText: meta.valueText || null,
            metric: meta.metric || def.legendTitle || def.name || null,
            name: f.name || null,
            description: f.description || null,
            color: buckets.get(label).color || color,
            x: cx,
            z: cz,
            vertices: verts,
            lonLatRing: ring,
            hydrology: id,
          });
        }
      }

      const root = new THREE.Group();
      root.name = `hydrology_${id}`;
      root.visible = false;
      const meshes = [];

      const onWater = !!def.waterSurface;
      for (const [, bucket] of buckets) {
        if (!bucket.geos.length) continue;
        const merged = mergeGeometries(bucket.geos, false);
        bucket.geos.forEach((g) => g.dispose());
        if (!merged) continue;
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(bucket.color),
          transparent: true,
          opacity: Math.min(1, Math.max(onWater ? 0.92 : 0.55, opacity)),
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: onWater ? -6 : -2,
          polygonOffsetUnits: onWater ? -6 : -2,
          toneMapped: false,
          depthTest: false,
          depthWrite: false,
        });
        if (!onWater) applyDrapeDepth(mat);
        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = `${id}_${bucket.label.replace(/\s+/g, "_")}`;
        mesh.renderOrder = onWater ? 110 : 52;
        mesh.frustumCulled = false;
        mesh.userData.hydrology = id;
        mesh.userData.class_label = bucket.label;
        mesh.userData.range = bucket.range;
        mesh.userData.color = bucket.color;
        root.add(mesh);
        meshes.push(mesh);
      }

      // Mandovi salinity: also stamp a flat water-sheet texture (overview fallback).
      if (def.rasterizeWaterOverlay) {
        const box = boundsFromFeatures(rawFeatures, def.bounds || MANDOVI_POLLUTION_BOUNDS);
        const canvas = rasterizeSalinityPolygonsToCanvas(rawFeatures, def, box);
        if (canvas) {
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          tex.flipY = false;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.NearestFilter;
          const mesh = buildSalinityFlatMesh({
            id,
            bounds: box,
            texture: tex,
            opacity: Math.max(opacity, 0.95),
            lift: Math.max(lift, 2.8),
          });
          root.add(mesh);
          meshes.push(mesh);
          console.info(`[${id}] raster overlay ready`, {
            features: featureIndex.length,
            classMeshes: meshes.length - 1,
            canvas: `${canvas.width}×${canvas.height}`,
            source: def.source || dataUrl,
          });
        } else if (!meshes.length) {
          throw new Error(`${id}: failed to rasterize ${dataUrl}`);
        }
      }

      if (!meshes.length) {
        throw new Error(`${id}: no polygon meshes built from ${dataUrl}`);
      }

      group.add(root);
      slot.root = root;
      slot.meshes = meshes;
      slot.featureIndex = featureIndex;
      slot.schemaKey = schemaKey;
      slot.loaded = true;
      slot.loading = null;
      root.userData.featureIndex = featureIndex;
      root.userData.meshCount = meshes.length;
      root.userData.featureCount = featureIndex.length;
    })().catch((err) => {
      slot.loading = null;
      throw err;
    });

    return slot.loading;
  }

  /** @deprecated use loadClassedPolygons */
  async function loadSalinity(def) {
    return loadClassedPolygons(def);
  }

  function getLulcYears(def) {
    const fromDef = Array.isArray(def?.years) && def.years.length ? def.years : null;
    const raw = fromDef || LULC_YEARS;
    // Drop Mula–Mutha / other-river years so LULC never drapes ~127 km away.
    const mithi = raw.filter((y) => !y.bounds || isMithiLatLonBox(y.bounds));
    if (mithi.length) {
      return mithi.map((y) =>
        y.bounds && isMithiLatLonBox(y.bounds)
          ? y
          : { ...y, bounds: { ...MITHI_CORRIDOR_BOUNDS } },
      );
    }
    return LULC_YEARS;
  }

  function resolveLulcYearEntry(def, year) {
    const years = getLulcYears(def);
    const y = Number(year);
    return years.find((e) => Number(e.year) === y) || years[years.length - 1] || null;
  }

  function buildLulcLegend(def, year, coverageByLabel = null) {
    const source = def.legendClasses?.length ? def.legendClasses : LULC_LEGEND;
    const classes = source.map((c) => {
      const label = c.label;
      const fromCoverage =
        coverageByLabel && typeof coverageByLabel === "object"
          ? coverageByLabel[label] || coverageByLabel[String(label)]
          : null;
      return {
        label,
        color: c.color,
        range: c.range || null,
        pct: fromCoverage || c.pct || c.range || null,
      };
    });
    return {
      type: "classes",
      title: def.legendTitle || def.name || "LULC",
      subtitle: `${year} · ${def.legendSubtitle || "Mithi land cover"}`,
      classes,
      years: getLulcYears(def).map((e) => Number(e.year)),
      activeYear: year,
      layerId: "landuse_lulc",
      interactiveClasses: false,
    };
  }

  async function showLulcLayer(def, expectedSeq = null, opts = {}) {
    const years = getLulcYears(def);
    if (!years.length) {
      return {
        ok: false,
        id: "landuse_lulc",
        available: false,
        message: "No LULC years configured",
      };
    }
    // Open on configured default (or most recent) unless caller is switching years
    if (!opts.keepSelection) {
      const preferred = Number(def.defaultYear);
      const preferredEntry = Number.isFinite(preferred)
        ? years.find((e) => Number(e.year) === preferred)
        : null;
      const latest = years[years.length - 1];
      lulcYear = Number((preferredEntry || latest).year);
    }
    const yearEntry = resolveLulcYearEntry(def, lulcYear) || years[years.length - 1];
    lulcYear = Number(yearEntry.year);
    const yearType = yearEntry.type || (yearEntry.overlay ? "groundOverlay" : "kmlPolygons");

    if (yearType === "groundOverlay") {
      const drapedDef = {
        ...def,
        id: "landuse_lulc",
        type: "groundOverlay",
        overlay: yearEntry.overlay,
        bounds: yearEntry.bounds || def.bounds,
        opacity: Number(def.opacity) || 0.82,
        liftM: Number(def.liftM) || 0.45,
        gridSegments: Number(def.gridSegments) || 112,
        legendClasses: def.legendClasses?.length ? def.legendClasses : LULC_LEGEND,
      };
      await loadDrapedOverlay(drapedDef);
      if (expectedSeq != null && showSeq !== expectedSeq) {
        return { ok: true, id: "landuse_lulc", available: false, superseded: true };
      }
      if (pendingShowId !== "landuse_lulc") {
        return { ok: true, id: "landuse_lulc", available: false, superseded: true };
      }
      const poly = polygonSlot("landuse_lulc");
      if (poly.root) poly.root.visible = false;
      clearActiveMeshes();
      const slot = drapedOverlays.landuse_lulc;
      if (slot?.mesh) {
        showExactOverlayFootprint(slot);
        if (slot.mesh.material) {
          slot.mesh.material.opacity = Math.min(1, Number(drapedDef.opacity) || 0.82);
          slot.mesh.material.needsUpdate = true;
        }
      }
      activeId = "landuse_lulc";
      group.visible = !!slot?.mesh;
      return {
        ok: !!slot?.mesh,
        id: "landuse_lulc",
        available: !!slot?.mesh,
        message: slot?.mesh ? undefined : "Failed to build LULC overlay",
        legend: buildLulcLegend(def, lulcYear, slot?.sampler?.coverageByLabel || null),
        stats: { year: lulcYear, type: "groundOverlay", hasMesh: !!slot?.mesh },
      };
    }

    const polyDef = {
      ...def,
      id: "landuse_lulc",
      type: "kmlPolygons",
      data: yearEntry.data,
      // 2026 vector Class N ≠ KMZ raster codes — use vector map
      classes:
        yearEntry.classes?.length
          ? yearEntry.classes
          : Number(yearEntry.year) === 2026
            ? LULC_CLASSES_2026
            : def.classes?.length
              ? def.classes
              : LULC_CLASSES,
      opacity: Number(def.opacity) || 0.7,
      liftM: Number(def.liftM) || 0.4,
    };
    await loadClassedPolygons(polyDef);
    if (expectedSeq != null && showSeq !== expectedSeq) {
      return { ok: true, id: "landuse_lulc", available: false, superseded: true };
    }
    if (pendingShowId !== "landuse_lulc") {
      return { ok: true, id: "landuse_lulc", available: false, superseded: true };
    }
    clearActiveMeshes();
    const slot = polygonSlot("landuse_lulc");
    if (slot.root) slot.root.visible = true;
    activeId = "landuse_lulc";
    group.visible = !!slot.root;
    return {
      ok: !!slot.root && slot.meshes.length > 0,
      id: "landuse_lulc",
      available: !!slot.root && slot.meshes.length > 0,
      legend: buildLulcLegend(def, lulcYear),
      stats: {
        year: lulcYear,
        type: "kmlPolygons",
        features: slot.featureIndex.length,
        meshes: slot.meshes.length,
      },
    };
  }

  async function setLulcYear(year) {
    await ensureConfig();
    const def = layerDef("landuse_lulc");
    if (!def?.available) {
      return { ok: false, id: "landuse_lulc", available: false, message: "LULC unavailable" };
    }
    const entry = resolveLulcYearEntry(def, year);
    if (!entry) {
      return { ok: false, id: "landuse_lulc", available: false, message: `No LULC for ${year}` };
    }
    lulcYear = Number(entry.year);
    pendingShowId = "landuse_lulc";
    const seq = ++showSeq;
    return showLulcLayer(def, seq, { keepSelection: true });
  }

  function getSiltPeriods(def) {
    const fromDef = Array.isArray(def?.periods) && def.periods.length ? def.periods : null;
    return fromDef || SILT_CLASS_PERIODS;
  }

  function resolveSiltPeriodEntry(def, periodId) {
    const periods = getSiltPeriods(def);
    const id = String(periodId || "");
    return periods.find((p) => String(p.id) === id) || periods[periods.length - 1] || null;
  }

  function buildSiltClassLegend(def, period, coverageByLabel = null) {
    const source = def.classes?.length ? def.classes : SILT_CLASS_CLASSES;
    const classes = source.map((c) => {
      const label = c.label;
      const fromCoverage =
        coverageByLabel && typeof coverageByLabel === "object"
          ? coverageByLabel[label] || coverageByLabel[String(label)]
          : null;
      return {
        label,
        color: c.color,
        range: c.range || null,
        pct: fromCoverage || c.pct || c.range || null,
      };
    });
    const periods = getSiltPeriods(def);
    return {
      type: "classes",
      title: def.legendTitle || def.name || "Silt Classification",
      subtitle: `${period.label || period.id} · ${def.legendSubtitle || "JalNetra · date-wise"}`.replace(/\s+/g, " ").trim(),
      classes,
      periods: periods.map((p) => ({
        id: p.id,
        label: p.label || p.id,
        year: p.year,
        month: p.month,
      })),
      activePeriod: period.id,
      layerId: "silt_classification",
      interactiveClasses: false,
    };
  }

  async function showSiltClassificationLayer(def, expectedSeq = null, opts = {}) {
    const periods = getSiltPeriods(def);
    if (!periods.length) {
      return {
        ok: false,
        id: "silt_classification",
        available: false,
        message: "No silt classification periods configured",
      };
    }
    // Always open on most recent period unless switching
    if (!opts.keepSelection) {
      const preferred = def.defaultPeriod;
      siltClassPeriod = preferred
        ? periods.find((p) => String(p.id) === String(preferred))?.id || periods[periods.length - 1].id
        : periods[periods.length - 1].id;
    }
    const period = resolveSiltPeriodEntry(def, siltClassPeriod) || periods[periods.length - 1];
    siltClassPeriod = period.id;
    const periodType = period.type || (period.overlay ? "groundOverlay" : period.data ? "kmlPolygons" : "groundOverlay");

    if (periodType === "kmlPolygons" && period.data) {
      const polyDef = {
        ...def,
        id: "silt_classification",
        type: "kmlPolygons",
        data: period.data,
        classes: def.classes || def.legendClasses || SILT_CLASS_CLASSES,
        opacity: Number(def.opacity) || 0.88,
        liftM: Number(def.liftM) || 1.2,
        // Keep silt process polygons on the water surface (river KML channel).
        waterSurface: true,
      };
      await loadClassedPolygons(polyDef);
      if (expectedSeq != null && showSeq !== expectedSeq) {
        return { ok: true, id: "silt_classification", available: false, superseded: true };
      }
      if (pendingShowId !== "silt_classification") {
        return { ok: true, id: "silt_classification", available: false, superseded: true };
      }
      clearActiveMeshes();
      const slot = polygonSlot("silt_classification");
      if (slot.root) slot.root.visible = true;
      activeId = "silt_classification";
      group.visible = !!slot.root;
      return {
        ok: !!slot.root && slot.meshes.length > 0,
        id: "silt_classification",
        available: !!slot.root && slot.meshes.length > 0,
        message: slot.root ? undefined : "Failed to build silt classification polygons",
        legend: buildSiltClassLegend(def, period),
        stats: {
          period: period.id,
          type: "kmlPolygons",
          features: slot.featureIndex.length,
          meshes: slot.meshes.length,
        },
      };
    }

    let localOverlay = null;
    try {
      localOverlay = await loadSiltKmlGroundOverlay(period);
    } catch (err) {
      // Prefer period.overlay (JalNetra / offline paint) if local KML parse fails.
      console.warn("[silt_classification] local KML skipped:", err?.message || err);
    }
    const rawBounds = period.bounds || localOverlay?.bounds || def.bounds || SILT_CLASS_BOUNDS;
    const bounds = isMithiLatLonBox(rawBounds) ? rawBounds : { ...MITHI_CORRIDOR_BOUNDS };
    let overlayUrl = period.overlay || localOverlay?.image || "";
    if (!overlayUrl && (period.data || period.kml)) {
      return showSiltClassificationLayer(
        {
          ...def,
          periods: [{ ...period, type: "kmlPolygons", data: period.data || period.kml }],
          defaultPeriod: period.id,
        },
        expectedSeq,
        { keepSelection: true },
      );
    }
    // Clip LatLonBox rasters to the uploaded Mithi river KML so land stays clear.
    if (overlayUrl && !period.aoiMasked) {
      const sessionKml =
        (typeof window !== "undefined" && window.__RIVER_SESSION__?.kmlText) || "";
      if (sessionKml) {
        overlayUrl = await maskOverlayImageToRiverAoi(overlayUrl, bounds, sessionKml);
      }
    }
    const drapedDef = {
      ...def,
      id: "silt_classification",
      type: "groundOverlay",
      overlay: overlayUrl,
      bounds,
      opacity: Number(def.opacity) || 0.88,
      liftM: Number(def.liftM) || 1.2,
      gridSegments: Number(def.gridSegments) || 128,
      legendClasses: def.classes || def.legendClasses || [],
    };
    if (!drapedDef.overlay) {
      return {
        ok: false,
        id: "silt_classification",
        available: false,
        message: "Silt classification image missing for this month",
        legend: buildSiltClassLegend(def, period),
      };
    }
    await loadDrapedOverlay(drapedDef);
    if (expectedSeq != null && showSeq !== expectedSeq) {
      return { ok: true, id: "silt_classification", available: false, superseded: true };
    }
    if (pendingShowId !== "silt_classification") {
      return { ok: true, id: "silt_classification", available: false, superseded: true };
    }
    const poly = polygonSlot("silt_classification");
    if (poly.root) poly.root.visible = false;
    clearActiveMeshes();
    const slot = drapedOverlays.silt_classification;
    if (slot?.mesh) {
      showExactOverlayFootprint(slot);
      if (slot.mesh.material) {
        slot.mesh.material.opacity = Math.min(1, Number(drapedDef.opacity) || 0.88);
        slot.mesh.material.needsUpdate = true;
      }
    }
    activeId = "silt_classification";
    group.visible = !!slot?.mesh;
    return {
      ok: !!slot?.mesh,
      id: "silt_classification",
      available: !!slot?.mesh,
      message: slot?.mesh ? undefined : "Failed to build silt classification overlay",
      legend: buildSiltClassLegend(def, period, slot?.sampler?.coverageByLabel || null),
      stats: {
        period: period.id,
        type: "groundOverlay",
        hasMesh: !!slot?.mesh,
        bounds: drapedDef.bounds,
      },
    };
  }

  async function setSiltClassificationPeriod(periodId) {
    await ensureConfig();
    const def = layerDef("silt_classification");
    if (!def?.available) {
      return {
        ok: false,
        id: "silt_classification",
        available: false,
        message: "Silt classification unavailable",
      };
    }
    const entry = resolveSiltPeriodEntry(def, periodId);
    if (!entry) {
      return {
        ok: false,
        id: "silt_classification",
        available: false,
        message: `No silt classification for ${periodId}`,
      };
    }
    siltClassPeriod = entry.id;
    pendingShowId = "silt_classification";
    const seq = ++showSeq;
    return showSiltClassificationLayer(def, seq, { keepSelection: true });
  }

  function getSiltVolumePeriods(def) {
    const fromDef = Array.isArray(def?.periods) && def.periods.length ? def.periods : null;
    return fromDef || SILT_VOLUME_PERIODS;
  }

  function resolveSiltVolumePeriodEntry(def, periodId) {
    const periods = getSiltVolumePeriods(def);
    const id = String(periodId || "");
    return periods.find((p) => String(p.id) === id) || periods[periods.length - 1] || null;
  }

  function buildSiltVolumeLegend(def, period) {
    const classes = (def.classes?.length ? def.classes : SILT_VOLUME_CLASSES).map((c) => ({
      label: c.label,
      color: c.color,
      range: c.range,
    }));
    const periods = getSiltVolumePeriods(def);
    return {
      type: "classes",
      title: def.legendTitle || def.name || "Silt Verification",
      subtitle: `${period.label || period.id} · ${def.legendSubtitle || "JalNetra · date-wise"}`.replace(/\s+/g, " ").trim(),
      classes,
      periods: periods.map((p) => ({
        id: p.id,
        label: p.label || p.id,
        year: p.year,
        month: p.month,
      })),
      activePeriod: period.id,
      layerId: "silt_volume_surface",
      imageUrl: period.legend || null,
    };
  }

  async function showSiltVolumeLayer(def, expectedSeq = null, opts = {}) {
    const periods = getSiltVolumePeriods(def);
    if (!periods.length) {
      return {
        ok: false,
        id: "silt_volume_surface",
        available: false,
        message: "No silt volume periods configured",
      };
    }
    if (!opts.keepSelection) {
      const preferred = def.defaultPeriod;
      siltVolumePeriod = preferred
        ? periods.find((p) => String(p.id) === String(preferred))?.id || periods[periods.length - 1].id
        : periods[periods.length - 1].id;
    }
    const period = resolveSiltVolumePeriodEntry(def, siltVolumePeriod) || periods[periods.length - 1];
    siltVolumePeriod = period.id;
    const periodType = period.type || (period.overlay ? "groundOverlay" : period.data ? "kmlPolygons" : "groundOverlay");

    if (periodType === "kmlPolygons" && period.data) {
      const polyDef = {
        ...def,
        id: "silt_volume_surface",
        type: "kmlPolygons",
        data: period.data,
        classes: def.classes || def.legendClasses || SILT_VOLUME_CLASSES,
        opacity: Number(def.opacity) || 0.9,
        liftM: Number(def.liftM) || 1.5,
        waterSurface: true,
      };
      await loadClassedPolygons(polyDef);
      if (expectedSeq != null && showSeq !== expectedSeq) {
        return { ok: true, id: "silt_volume_surface", available: false, superseded: true };
      }
      if (pendingShowId !== "silt_volume_surface") {
        return { ok: true, id: "silt_volume_surface", available: false, superseded: true };
      }
      clearActiveMeshes();
      const slot = polygonSlot("silt_volume_surface");
      if (slot.root) slot.root.visible = true;
      activeId = "silt_volume_surface";
      group.visible = !!slot.root;
      return {
        ok: !!slot.root && slot.meshes.length > 0,
        id: "silt_volume_surface",
        available: !!slot.root && slot.meshes.length > 0,
        message: slot.root ? undefined : "Failed to build silt volume polygons",
        legend: buildSiltVolumeLegend(def, period),
        stats: {
          period: period.id,
          type: "kmlPolygons",
          features: slot.featureIndex.length,
          meshes: slot.meshes.length,
        },
      };
    }

    let localOverlay = null;
    try {
      localOverlay = await loadSiltKmlGroundOverlay(period);
    } catch (err) {
      console.warn("[silt_volume] local KML skipped:", err?.message || err);
    }
    const rawBounds = period.bounds || localOverlay?.bounds || def.bounds || SILT_VOLUME_BOUNDS;
    const bounds = isMithiLatLonBox(rawBounds) ? rawBounds : { ...MITHI_CORRIDOR_BOUNDS };
    let overlayUrl = period.overlay || localOverlay?.image || "";
    if (!overlayUrl && (period.data || period.kml)) {
      return showSiltVolumeLayer(
        {
          ...def,
          periods: [{ ...period, type: "kmlPolygons", data: period.data || period.kml }],
          defaultPeriod: period.id,
        },
        expectedSeq,
        { keepSelection: true },
      );
    }
    // Clip LatLonBox rasters to the uploaded Mithi river KML so land stays clear.
    if (overlayUrl && !period.aoiMasked) {
      const sessionKml =
        (typeof window !== "undefined" && window.__RIVER_SESSION__?.kmlText) || "";
      if (sessionKml) {
        overlayUrl = await maskOverlayImageToRiverAoi(overlayUrl, bounds, sessionKml);
      }
    }
    const drapedDef = {
      ...def,
      id: "silt_volume_surface",
      type: "groundOverlay",
      overlay: overlayUrl,
      bounds,
      opacity: Number(def.opacity) || 1,
      liftM: Number(def.liftM) || 1.5,
      gridSegments: Number(def.gridSegments) || 128,
      legendClasses: def.classes || def.legendClasses || [],
    };
    if (!drapedDef.overlay) {
      return {
        ok: false,
        id: "silt_volume_surface",
        available: false,
        message: "Silt verification image missing for this month",
        legend: buildSiltVolumeLegend(def, period),
      };
    }
    await loadDrapedOverlay(drapedDef);
    if (expectedSeq != null && showSeq !== expectedSeq) {
      return { ok: true, id: "silt_volume_surface", available: false, superseded: true };
    }
    if (pendingShowId !== "silt_volume_surface") {
      return { ok: true, id: "silt_volume_surface", available: false, superseded: true };
    }
    const poly = polygonSlot("silt_volume_surface");
    if (poly.root) poly.root.visible = false;
    clearActiveMeshes();
    const slot = drapedOverlays.silt_volume_surface;
    if (slot?.mesh) {
      showExactOverlayFootprint(slot);
      if (slot.mesh.material) {
        slot.mesh.material.opacity = Math.min(1, Number(drapedDef.opacity) || 1);
        slot.mesh.material.needsUpdate = true;
      }
    }
    activeId = "silt_volume_surface";
    group.visible = !!slot?.mesh;
    return {
      ok: !!slot?.mesh,
      id: "silt_volume_surface",
      available: !!slot?.mesh,
      message: slot?.mesh ? undefined : "Failed to build silt volume overlay",
      legend: buildSiltVolumeLegend(def, period),
      stats: {
        period: period.id,
        type: "groundOverlay",
        hasMesh: !!slot?.mesh,
        bounds: drapedDef.bounds,
      },
    };
  }

  async function setSiltVolumePeriod(periodId) {
    await ensureConfig();
    const def = layerDef("silt_volume_surface");
    if (!def?.available) {
      return {
        ok: false,
        id: "silt_volume_surface",
        available: false,
        message: "Silt volume unavailable",
      };
    }
    const entry = resolveSiltVolumePeriodEntry(def, periodId);
    if (!entry) {
      return {
        ok: false,
        id: "silt_volume_surface",
        available: false,
        message: `No silt volume for ${periodId}`,
      };
    }
    siltVolumePeriod = entry.id;
    pendingShowId = "silt_volume_surface";
    const seq = ++showSeq;
    return showSiltVolumeLayer(def, seq, { keepSelection: true });
  }

  /** Cache of parsed Mandovi pollution KMLs (data-URI ground overlays). */
  const kmlOverlayCache = new Map();

  async function resolveKmlGroundOverlay(def) {
    if (!def) return def;
    if (def.overlay && (/^data:image\//i.test(def.overlay) || def.overlay.startsWith("/") || /^https?:/i.test(def.overlay))) {
      return def;
    }
    const url = def.kmlUrl;
    if (!url) return def;
    if (kmlOverlayCache.has(url)) {
      const cached = kmlOverlayCache.get(url);
      return { ...def, overlay: cached.overlay, bounds: cached.bounds || def.bounds };
    }
    const candidates = [url, ...(def.kmlUrlFallbacks || [])];
    try {
      const decoded = decodeURIComponent(url);
      if (decoded !== url) candidates.push(decoded);
      const enc = encodeURI(decoded);
      if (!candidates.includes(enc)) candidates.push(enc);
    } catch {
      /* ignore */
    }
    if (/tss|water-quality|water_quality/i.test(url)) {
      candidates.push("/data/mithi/water_quality.kml");
      candidates.push(mandoviTssKmlUrl);
      candidates.push("/data/mithi/WATERQ-Pollution/tss.kml");
      candidates.push("/data/mithi/WATERQ-Pollution/tss%20(1).kml");
    }
    if (/chlorophyll|ndci/i.test(url)) {
      candidates.push(mandoviChlorophyllKmlUrl);
      candidates.push("/data/mithi/WATERQ-Pollution/chlorophyll.kml");
    }
    if (/lithology|geology/i.test(url)) {
      candidates.push("/data/mithi/lithology.kml");
    }
    if (/bank-erosion|bank_erosion/i.test(url)) {
      candidates.push("/data/mithi/bank_erosion_hotspots_2016_2026.kml");
    }
    if (/vegetation-health|vegetation_health/i.test(url)) {
      candidates.push("/data/mithi/vegetation_health.kml");
    }
    if (/water-depth|mithi_river_depth/i.test(url)) {
      candidates.push("/data/mithi/mithi_river_depth.kml");
    }
    if (/salinity/i.test(url) || def.id === "salinity") {
      candidates.push("/data/mithi/jalnetra-history/salinity1_21-10-2026__18-11-2026.kml");
      candidates.push("/data/mithi/WATERQ-Pollution/salinity.kml");
    }
    try {
      let lastErr = null;
      for (const candidate of [...new Set(candidates)]) {
        try {
          const res = await fetch(candidate, { cache: "no-store" });
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status} for ${candidate}`);
            continue;
          }
          const text = await res.text();
          if (/^\s*<!DOCTYPE html/i.test(text) || /^\s*<html/i.test(text)) {
            lastErr = new Error(`KML URL returned HTML (${candidate})`);
            continue;
          }
          const parsed = parseOverlayKml(text, candidate);
          if (!parsed.ground || !parsed.image) {
            lastErr = new Error("KML has no GroundOverlay image");
            continue;
          }
          kmlOverlayCache.set(url, { overlay: parsed.image, bounds: parsed.bounds });
          if (BUILTIN_LAYER_DEFS[def.id]) {
            BUILTIN_LAYER_DEFS[def.id].overlay = parsed.image;
            if (parsed.bounds) BUILTIN_LAYER_DEFS[def.id].bounds = parsed.bounds;
          }
          return {
            ...def,
            available: true,
            overlay: parsed.image,
            bounds: parsed.bounds || def.bounds,
          };
        } catch (err) {
          lastErr = err;
        }
      }
      return {
        ...def,
        available: false,
        message: lastErr?.message || "KML has no GroundOverlay image",
      };
    } catch (err) {
      return {
        ...def,
        available: false,
        message: err?.message || "Failed to load pollution KML",
      };
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<{ ok:boolean, id:string, available:boolean, legend?:object, message?:string, stats?:object }>}
   */
  async function showLayer(id) {
    const seq = ++showSeq;
    pendingShowId = id;
    // Local / demo KMLs are bundled — never wait on JalNetra for them.
    const localMandoviBundle =
      id === "geology" ||
      id === "bank_erosion" ||
      id === "water_depth" ||
      id === "vegetation_health" ||
      id === "salinity" ||
      id === "water_quality_tss" ||
      id === "water_quality_ndci" ||
      id === "pollution_eutrophication" ||
      id === "pollution_nitrogen" ||
      id === "pollution_coliform";
    if (!localMandoviBundle) await ensureLiveOverlay(id);
    await ensureConfig();
    if (pendingShowId !== id) return { ok: false, id, available: false, superseded: true };

    let def = layerDef(id);
    if (!def) return { ok: false, id, available: false, message: "Unknown hydrology layer" };

    // Salinity: prefer LatLonBox GroundOverlay (exact KML footprint). Polygon zones are fallback only.
    if (id === "salinity" && BUILTIN_LAYER_DEFS.salinity) {
      const scheme = WQ_LAYER_SCHEMES.salinity;
      const builtin = BUILTIN_LAYER_DEFS.salinity;
      def = {
        ...def,
        ...builtin,
        available: true,
        type: def.type === "groundOverlay" && def.overlay ? def.type : builtin.type,
        overlay: def.overlay || builtin.overlay || "",
        bounds: isMithiLatLonBox(def.bounds) ? def.bounds : { ...MITHI_CORRIDOR_BOUNDS },
        kmlUrl: def.kmlUrl || builtin.kmlUrl,
        kmlUrlFallbacks: builtin.kmlUrlFallbacks,
      };
      if (scheme) {
        def.classes = scheme.classes;
        def.unit = scheme.unit;
        def.legendTitle = scheme.title;
        def.legendSubtitle = scheme.subtitle || "PSU · Mithi LatLonBox";
      }
    }

    if (!def.available) {
      if (pendingShowId !== id) return { ok: false, id, available: false, superseded: true };
      clearActiveMeshes();
      activeId = id;
      group.visible = false;
      return {
        ok: true,
        id,
        available: false,
        loading: !!def.loading,
        message: def.unavailableLabel || "DATA UNAVAILABLE",
        reason: def.reason || null,
        legend: null,
      };
    }

    if (
      (DRAPED_CLASS_LAYER_IDS.has(id) || def.type === "groundOverlay") &&
      def.type !== "kmlPolygons"
    ) {
      def = await resolveKmlGroundOverlay(def);
      const salinityNeedsPolygonFallback =
        id === "salinity" && (!def?.overlay || !def?.available);

      if (!salinityNeedsPolygonFallback) {
        if (!def?.available && def?.message) {
          return { ok: false, id, available: false, message: def.message };
        }
        if (!def?.overlay) {
          return {
            ok: false,
            id,
            available: false,
            message: def?.message || "Ground overlay image missing in KML",
          };
        }
        // Never drape a non-Mithi LatLonBox onto the Mithi river twin.
        if (
          def.bounds &&
          !isMithiLatLonBox(def.bounds) &&
          (id === "salinity" ||
            id === "landuse_lulc" ||
            id === "vegetation_extent" ||
            id === "vegetation_health" ||
            id === "silt_classification" ||
            id === "silt_volume_surface")
        ) {
          def = { ...def, bounds: { ...MITHI_CORRIDOR_BOUNDS } };
        }
        await loadDrapedOverlay(def);
        if (pendingShowId !== id) {
          return { ok: true, id, available: false, superseded: true };
        }
        clearActiveMeshes();
        const slot = drapedOverlays[id];
        if (!slot?.mesh && slot) {
          slot.loaded = false;
          slot.loading = null;
          await loadDrapedOverlay(def);
        }
        if (pendingShowId !== id) {
          return { ok: true, id, available: false, superseded: true };
        }
        clearActiveMeshes();
        if (slot?.mesh) {
          showExactOverlayFootprint(slot, id);
          if (slot.mesh.material) {
            slot.mesh.material.opacity = Math.min(1, Number(def.opacity) || 1);
            slot.mesh.material.needsUpdate = true;
          }
          if (slot.paste?.material) {
            slot.paste.material.opacity = Math.min(1, Number(def.opacity) || 1);
            slot.paste.material.needsUpdate = true;
          }
        }
        activeId = id;
        group.visible = !!(slot?.mesh || slot?.paste);
        const coverage = slot?.sampler?.coverageByLabel || null;
        const sourceClasses = def.legendClasses || def.classes || [];
        const legend =
          sourceClasses.length
            ? {
                type: "classes",
                title: def.legendTitle || def.name,
                subtitle: def.legendSubtitle || null,
                unit: def.unit || null,
                layerId: id,
                interactiveClasses: false,
                classes: sourceClasses.map((c) => ({
                  label: c.label,
                  color: c.color,
                  range: c.range || null,
                  pct:
                    c.pct ||
                    (coverage && (coverage[c.label] || coverage[String(c.label)])) ||
                    null,
                })),
              }
            : { type: "image", url: def.legend, title: def.name, layerId: id };
        return {
          ok: !!slot?.mesh,
          id,
          available: !!slot?.mesh,
          message: slot?.mesh ? undefined : `Failed to build ${id} overlay mesh`,
          legend,
          stats: {
            bounds: def.bounds,
            segments: def.gridSegments,
            opacity: def.opacity,
            hasMesh: !!slot?.mesh,
          },
        };
      }

      // Salinity GroundOverlay unavailable → classed corridor polygons
      def = {
        ...BUILTIN_LAYER_DEFS.salinity,
        ...def,
        type: "kmlPolygons",
        available: true,
        data: BUILTIN_LAYER_DEFS.salinity.data,
        dataFallbacks: BUILTIN_LAYER_DEFS.salinity.dataFallbacks,
        waterSurface: true,
        rasterizeWaterOverlay: true,
        liftM: 3.2,
      };
    }

    if (id === "landuse_lulc" || def.type === "lulcYears") {
      return showLulcLayer(def, pendingShowId === id ? showSeq : -1);
    }

    if (id === "silt_classification" || def.type === "siltClassificationPeriods") {
      return showSiltClassificationLayer(def, pendingShowId === id ? showSeq : -1);
    }

    if (id === "silt_volume_surface" || def.type === "siltVolumePeriods") {
      return showSiltVolumeLayer(def, pendingShowId === id ? showSeq : -1);
    }

    if (id === "pollution" || def.type === "garbagePoints") {
      const dataUrl = def.data || "/data/hydrology/pollution/garbage-locations.kml";
      try {
        await pollutionGarbage.userData.load(dataUrl);
      } catch (err) {
        console.error("[GarbageSystem] Initialization failed:", err);
        return {
          ok: false,
          id: "pollution",
          available: false,
          message: err?.message || "Garbage layer failed to load",
        };
      }
      if (pendingShowId !== id) {
        return { ok: true, id, available: false, superseded: true };
      }
      clearActiveMeshes();
      pollutionGarbage.userData.setVisible(true);
      pollutionGarbage.userData.setLabelsEnabled?.(true);
      pollutionGarbage.userData.setClassFilter?.(null);
      activeId = "pollution";
      group.visible = true;
      const count = pollutionGarbage.userData.getCount?.() || 0;
      const report = pollutionGarbage.userData.getReport?.() || {};
      const riverN = (report.riverAssociated || 0) + (report.nearRiver || 0);
      return {
        ok: count > 0,
        id: "pollution",
        available: count > 0,
        message: count > 0 ? undefined : "No garbage locations found",
        legend: {
          type: "classes",
          title: def.legendTitle || "Pollution",
          subtitle:
            def.legendSubtitle ||
            `${count} KML sites · ${riverN} river-associated`,
          classes: [
            { label: "Garbage location", color: "#E89A1C" },
            { label: "Density LOW", color: "#F1C40F" },
            { label: "Density MEDIUM", color: "#E67E22" },
            { label: "Density HIGH", color: "#C0392B" },
          ],
          layerId: "pollution",
          garbageDensityToggle: true,
          densityOn: !!pollutionGarbage.userData.getShowDensity?.(),
        },
        stats: {
          sites: count,
          data: dataUrl,
          report,
        },
      };
    }

    if (POLYGON_LAYER_IDS.has(id) || def.type === "polygon" || def.type === "kmlPolygons") {
      await loadClassedPolygons(def);
      if (pendingShowId !== id) return { ok: false, id, available: false, superseded: true };
      clearActiveMeshes();
      const slot = polygonSlot(id);
      if (slot.root) slot.root.visible = true;
      activeId = id;
      group.visible = !!slot.root;
      const legendClasses =
        (def.classes || []).length > 0
          ? def.classes
          : slot.meshes.map((m) => ({
              label: m.userData.class_label,
              color: m.userData.color,
              range: m.userData.range,
            }));
      return {
        ok: !!slot.root,
        id,
        available: !!slot.root && slot.meshes.length > 0,
        legend: {
          type: "classes",
          title: def.legendTitle || def.name,
          subtitle: def.legendSubtitle || null,
          layerId: id,
          classes: legendClasses.map((c) => ({
            label: c.label,
            color: c.color,
            range: c.range,
          })),
        },
        stats: {
          features: slot.featureIndex.length,
          meshes: slot.meshes.length,
          bounds: def.bounds,
          opacity: def.opacity,
        },
      };
    }

    return { ok: false, id, available: false, message: "Layer not implemented in this phase" };
  }

  function hideAll() {
    showSeq += 1;
    pendingShowId = null;
    clearActiveMeshes();
    activeId = null;
    group.visible = false;
  }

  function getActiveId() {
    return activeId;
  }

  function getConfig() {
    return config;
  }

  /** Ray pick salinity / WQ polygons / bank erosion / geology / pollution at local XZ. */
  function pickAt(x, z) {
    if (activeId === "bank_erosion") {
      return sampleBankErosionAt(x, z);
    }
    if (activeId === "geology") {
      return sampleGeologyAt(x, z);
    }
    if (
      activeId === "landuse_lulc" ||
      activeId === "silt_classification" ||
      activeId === "silt_volume_surface" ||
      activeId === "vegetation_extent" ||
      activeId === "vegetation_health"
    ) {
      return sampleLandUseAt(x, z);
    }
    if (activeId === "pollution") {
      return pollutionGarbage.userData?.pickAt?.(x, z) || null;
    }
    if (!POLYGON_LAYER_IDS.has(activeId)) return null;
    const slot = polygonSlot(activeId);
    if (!slot.featureIndex.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const f of slot.featureIndex) {
      if (!pointInPolyXZ(x, z, f.vertices)) continue;
      const d = (f.x - x) ** 2 + (f.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /** Sample draped class overlay (salinity / NDCI) at local XZ. */
  function sampleDrapedClassAt(id, x, z) {
    const slot = drapedOverlays[id];
    const sampler = slot?.sampler;
    if (!sampler || activeId !== id) return null;
    const ll = localToLonLat(x, z);
    const hit = sampler.sampleLonLat(ll.lon, ll.lat);
    if (!hit) return null;
    return {
      ...hit,
      x,
      z,
      lon: ll.lon,
      lat: ll.lat,
      hydrology: id,
    };
  }

  /** Sample bank-erosion class from the JalNetra LatLonBox raster (same as Earth). */
  function sampleBankErosionAt(x, z) {
    return sampleDrapedClassAt("bank_erosion", x, z);
  }

  /** Sample spectral lithology class at local XZ (click identification). */
  function sampleGeologyAt(x, z) {
    const slot = drapedOverlays.geology;
    const sampler = slot?.sampler;
    if (!sampler || activeId !== "geology") return null;
    const ll = localToLonLat(x, z);
    const hit = sampler.sampleLonLat(ll.lon, ll.lat);
    if (!hit) return null;
    return {
      ...hit,
      x,
      z,
      lon: ll.lon,
      lat: ll.lat,
      hydrology: "geology",
    };
  }

  /** Sample LULC / silt / vegetation class under the pointer for hover tooltips. */
  function sampleLandUseAt(x, z) {
    const id = activeId;
    if (
      id !== "landuse_lulc" &&
      id !== "silt_classification" &&
      id !== "silt_volume_surface" &&
      id !== "vegetation_extent" &&
      id !== "vegetation_health"
    ) {
      return null;
    }
    const slot = drapedOverlays[id];
    const sampler = slot?.sampler;
    if (!sampler) return null;
    const ll = localToLonLat(x, z);
    const hit = sampler.sampleLonLat(ll.lon, ll.lat);
    if (!hit) return null;
    const scheme = WQ_LAYER_SCHEMES[id];
    const schemeClass =
      scheme?.classes?.find(
        (c) =>
          String(c.label).toLowerCase() === String(hit.class_label || hit.label || "").toLowerCase() ||
          String(c.id).toLowerCase() === String(hit.id || "").toLowerCase(),
      ) || null;
    return {
      ...hit,
      x,
      z,
      lon: ll.lon,
      lat: ll.lat,
      hydrology: id,
      range: hit.range || hit.pct || schemeClass?.range || null,
      metric: scheme?.metric || null,
      value: hit.value ?? (schemeClass ? classRepresentativeValue(schemeClass) : null),
      layerTitle:
        id === "landuse_lulc"
          ? "LULC"
          : id === "silt_volume_surface"
            ? "SILT VOLUME"
            : "SILT CLASS",
      valueText:
        id === "silt_volume_surface" && hit.value != null && Number.isFinite(Number(hit.value))
          ? `${Number(hit.value) >= 10 ? Number(hit.value).toFixed(1) : Number(hit.value).toFixed(2)} m³`
          : hit.valueText ||
            (schemeClass && scheme?.unit
              ? formatWqValue(classRepresentativeValue(schemeClass), scheme.unit)
              : null),
      unit: id === "silt_volume_surface" ? "m³" : scheme?.unit || hit.unit || null,
    };
  }

  function dispose() {
    hideAll();
    for (const slot of Object.values(drapedOverlays)) {
      if (slot.mesh) {
        group.remove(slot.mesh);
        disposeObject(slot.mesh);
        slot.mesh = null;
        slot.loaded = false;
      }
      slot.sampler = null;
    }
    for (const slot of Object.values(polygonLayers)) {
      if (slot.root) {
        group.remove(slot.root);
        disposeObject(slot.root);
        slot.root = null;
        slot.meshes = [];
        slot.featureIndex = [];
        slot.loaded = false;
        slot.loading = null;
      }
    }
    pollutionGarbage.userData?.dispose?.();
    group.remove(pollutionGarbage);
  }

  let erosionAnimTime = 0;

  function update(dt) {
    if (activeId === "pollution") {
      pollutionGarbage.userData?.update?.(dt, group.userData._camera || null);
    }
    if (activeId === "bank_erosion") {
      erosionAnimTime += dt;
      const slot = drapedOverlays.bank_erosion;
      const ribbon = slot?.paste;
      if (ribbon?.material) updateBankErosionMaterial(ribbon.material, erosionAnimTime);
      const mesh = slot?.mesh;
      if (mesh?.userData?.animateBankErosion) {
        updateBankErosionMaterial(mesh.material, erosionAnimTime);
      }
    }
  }

  function setCamera(camera) {
    group.userData._camera = camera || null;
  }

  /** Validate active layer geographic footprint (lon/lat of corners / samples). */
  function validateExtent() {
    const out = { activeId, checks: [] };
    if (activeId === "geology" && geology.mesh) {
      const b = geology.mesh.userData.boundsLonLat;
      out.checks.push({
        layer: "geology",
        lon: [b.west, b.east],
        lat: [b.south, b.north],
        ok:
          b.west >= 73.84 &&
          b.east <= 74.0 &&
          b.south >= 18.5 &&
          b.north <= 18.57,
      });
    }
    if (POLYGON_LAYER_IDS.has(activeId)) {
      const slot = polygonSlot(activeId);
      if (slot.featureIndex.length) {
        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        const step = Math.max(1, Math.floor(slot.featureIndex.length / 40));
        for (let i = 0; i < slot.featureIndex.length; i += step) {
          const f = slot.featureIndex[i];
          const ll = f.vertices[0];
          if (!ll) continue;
          minLon = Math.min(minLon, ll.lon);
          maxLon = Math.max(maxLon, ll.lon);
          minLat = Math.min(minLat, ll.lat);
          maxLat = Math.max(maxLat, ll.lat);
        }
        out.checks.push({
          layer: activeId,
          sampleLon: [minLon, maxLon],
          sampleLat: [minLat, maxLat],
          features: slot.featureIndex.length,
          meshes: slot.meshes.length,
          ok:
            minLon >= 73.85 &&
            maxLon <= 74.0 &&
            minLat >= 18.5 &&
            maxLat <= 18.57,
        });
      }
    }
    return out;
  }

  group.userData = {
    showLayer,
    hideAll,
    getActiveId,
    getConfig,
    ensureConfig,
    pickAt,
    sampleBankErosionAt,
    sampleGeologyAt,
    sampleLandUseAt,
    setLulcYear,
    getLulcYear: () => lulcYear,
    setSiltClassificationPeriod,
    getSiltClassificationPeriod: () => siltClassPeriod,
    setSiltVolumePeriod,
    getSiltVolumePeriod: () => siltVolumePeriod,
    update,
    setCamera,
    dispose,
    validateExtent,
    layerDef: (id) => layerDef(id),
    getPollutionLayer: () => pollutionGarbage,
  };

  return group;
}

/** Colored pixels in the API image, so a straight analysis strip can be laid on the bends. */
function colorStrip(image) {
  const iw = image?.width || image?.videoWidth || 0;
  const ih = image?.height || image?.videoHeight || 0;
  if (iw < 4 || ih < 4) return null;
  const w = Math.min(220, iw);
  const h = Math.min(220, ih);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const bg = [0, 0, 0];
  for (const [x, y] of [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]]) {
    const i = (y * w + x) * 4;
    bg[0] += px[i];
    bg[1] += px[i + 1];
    bg[2] += px[i + 2];
  }
  bg[0] /= 4;
  bg[1] /= 4;
  bg[2] /= 4;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let n = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (px[i + 3] < 40) continue;
      const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
      if (d < 40) continue;
      n += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (n < 12 || maxX <= minX || maxY <= minY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    w,
    h,
    vertical: maxY - minY >= maxX - minX,
    coverage: n / ((w * h) / 4),
  };
}

/**
 * Bank-erosion display mesh: true left/right banks of the twin corridor,
 * with the JalNetra coloured strip stretched along chainage.
 * This is the only visible surface for bank_erosion (LatLonBox stays hidden).
 */
function buildBankErosionRibbon(stations, texture, bounds) {
  if (!texture || !stations || stations.length < 2) return null;

  // Subsample dense corridors so the ribbon stays smooth but light.
  const step = Math.max(1, Math.floor(stations.length / 420));
  const pts = [];
  for (let i = 0; i < stations.length; i += step) pts.push(stations[i]);
  if (pts[pts.length - 1] !== stations[stations.length - 1]) pts.push(stations[stations.length - 1]);
  const n = pts.length;
  if (n < 2) return null;

  const dist = new Array(n);
  dist[0] = 0;
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  const total = dist[n - 1] || 1;

  const strip = colorStrip(texture.image);
  const start = localToLonLat(pts[0].x, pts[0].z);
  const end = localToLonLat(pts[n - 1].x, pts[n - 1].z);
  // Prefer image long-axis along chainage; flip if river runs opposite to image.
  let vertical = strip ? strip.vertical : Math.abs(end.lat - start.lat) >= Math.abs(end.lon - start.lon);
  if (!strip) {
    // Fall back to full-image UVs along chainage × across.
    vertical = Math.abs(end.lat - start.lat) >= Math.abs(end.lon - start.lon);
  }
  const flip = vertical ? start.lat < end.lat : start.lon > end.lon;

  const west = Number(bounds?.west);
  const east = Number(bounds?.east);
  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const lonSpan = east - west;
  const latSpan = north - south;
  const haveBox = [west, east, north, south].every(Number.isFinite) && lonSpan && latSpan;

  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    const s = pts[i];
    const t = flip ? 1 - dist[i] / total : dist[i] / total;
    // Use surveyed bank intersections when present — that locks the ribbon to water.
    let lx = Number.isFinite(s.leftX) ? s.leftX : s.x;
    let lz = Number.isFinite(s.leftZ) ? s.leftZ : s.z;
    let rx = Number.isFinite(s.rightX) ? s.rightX : s.x;
    let rz = Number.isFinite(s.rightZ) ? s.rightZ : s.z;
    if (!Number.isFinite(s.leftX) || !Number.isFinite(s.rightX)) {
      const flowLen = Math.hypot(s.flowX || 0, s.flowZ || 0) || 1;
      const nx = -(s.flowZ || 0) / flowLen;
      const nz = (s.flowX || 1) / flowLen;
      const half = Math.max(28, s.halfWidth || 30);
      lx = s.x - nx * half;
      lz = s.z - nz * half;
      rx = s.x + nx * half;
      rz = s.z + nz * half;
    }
    // Slight pad so banks stay covered without spilling onto buildings.
    const cx = (lx + rx) * 0.5;
    const cz = (lz + rz) * 0.5;
    const pad = 1.08;
    lx = cx + (lx - cx) * pad;
    lz = cz + (lz - cz) * pad;
    rx = cx + (rx - cx) * pad;
    rz = cz + (rz - cz) * pad;

    const y = SURFACE_Y + 1.45;
    positions[(i * 2) * 3] = lx;
    positions[(i * 2) * 3 + 1] = y;
    positions[(i * 2) * 3 + 2] = lz;
    positions[(i * 2 + 1) * 3] = rx;
    positions[(i * 2 + 1) * 3 + 1] = y;
    positions[(i * 2 + 1) * 3 + 2] = rz;

    for (let k = 0; k < 2; k++) {
      const across = k === 0 ? 0.06 : 0.94;
      const vi = i * 2 + k;
      if (strip) {
        const px = vertical
          ? strip.minX + (strip.maxX - strip.minX) * across
          : strip.minX + (strip.maxX - strip.minX) * t;
        const py = vertical
          ? strip.minY + (strip.maxY - strip.minY) * t
          : strip.minY + (strip.maxY - strip.minY) * across;
        uvs[vi * 2] = px / strip.w;
        uvs[vi * 2 + 1] = py / strip.h;
      } else if (haveBox) {
        const x = k === 0 ? lx : rx;
        const z = k === 0 ? lz : rz;
        const ll = localToLonLat(x, z);
        uvs[vi * 2] = (ll.lon - west) / lonSpan;
        uvs[vi * 2 + 1] = (north - ll.lat) / latSpan;
      } else {
        uvs[vi * 2] = across;
        uvs[vi * 2 + 1] = t;
      }
    }
  }

  const indices = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  const mat = createBankErosionMaterial(texture, { opacity: 0.78 });
  mat.depthTest = false;
  mat.depthWrite = false;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "bankErosionRibbon";
  mesh.renderOrder = 58;
  mesh.frustumCulled = false;
  mesh.userData.riverPaste = true;
  mesh.userData.bankErosionRibbon = true;
  mesh.userData.animateBankErosion = true;
  return mesh;
}

/** @deprecated kept for any residual callers — prefer buildBankErosionRibbon */
function buildRiverPaste(stations, texture, bounds, opts = {}) {
  return buildBankErosionRibbon(stations, texture, bounds);
}

function sampleHydroY(x, z, stations, lift) {
  const ty = stations?.length ? terrainHeightAt(x, z, stations) : SURFACE_Y + 2;
  // Always sit on/above the water surface so river-corridor overlays are not buried
  // under the translucent water mesh (SURFACE_Y = 9.4).
  const base = Math.max(ty, SURFACE_Y);
  return base + Math.max(0.55, Number(lift) || 0.55);
}

/**
 * Decode bank-erosion overlay into ImageData and match pixels to legend classes.
 * UV mapping must mirror buildDrapedGridMesh (flipV for bank_erosion).
 */
async function createBankErosionSampler(def) {
  const box = def.bounds;
  const west = Number(box.west);
  const east = Number(box.east);
  const north = Number(box.north);
  const south = Number(box.south);
  const flipU = false;
  const flipV = true;
  const classes = (def.legendClasses || []).map((c) => {
    const hex = normalizeHex(c.color) || "#888888";
    const rgb = hexToRgb(hex);
    return {
      id: c.id,
      label: c.label,
      color: hex,
      pct: c.pct || null,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
    };
  });

  const blob = await overlayBlob(def.overlay);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  const coverageByLabel = computeClassCoveragePct(data, width, height, classes);
  for (const c of classes) {
    if (coverageByLabel[c.label]) c.pct = coverageByLabel[c.label];
  }

  function sampleLonLat(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < west || lon > east || lat < south || lat > north) return null;
    const u = (lon - west) / (east - west);
    // Match buildDrapedGridMesh UV: with flipV, north→image top (v=0).
    const texU = flipU ? 1 - u : u;
    const texV = flipV
      ? (north - lat) / (north - south)
      : (lat - south) / (north - south);
    const px = Math.min(width - 1, Math.max(0, Math.round(texU * (width - 1))));
    const py = Math.min(height - 1, Math.max(0, Math.round(texV * (height - 1))));
    const i = (py * width + px) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 28) return null;
    // Skip near-black / empty corridor fill
    if (r + g + b < 40) return null;

    let best = null;
    let bestD = Infinity;
    for (const c of classes) {
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    // Reject weak matches (mixed / anti-aliased edge far from class colors)
    if (!best || bestD > 95 * 95) return null;
    return {
      class_label: best.label,
      label: best.label,
      id: best.id,
      color: best.color,
      pct: best.pct,
      class: best.label,
    };
  }

  return { sampleLonLat, width, height, west, east, north, south, coverageByLabel };
}

/**
 * Approximate class area share from draped overlay pixels (skips transparent / empty).
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {{ label: string, r: number, g: number, b: number }[]} classes
 */
function computeClassCoveragePct(data, width, height, classes) {
  /** @type {Record<string, number>} */
  const counts = Object.create(null);
  for (const c of classes) counts[c.label] = 0;
  let total = 0;
  const pixels = Math.max(1, width * height);
  const step = Math.max(1, Math.floor(Math.sqrt(pixels / 90000)));
  const maxDist = 95 * 95;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 28) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r + g + b < 40) continue;
      let best = null;
      let bestD = Infinity;
      for (const c of classes) {
        const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (!best || bestD > maxDist) continue;
      counts[best.label] = (counts[best.label] || 0) + 1;
      total += 1;
    }
  }
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  for (const c of classes) {
    const n = counts[c.label] || 0;
    out[c.label] = total > 0 ? `${((100 * n) / total).toFixed(1)}%` : "0%";
  }
  return out;
}

/**
 * LULC / silt draped overlay sampler — same UV as buildDrapedGridMesh (flipV).
 * Silt overlays are upscaled (~12k px) — use a dedicated downsampled sampler.
 */
async function createLandUseSampler(def, id) {
  if (id === "silt_classification" || id === "silt_volume_surface") {
    return createSiltOverlaySampler(def, id);
  }
  const classes =
    (Array.isArray(def.legendClasses) && def.legendClasses.length
      ? def.legendClasses
      : null) ||
    (Array.isArray(def.classes) && def.classes.length ? def.classes : null) ||
    (id === "landuse_lulc" ? LULC_LEGEND : []);
  if (!classes.length || !def.overlay || !def.bounds) {
    throw new Error(`${id} sampler missing classes/overlay/bounds`);
  }
  return createBankErosionSampler({
    ...def,
    legendClasses: classes.map((c, i) => ({
      id: c.id || `class_${i}`,
      label: c.label,
      color: c.color,
      pct: c.pct || c.range || null,
    })),
  });
}

/**
 * Decode silt classification / volume overlays for hover.
 * - Classification: snap to discrete legend colors (Low → Very High)
 * - Volume: project pixel RGB onto the white→brown ramp → numeric 0–94.31
 * Downsamples large smoothed PNGs so getImageData stays reliable on Windows.
 */
async function createSiltOverlaySampler(def, id) {
  const box = def.bounds;
  const west = Number(box.west);
  const east = Number(box.east);
  const north = Number(box.north);
  const south = Number(box.south);
  if (![west, east, north, south].every(Number.isFinite)) {
    throw new Error(`${id} sampler bounds invalid`);
  }

  const isVolume = id === "silt_volume_surface";
  const rawClasses =
    (Array.isArray(def.legendClasses) && def.legendClasses.length
      ? def.legendClasses
      : null) ||
    (Array.isArray(def.classes) && def.classes.length ? def.classes : null) ||
    (isVolume ? SILT_VOLUME_CLASSES : SILT_CLASS_CLASSES);

  const classes = rawClasses.map((c, i) => {
    const hex = normalizeHex(c.color) || "#888888";
    const rgb = hexToRgb(hex);
    const value =
      Number.isFinite(Number(c.value))
        ? Number(c.value)
        : isVolume
          ? (i / Math.max(1, rawClasses.length - 1)) * SILT_VOLUME_MAX
          : null;
    return {
      id: c.id || `class_${i}`,
      label: c.label,
      color: hex,
      pct: c.pct || c.range || null,
      value,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
    };
  });

  const blob = await overlayBlob(def.overlay);
  const full = await createImageBitmap(blob);
  const maxW = 2048;
  const scale = Math.min(1, maxW / Math.max(1, full.width));
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = !isVolume ? false : true;
  ctx.drawImage(full, 0, 0, width, height);
  full.close?.();
  const { data } = ctx.getImageData(0, 0, width, height);

  const coverageByLabel = !isVolume
    ? computeClassCoveragePct(data, width, height, classes)
    : null;
  if (coverageByLabel) {
    for (const c of classes) {
      if (coverageByLabel[c.label]) c.pct = coverageByLabel[c.label];
    }
  }

  function rgbToHex(r, g, b) {
    const h = (n) => n.toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  /** Project RGB onto piecewise-linear legend ramp → continuous value. */
  function volumeFromRgb(r, g, b) {
    if (classes.length < 2) {
      return { value: classes[0]?.value ?? 0, color: classes[0]?.color, label: classes[0]?.label };
    }
    let bestD = Infinity;
    let bestValue = 0;
    let bestColor = classes[0].color;
    let bestLabel = classes[0].label;
    for (let i = 0; i < classes.length - 1; i++) {
      const a = classes[i];
      const c = classes[i + 1];
      const abx = c.r - a.r;
      const aby = c.g - a.g;
      const abz = c.b - a.b;
      const abLen2 = abx * abx + aby * aby + abz * abz || 1;
      let t = ((r - a.r) * abx + (g - a.g) * aby + (b - a.b) * abz) / abLen2;
      t = Math.max(0, Math.min(1, t));
      const pr = a.r + abx * t;
      const pg = a.g + aby * t;
      const pb = a.b + abz * t;
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bestD) {
        bestD = d;
        const va = Number.isFinite(a.value) ? a.value : 0;
        const vc = Number.isFinite(c.value) ? c.value : SILT_VOLUME_MAX;
        bestValue = va + (vc - va) * t;
        bestColor = rgbToHex(
          Math.round(pr),
          Math.round(pg),
          Math.round(pb),
        );
        // Prefer the nearer stop label for the chip text
        bestLabel = t < 0.5 ? a.label : c.label;
      }
    }
    // Also allow snap to endpoint classes (outside segment projection)
    for (const c of classes) {
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestD) {
        bestD = d;
        bestValue = Number.isFinite(c.value) ? c.value : bestValue;
        bestColor = c.color;
        bestLabel = c.label;
      }
    }
    return {
      value: Math.max(0, Math.min(SILT_VOLUME_MAX, bestValue)),
      color: bestColor,
      label: bestLabel,
      matchDist: Math.sqrt(bestD),
    };
  }

  function classFromRgb(r, g, b) {
    let best = null;
    let bestD = Infinity;
    for (const c of classes) {
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    // Remapped overlays are exact legend colors; allow some edge bleed.
    if (!best || bestD > 110 * 110) return null;
    return best;
  }

  function sampleLonLat(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < west || lon > east || lat < south || lat > north) return null;
    const texU = (lon - west) / (east - west);
    const texV = (north - lat) / (north - south);
    const px = Math.min(width - 1, Math.max(0, Math.round(texU * (width - 1))));
    const py = Math.min(height - 1, Math.max(0, Math.round(texV * (height - 1))));
    const i = (py * width + px) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 20) return null;
    if (r + g + b < 24) return null;

    if (isVolume) {
      const hit = volumeFromRgb(r, g, b);
      const value = hit.value;
      const valueLabel =
        value >= 10 ? value.toFixed(1) : value.toFixed(2);
      const valueText = `${valueLabel} m³`;
      return {
        class_label: valueText,
        label: valueText,
        id: "volume",
        color: hit.color || rgbToHex(r, g, b),
        sampleColor: rgbToHex(r, g, b),
        pct: null,
        value,
        valueMax: SILT_VOLUME_MAX,
        unit: "m³",
        valueText,
        rampLabel: hit.label,
        class: valueText,
      };
    }

    const best = classFromRgb(r, g, b);
    if (!best) return null;
    return {
      class_label: best.label,
      label: best.label,
      id: best.id,
      color: best.color,
      sampleColor: rgbToHex(r, g, b),
      pct: best.pct,
      class: best.label,
    };
  }

  return { sampleLonLat, width, height, west, east, north, south, kind: id, coverageByLabel };
}

/**
 * Geology / Spectral Lithology overlay sampler — matches LITHOLOGY_CLASSES colors.
 * UV matches buildDrapedGridMesh with flipV (north = image top).
 */
async function createGeologySampler(def) {
  const box = def.bounds;
  const west = Number(box.west);
  const east = Number(box.east);
  const north = Number(box.north);
  const south = Number(box.south);
  const classes = LITHOLOGY_CLASSES.map((c) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    pct: c.pct,
    samples: (c.samples || []).map(([r, g, b]) => ({ r, g, b })),
  }));

  const blob = await overlayBlob(def.overlay);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  function sampleLonLat(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < west || lon > east || lat < south || lat > north) return null;
    const texU = (lon - west) / (east - west);
    // flipV: north → image top (v=0)
    const texV = (north - lat) / (north - south);
    const px = Math.min(width - 1, Math.max(0, Math.round(texU * (width - 1))));
    const py = Math.min(height - 1, Math.max(0, Math.round(texV * (height - 1))));
    const i = (py * width + px) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 28 || r + g + b < 40) return null;

    let best = null;
    let bestD = Infinity;
    for (const c of classes) {
      for (const s of c.samples) {
        const d = (s.r - r) ** 2 + (s.g - g) ** 2 + (s.b - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    if (!best || bestD > 110 * 110) return null;
    return {
      class_label: best.label,
      label: best.label,
      id: best.id,
      color: best.color,
      pct: best.pct,
      class: best.label,
    };
  }

  return { sampleLonLat, width, height, west, east, north, south };
}

function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Geology-style terrain-draped grid (keeps Spectral Lithology behaviour). */
async function buildDrapedGridMesh({
  id,
  def,
  bounds,
  west,
  east,
  north,
  south,
  stations,
  lift,
  opacity,
  version,
  nearest = false,
  highContrast = false,
  animateBankErosion = false,
  upsampleMinEdge = 0,
  preserveMask = false,
}) {
  const segs = Math.max(32, Math.min(192, Number(def.gridSegments) || 96));
  const lonSpan = east - west;
  const latSpan = north - south;
  const flipU = !!def.flipU;
  const flipV = !!def.flipV;

  const positions = new Float32Array((segs + 1) * (segs + 1) * 3);
  const uvs = new Float32Array((segs + 1) * (segs + 1) * 2);
  let vi = 0;
  for (let iy = 0; iy <= segs; iy++) {
    const tv = iy / segs;
    const lat = north - tv * latSpan;
    for (let ix = 0; ix <= segs; ix++) {
      const tu = ix / segs;
      const lon = west + tu * lonSpan;
      const p = lonLatToLocal(lon, lat);
      const y = sampleHydroY(p.x, p.z, stations, lift);
      positions[vi * 3] = p.x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = p.z;
      let u = tu;
      let v = 1 - tv;
      if (flipU) u = 1 - u;
      if (flipV) v = 1 - v;
      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = v;
      vi += 1;
    }
  }

  const draped = new THREE.BufferGeometry();
  draped.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  draped.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  const indices = [];
  for (let iy = 0; iy < segs; iy++) {
    for (let ix = 0; ix < segs; ix++) {
      const a = iy * (segs + 1) + ix;
      const b = a + 1;
      const c = a + (segs + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  draped.setIndex(indices);
  draped.computeVertexNormals();

  const texture = await loadBoostedOverlayTexture(assetUrl(def.overlay, version), nearest, {
    minEdge: upsampleMinEdge,
    preserveMask: !!preserveMask || !!nearest,
  });
  const mat = animateBankErosion
    ? createBankErosionMaterial(texture, {
        opacity: Math.min(0.85, Math.max(0.62, opacity)),
      })
    : new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: Math.min(1, Math.max(highContrast ? 1 : 0.85, opacity)),
        alphaTest: highContrast || preserveMask ? 0.06 : 0.02,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
  applyDrapeDepth(mat);
  if (highContrast || animateBankErosion) mat.depthTest = false;
  const mesh = new THREE.Mesh(draped, mat);
  mesh.name = `hydrology_${id}`;
  mesh.renderOrder = highContrast || animateBankErosion ? 48 : 18;
  mesh.frustumCulled = !(highContrast || animateBankErosion);
  mesh.visible = false;
  mesh.userData.hydrology = id;
  mesh.userData.geoUvVersion = version;
  mesh.userData.overlayUrl = def.overlay;
  mesh.userData.boundsLonLat = { west, east, north, south };
  mesh.userData.boundsLocal = bounds;
  mesh.userData.animateBankErosion = !!animateBankErosion;
  return mesh;
}

/**
 * Flat KMZ GroundOverlay plane in local XZ — bank erosion ribbon stays readable in 2D.
 * Corners match LatLonBox exactly via lonLatToLocal.
 */
async function buildFlatGroundOverlayMesh({
  id,
  bounds,
  west,
  east,
  north,
  south,
  overlayUrl,
  opacity,
  lift,
  version,
  nearest = true,
  preserveMask = true,
}) {
  const nw = lonLatToLocal(west, north);
  const ne = lonLatToLocal(east, north);
  const se = lonLatToLocal(east, south);
  const sw = lonLatToLocal(west, south);
  const y = SURFACE_Y + Math.max(id === "geology" ? 1.6 : 2.5, Number(lift) || 2.5);

  const positions = new Float32Array([
    nw.x, y, nw.z,
    ne.x, y, ne.z,
    se.x, y, se.z,
    sw.x, y, sw.z,
  ]);
  const isPollution = isMandoviFlatRaster(id);
  const isGeology = id === "geology";
  const isBankErosion = id === "bank_erosion";
  const isJalNetraFlat = isPollution || isGeology || isBankErosion;
  // Google Earth GroundOverlay: image top = north. With texture.flipY=false, that is v=0.
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  geo.computeVertexNormals();

  // Keep the JalNetra PNG byte-for-byte (no bilinear upsample) so the river mask
  // matches the KML opened in Google Earth.
  const texture = await loadBoostedOverlayTexture(assetUrl(overlayUrl, version), !!nearest, {
    minEdge: preserveMask || nearest ? 0 : 2048,
    preserveMask: !!preserveMask,
  });
  const mat = isBankErosion
    ? createBankErosionMaterial(texture, {
        opacity: Math.min(0.85, Math.max(0.62, Number(opacity) || 0.78)),
      })
    : new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: Math.min(1, Math.max(0.9, Number(opacity) || 1)),
        alphaTest: isJalNetraFlat ? 0.04 : 0.08,
        depthTest: !isJalNetraFlat,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        blending: THREE.NormalBlending,
      });
  if (isBankErosion) {
    mat.depthTest = false;
    mat.depthWrite = false;
  } else if (!isJalNetraFlat) {
    applyDrapeDepth(mat);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `hydrology_${id}`;
  mesh.renderOrder = isJalNetraFlat ? 58 : 48;
  mesh.userData.animateBankErosion = isBankErosion;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.userData.hydrology = id;
  mesh.userData.geoUvVersion = version;
  mesh.userData.overlayUrl = overlayUrl;
  mesh.userData.boundsLonLat = { west, east, north, south };
  mesh.userData.boundsLocal = bounds;
  mesh.userData.flatGroundOverlay = true;
  return mesh;
}

function assetUrl(url, version) {
  let raw = String(url || "").trim().replace(/\s+/g, "");
  if (/^data:/i.test(raw)) return raw.replace(/\?v=\d+$/i, "");
  if (!raw || /^blob:/i.test(raw)) return raw;
  if (!/^https?:/i.test(raw)) raw = new URL(raw, window.location.origin).href;
  return raw.includes("?") ? raw : `${raw}?v=${version}`;
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = /data:([^;,]+)/i.exec(meta)?.[1] || "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function overlayBlob(url, version) {
  const abs = assetUrl(url, version);
  if (/^data:/i.test(abs)) return dataUrlToBlob(abs);
  const res = await fetch(abs, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Load overlay PNG via fetch (avoids stale service-worker image cache).
 * Small JalNetra/EE exports are upscaled so class cells don't explode into
 * screen-sized blocks when the LatLonBox is viewed up close.
 */
async function loadBoostedOverlayTexture(url, nearest, opts = {}) {
  const abs = assetUrl(url);
  const preserveMask = !!opts.preserveMask || !!nearest;
  const minEdge = preserveMask ? 0 : Math.max(0, Number(opts.minEdge) || 0);
  let objectUrl = null;

  function finalize(texture) {
    if (minEdge > 0) upsampleOverlayImage(texture, minEdge, !nearest);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.flipY = false;
    if (nearest || preserveMask) {
      // Keep JalNetra / EE class + alpha masks crisp (same as Google Earth).
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
    } else {
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 8;
    }
    texture.needsUpdate = true;
    return texture;
  }

  try {
    const blob = /^data:/i.test(abs) ? dataUrlToBlob(abs) : await (async () => {
      const res = await fetch(abs, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${abs}`);
      return res.blob();
    })();
    if (!blob || blob.size < 32) throw new Error(`Empty overlay image (${blob?.size || 0} bytes)`);
    objectUrl = URL.createObjectURL(blob);
    return finalize(await loadTexture(objectUrl));
  } catch (err) {
    if (/^data:/i.test(abs)) throw new Error(formatLoadError(err, abs));
    try {
      return finalize(await loadTexture(abs));
    } catch (err2) {
      throw new Error(formatLoadError(err2, abs) || formatLoadError(err, abs));
    }
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/** Bilinear-upsample small EE rasters so magnified texels don't stair-step. */
function upsampleOverlayImage(texture, minEdge, smooth) {
  const img = texture?.image;
  if (!img) return;
  const srcW = img.width || img.videoWidth || 0;
  const srcH = img.height || img.videoHeight || 0;
  if (!srcW || !srcH) return;
  const longest = Math.max(srcW, srcH);
  if (longest >= minEdge) return;

  const scale = Math.min(8, Math.ceil(minEdge / longest));
  const w = Math.min(4096, srcW * scale);
  const h = Math.min(4096, srcH * scale);
  if (w <= srcW && h <= srcH) return;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = !!smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  texture.image = canvas;
}

function formatLoadError(err, url) {
  const where = /^data:/i.test(String(url || "")) ? "overlay image" : url;
  if (!err) return `Failed to load ${where}`;
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.type) return `Image load ${err.type} for ${where}`;
  return `Failed to load ${where}`;
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => resolve(tex),
      undefined,
      (err) => reject(err || new Error(`Failed to load texture ${url}`)),
    );
  });
}

function normalizeHex(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase();
  }
  return null;
}

function stripRange(name) {
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

/**
 * Map raw KML/GeoJSON class ("Class 1" / "Very Low Salinity") → configured legend label/color/range.
 */
function resolveClassMeta(def, rawLabel, feature = null) {
  const raw = String(rawLabel || "Unknown").trim();
  const classes = def?.classes || [];
  const stripped = stripRange(raw);
  const numM = raw.match(/^Class\s*(\d+)$/i);
  const classNum = numM ? Number(numM[1]) : null;

  const rawKey = raw.toLowerCase().replace(/\s+/g, "_");
  // ExtendedData aliases from WATERQ-Pollution zone KMLs
  const CLASS_ALIASES = {
    oligotrophic: "oligo",
    mesotrophic: "meso",
    eutrophic: "eutro",
    hypereutrophic: "hyper",
    fresh: "good",
    brackish: "moderate",
    tidal: "high",
    "very_low": "very_low",
    "very low": "very_low",
    // Local Mithi Classification / Volume polygon KMLs
    stable: "low",
    deposition: "moderate",
    erosion: "very_high",
  };
  const aliasId = CLASS_ALIASES[raw.toLowerCase()] || CLASS_ALIASES[stripped.toLowerCase()] || null;

  let hit =
    classes.find((c) => c.kmlClass && String(c.kmlClass).toLowerCase() === raw.toLowerCase()) ||
    classes.find((c) => c.kmlClass && String(c.kmlClass).toLowerCase() === stripped.toLowerCase()) ||
    classes.find((c) => c.label && String(c.label).toLowerCase() === raw.toLowerCase()) ||
    classes.find((c) => c.label && String(c.label).toLowerCase() === stripped.toLowerCase()) ||
    classes.find((c) => c.id && String(c.id).toLowerCase() === rawKey) ||
    (aliasId
      ? classes.find((c) => c.id && String(c.id).toLowerCase() === aliasId) ||
        classes.find((c) => c.label && String(c.label).toLowerCase().startsWith(aliasId))
      : null) ||
    null;

  if (!hit && classNum != null) {
    hit =
      classes.find((c) => c.id === `class_${classNum}`) ||
      classes.find((c) => String(c.kmlClass || "").match(new RegExp(`^Class\\s*${classNum}$`, "i"))) ||
      null;
  }

  // Salinity KML: "Very Low Salinity" → scheme label "Very Low"
  if (!hit && /salinity/i.test(stripped)) {
    const short = stripped.replace(/\s*salinity\s*$/i, "").trim();
    hit = classes.find((c) => String(c.label).toLowerCase() === short.toLowerCase()) || null;
  }
  // Mandovi salinity: "1 Very Low" / "5 Very High" → scheme by kmlClass or label
  if (!hit) {
    const numbered = stripped.match(/^\d+\s+((?:Very\s+)?(?:Low|Moderate|High|Very\s+High))$/i);
    if (numbered) {
      const label = numbered[1].replace(/\s+/g, " ");
      hit =
        classes.find((c) => String(c.label).toLowerCase() === label.toLowerCase()) ||
        classes.find(
          (c) =>
            c.kmlClass &&
            String(c.kmlClass).toLowerCase() === stripped.toLowerCase(),
        ) ||
        null;
    }
  }

  if (hit) {
    const scheme = WQ_LAYER_SCHEMES[def?.id];
    const unit = hit.unit || def?.unit || scheme?.unit || null;
    const mid = classRepresentativeValue(hit);
    return {
      label: hit.label,
      color: normalizeHex(hit.color) || CLASS_COLOR[hit.label] || "#888888",
      range: hit.range || feature?.range || null,
      unit,
      value: mid,
      valueText: mid != null && unit ? formatWqValue(mid, unit) : null,
      metric: scheme?.metric || def?.legendTitle || def?.name || null,
    };
  }

  const color =
    CLASS_COLOR[raw] ||
    CLASS_COLOR[stripped] ||
    normalizeHex(feature?.color) ||
    "#888888";
  return {
    label: stripped || raw,
    color,
    range: feature?.range || null,
    unit: def?.unit || null,
    value: null,
    valueText: null,
    metric: def?.legendTitle || def?.name || null,
  };
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates?.[0] ? [geometry.coordinates[0]] : [];
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).map((poly) => poly?.[0]).filter((ring) => ring?.length >= 4);
  }
  if (geometry.type === "GeometryCollection") {
    return (geometry.geometries || []).flatMap((child) => ringsOf(child));
  }
  return [];
}

function featuresFromGeoJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  const walk = (node, props = {}) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "FeatureCollection") {
      for (const feature of node.features || []) walk(feature);
      return;
    }
    if (node.type === "Feature") {
      walk(node.geometry, node.properties || {});
      return;
    }
    if (node.type === "GeometryCollection") {
      for (const child of node.geometries || []) walk(child, props);
      return;
    }
    if (node.type !== "Polygon" && node.type !== "MultiPolygon") return;
    const label = props.class_label || props.class || props.name || props.category || "Class";
    out.push({
      id: out.length,
      class_label: String(label),
      class: String(label),
      range: props.range || null,
      name: props.name || null,
      description: props.description || null,
      color: props.color || null,
      geometry: node,
    });
  };
  walk(data);
  return out;
}

function ringToLocalVerts(geometry) {
  if (!geometry) return null;
  let ring = null;
  if (geometry.type === "Polygon") ring = geometry.coordinates?.[0];
  else if (geometry.type === "MultiPolygon") ring = geometry.coordinates?.[0]?.[0];
  if (!ring || ring.length < 4) return null;
  const verts = [];
  for (const c of ring) {
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = lonLatToLocal(lon, lat);
    verts.push({ x: p.x, z: p.z, lon, lat });
  }
  if (verts.length >= 2) {
    const a = verts[0];
    const b = verts[verts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6) verts.pop();
  }
  return verts.length >= 3 ? verts : null;
}

/** Lon/lat ring from parseClassedPolygonKml → local XZ verts. */
function lonLatRingToLocalVerts(coordinates) {
  if (!coordinates?.length) return null;
  const verts = [];
  for (const c of coordinates) {
    const lon = Number(c.lon ?? c[0]);
    const lat = Number(c.lat ?? c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = lonLatToLocal(lon, lat);
    verts.push({ x: p.x, z: p.z, lon, lat });
  }
  if (verts.length >= 2) {
    const a = verts[0];
    const b = verts[verts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6) verts.pop();
  }
  return verts.length >= 3 ? verts : null;
}

function polygonToTerrainGeometry(verts, stations, lift) {
  try {
    const shape = new THREE.Shape();
    shape.moveTo(verts[0].x, -verts[0].z);
    for (let i = 1; i < verts.length; i++) {
      shape.lineTo(verts[i].x, -verts[i].z);
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, sampleHydroY(x, z, stations, lift));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null;
  }
}

/** Flat class polygons on the water sheet — used for Mandovi salinity PSU. */
function polygonToWaterSurfaceGeometry(verts, lift) {
  try {
    if (!verts || verts.length < 3) return null;
    const shape = new THREE.Shape();
    shape.moveTo(verts[0].x, -verts[0].z);
    for (let i = 1; i < verts.length; i++) {
      shape.lineTo(verts[i].x, -verts[i].z);
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const y = SURFACE_Y + Math.max(0.85, Number(lift) || 1.0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null;
  }
}

/** Expand LatLonBox to cover every class polygon (with a small pad). */
function boundsFromFeatures(rawFeatures, fallback) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const f of rawFeatures || []) {
    const ring = f.coordinates;
    if (!ring?.length) continue;
    for (const c of ring) {
      const lon = Number(c.lon);
      const lat = Number(c.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  if (![west, east, south, north].every(Number.isFinite) || east <= west || north <= south) {
    return { ...(fallback || MANDOVI_POLLUTION_BOUNDS) };
  }
  const padLon = Math.max(0.0008, (east - west) * 0.01);
  const padLat = Math.max(0.0008, (north - south) * 0.01);
  return {
    west: west - padLon,
    east: east + padLon,
    south: south - padLat,
    north: north + padLat,
  };
}

/**
 * Paint Mandovi_Salinity_smoothed_v2 class polygons into a canvas covering the estuary LatLonBox.
 * Drawn in class order so higher salinity paints over lower where they meet.
 */
function rasterizeSalinityPolygonsToCanvas(rawFeatures, def, bounds) {
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  if (![west, east, north, south].every(Number.isFinite) || east <= west || north <= south) {
    return null;
  }
  const aspect = (north - south) / (east - west);
  const width = 2048;
  const height = Math.max(768, Math.round(width * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);

  const order = new Map(
    (def.classes || []).map((c, i) => [String(c.label).toLowerCase(), i]),
  );
  const sorted = [...rawFeatures].sort((a, b) => {
    const ma = resolveClassMeta(def, a.class_label || "Unknown", a);
    const mb = resolveClassMeta(def, b.class_label || "Unknown", b);
    return (order.get(String(ma.label).toLowerCase()) ?? 0) - (order.get(String(mb.label).toLowerCase()) ?? 0);
  });

  let painted = 0;
  for (const f of sorted) {
    const ring = f.coordinates;
    if (!ring || ring.length < 3) continue;
    const meta = resolveClassMeta(def, f.class_label || "Unknown", f);
    // Prefer Google Earth PolyStyle color from the KML when present.
    const hex =
      normalizeHex(f.color) || normalizeHex(meta.color) || "#888888";
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < ring.length; i++) {
      const lon = Number(ring[i].lon);
      const lat = Number(ring[i].lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const x = ((lon - west) / (east - west)) * width;
      const y = ((north - lat) / (north - south)) * height;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (!started) continue;
    ctx.closePath();
    ctx.fillStyle = hex;
    ctx.globalAlpha = 1;
    ctx.fill();
    painted += 1;
  }
  if (!painted) return null;
  return canvas;
}

function buildSalinityFlatMesh({ id, bounds, texture, opacity, lift }) {
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  const nw = lonLatToLocal(west, north);
  const ne = lonLatToLocal(east, north);
  const se = lonLatToLocal(east, south);
  const sw = lonLatToLocal(west, south);
  const y = SURFACE_Y + Math.max(1.6, Number(lift) || 2.5);
  const positions = new Float32Array([
    nw.x, y, nw.z,
    ne.x, y, ne.z,
    se.x, y, se.z,
    sw.x, y, sw.z,
  ]);
  // flipY=false → image top (north) is v=0
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: Math.min(1, Math.max(0.95, Number(opacity) || 0.98)),
    alphaTest: 0.02,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `hydrology_${id}_raster`;
  mesh.renderOrder = 120;
  mesh.frustumCulled = false;
  mesh.userData.hydrology = id;
  mesh.userData.flatGroundOverlay = true;
  mesh.userData.boundsLonLat = { west, east, north, south };
  return mesh;
}

function pointInPolyXZ(x, z, verts) {
  if (!verts || verts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x;
    const zi = verts[i].z;
    const xj = verts[j].x;
    const zj = verts[j].z;
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
