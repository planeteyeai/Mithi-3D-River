/**
 * Turns JalNetra JSON + downloaded KMLs into the same hydrology layer defs RIVEREYE drapes.
 */

import { getRiverSession } from "./riverSession.js";
import {
  collectKmlRefs,
  downloadText,
  fetchEndpointNow,
  kmlDownloadUrl,
} from "./jalnetraClient.js";
import { localKmlUrl, snapshotToPayload, FRONTEND_KML } from "./localJalnetraSnapshots.js";
import {
  extractAoiPolygonsFromKml,
  pointInAnyAoi,
} from "../geo/aoiKml.js";

const defs = new Map();
const inflight = new Map();

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SOURCE = {
  salinity: { endpoint: "salinity", mode: "overlay" },
  vegetation_extent: { endpoint: "vegetation-type", mode: "overlay" },
  vegetation_health: { endpoint: "vegetation-health", mode: "overlay" },
  bank_erosion: { endpoint: "bank-erosion", mode: "overlay" },
  geology: { endpoint: "lithology", mode: "overlay" },
  water_depth: { endpoint: "water-depth", mode: "overlay" },
  water_quality_tss: { endpoint: "water-quality", mode: "named", match: /tss|turbid/i },
  water_quality_ndci: { endpoint: "water-quality", mode: "named", match: /ndci|chloro/i },
  water_quality_ndwi: { endpoint: "water-quality", mode: "named", match: /ndwi/i },
  water_quality_wst: { endpoint: "water-quality", mode: "named", match: /wst|temp/i },
  // Pollution suite — live JalNetra when ready; hydrologyLayer falls back to local KMLs.
  pollution_eutrophication: { endpoint: "eutrophication", mode: "overlay" },
  pollution_nitrogen: { endpoint: "nitrogen", mode: "overlay" },
  pollution_coliform: { endpoint: "coliform", mode: "overlay" },
  landuse_lulc: { endpoint: "lulc", mode: "years" },
  // Separate JalNetra APIs — date-wise monthly overlays for the uploaded river KML.
  silt_classification: {
    endpoint: "silt-classification",
    mode: "months",
    fallbackEndpoints: ["silt"],
  },
  silt_volume_surface: {
    endpoint: "silt-volume",
    mode: "months",
  },
};

const WQ_ORDER = ["water_quality_wst", "water_quality_tss", "water_quality_ndwi", "water_quality_ndci"];

const LAYER_TITLES = {
  salinity: "Salinity",
  vegetation_extent: "Vegetation Type",
  vegetation_health: "Vegetation Classification",
  bank_erosion: "Bank Erosion",
  geology: "Spectral Lithology",
  water_depth: "Water Depth",
  water_quality_tss: "TSS",
  water_quality_ndci: "Chlorophyll-a",
  water_quality_ndwi: "NDWI",
  water_quality_wst: "Water Temperature",
  pollution_eutrophication: "Eutrophication",
  pollution_nitrogen: "Nitrogen",
  pollution_coliform: "Coliform",
  landuse_lulc: "LULC",
  silt_classification: "Silt Classification",
  silt_volume_surface: "Silt Verification",
};

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

const MITHI_CORRIDOR_BOUNDS = {
  north: 19.08782672,
  south: 19.04514933,
  east: 72.87929619,
  west: 72.83456075,
};

export function clearLiveOverlay(id) {
  if (id) defs.delete(id);
  else defs.clear();
}

export function liveLayerDef(id) {
  return defs.get(id) || null;
}

function classesFrom(categories) {
  const rows = Array.isArray(categories) ? categories : [];
  return rows
    .map((c) => ({
      id: String(c.id ?? c.name ?? c.label ?? ""),
      label: c.name || c.label || c.class_name || c.category || c.title || "Class",
      color: c.color || "#94a3b8",
      pct: c.percent != null ? `${Number(c.percent).toFixed(1)}%` : c.area_ha != null ? `${Number(c.area_ha).toFixed(1)} ha` : null,
      range: c.range || c.status || null,
    }))
    .filter((c) => c.label);
}

export function parseOverlayKml(kmlText, baseUrl) {
  const box = {};
  for (const key of ["north", "south", "east", "west"]) {
    const m = String(kmlText).match(new RegExp(`<(?:\\w+:)?${key}>\\s*([\\d.+-eE]+)\\s*<\\/(?:\\w+:)?${key}>`, "i"));
    if (m) box[key] = Number(m[1]);
  }
  const hasBox = [box.north, box.south, box.east, box.west].every((n) => Number.isFinite(n));
  const hrefM = String(kmlText).match(/<(?:\w+:)?href>\s*([^<]+?)\s*<\/(?:\w+:)?href>/i);
  let href = (hrefM?.[1] || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
  if (/^data:/i.test(href)) href = href.replace(/\s+/g, "");
  if (href && !/^data:image\//i.test(href) && !/^https?:/i.test(href) && baseUrl) {
    try {
      href = new URL(href, baseUrl).href;
    } catch {
      href = "";
    }
  }
  const image = /^data:image\//i.test(href) || /^https?:/i.test(href) ? href : "";
  return {
    ground: hasBox && !!image,
    bounds: hasBox ? box : null,
    image,
    polygons: /<(?:\w+:)?Polygon[\s>]/i.test(kmlText),
  };
}

function geoJsonToKml(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const polys = [];
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
    const label = props.class_label || props.class || props.name || props.category || "Class";
    const hex = String(props.color || "94a3b8").replace("#", "").padStart(6, "0").slice(0, 6);
    const color = `ff${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
    const pushRing = (ring) => {
      if (!ring || ring.length < 4) return;
      const coords = ring
        .map((c) => `${Number(c[0]).toFixed(6)},${Number(c[1]).toFixed(6)},0`)
        .join(" ");
      polys.push({ label, color, coords });
    };
    if (node.type === "Polygon") pushRing(node.coordinates?.[0]);
    if (node.type === "MultiPolygon") {
      for (const poly of node.coordinates || []) pushRing(poly?.[0]);
    }
  };
  walk(data);
  if (!polys.length) return null;
  const placemarks = polys
    .map(
      (p) => `<Placemark><name>${p.label}</name><Style><PolyStyle><color>${p.color}</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${p.coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarks}</Document></kml>`;
}

function normalizeDownload(text) {
  const raw = String(text || "");
  if (!raw.trimStart().startsWith("{")) return raw;
  return geoJsonToKml(raw) || raw;
}

export const WATER_DEPTH_CLASSES = [
  { id: "shallow", label: "Shallow (<1.5 m)", range: "< 1.5 m", color: "#8FEAF8", minDepth: 0.2, maxDepth: 1.5 },
  { id: "moderate", label: "Moderate (1.5–3.0 m)", range: "1.5–3.0 m", color: "#55C4EE", minDepth: 1.5, maxDepth: 3.0 },
  { id: "medium_deep", label: "Medium-Deep (3.0–4.5 m)", range: "3.0–4.5 m", color: "#3AA0D6", minDepth: 3.0, maxDepth: 4.5 },
  { id: "deep", label: "Deep (>4.5 m)", range: "> 4.5 m", color: "#2B86C0", minDepth: 4.5, maxDepth: 5.5 },
];

async function kmlForRef(endpoint, ref) {
  if (ref?.inlineKml) {
    return { text: normalizeDownload(ref.inlineKml), href: null };
  }
  const tryLocal = async () => {
    const urls = [
      localKmlUrl(endpoint, "history"),
      localKmlUrl(endpoint, "active"),
      FRONTEND_KML[endpoint]?.history,
      FRONTEND_KML[endpoint]?.active,
    ].filter(Boolean);
    for (const fallbackUrl of [...new Set(urls)]) {
      try {
        const localRes = await fetch(fallbackUrl);
        if (!localRes.ok) continue;
        return {
          text: normalizeDownload(await localRes.text()),
          href: fallbackUrl,
        };
      } catch {
        /* next */
      }
    }
    return null;
  };

  // Prefer durable local snapshots (embedded PNG + Mithi LatLonBox) before remote URLs that expire.
  const localFirst = await tryLocal();
  if (localFirst) return localFirst;

  const candidates = [];
  if (ref?.id) candidates.push(kmlDownloadUrl(endpoint, ref.id));
  if (ref?.url) candidates.push(kmlDownloadUrl(endpoint, ref.url));
  if (!candidates.length && (ref?.url || ref?.id)) {
    candidates.push(kmlDownloadUrl(endpoint, ref.url || ref.id));
  }

  let lastErr = new Error("No KML download link");
  for (const href of [...new Set(candidates.filter(Boolean))]) {
    try {
      const text = normalizeDownload(await downloadText(href));
      return { text, href };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function overlayDef(id, title, parsed, categories) {
  const depthClasses = id === "water_depth" ? WATER_DEPTH_CLASSES : classesFrom(categories);
  if (parsed.ground) {
    const landUse =
      id === "landuse_lulc" || id === "vegetation_extent" || id === "vegetation_health";
    const bounds =
      landUse && parsed.bounds && !isMithiLatLonBox(parsed.bounds)
        ? { ...MITHI_CORRIDOR_BOUNDS }
        : parsed.bounds;
    return {
      id,
      name: title,
      available: true,
      type: "groundOverlay",
      bounds,
      overlay: parsed.image || (id === "water_depth" ? "/data/mithi/mithi_river_depth_overlay.png" : ""),
      opacity: id.startsWith("vegetation") ? 0.72 : 0.9,
      gridSegments: 112,
      liftM: 0.55,
      flipV: true,
      legendTitle: id === "water_depth" ? "Water Depth (Sentinel-2)" : title,
      legendSubtitle:
        id === "water_depth"
          ? "Satellite Bathymetry · 1.5–8.0 m"
          : landUse
            ? "JalNetra · Mithi LatLonBox"
            : "JalNetra",
      legendClasses: depthClasses,
      classes: depthClasses,
    };
  }
  if (parsed.polygons) {
    const blob = URL.createObjectURL(new Blob([parsed.text], { type: "application/vnd.google-earth.kml+xml" }));
    return {
      id,
      name: title,
      available: true,
      type: "kmlPolygons",
      data: blob,
      opacity: 0.82,
      liftM: 0.45,
      legendTitle: id === "water_depth" ? "Water Depth (Sentinel-2)" : title,
      legendSubtitle: id === "water_depth" ? "Satellite Bathymetry · 1.5–8.0 m" : "JalNetra",
      classes: depthClasses,
      legendClasses: depthClasses,
    };
  }
  return null;
}

function pickNamed(refs, source) {
  const hit = refs.find((r) => source.match.test(`${r.path} ${r.name}`));
  if (hit) return hit;
    const idx = WQ_ORDER.indexOf(Object.keys(SOURCE).find((key) => SOURCE[key] === source) || "");
    return (idx >= 0 && refs[idx]) || refs[0];
}

function yearOf(ref, index) {
  const y = Number(ref.year || String(ref.date || ref.name || "").match(/20\d{2}/)?.[0]);
  return Number.isFinite(y) ? y : 2021 + index;
}

function monthOf(ref, index) {
  const yDirect = Number(ref?.year);
  const mDirect = Number(ref?.month);
  if (Number.isFinite(yDirect) && Number.isFinite(mDirect) && mDirect >= 1 && mDirect <= 12) {
    return {
      year: yDirect,
      month: mDirect,
      id: `${yDirect}-${String(mDirect).padStart(2, "0")}`,
    };
  }
  const raw = String(ref.date || ref.name || ref.path || "");
  const ym = raw.match(/(20\d{2})[-_/](\d{1,2})/);
  if (ym) {
    return {
      year: Number(ym[1]),
      month: Number(ym[2]),
      id: `${ym[1]}-${String(Number(ym[2])).padStart(2, "0")}`,
    };
  }
  const id = raw.match(/20\d{2}-\d{2}/)?.[0];
  if (id) return { year: Number(id.slice(0, 4)), month: Number(id.slice(5)), id };
  return { year: 2026, month: index + 1, id: `p${index + 1}` };
}

async function resolveEndpointBody(source, session) {
  const endpoints = [source.endpoint, ...(source.fallbackEndpoints || [])].filter(Boolean);
  const siltMonths = source.mode === "months";

  // Instant local demo KML payload (jalnetra-history) — prefer before stale remote URLs.
  for (const ep of endpoints) {
    const url = localKmlUrl(ep, "history") || localKmlUrl(ep, "active");
    if (!url || !FRONTEND_KML[ep]) continue;
    const body = snapshotToPayload({
      component: ep,
      version: 1,
      logicalName: FRONTEND_KML[ep].logicalName,
      url,
      startDate: "21-10-2026",
      endDate: "18-11-2026",
    });
    if (body) {
      session.results[ep] = body;
      return { body, endpoint: ep, localSnapshot: true };
    }
  }

  for (const ep of endpoints) {
    if (session.results?.[ep]) return { body: session.results[ep], endpoint: ep };
  }

  // Silt: never block the map for minutes. Prefer live results; otherwise fall through
  // to an immediate river-AOI preview while JalNetra keeps running in the background.
  if (siltMonths) {
    const pending = endpoints.some((ep) => session.pending?.[ep]);
    if (!pending && session.kmlText && source.endpoint) {
      try {
        const body = await fetchEndpointNow(source.endpoint);
        if (body) return { body, endpoint: source.endpoint };
      } catch (err) {
        session.errors[source.endpoint] = err?.message || String(err);
      }
    }
    for (const ep of endpoints) {
      if (session.errors?.[ep]) return { body: null, endpoint: ep, error: session.errors[ep] };
    }
    return { body: null, endpoint: source.endpoint };
  }

  for (const ep of endpoints) {
    if (session.pending?.[ep]) {
      const until = Date.now() + 240000;
      while (session.pending[ep] && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (session.results?.[ep]) return { body: session.results[ep], endpoint: ep };
  }

  if (session.kmlText && source.endpoint) {
    try {
      const body = await fetchEndpointNow(source.endpoint);
      if (body) return { body, endpoint: source.endpoint };
    } catch (err) {
      session.errors[source.endpoint] = err?.message || String(err);
    }
  }

  for (const ep of endpoints) {
    if (session.errors?.[ep]) return { body: null, endpoint: ep, error: session.errors[ep] };
  }
  return { body: null, endpoint: source.endpoint };
}

function bboxFromKml(text) {
  const nums = [...String(text || "").matchAll(/([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)/g)]
    .map((m) => ({ lon: Number(m[1]), lat: Number(m[2]) }))
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90);
  if (nums.length < 3) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const p of nums) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  const padLon = Math.max(0.003, (east - west) * 0.03);
  const padLat = Math.max(0.003, (north - south) * 0.03);
  return { west: west - padLon, east: east + padLon, south: south - padLat, north: north + padLat };
}

const OFFLINE_SILT_CLASS = [
  { id: "low", label: "Low", color: "#00FF00" },
  { id: "moderate", label: "Moderate", color: "#FFFF00" },
  { id: "high", label: "High", color: "#FFA500" },
  { id: "very_high", label: "Very High", color: "#FF0000" },
];
const OFFLINE_SILT_VOLUME_MAX = 96.37;
const OFFLINE_SILT_VOLUME = [
  { id: "v0", label: "0 m³", color: "#FFFFE5", value: 0, unit: "m³" },
  { id: "v25", label: "24.1 m³", color: "#FEC44F", value: OFFLINE_SILT_VOLUME_MAX * 0.25, unit: "m³" },
  { id: "v50", label: "48.2 m³", color: "#FE9929", value: OFFLINE_SILT_VOLUME_MAX * 0.5, unit: "m³" },
  { id: "v75", label: "72.3 m³", color: "#D95F0E", value: OFFLINE_SILT_VOLUME_MAX * 0.75, unit: "m³" },
  { id: "v100", label: "96.37 m³", color: "#662506", value: OFFLINE_SILT_VOLUME_MAX, unit: "m³" },
];

function hexRgb(hex) {
  const h = String(hex || "").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

/**
 * Paint silt preview only inside the Mithi river KML polygon (alpha=0 on land).
 * Bounds frame the texture; silhouette comes from AOI rings.
 */
function paintOfflineSiltOverlay(volume, seed, bounds, polygons) {
  if (typeof document === "undefined" || !bounds) return "";
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  if (![west, east, north, south].every(Number.isFinite) || east <= west || north <= south) {
    return "";
  }
  const aspect = (north - south) / (east - west);
  const w = 1024;
  const h = Math.max(384, Math.min(1536, Math.round(w * aspect)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const colors = (volume
    ? ["#FFFFE5", "#FEC44F", "#FE9929", "#D95F0E", "#662506"]
    : ["#00FF00", "#FFFF00", "#FFA500", "#FF0000"]
  ).map(hexRgb);
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const hasAoi = Array.isArray(polygons) && polygons.length > 0;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const lat = north - v * (north - south);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const lon = west + u * (east - west);
      const i = (y * w + x) * 4;
      if (hasAoi && !pointInAnyAoi(lon, lat, polygons)) {
        data[i + 3] = 0;
        continue;
      }
      const along = u;
      const across = Math.abs(v - 0.5) * 2;
      const wave = 0.5 + 0.5 * Math.sin((along * 8 + seed * 0.17) * Math.PI);
      const score = Math.min(
        1,
        Math.max(0, across * 0.45 + wave * 0.4 + ((seed % 9) * 0.012)),
      );
      const idx = Math.min(colors.length - 1, Math.floor(score * colors.length));
      const c = colors[idx];
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = hasAoi ? 230 : Math.round(Math.exp(-(((v - 0.5) / 0.22) ** 2)) * 220);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Multiply an overlay PNG's alpha by Mithi river KML membership so land stays clear.
 * @returns {Promise<string>} data URL or original url on failure
 */
export async function maskOverlayImageToRiverAoi(imageUrl, bounds, kmlText) {
  if (typeof document === "undefined" || !imageUrl || !bounds) return imageUrl;
  const polygons = extractAoiPolygonsFromKml(kmlText || "");
  if (!polygons.length) return imageUrl;
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  if (![west, east, north, south].every(Number.isFinite) || east <= west || north <= south) {
    return imageUrl;
  }
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("overlay image load failed"));
      el.src = imageUrl;
    });
    const w = Math.min(2048, Math.max(256, img.naturalWidth || img.width || 1024));
    const h = Math.min(2048, Math.max(256, img.naturalHeight || img.height || 512));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return imageUrl;
    ctx.drawImage(img, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    const data = frame.data;
    for (let y = 0; y < h; y++) {
      const lat = north - (y / (h - 1)) * (north - south);
      for (let x = 0; x < w; x++) {
        const lon = west + (x / (w - 1)) * (east - west);
        const i = (y * w + x) * 4;
        if (!pointInAnyAoi(lon, lat, polygons)) data[i + 3] = 0;
      }
    }
    ctx.putImageData(frame, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return imageUrl;
  }
}

/** River-local silt periods so Land Use still drapes while JalNetra is slow/down. */
function buildOfflineSiltDef(id, session) {
  if (typeof document === "undefined") return null;
  const kmlText = session?.kmlText || "";
  const polygons = extractAoiPolygonsFromKml(kmlText);
  const bounds = bboxFromKml(kmlText);
  if (!bounds) return null;
  // Signal hydrology to prefer bundled Mithi polygon months when available.
  if (!polygons.length) {
    return {
      id,
      available: true,
      offlinePreview: true,
      preferBuiltinPolygons: true,
      type: id === "silt_volume_surface" ? "siltVolumePeriods" : "siltClassificationPeriods",
      periods: [],
      name: id === "silt_volume_surface" ? "SILT VERIFICATION" : "SILT CLASSIFICATION",
    };
  }
  const volume = id === "silt_volume_surface";
  const now = new Date();
  const periods = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const pid = `${year}-${String(month).padStart(2, "0")}`;
    periods.push({
      id: pid,
      label: `${MONTH_SHORT[month - 1]} ${year}`,
      year,
      month,
      overlay: paintOfflineSiltOverlay(volume, month + year, bounds, polygons),
      bounds: { ...bounds },
      aoiMasked: true,
    });
  }
  const latest = periods[periods.length - 1];
  const classes = volume ? OFFLINE_SILT_VOLUME : OFFLINE_SILT_CLASS;
  return {
    id,
    name: volume ? "SILT VERIFICATION" : "SILT CLASSIFICATION",
    available: true,
    type: volume ? "siltVolumePeriods" : "siltClassificationPeriods",
    periods,
    defaultPeriod: latest.id,
    bounds: latest.bounds,
    opacity: 0.88,
    liftM: 1.2,
    gridSegments: 112,
    legendTitle: volume ? "Silt Verification" : "Silt Classification",
    legendSubtitle: "Clipped to Mithi river KML · refreshing when JalNetra returns",
    classes,
    legendClasses: classes,
    offlinePreview: true,
    preferBuiltinPolygons: true,
  };
}

async function build(id) {
  const source = SOURCE[id];
  const session = getRiverSession();
  if (!source) return null;

  let resolved = await resolveEndpointBody(source, session);
  let body = resolved.body;
  let activeEndpoint = resolved.endpoint || source.endpoint;

  if (!body && (id === "water_depth" || source.endpoint === "water-depth")) {
    try {
      const res = await fetch("/data/mithi/mithi_river_water_depth.json");
      if (res.ok) {
        body = await res.json();
        session.results["water-depth"] = body;
        activeEndpoint = "water-depth";
      }
    } catch {}
  }
  if (!body) {
    const err = resolved.error || session.errors?.[source.endpoint];
    if (err) session.errors[id] = err;
    if (source.mode === "months" && session.kmlText) {
      const offline = buildOfflineSiltDef(id, session);
      if (offline) return offline;
    }
    return null;
  }
  const refs = collectKmlRefs(body);
  if (!refs.length) {
    if (source.mode === "months" && session.kmlText) {
      const offline = buildOfflineSiltDef(id, session);
      if (offline) return offline;
    }
    return null;
  }

  if (source.mode === "years") {
    const collectYears = async (yearRefs) => {
      const years = [];
      for (let i = 0; i < yearRefs.length; i++) {
        let loaded;
        try {
          loaded = await kmlForRef(activeEndpoint, yearRefs[i]);
        } catch {
          continue;
        }
        const text = loaded.text;
        const parsed = { ...parseOverlayKml(text, loaded.href), text };
        const year = yearOf(yearRefs[i], i);
        if (parsed.ground) {
          const b = parsed.bounds;
          if (!isMithiLatLonBox(b)) {
            console.warn(`[lulc] skip year ${year} — LatLonBox not on Mithi`, b);
            continue;
          }
          years.push({ year, type: "groundOverlay", overlay: parsed.image, bounds: parsed.bounds });
        } else if (parsed.polygons) {
          years.push({
            year,
            type: "kmlPolygons",
            data: URL.createObjectURL(new Blob([text], { type: "application/vnd.google-earth.kml+xml" })),
          });
        }
      }
      return years;
    };

    let years = await collectYears(refs);
    if (!years.length && session?.kmlText && activeEndpoint === "lulc") {
      try {
        console.warn("[lulc] no usable year overlays — live refresh with river KML AOI");
        const fresh = await fetchEndpointNow("lulc", { forceLive: true });
        if (fresh) {
          body = fresh;
          years = await collectYears(collectKmlRefs(body));
        }
      } catch (err) {
        console.warn("[lulc] live refresh failed", err?.message || err);
      }
    }
    years.sort((a, b) => a.year - b.year);
    if (!years.length) return null;
    const classes = classesFrom(body.categories || body.legend || refs[0].categories);
    return {
      id,
      name: "LULC",
      available: true,
      type: "lulcYears",
      years,
      defaultYear: years[years.length - 1].year,
      opacity: 0.82,
      liftM: 0.45,
      gridSegments: 112,
      legendTitle: "LULC",
      legendSubtitle: "JalNetra",
      legendClasses: classes,
      classes,
    };
  }

  if (source.mode === "months") {
    const collectMonths = async (monthRefs) => {
      const periods = [];
      for (let i = 0; i < monthRefs.length; i++) {
        const meta = monthOf(monthRefs[i], i);
        let loaded;
        try {
          loaded = await kmlForRef(activeEndpoint, monthRefs[i]);
        } catch {
          continue;
        }
        const parsed = parseOverlayKml(loaded.text, loaded.href);
        const label = Number.isFinite(meta.month)
          ? `${MONTH_SHORT[meta.month - 1] || meta.id} ${meta.year || ""}`.trim()
          : meta.id;
        // Prefer ground overlays; fall back to polygon KML months when needed.
        if (parsed.ground) {
          if (!isMithiLatLonBox(parsed.bounds)) {
            console.warn(`[silt] skip ${meta.id} — LatLonBox not on Mithi`, parsed.bounds);
            continue;
          }
          periods.push({
            id: meta.id,
            label,
            year: meta.year,
            month: meta.month,
            overlay: parsed.image,
            bounds: parsed.bounds,
            needsAoiMask: true,
          });
          continue;
        }
        if (parsed.polygons || /<(?:\w+:)?Polygon[\s>]/i.test(loaded.text)) {
          periods.push({
            id: meta.id,
            label,
            year: meta.year,
            month: meta.month,
            type: "kmlPolygons",
            data: URL.createObjectURL(
              new Blob([loaded.text], { type: "application/vnd.google-earth.kml+xml" }),
            ),
            bounds: isMithiLatLonBox(parsed.bounds)
              ? parsed.bounds
              : { ...MITHI_CORRIDOR_BOUNDS },
          });
        }
      }
      return periods;
    };

    let periods = await collectMonths(refs);
    if (!periods.length && session?.kmlText) {
      try {
        console.warn(`[silt] ${activeEndpoint} months empty — live refresh with river KML AOI`);
        const fresh = await fetchEndpointNow(activeEndpoint, { forceLive: true });
        if (fresh) {
          body = fresh;
          periods = await collectMonths(collectKmlRefs(body));
        }
      } catch (err) {
        console.warn(`[silt] ${activeEndpoint} live refresh failed`, err?.message || err);
      }
    }
    periods.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!periods.length) {
      if (session?.kmlText) {
        const offline = buildOfflineSiltDef(id, session);
        if (offline) return offline;
      }
      return null;
    }
    const latest = periods[periods.length - 1];
    const classes = classesFrom(body.categories || body.classes || refs[0].categories);
    const volume = id === "silt_volume_surface";
    return {
      id,
      name: volume ? "SILT VERIFICATION" : "SILT CLASSIFICATION",
      available: true,
      type: volume ? "siltVolumePeriods" : "siltClassificationPeriods",
      periods,
      defaultPeriod: latest.id,
      bounds: isMithiLatLonBox(latest.bounds) ? latest.bounds : { ...MITHI_CORRIDOR_BOUNDS },
      opacity: 0.9,
      liftM: 1.2,
      gridSegments: 112,
      legendTitle: volume ? "Silt Verification" : "Silt Classification",
      legendSubtitle: "JalNetra · Mithi river KML AOI",
      classes: classes.length ? classes : volume ? OFFLINE_SILT_VOLUME : OFFLINE_SILT_CLASS,
      legendClasses: classes.length ? classes : volume ? OFFLINE_SILT_VOLUME : OFFLINE_SILT_CLASS,
      sourceEndpoint: activeEndpoint,
    };
  }

  const ref = source.mode === "named" ? pickNamed(refs, source) : refs[0];
  if (!ref) return null;
  let loaded;
  try {
    loaded = await kmlForRef(activeEndpoint, ref);
  } catch (err) {
    // Same-day DB often keeps expired Railway KML URLs — force a fresh river-AOI POST once.
    const landUseEp =
      activeEndpoint === "lulc" ||
      activeEndpoint === "vegetation-type" ||
      activeEndpoint === "vegetation-health";
    if (!landUseEp || !session?.kmlText) throw err;
    console.warn(`[jalnetra] ${activeEndpoint} KML stale — live refresh`, err?.message || err);
    const fresh = await fetchEndpointNow(activeEndpoint, { forceLive: true });
    body = fresh || body;
    const freshRefs = collectKmlRefs(body);
    const freshRef = source.mode === "named" ? pickNamed(freshRefs, source) : freshRefs[0];
    if (!freshRef) throw err;
    loaded = await kmlForRef(activeEndpoint, freshRef);
  }
  const text = loaded.text;
  const parsed = { ...parseOverlayKml(text, loaded.href), text };
  // Reject non-Mithi ground overlays for land-use layers (wrong-river leftovers).
  if (
    parsed.ground &&
    (id === "landuse_lulc" || id === "vegetation_extent" || id === "vegetation_health") &&
    parsed.bounds &&
    !isMithiLatLonBox(parsed.bounds)
  ) {
    console.warn(`[jalnetra] ${id} LatLonBox not on Mithi — clamping corridor`, parsed.bounds);
    parsed.bounds = { ...MITHI_CORRIDOR_BOUNDS };
  }
  const title = LAYER_TITLES[id] || (ref.name && ref.name !== ref.path ? ref.name : id.replace(/_/g, " "));
  return overlayDef(id, title, parsed, ref.categories || body.categories || body.legend || body.classes);
}

export async function ensureLiveOverlay(id) {
  if (defs.has(id)) return defs.get(id);
  if (!SOURCE[id]) return null;
  if (inflight.has(id)) return inflight.get(id);
  const job = build(id)
    .then((def) => {
      if (def) defs.set(id, def);
      return def;
    })
    .catch((err) => {
      const session = getRiverSession();
      session.errors[id] = err?.message || String(err);
      console.warn(`[jalnetra] ${id}`, err);
      return null;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/** endpoint id → live overlay layer ids that must rebuild when data swaps. */
const ENDPOINT_LAYERS = {
  lithology: ["geology"],
  "bank-erosion": ["bank_erosion"],
  salinity: ["salinity"],
  "water-quality": WQ_ORDER.slice(),
  "water-depth": ["water_depth"],
  eutrophication: ["pollution_eutrophication"],
  nitrogen: ["pollution_nitrogen"],
  coliform: ["pollution_coliform"],
  lulc: ["landuse_lulc"],
  "vegetation-type": ["vegetation_extent"],
  "vegetation-health": ["vegetation_health"],
  "silt-classification": ["silt_classification"],
  silt: ["silt_classification"],
  "silt-volume": ["silt_volume_surface"],
};

/**
 * Drop cached defs when JalNetra/history data arrives.
 * Hydrated (DB) paint first; liveReplace rebuilds when fresh live lands.
 */
if (typeof window !== "undefined") {
  window.addEventListener("planeteye-endpoint", (e) => {
    const ep = String(e.detail?.id || "");
    const ok = e.detail?.ok === true;
    const layers = ENDPOINT_LAYERS[ep];
    if (!layers?.length) return;
    // Skip no-op "still stale" events after a failed live refresh.
    if (e.detail?.staleSession && !e.detail?.liveReplace) return;
    for (const layerId of layers) {
      clearLiveOverlay(layerId);
      if (ok) void ensureLiveOverlay(layerId);
    }
  });
}
