/**
 * Always-on Mithi vegetation from src/data/vegetation_health (1).kml.
 * Health overlay (WGS84 GroundOverlay) drives density; six procedural species
 * fill suitable land: Avicennia, Rhizophora, Neem, Banyan, Coconut, coastal shrub.
 *
 * Placements are procedural visualization inside the KML bounds — not surveyed
 * individual trees. Keeps water / roads / buildings clear.
 */
import * as THREE from "three";
import { lonLatToLocal, localToLonLat } from "../geo/geoReference.js";
import { terrainHeightAt, getTerrainBounds } from "./terrain.js";
import { preloadTreeAssets, foliageHex } from "./treeRegistry.js";
import { treeTargetHeight } from "./treeOrient.js";
import { VISUAL_LOCK } from "../config/visualLock.js";

/** Locked vegetation look — do not retune unless user explicitly asks. */
const V = VISUAL_LOCK.vegetation;
const MAX_INSTANCES = V.maxInstances;
const DEFAULT_STEP_M = V.stepM;
/** Keep canopies off houses — pad covers wide popcorn crowns. */
const BUILDING_CLEAR_M = V.buildingClearM;
const BUILDING_FOOTPRINT_PAD_M = V.buildingFootprintPadM;
const ROAD_CLEAR_M = V.roadClearM;
/** Keep trees off bridge decks and approaches. */
const BRIDGE_CLEAR_M = V.bridgeClearM;
/** Keep clear of channel center — plant on banks, not water. */
const RIVER_CLEAR_FRAC = V.riverClearFrac;
/** Plant within this distance past the channel edge (vacant flats). */
const MAX_BANK_OUT_M = V.maxBankOutM;

export const VEGETATION_HEALTH_LAYER = {
  overlay: "/data/hydrology/vegetation/vegetation_health_overlay.png",
  meta: "/data/hydrology/vegetation/vegetation_health_meta.json",
  source: "src/data/vegetation_health (1).kml",
  bounds: {
    north: 19.10610744,
    south: 19.02674113,
    east: 72.89905415,
    west: 72.81483231,
  },
  classes: [
    { id: "very_healthy", label: "Very Healthy", color: "#006400", kind: "trees", dens: 1 },
    { id: "healthy", label: "Healthy", color: "#32CD32", kind: "trees", dens: 0.95 },
    { id: "moderate", label: "Moderate", color: "#FFFF00", kind: "mixed", dens: 0.85 },
    { id: "poor", label: "Poor", color: "#FF8C00", kind: "shrub", dens: 0.7 },
    { id: "critical", label: "Critical", color: "#FF0000", kind: "grass", dens: 0.55 },
  ],
};

/**
 * Permanent health-colored vegetation — always visible on Mithi.
 * Also greens bank terrain from the vegetation_health overlay when terrainMesh is passed.
 */
export async function createPermanentVegetationHealthTrees(dataset, opts = {}) {
  const sampler = await createVegetationHealthOverlaySampler();
  // Yield once so first paint isn't blocked by tint + plant.
  await yieldFrame();
  if (opts.terrainMesh) {
    try {
      tintTerrainGreenFromVegetationHealth(opts.terrainMesh, dataset, sampler);
    } catch (err) {
      console.warn("[vegetation-health] terrain tint failed:", err?.message || err);
    }
  }
  await yieldFrame();
  return createVegetationHealthGrowLayer(dataset, {
    sampleLonLat: (lon, lat) => sampler.sampleLonLat(lon, lat),
    sampleLonLatSoft: (lon, lat) => sampler.sampleLonLatSoft(lon, lat),
    bounds: sampler.bounds || VEGETATION_HEALTH_LAYER.bounds,
    maxInstances: opts.maxInstances,
    stepM: opts.stepM,
    castShadow: !!opts.castShadow,
  });
}

function yieldFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Paint riverside / vegetation_health land green on the terrain mesh so banks
 * read as greenery even where 3D trees are sparse. Skips open water.
 */
export function tintTerrainGreenFromVegetationHealth(terrainMesh, dataset, sampler) {
  const geo = terrainMesh?.geometry;
  const pos = geo?.attributes?.position;
  const col = geo?.attributes?.color;
  if (!pos || !col || typeof sampler?.sampleLonLatSoft !== "function") return 0;

  const stations = dataset?.corridor?.stations || [];
  const liveWater = dataset?.liveWaterMask || null;
  const riverRing = dataset?.ringLocal || null;

  // Soft riparian green under trees — vacant flats read as greenery, not bare tan.
  const softBank = new THREE.Color("#4f7348");
  const tmp = new THREE.Color();
  let tinted = 0;
  // Subsample verts so tint never freezes the tab on dense terrain meshes.
  const stride = pos.count > 80000 ? 4 : pos.count > 40000 ? 3 : 2;

  for (let i = 0; i < pos.count; i += stride) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (isOpenWater(x, z, liveWater, stations, riverRing)) continue;

    let ll;
    try {
      ll = localToLonLat(x, z);
    } catch {
      continue;
    }

    const hit =
      sampler.sampleLonLatSoft?.(ll.lon, ll.lat) || sampler.sampleLonLat?.(ll.lon, ll.lat);
    let strength = 0;

    if (hit) {
      if (hit.id === "very_healthy" || hit.id === "healthy") strength = 0.22;
      else if (hit.id === "moderate") strength = 0.14;
      else strength = 0.07;
    }

    if (stations.length) {
      const near = nearest(x, z, stations);
      if (near.lat > near.half * 0.5 && near.lat < near.half + MAX_BANK_OUT_M) {
        const t = 1 - (near.lat - near.half * 0.5) / (MAX_BANK_OUT_M + near.half * 0.5);
        strength = Math.max(strength, Math.max(0, t) * 0.2);
      }
    }

    if (strength <= 0.04) continue;
    tmp.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    tmp.lerp(softBank, strength);
    col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    tinted += 1;
  }

  col.needsUpdate = true;
  if (tinted) {
    console.info("[vegetation-health] terrain greened", { verts: tinted });
  }
  return tinted;
}

export async function createVegetationHealthOverlaySampler() {
  let box = { ...VEGETATION_HEALTH_LAYER.bounds };
  let classes = VEGETATION_HEALTH_LAYER.classes.map((c) => ({ ...c, ...hexToRgb(c.color) }));
  try {
    const metaRes = await fetch(VEGETATION_HEALTH_LAYER.meta, { cache: "force-cache" });
    if (metaRes.ok) {
      const meta = await metaRes.json();
      if (meta?.bounds) box = { ...box, ...meta.bounds };
      if (Array.isArray(meta?.classes) && meta.classes.length) {
        classes = meta.classes.map((c) => {
          const base = VEGETATION_HEALTH_LAYER.classes.find((x) => x.id === c.id) || {};
          return { ...base, ...c, ...hexToRgb(c.color || base.color) };
        });
      }
    }
  } catch {
    /* use defaults */
  }

  const west = Number(box.west);
  const east = Number(box.east);
  const north = Number(box.north);
  const south = Number(box.south);

  const url = new URL(VEGETATION_HEALTH_LAYER.overlay, window.location.origin).href;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`vegetation_health overlay unavailable (${res.status})`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const maxW = 1600;
  const scale = Math.min(1, maxW / Math.max(1, bitmap.width));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, width, height);

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
    // Transparent / empty = no vegetation class under the pixel
    if (a < 18 || (r + g + b < 18 && a < 40)) return null;

    let best = null;
    let bestD = Infinity;
    for (const c of classes) {
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    // Green vegetation pixels in the KML are often near #006800 / #00D500 — keep loose match
    if (!best || bestD > 140 * 140) {
      // Any green-dominant opaque pixel → healthy trees
      if (g > r + 20 && g > b + 10 && a >= 18) {
        return {
          id: "healthy",
          label: "Healthy",
          class_label: "Healthy",
          color: "#32CD32",
          kind: "trees",
          dens: 0.95,
        };
      }
      return null;
    }
    return {
      id: best.id,
      label: best.label,
      class_label: best.label,
      color: best.color,
      kind: best.kind || healthToKind(best.id),
      dens: best.dens ?? 0.85,
    };
  }

  /** Nearest non-null class within a few pixels (fills sparse overlay holes). */
  function sampleLonLatSoft(lon, lat, radiusPx = 2) {
    const direct = sampleLonLat(lon, lat);
    if (direct) return direct;
    if (lon < west || lon > east || lat < south || lat > north) return null;
    const texU = (lon - west) / (east - west);
    const texV = (north - lat) / (north - south);
    const cx = Math.round(texU * (width - 1));
    const cy = Math.round(texV * (height - 1));
    let best = null;
    let bestD = Infinity;
    for (let dy = -radiusPx; dy <= radiusPx; dy++) {
      for (let dx = -radiusPx; dx <= radiusPx; dx++) {
        if (!dx && !dy) continue;
        const px = Math.min(width - 1, Math.max(0, cx + dx));
        const py = Math.min(height - 1, Math.max(0, cy + dy));
        const i = (py * width + px) * 4;
        const a = data[i + 3];
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (a < 18 || r + g + b < 18) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestD) continue;
        // reuse lon/lat of neighbor cell
        const nLon = west + (px / (width - 1)) * (east - west);
        const nLat = north - (py / (height - 1)) * (north - south);
        const hit = sampleLonLat(nLon, nLat);
        if (hit) {
          bestD = d2;
          best = hit;
        }
      }
    }
    return best;
  }

  return {
    sampleLonLat,
    sampleLonLatSoft,
    bounds: { west, east, north, south },
    width,
    height,
    classes,
  };
}

export async function createVegetationHealthGrowLayer(dataset, opts = {}) {
  const group = new THREE.Group();
  group.name = "vegetationHealthPermanent";
  group.visible = true;

  const box = opts.bounds || VEGETATION_HEALTH_LAYER.bounds;
  const maxN = Math.max(400, Number(opts.maxInstances) || MAX_INSTANCES);
  const stepM = Math.max(8, Math.min(20, Number(opts.stepM) || DEFAULT_STEP_M));
  const castShadow = !!opts.castShadow;
  const sampleLonLat = opts.sampleLonLat;
  if (typeof sampleLonLat !== "function") {
    group.userData.empty = true;
    group.userData.update = () => {};
    group.userData.dispose = () => {};
    return group;
  }

  // Soft sampler fills 1–2 px gaps in the health raster
  const softSample =
    typeof opts.sampleLonLatSoft === "function"
      ? opts.sampleLonLatSoft
      : (lon, lat) => sampleLonLat(lon, lat);

  const stations = dataset.corridor?.stations || [];
  const buildings = dataset.osm?.buildings || [];
  const roads = dataset.osm?.roads || [];
  const greenPolys = dataset.osm?.green || dataset.osm?.vegetation || [];
  const bridges = dataset.bridges || dataset.bridgeSpans || dataset.osm?.bridges || [];
  const riverRing = dataset.ringLocal || null;
  const liveWater = dataset.liveWaterMask || null;
  const terrainBox = getTerrainBounds();
  const buildingIndex = buildFeatureIndex(buildings, BUILDING_CLEAR_M + BUILDING_FOOTPRINT_PAD_M + 40);
  const roadIndex = buildFeatureIndex(roads, 24);
  const nearBridge = createBridgeClearance(bridges, roads);
  // Do NOT use Mandovi/Pune LULC here — it is not Mumbai-local and wipes banks.
  // Fixed seed → same tree layout every reload while visuals are locked.
  const rng = mulberry(V.seed ^ Math.floor(box.west * 1e6));

  console.info("[vegetation-health] clearance", {
    buildings: buildings.length,
    roads: roads.length,
    bridges: bridges.length,
    clearM: BUILDING_CLEAR_M,
    bridgeClearM: BRIDGE_CLEAR_M,
  });

  // Clip overlay scan to corridor + bank strip (full AOI grid freezes the tab).
  let west = Number(box.west);
  let east = Number(box.east);
  let north = Number(box.north);
  let south = Number(box.south);
  if (stations.length > 2) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const pad = MAX_BANK_OUT_M + 40;
    for (let i = 0; i < stations.length; i += Math.max(1, Math.floor(stations.length / 400))) {
      const st = stations[i];
      const half = Math.max(18, Number(st.halfWidth) || 30) + pad;
      minX = Math.min(minX, st.x - half);
      maxX = Math.max(maxX, st.x + half);
      minZ = Math.min(minZ, st.z - half);
      maxZ = Math.max(maxZ, st.z + half);
    }
    try {
      const a = localToLonLat(minX, minZ);
      const b = localToLonLat(maxX, maxZ);
      const c = localToLonLat(minX, maxZ);
      const d = localToLonLat(maxX, minZ);
      west = Math.max(west, Math.min(a.lon, b.lon, c.lon, d.lon));
      east = Math.min(east, Math.max(a.lon, b.lon, c.lon, d.lon));
      south = Math.max(south, Math.min(a.lat, b.lat, c.lat, d.lat));
      north = Math.min(north, Math.max(a.lat, b.lat, c.lat, d.lat));
    } catch {
      /* keep full box */
    }
  }
  const midLat = (north + south) * 0.5;
  const lonStep = stepM / (111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const latStep = stepM / 110540;

  const placements = [];
  const typeCounts = {
    very_healthy: 0,
    healthy: 0,
    moderate: 0,
    poor: 0,
    critical: 0,
    bank_fill: 0,
    canopy_clump: 0,
    avicennia: 0,
    rhizophora: 0,
    neem: 0,
    banyan: 0,
    coconut: 0,
    coastal_shrub: 0,
    grass: 0,
  };

  function onTerrainSlab(x, z) {
    if (!terrainBox) return true;
    const pad = 8;
    return (
      x >= terrainBox.minX + pad &&
      x <= terrainBox.maxX - pad &&
      z >= terrainBox.minZ + pad &&
      z <= terrainBox.maxZ - pad
    );
  }

  function bankOk(x, z) {
    if (!stations.length) return true;
    const near = nearest(x, z, stations);
    // Must sit on the dry bank strip — not mid-city far from the river.
    if (near.lat < near.half * RIVER_CLEAR_FRAC) return false;
    if (near.lat > near.half + MAX_BANK_OUT_M) return false;
    return true;
  }

  function tryPlace(x, z, hit, forceKind = null, bankDistM = null) {
    if (placements.length >= maxN) return false;
    if (!onTerrainSlab(x, z)) return false;
    if (!bankOk(x, z)) return false;
    if (isOpenWater(x, z, liveWater, stations, riverRing)) return false;
    if (nearBridge(x, z)) return false;
    if (blockedNear(x, z, buildingIndex, roadIndex)) return false;
    const y = terrainHeightAt(x, z, stations);
    if (!Number.isFinite(y)) return false;

    const kind = forceKind || hit.kind || healthToKind(hit.id);
    const assetId = assetForKind(kind, rng, bankDistM);
    const seat =
      assetId === "canopy_clump"
        ? y + 0.05
        : assetId === "rhizophora"
          ? y - 0.05
          : assetId === "coastal_shrub" || assetId === "grass"
            ? y + 0.05
            : y + 0.12;
    placements.push({
      x,
      z,
      y: seat,
      rotY: rng() * Math.PI * 2,
      scale: scaleForKind(kind, rng, assetId),
      assetId,
      kind,
      healthId: hit.id,
      healthColor: hit.color,
    });
    typeCounts[hit.id] = (typeCounts[hit.id] || 0) + 1;
    typeCounts[assetId] = (typeCounts[assetId] || 0) + 1;
    return true;
  }

  // 1) Locked riverside bands — stable density (visualLock.vegetation).
  if (stations.length > 2) {
    const gapM = stationGap(stations);
    const alongStep = Math.max(1, Math.round(V.alongStepM / Math.max(5, gapM)));
    const bands = [
      { out: 8, kind: "mangrove", n: 2 },
      { out: 18, kind: "mangrove", n: 2 },
      { out: 32, kind: "trees", n: 2 },
      { out: 55, kind: "trees", n: 2 },
      { out: 85, kind: "mixed", n: 2 },
      { out: 120, kind: "trees", n: 1 },
      { out: 160, kind: "mixed", n: 1 },
      { out: 210, kind: "trees", n: 1 },
      { out: 260, kind: "trees", n: 1 },
    ];
    for (let i = 0; i < stations.length && placements.length < maxN; i += alongStep) {
      const st = stations[i];
      const half = Math.max(18, Number(st.halfWidth) || 30);
      const px = -(st.flowZ || 0);
      const pz = st.flowX || 1;
      const plen = Math.hypot(px, pz) || 1;
      const nx = px / plen;
      const nz = pz / plen;

      for (const side of [-1, 1]) {
        for (const band of bands) {
          if (placements.length >= maxN) break;
          if (band.out < 40 && rng() > V.nearBankKeepChance) continue;
          if (band.out >= 40 && band.out < 120 && rng() > V.inlandKeepChance) continue;
          if (band.out >= 120 && rng() > V.farInlandKeepChance) continue;
          for (let t = 0; t < band.n; t++) {
            const jx = (rng() - 0.5) * 16;
            const jz = (rng() - 0.5) * 16;
            const x = st.x + nx * side * (half + band.out) + jx;
            const z = st.z + nz * side * (half + band.out) + jz;
            let ll;
            try {
              ll = localToLonLat(x, z);
            } catch {
              continue;
            }
            let hit = softSample(ll.lon, ll.lat) || sampleLonLat(ll.lon, ll.lat);
            if (!hit) {
              if (rng() > 0.5) continue;
              hit = {
                id: "healthy",
                label: "Healthy",
                color: "#32CD32",
                kind: band.kind,
                dens: 1,
              };
              typeCounts.bank_fill += 1;
            }
            tryPlace(x, z, hit, band.kind, band.out);
          }
        }
      }
    }

    const flatStep = Math.max(1, Math.round(10 / Math.max(5, gapM)));
    const flatOuts = [70, 110, 155, 200, 250];
    for (let i = 0; i < stations.length && placements.length < maxN; i += flatStep) {
      const st = stations[i];
      const half = Math.max(18, Number(st.halfWidth) || 30);
      const px = -(st.flowZ || 0);
      const pz = st.flowX || 1;
      const plen = Math.hypot(px, pz) || 1;
      const nx = px / plen;
      const nz = pz / plen;
      for (const side of [-1, 1]) {
        for (const out of flatOuts) {
          if (placements.length >= maxN) break;
          for (let k = 0; k < 2; k++) {
            if (rng() > V.flatFillKeepChance) continue;
            const x = st.x + nx * side * (half + out) + (rng() - 0.5) * 16;
            const z = st.z + nz * side * (half + out) + (rng() - 0.5) * 16;
            const hit = {
              id: "healthy",
              label: "Healthy",
              color: "#32CD32",
              kind: "trees",
              dens: 1,
            };
            if (tryPlace(x, z, hit, "trees", out)) typeCounts.bank_fill += 1;
          }
        }
      }
    }
  }

  // 2) Vegetation-health overlay — corridor-bounded grid with yields (never freeze tab).
  let overlayIters = 0;
  for (let lat = south + latStep * 0.5; lat < north && placements.length < maxN; lat += latStep) {
    for (let lon = west + lonStep * 0.5; lon < east; lon += lonStep) {
      if (placements.length >= maxN) break;
      overlayIters += 1;
      if ((overlayIters & 2047) === 0) await yieldFrame();
      let local;
      try {
        local = lonLatToLocal(lon, lat);
      } catch {
        continue;
      }
      if (!onTerrainSlab(local.x, local.z) || !bankOk(local.x, local.z)) continue;
      let hit = softSample(lon, lat) || sampleLonLat(lon, lat);
      const near = stations.length ? nearest(local.x, local.z, stations) : null;
      const bankDist = near ? near.lat - near.half : 30;
      if (!hit) {
        if (bankDist < 20 || bankDist > MAX_BANK_OUT_M) continue;
        if (rng() > V.vacantNoHitChance) continue;
        hit = {
          id: "healthy",
          label: "Healthy",
          color: "#32CD32",
          kind: bankDist < 30 ? "mangrove" : "trees",
          dens: 1,
        };
        typeCounts.bank_fill += 1;
      } else if (
        hit.id !== "very_healthy" &&
        hit.id !== "healthy" &&
        hit.id !== "moderate"
      ) {
        continue;
      }
      const densScale =
        bankDist >= 70 ? V.overlayDensFar : bankDist >= 35 ? V.overlayDensMid : V.overlayDensNear;
      if (rng() > (hit.dens ?? 0.85) * densScale) continue;

      const kind =
        bankDist < 18 ? "mangrove" : hit.id === "moderate" ? "mixed" : "trees";
      const x = local.x + (rng() - 0.5) * 6;
      const z = local.z + (rng() - 0.5) * 6;
      tryPlace(x, z, hit, kind, bankDist);
      if (rng() < 0.35) {
        tryPlace(
          x + (rng() - 0.5) * 8,
          z + (rng() - 0.5) * 8,
          hit,
          kind,
          bankDist,
        );
      }
    }
  }
  await yieldFrame();

  // 3) OSM green / park polygons → species mix inside vacant polygons.
  for (const poly of greenPolys) {
    if (placements.length >= maxN) break;
    const verts = poly?.vertices;
    if (!Array.isArray(verts) || verts.length < 3) continue;
    let cx = 0;
    let cz = 0;
    for (const v of verts) {
      cx += v.x;
      cz += v.z;
    }
    cx /= verts.length;
    cz /= verts.length;
    if (!onTerrainSlab(cx, cz) || !bankOk(cx, cz)) continue;

    let area = 0;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      area += verts[i].x * verts[j].z - verts[j].x * verts[i].z;
    }
    area = Math.abs(area) * 0.5;
    const n = Math.min(V.osmGreenMaxN, Math.max(3, Math.floor(area / V.osmGreenAreaDiv)));
    const hit = {
      id: "healthy",
      label: "Healthy",
      color: "#32CD32",
      kind: "trees",
      dens: 1,
    };
    for (let i = 0; i < n && placements.length < maxN; i++) {
      if (rng() > V.osmGreenKeepChance) continue;
      const p = randomInPolygon(verts, rng);
      if (!p) continue;
      const near = stations.length ? nearest(p.x, p.z, stations) : null;
      const bankDist = near ? near.lat - near.half : 25;
      tryPlace(p.x, p.z, hit, bankDist < 16 ? "mangrove" : "trees", bankDist);
    }
  }

  const prototypes = await preloadTreeAssets(placements.map((p) => p.assetId));
  const byAsset = new Map();
  for (const p of placements) {
    if (!prototypes.has(p.assetId)) continue;
    if (!byAsset.has(p.assetId)) byAsset.set(p.assetId, []);
    byAsset.get(p.assetId).push(p);
  }

  const batches = [];
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const box3 = new THREE.Box3();
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();

  for (const [assetId, list] of byAsset) {
    const proto = prototypes.get(assetId);
    const mat = proto.material.clone();
    // Bright canopy greens — vertex foliage + light lift so trees are not near-black.
    mat.vertexColors = true;
    mat.color?.set?.("#ffffff");
    if (mat.emissive) {
      mat.emissive.set(foliageHex(assetId));
      mat.emissiveIntensity = 0.16;
    }
    mat.roughness = 0.72;
    const mesh = new THREE.InstancedMesh(proto.geometry, mat, list.length);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    // Prototype bounds sit at origin — culling would hide every bank tree.
    mesh.frustumCulled = false;
    mesh.name = `vegHealth:${assetId}`;
    mesh.renderOrder = 2;

    box3.makeEmpty();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const targetH = treeTargetHeight(assetId, p.scale) * 1.35;
      p.uniform = targetH / Math.max(0.5, proto.nativeH);
      const crown =
        assetId === "banyan"
          ? 1.55
          : assetId === "avicennia" || assetId === "rhizophora"
            ? 1.35
            : assetId === "coconut" || assetId === "palm"
              ? 1.25
              : assetId === "neem"
                ? 1.4
                : assetId === "coastal_shrub" || assetId === "grass"
                  ? 1.15
                  : 1.3;
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rotY, 0);
      // Uniform scale — keeps trunks upright (no squash that reads as “lying down”).
      dummy.scale.setScalar(p.uniform * crown);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      box3.expandByPoint(dummy.position);
      color.copy(tintForHealth(p.healthId, p.healthColor, assetId));
      color.offsetHSL((rng() - 0.5) * 0.02, 0.03, (rng() - 0.5) * 0.025);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (!box3.isEmpty()) {
      box3.getCenter(center);
      box3.getSize(size);
      const radius = Math.max(size.x, size.y, size.z) * 0.6 + 60;
      mesh.boundingSphere = new THREE.Sphere(center.clone(), radius);
    }
    group.add(mesh);
    batches.push({ mesh, list });
  }

  function dispose() {
    for (const { mesh } of batches) {
      mesh.material?.dispose?.();
      mesh.dispose?.();
    }
    batches.length = 0;
    group.clear();
  }

  group.userData = {
    instanceCount: placements.length,
    typeCounts,
    empty: placements.length === 0,
    update: () => {},
    dispose,
    permanent: true,
    source: "vegetation-health-permanent",
    legend: VEGETATION_HEALTH_LAYER.classes,
  };

  console.info("[vegetation-health] permanent plants ready", {
    placed: placements.length,
    typeCounts,
    stepM,
  });

  return group;
}

function stationGap(stations) {
  if (stations.length < 2) return 12;
  return Math.hypot(stations[1].x - stations[0].x, stations[1].z - stations[0].z) || 12;
}

function isOpenWater(x, z, liveWater, stations, riverRing) {
  // Observed MNDWI water only — never plant on wet pixels.
  // Do NOT clear the whole KML river polygon / inflated ribbon: disconnected
  // ponds used to wipe mangrove parks (Sion–Bandra / BKC flats).
  if (liveWater?.available && liveWater.isWaterAtLocal?.(x, z)) return true;
  if (liveWater?.available) {
    // Tiny shore buffer so trunks don't sit in the blue sheet edge.
    if (stations?.length) {
      const near = nearest(x, z, stations);
      if (near.lat < Math.min(10, near.half * 0.35)) return true;
    }
    return false;
  }
  if (stations?.length) {
    const near = nearest(x, z, stations);
    if (near.lat < near.half * Math.max(0.55, RIVER_CLEAR_FRAC)) return true;
  }
  if (riverRing && pointInRing(x, z, riverRing)) return true;
  return false;
}

function healthToKind(id) {
  if (id === "very_healthy" || id === "healthy") return "trees";
  if (id === "moderate") return "mixed";
  if (id === "poor") return "shrub";
  return "grass";
}

/** Bright foliage tint — healthy trees read as proper green, not dark silhouettes. */
function tintForHealth(healthId, healthColor, assetId) {
  const natural = new THREE.Color(foliageHex(assetId));
  // Lift lightness so instance multiply stays vivid under daylight.
  natural.offsetHSL(0.02, 0.12, 0.1);
  if (healthId === "poor" || healthId === "critical") {
    return natural.lerp(new THREE.Color(healthColor || "#FF8C00"), 0.28);
  }
  if (healthId === "moderate") {
    return natural.lerp(new THREE.Color("#9ccc4a"), 0.18);
  }
  return natural.lerp(new THREE.Color("#6ec050"), 0.2);
}

/**
 * Proper Mithi bank species (upright trees — not neon foam clumps).
 * Water edge → mangroves; inland → neem / banyan / coconut / shrub.
 */
function assetForKind(kind, rng, bankDistM = null) {
  const nearBank = Number.isFinite(bankDistM) && bankDistM < 18;
  if (kind === "grass") return rng() < 0.7 ? "coastal_shrub" : "grass";
  if (kind === "shrub") return rng() < 0.8 ? "coastal_shrub" : "grass";
  if (kind === "mangrove" || nearBank) {
    const roll = rng();
    if (roll < 0.4) return "avicennia";
    if (roll < 0.72) return "rhizophora";
    if (roll < 0.88) return "coastal_shrub";
    return "coconut";
  }
  if (kind === "trees" || kind === "canopy") {
    const roll = rng();
    if (roll < 0.22) return "coconut";
    if (roll < 0.44) return "neem";
    if (roll < 0.6) return "banyan";
    if (roll < 0.74) return "avicennia";
    if (roll < 0.86) return "rhizophora";
    return "coastal_shrub";
  }
  // mixed inland
  const roll = rng();
  if (roll < 0.2) return "coastal_shrub";
  if (roll < 0.4) return "coconut";
  if (roll < 0.6) return "neem";
  if (roll < 0.76) return "banyan";
  if (roll < 0.88) return "avicennia";
  return "rhizophora";
}

function scaleForKind(kind, rng, assetId = null) {
  if (assetId === "banyan") return 1.35 + rng() * 1.15;
  if (assetId === "coconut") return 1.2 + rng() * 1.0;
  if (assetId === "rhizophora" || assetId === "avicennia") return 1.0 + rng() * 0.9;
  if (assetId === "neem") return 1.1 + rng() * 1.05;
  if (assetId === "coastal_shrub") return 0.9 + rng() * 0.85;
  if (assetId === "canopy_clump") return 1.0 + rng() * 0.9;
  if (kind === "grass") return 0.85 + rng() * 0.75;
  if (kind === "shrub" || kind === "mangrove") return 1.0 + rng() * 0.85;
  if (kind === "mixed") return 1.1 + rng() * 1.05;
  return 1.2 + rng() * 1.2;
}

/** Spatial hash so house clearance stays fast with tens of thousands of buildings. */
function buildFeatureIndex(features, radiusHint = 32, cellSize = 40) {
  const cells = new Map();
  const list = Array.isArray(features) ? features : [];
  for (const f of list) {
    const mx = Number(f.midX);
    const mz = Number(f.midZ);
    if (!Number.isFinite(mx) || !Number.isFinite(mz)) continue;
    let rad = radiusHint;
    if (Array.isArray(f.vertices) && f.vertices.length >= 3) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const v of f.vertices) {
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minZ = Math.min(minZ, v.z);
        maxZ = Math.max(maxZ, v.z);
      }
      f._bb = { minX, maxX, minZ, maxZ };
      rad = Math.max(rad, Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + BUILDING_FOOTPRINT_PAD_M);
    }
    const r = Math.max(rad, Number(f.sizeM) || 0, Number(f.widthM) || 0);
    const i0 = Math.floor((mx - r) / cellSize);
    const i1 = Math.floor((mx + r) / cellSize);
    const j0 = Math.floor((mz - r) / cellSize);
    const j1 = Math.floor((mz + r) / cellSize);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = `${i}:${j}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(f);
      }
    }
  }
  return { cells, cellSize };
}

function queryIndex(index, x, z) {
  if (!index?.cells) return [];
  const i = Math.floor(x / index.cellSize);
  const j = Math.floor(z / index.cellSize);
  const out = [];
  const seen = new Set();
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = index.cells.get(`${i + di}:${j + dj}`);
      if (!bucket) continue;
      for (const f of bucket) {
        if (seen.has(f)) continue;
        seen.add(f);
        out.push(f);
      }
    }
  }
  return out;
}

/** No vegetation on bridge decks, approaches, or bridge-tagged roads. */
function createBridgeClearance(bridges, roads) {
  const spans = [];
  for (const b of bridges || []) {
    const verts =
      b.vertices?.length >= 2
        ? b.vertices
        : b.start && b.end
          ? [b.start, b.end]
          : null;
    if (!verts || verts.length < 2) continue;
    spans.push({
      verts,
      halfW: Math.max(BRIDGE_CLEAR_M, (b.widthM || 12) * 0.85 + 6),
    });
  }
  for (const r of roads || []) {
    const isBridge =
      r.bridge === true ||
      r.bridge === "yes" ||
      /bridge|flyover|viaduct|causeway/i.test(String(r.name || r.highway || r.tags || ""));
    if (!isBridge) continue;
    const verts = r.vertices?.length >= 2 ? r.vertices : null;
    if (verts) {
      spans.push({
        verts,
        halfW: Math.max(BRIDGE_CLEAR_M, (r.widthM || 10) * 0.9 + 8),
      });
    } else if (Number.isFinite(r.midX) && Number.isFinite(r.midZ)) {
      spans.push({
        point: { x: r.midX, z: r.midZ },
        halfW: Math.max(BRIDGE_CLEAR_M, (r.widthM || 10) * 0.9 + 10),
      });
    }
  }

  return function nearBridge(x, z) {
    for (const s of spans) {
      if (s.point) {
        if (Math.hypot(x - s.point.x, z - s.point.z) < s.halfW) return true;
        continue;
      }
      const verts = s.verts;
      for (let i = 1; i < verts.length; i++) {
        const ax = verts[i - 1].x;
        const az = verts[i - 1].z;
        const bx = verts[i].x;
        const bz = verts[i].z;
        const abx = bx - ax;
        const abz = bz - az;
        const ab2 = abx * abx + abz * abz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / ab2));
        const px = ax + abx * t;
        const pz = az + abz * t;
        if (Math.hypot(x - px, z - pz) < s.halfW) return true;
      }
    }
    return false;
  };
}

/**
 * True when a canopy would cover a house or road.
 * Uses building footprints (+ pad) so trees stay only on vacant bank land.
 */
function blockedNear(x, z, buildingIndex, roadIndex) {
  for (const b of queryIndex(buildingIndex, x, z)) {
    if (hitsBuilding(x, z, b)) return true;
  }
  for (const r of queryIndex(roadIndex, x, z)) {
    if (Math.hypot(r.midX - x, r.midZ - z) < Math.max(ROAD_CLEAR_M, (r.widthM || 5) * 0.65)) {
      return true;
    }
  }
  return false;
}

function hitsBuilding(x, z, b) {
  const bb = b._bb;
  if (bb) {
    const pad = BUILDING_FOOTPRINT_PAD_M;
    if (x < bb.minX - pad || x > bb.maxX + pad || z < bb.minZ - pad || z > bb.maxZ + pad) {
      const cx = (bb.minX + bb.maxX) * 0.5;
      const cz = (bb.minZ + bb.maxZ) * 0.5;
      const span = Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ, 8);
      return Math.hypot(cx - x, cz - z) < span * 0.55 + BUILDING_CLEAR_M * 0.5;
    }
    // Inside padded footprint box → occupied house plot (no trees).
    return true;
  }
  const mx = Number(b.midX);
  const mz = Number(b.midZ);
  if (!Number.isFinite(mx) || !Number.isFinite(mz)) return false;
  const span = Math.max(Number(b.sizeM) || 0, Number(b.widthM) || 0, 10);
  const clear = Math.max(BUILDING_CLEAR_M, span * 0.75 + BUILDING_FOOTPRINT_PAD_M);
  return Math.hypot(mx - x, mz - z) < clear;
}

function nearest(x, z, stations) {
  let best = stations[0];
  let bestD = Infinity;
  // Coarse subsample — called from dense plant loops; refine locally after.
  const step = Math.max(1, Math.floor(stations.length / 120));
  for (let i = 0; i < stations.length; i += step) {
    const st = stations[i];
    const d2 = (st.x - x) ** 2 + (st.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = st;
    }
  }
  // Refine locally
  const i0 = Math.max(0, stations.indexOf(best) - step);
  const i1 = Math.min(stations.length - 1, stations.indexOf(best) + step);
  for (let i = i0; i <= i1; i++) {
    const st = stations[i];
    const d2 = (st.x - x) ** 2 + (st.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = st;
    }
  }
  const lat = Math.abs((x - best.x) * -best.flowZ + (z - best.z) * best.flowX);
  return { lat, half: Math.max(18, Number(best.halfWidth) || 30) };
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const zi = ring[i].z;
    const xj = ring[j].x;
    const zj = ring[j].z;
    const hit = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function randomInPolygon(verts, rng) {
  if (!verts?.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const v of verts) {
    if (!v) continue;
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  for (let tries = 0; tries < 28; tries++) {
    const x = minX + rng() * (maxX - minX);
    const z = minZ + rng() * (maxZ - minZ);
    if (pointInRing(x, z, verts)) return { x, z };
  }
  return null;
}

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  if (!Number.isFinite(n)) return { r: 128, g: 128, b: 128 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mulberry(a) {
  let seed = a >>> 0;
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
