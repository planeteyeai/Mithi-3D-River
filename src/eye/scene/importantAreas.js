/**
 * Whitelist of major Mithi corridor geographical areas for proximity labels.
 * Matching uses OSM place names when available; curated lon/lat fill gaps.
 * `radiusM` approximates the locality footprint so distance is to the soft boundary,
 * not only the centroid (GIS-style “approach the area”).
 */

/** @typedef {{ id: string, name: string, aliases: string[], lon?: number, lat?: number, radiusM: number, priority: number }} ImportantAreaDef */

/** @type {ImportantAreaDef[]} */
export const IMPORTANT_AREA_DEFS = [
  {
    id: "csia-bom",
    name: "Chhatrapati Shivaji Maharaj International Airport (BOM)",
    aliases: [
      "chhatrapati shivaji maharaj international airport",
      "mumbai airport",
      "csia",
      "bom",
      "santacruz airport",
    ],
    lon: 72.8679,
    lat: 19.0908,
    radiusM: 1200,
    priority: 12,
  },
  {
    id: "bkc",
    name: "Bandra Kurla Complex",
    aliases: ["bandra kurla complex", "bkc"],
    lon: 72.8657245,
    lat: 19.067115,
    radiusM: 420,
    priority: 10,
  },
  {
    id: "dharavi",
    name: "Dharavi",
    aliases: ["dharavi"],
    lon: 72.8586177,
    lat: 19.044463,
    radiusM: 480,
    priority: 10,
  },
  {
    id: "mahim",
    name: "Mahim",
    aliases: ["mahim"],
    // Curated suburb centre (Mahim Koliwada is a smaller neighbourhood — do not alias to it)
    lon: 72.8405,
    lat: 19.0415,
    radiusM: 450,
    priority: 9,
  },
  {
    id: "bandra-east",
    name: "Bandra East",
    aliases: ["bandra east"],
    lon: 72.8498111,
    lat: 19.0616565,
    radiusM: 400,
    priority: 8,
  },
  {
    id: "sion",
    name: "Sion",
    aliases: ["sion"],
    lon: 72.8612,
    lat: 19.0435,
    radiusM: 420,
    priority: 9,
  },
  {
    id: "kalina",
    name: "Kalina",
    aliases: ["kalina"],
    lon: 72.8612672,
    lat: 19.079273,
    radiusM: 380,
    priority: 8,
  },
  {
    id: "kurla",
    name: "Kurla",
    aliases: ["kurla", "kurla west", "kurla east"],
    lon: 72.876583,
    lat: 19.0686026,
    radiusM: 400,
    priority: 8,
  },
  {
    id: "vakola",
    name: "Vakola",
    aliases: ["vakola"],
    lon: 72.853893,
    lat: 19.0813635,
    radiusM: 320,
    priority: 7,
  },
  {
    id: "mahim-causeway",
    name: "Mahim Causeway",
    aliases: ["mahim causeway", "linhares"],
    lon: 72.83824,
    lat: 19.04826,
    radiusM: 80,
    priority: 9,
  },
];

/** Geographical show/hide radii (metres on the ground plane). */
export const AREA_LABEL_SHOW_M = 20;
export const AREA_LABEL_HIDE_M = 32;

/** Allowed trailing qualifiers when mapping "Kalina Village" → Kalina, etc. */
const ALLOWED_SUFFIX = /^(east|west|north|south|village|complex)$/i;

/**
 * Match a raw OSM / destination name to a whitelist entry.
 * Exact aliases only — rejects "Mahim Koliwada", colonies, nagars, etc.
 */
export function matchImportantArea(rawName) {
  const n = String(rawName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!n) return null;

  for (const def of IMPORTANT_AREA_DEFS) {
    for (const alias of def.aliases) {
      if (n === alias) return def;
    }
  }
  // "Kalina Village" / "Kurla West" → base area; not "Mahim Koliwada"
  for (const def of IMPORTANT_AREA_DEFS) {
    for (const alias of def.aliases) {
      if (alias.length < 4 || !n.startsWith(alias + " ")) continue;
      const rest = n.slice(alias.length + 1).trim();
      if (ALLOWED_SUFFIX.test(rest)) return def;
    }
  }
  return null;
}

/**
 * Build resolved area records in local scene coordinates.
 * Prefer OSM place coordinates when the name matches; else curated lon/lat.
 */
export function resolveImportantAreas(dataset, lonLatToLocal) {
  const places = [
    ...(dataset?.osm?.places || []),
    ...(dataset?.places || []),
    ...(dataset?.destinations || []),
  ];

  /** @type {Map<string, any>} */
  const byId = new Map();

  for (const def of IMPORTANT_AREA_DEFS) {
    byId.set(def.id, {
      id: def.id,
      name: def.name,
      priority: def.priority,
      radiusM: def.radiusM,
      lon: def.lon,
      lat: def.lat,
      ringLocal: null, // optional polygon in local XZ
      x: null,
      z: null,
      source: "curated",
    });
  }

  for (const p of places) {
    const def = matchImportantArea(p.name);
    if (!def) continue;
    const rec = byId.get(def.id);
    if (!rec) continue;
    // Prefer suburb / higher-rank OSM hits; first match wins coords if curated already set from OSM
    if (rec.source === "osm") continue;
    if (Number.isFinite(p.x) && Number.isFinite(p.z)) {
      rec.x = p.x;
      rec.z = p.z;
      rec.lon = p.lon ?? rec.lon;
      rec.lat = p.lat ?? rec.lat;
      rec.source = "osm";
    } else if (Number.isFinite(p.lon) && Number.isFinite(p.lat) && typeof lonLatToLocal === "function") {
      const loc = lonLatToLocal(p.lon, p.lat);
      if (loc && Number.isFinite(loc.x) && Number.isFinite(loc.z)) {
        rec.x = loc.x;
        rec.z = loc.z;
        rec.lon = p.lon;
        rec.lat = p.lat;
        rec.source = "osm";
      }
    }
  }

  // Project curated lon/lat for any still missing local coords
  for (const rec of byId.values()) {
    if (Number.isFinite(rec.x) && Number.isFinite(rec.z)) continue;
    if (Number.isFinite(rec.lon) && Number.isFinite(rec.lat) && typeof lonLatToLocal === "function") {
      const loc = lonLatToLocal(rec.lon, rec.lat);
      if (loc && Number.isFinite(loc.x) && Number.isFinite(loc.z)) {
        rec.x = loc.x;
        rec.z = loc.z;
      }
    }
  }

  // Optional: attach simple ring from landuse polygons if named
  const landuse = dataset?.osm?.landuse || dataset?.osm?.green || [];
  for (const lu of landuse) {
    const def = matchImportantArea(lu.name);
    if (!def) continue;
    const rec = byId.get(def.id);
    if (!rec || rec.ringLocal) continue;
    const coords = lu.coordinates || lu.ring || lu.vertices;
    if (!Array.isArray(coords) || coords.length < 3) continue;
    const ring = [];
    for (const c of coords) {
      if (Number.isFinite(c?.x) && Number.isFinite(c?.z)) {
        ring.push({ x: c.x, z: c.z });
      } else if (Array.isArray(c) && c.length >= 2 && typeof lonLatToLocal === "function") {
        const loc = lonLatToLocal(c[0], c[1]);
        if (loc) ring.push({ x: loc.x, z: loc.z });
      }
    }
    if (ring.length >= 3) {
      rec.ringLocal = ring;
      // centroid from ring if needed
      if (!Number.isFinite(rec.x)) {
        let sx = 0;
        let sz = 0;
        for (const p of ring) {
          sx += p.x;
          sz += p.z;
        }
        rec.x = sx / ring.length;
        rec.z = sz / ring.length;
        rec.source = "polygon";
      }
    }
  }

  return [...byId.values()].filter((r) => Number.isFinite(r.x) && Number.isFinite(r.z));
}

/** Point-in-ring (XZ). */
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const zi = ring[i].z;
    const xj = ring[j].x;
    const zj = ring[j].z;
    const inter = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-15) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

/** Distance from point to polygon boundary (0 if inside). */
function distToRingBoundary(x, z, ring) {
  if (pointInRing(x, z, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz || 1e-9;
    let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    best = Math.min(best, Math.hypot(x - cx, z - cz));
  }
  return best;
}

/**
 * Ground-plane distance (m) from navigation position to the area.
 * Uses polygon boundary when available; else soft disk radius around centroid.
 */
export function distanceToArea(navX, navZ, area) {
  if (area.ringLocal?.length >= 3) {
    return distToRingBoundary(navX, navZ, area.ringLocal);
  }
  const d = Math.hypot(navX - area.x, navZ - area.z);
  const r = Number.isFinite(area.radiusM) ? area.radiusM : 0;
  return Math.max(0, d - r);
}
