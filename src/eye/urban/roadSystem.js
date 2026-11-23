import * as THREE from "three";
import { terrainHeightAt } from "../scene/terrain.js";
import { OSM_ROADS_RENDER_ORDER } from "../scene/drapeDepth.js";
import { pointInRing } from "../features/fishing/FishingZoneSystem.js";

/**
 * Roads are flat on the DTM, below draped KML overlays. Drawing them in the
 * transparent pass after the overlays keeps them visible on top of the
 * overlay while terrain / buildings still occlude them via depth.
 */
const OSM_ROAD_DRAW = { transparent: true, opacity: 1, depthWrite: true };

/** OSM highway → carriageway width (m). */
const WIDTH_BY_CLASS = {
  motorway: 14,
  trunk: 12,
  primary: 10,
  secondary: 8.5,
  tertiary: 7,
  residential: 5.5,
  unclassified: 5,
  living_street: 5,
  service: 3.5,
  track: 3,
  footway: 2,
  path: 1.6,
  cycleway: 2.2,
  pedestrian: 3,
};

/** Asphalt / surface colors by class — dark grey, not pure black. */
const ASPHALT = {
  motorway: "#2e3238",
  trunk: "#32363c",
  primary: "#363a40",
  secondary: "#3a3e44",
  tertiary: "#3e4248",
  residential: "#42464c",
  unclassified: "#464a50",
  living_street: "#484c52",
  service: "#4c5056",
  track: "#5a5048",
  footway: "#6a6458",
  path: "#5e584c",
  cycleway: "#3a4850",
  pedestrian: "#6e6858",
};

const MAJOR = /^(motorway|trunk|primary|secondary)$/;
const MEDIUM = /^(tertiary|residential|unclassified|living_street)$/;
const PATH = /^(footway|path|cycleway|pedestrian|track)$/;

/**
 * Terrain-following OSM roads as continuous mitered ribbons (no box gaps at bends).
 * OSM ways share node coordinates at junctions, so ribbons meet without snapping.
 */
export function createRoadSystem(dataset) {
  const group = new THREE.Group();
  group.name = "roads";
  const stations = dataset.corridor.stations;
  const ring = dataset.ringLocal || [];
  const rawRoads = dataset.osm?.roads || [];
  const bridges = dataset.bridges || [];

  let roads = rawRoads.map((r) => ({
    ...r,
    vertices: (r.vertices || []).map((v) => ({ ...v })),
  }));

  // Preserve authentic OSM roads only — no synthetic roads.

  if (!roads.length) return group;

  /** @type {Array<{pts: Array<{x:number,z:number,y:number}>, halfW:number, color:string, major:boolean, medium:boolean, pathLike:boolean, hw:string}>} */
  const ribbons = [];
  const edgeSegs = [];
  const dashSegs = [];
  let skippedWater = 0;

  // Bridge tip anchors — land roads snap onto these for a perfect join line.
  const bridgeTips = collectBridgeTips(bridges);

  for (const road of roads) {
    const hw = road.highway || "residential";
    if (hw === "steps" || hw === "bridleway") continue;
    // Bridge-tagged ways are drawn as elevated decks — skip flat ribbon here.
    if (road.bridge === true || road.bridge === "yes") continue;
    const w = Math.max(1.6, road.widthM || WIDTH_BY_CLASS[hw] || 5.5);
    const verts = road.vertices || [];
    if (verts.length < 2) continue;

    const pathLike = PATH.test(hw);
    const major = MAJOR.test(hw);
    const medium = MEDIUM.test(hw);
    const widthScale = pathLike ? 0.85 : major ? 1.0 : medium ? 0.88 : 0.78;
    const deckW = w * widthScale;
    const color = ASPHALT[hw] || "#5a6068";
    const segW = pathLike ? Math.min(deckW, 2.8) : deckW;
    const halfW = segW * 0.5;

    // Build contiguous land runs (break over water / mid-deck only)
    let run = [];
    const flushRun = () => {
      if (run.length >= 2) {
        // Smooth → align riverside edge to KML border → bridge tips → densify.
        const cleaned = simplifyRun(run, major ? 1.25 : 0.85);
        const aligned = alignRunToRiverBorder(cleaned, halfW, stations, ring);
        const smoothed = smoothRunXZ(aligned, stations, 1);
        // Second align pass locks the river-facing edge flush after smoothing.
        const locked = alignRunToRiverBorder(smoothed, halfW, stations, ring);
        const snapped = snapRunToBridgeTips(locked, bridgeTips, stations);
        const densified = densifyRun(snapped, major ? 8 : 10, stations);
        ribbons.push({
          pts: densified,
          halfW,
          color,
          major,
          medium,
          pathLike,
          hw,
        });
        addMarkingsAlong(densified, halfW, major, medium, edgeSegs, dashSegs);
      }
      run = [];
    };

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const bank = nearestHalf(v.x, v.z, stations);
      const overWater = ring.length >= 3 ? pointInRing(v.x, v.z, ring) : bank.lat < bank.half * 0.72;
      const underBridge = isUnderBridgeDeck(v.x, v.z, bridges, stations);
      if (underBridge) {
        skippedWater++;
        flushRun();
        continue;
      }
      if (overWater) {
        // Keep riverside ribbons continuous: pull the vertex just onto land
        // so the road edge can sit flush on the river border.
        const clamped = clampOntoRiverBorder(v.x, v.z, halfW, stations, ring);
        if (clamped) {
          run.push(clamped);
          continue;
        }
        skippedWater++;
        flushRun();
        continue;
      }
      const y = terrainHeightAt(v.x, v.z, stations) + 0.14;
      run.push({ x: v.x, z: v.z, y });
    }
    flushRun();
  }

  if (!ribbons.length) return group;

  // —— Continuous asphalt ribbons (merged, vertex-colored) ——
  const asphaltGeo = buildMergedRibbons(ribbons, (r) => r.halfW, 0, stations);
  if (asphaltGeo) {
    const asphaltMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.96,
      metalness: 0.02,
      vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      ...OSM_ROAD_DRAW,
    });
    const asphalt = new THREE.Mesh(asphaltGeo, asphaltMat);
    asphalt.name = "roadAsphalt";
    asphalt.receiveShadow = true;
    asphalt.castShadow = false;
    asphalt.frustumCulled = false;
    asphalt.renderOrder = OSM_ROADS_RENDER_ORDER + 1;
    group.add(asphalt);
  }

  // —— Soft shoulders (slightly wider, lower) ——
  const shoulderRibbons = ribbons
    .filter((r) => r.major || r.medium)
    .map((r) => ({
      ...r,
      halfW: r.halfW + (r.major ? 0.55 : 0.35),
      color: "#a8a098",
    }));
  const shoulderGeo = buildMergedRibbons(shoulderRibbons, (r) => r.halfW, -0.04, stations);
  if (shoulderGeo) {
    const shoulderMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.92,
      metalness: 0.02,
      vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      ...OSM_ROAD_DRAW,
    });
    const shoulders = new THREE.Mesh(shoulderGeo, shoulderMat);
    shoulders.name = "roadShoulders";
    shoulders.receiveShadow = true;
    shoulders.frustumCulled = false;
    shoulders.renderOrder = OSM_ROADS_RENDER_ORDER;
    group.add(shoulders);
  }

  const unit = new THREE.BoxGeometry(1, 1, 1);
  unit.translate(0, 0.5, 0);
  const dummy = new THREE.Object3D();

  // —— White edge lines ——
  if (edgeSegs.length) {
    const edgeMat = new THREE.MeshStandardMaterial({
      color: "#e8ecef",
      roughness: 0.72,
      metalness: 0.05,
      emissive: "#2a2e32",
      emissiveIntensity: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      ...OSM_ROAD_DRAW,
    });
    const edges = new THREE.InstancedMesh(unit, edgeMat, edgeSegs.length);
    edges.name = "roadEdges";
    edges.frustumCulled = false;
    edges.renderOrder = OSM_ROADS_RENDER_ORDER + 2;
    for (let i = 0; i < edgeSegs.length; i++) {
      const s = edgeSegs[i];
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.w, 0.05, s.len);
      dummy.updateMatrix();
      edges.setMatrixAt(i, dummy.matrix);
    }
    edges.instanceMatrix.needsUpdate = true;
    group.add(edges);
  }

  // —— Dashed center markings ——
  if (dashSegs.length) {
    const dashMat = new THREE.MeshStandardMaterial({
      color: "#f0e6b0",
      roughness: 0.65,
      metalness: 0.04,
      emissive: "#3a3418",
      emissiveIntensity: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      ...OSM_ROAD_DRAW,
    });
    const dashes = new THREE.InstancedMesh(unit, dashMat, dashSegs.length);
    dashes.name = "roadDashes";
    dashes.frustumCulled = false;
    dashes.renderOrder = OSM_ROADS_RENDER_ORDER + 2;
    for (let i = 0; i < dashSegs.length; i++) {
      const s = dashSegs[i];
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.w, 0.05, s.len);
      dummy.updateMatrix();
      dashes.setMatrixAt(i, dummy.matrix);
    }
    dashes.instanceMatrix.needsUpdate = true;
    group.add(dashes);
  }

  console.info("Roads", {
    ribbons: ribbons.length,
    edges: edgeSegs.length,
    dashes: dashSegs.length,
    skippedWater,
  });
  return group;
}

/**
 * Insert points along long spans and re-sample DTM at every vertex.
 * Linear Y interpolation between OSM nodes caused roads to float/sink on slopes.
 */
function densifyRun(pts, maxStepM, stations) {
  if (pts.length < 2) return pts;
  const out = [
    {
      x: pts[0].x,
      z: pts[0].z,
      y: terrainHeightAt(pts[0].x, pts[0].z, stations) + 0.14,
    },
  ];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / maxStepM));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      out.push({
        x,
        z,
        y: terrainHeightAt(x, z, stations) + 0.14,
      });
    }
  }
  return out;
}

/**
 * Drop micro-wiggles so road edges read as clean continuous lines.
 * Keeps corners with a meaningful direction change.
 */
function simplifyRun(pts, minStepM = 1) {
  if (!pts || pts.length < 3) return pts?.slice?.() || [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const dPrev = Math.hypot(cur.x - prev.x, cur.z - prev.z);
    if (dPrev < minStepM) continue;
    const ax = cur.x - prev.x;
    const az = cur.z - prev.z;
    const bx = next.x - cur.x;
    const bz = next.z - cur.z;
    const al = Math.hypot(ax, az) || 1;
    const bl = Math.hypot(bx, bz) || 1;
    const dot = (ax / al) * (bx / bl) + (az / al) * (bz / bl);
    // Keep only real bends; collinear micro-nodes get skipped.
    if (dot < 0.985 || dPrev > minStepM * 3) out.push(cur);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function collectBridgeTips(bridges) {
  const tips = [];
  for (const br of bridges || []) {
    const verts =
      br.vertices?.length >= 2
        ? br.vertices
        : br.start && br.end
          ? [br.start, br.end]
          : null;
    if (!verts || verts.length < 2) continue;
    const a = verts[0];
    const b = verts[verts.length - 1];
    const deckY = Number(br.deckY);
    tips.push({
      x: a.x,
      z: a.z,
      y: Number.isFinite(deckY) ? deckY + 0.2 : null,
      widthM: br.widthM || 12,
    });
    tips.push({
      x: b.x,
      z: b.z,
      y: Number.isFinite(deckY) ? deckY + 0.2 : null,
      widthM: br.widthM || 12,
    });
  }
  return tips;
}

/** Snap land-road run tips onto nearby bridge abutments for a perfect join. */
function snapRunToBridgeTips(pts, tips, stations) {
  if (!pts?.length || pts.length < 2 || !tips?.length) return pts;
  const out = pts.map((p) => ({ ...p }));
  const maxDist = 28;

  for (const end of [0, out.length - 1]) {
    const p = out[end];
    let best = null;
    for (const tip of tips) {
      const d = Math.hypot(tip.x - p.x, tip.z - p.z);
      if (d > maxDist) continue;
      if (!best || d < best.d) best = { tip, d };
    }
    if (!best) continue;
    const y =
      Number.isFinite(best.tip.y)
        ? best.tip.y
        : terrainHeightAt(best.tip.x, best.tip.z, stations) + 0.14;
    out[end] = { x: best.tip.x, z: best.tip.z, y };
  }
  return out;
}

/** Light Laplacian smooth in XZ so aligned bank-hugging roads stay continuous. */
function smoothRunXZ(pts, stations, passes = 1) {
  if (!pts || pts.length < 3) return pts;
  let cur = pts.map((p) => ({ ...p }));
  for (let pass = 0; pass < passes; pass++) {
    const next = [{ ...cur[0] }];
    for (let i = 1; i < cur.length - 1; i++) {
      const x = cur[i].x * 0.55 + (cur[i - 1].x + cur[i + 1].x) * 0.225;
      const z = cur[i].z * 0.55 + (cur[i - 1].z + cur[i + 1].z) * 0.225;
      next.push({
        x,
        z,
        y: terrainHeightAt(x, z, stations) + 0.14,
      });
    }
    next.push({ ...cur[cur.length - 1] });
    cur = next;
  }
  return cur;
}

/**
 * Pull riverside road centerlines so the river-facing asphalt edge sits flush
 * on the KML / corridor bank (perfect match with the river border).
 * Only adjusts points already beside the bank and roughly parallel to flow.
 */
function alignRunToRiverBorder(pts, halfW, stations, ring) {
  if (!pts?.length || pts.length < 2 || !stations?.length) return pts;
  const gap = 0.55; // small land gap so edge doesn't dip into water
  const targetOff = halfW + gap;
  const maxBankReach = halfW + 38;
  const out = pts.map((p) => ({ ...p }));

  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const bank = nearestBankEdge(p.x, p.z, stations, ring);
    if (!bank || bank.dist > maxBankReach) continue;

    // Skip approach roads that hit the river nearly head-on (bridge ramps).
    let tx;
    let tz;
    if (i === 0) {
      tx = out[1].x - p.x;
      tz = out[1].z - p.z;
    } else if (i === out.length - 1) {
      tx = p.x - out[i - 1].x;
      tz = p.z - out[i - 1].z;
    } else {
      tx = out[i + 1].x - out[i - 1].x;
      tz = out[i + 1].z - out[i - 1].z;
    }
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const alongFlow = Math.abs(tx * bank.flowX + tz * bank.flowZ);
    if (alongFlow < 0.42) continue;

    const tx2 = bank.bx + bank.nx * targetOff;
    const tz2 = bank.bz + bank.nz * targetOff;
    // Stronger pull when already hugging the bank.
    const t = bank.dist < halfW + 8 ? 1 : bank.dist < halfW + 20 ? 0.85 : 0.55;
    const x = p.x + (tx2 - p.x) * t;
    const z = p.z + (tz2 - p.z) * t;
    out[i] = {
      x,
      z,
      y: terrainHeightAt(x, z, stations) + 0.14,
    };
  }
  return out;
}

/** Move a water-side OSM vertex onto land with the road edge flush to the border. */
function clampOntoRiverBorder(x, z, halfW, stations, ring) {
  const bank = nearestBankEdge(x, z, stations, ring);
  if (!bank) return null;
  // Only rescue shallow overshoots into the channel.
  if (bank.dist > halfW + 22) return null;
  const gap = 0.55;
  const nx = bank.nx;
  const nz = bank.nz;
  const cx = bank.bx + nx * (halfW + gap);
  const cz = bank.bz + nz * (halfW + gap);
  if (ring?.length >= 3 && pointInRing(cx, cz, ring)) return null;
  return {
    x: cx,
    z: cz,
    y: terrainHeightAt(cx, cz, stations) + 0.14,
  };
}

/**
 * Closest river-border point + landward normal.
 * Prefers KML ring edges; falls back to station left/right banks.
 */
function nearestBankEdge(x, z, stations, ring) {
  let best = null;

  if (ring?.length >= 2) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const ax = a.x ?? a.lon;
      const az = a.z ?? a.lat;
      const bx = b.x ?? b.lon;
      const bz = b.z ?? b.lat;
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
      const hit = closestOnSeg(x, z, ax, az, bx, bz);
      const ex = bx - ax;
      const ez = bz - az;
      const el = Math.hypot(ex, ez) || 1;
      // Candidate outward (land) normals from the edge.
      let nx = -ez / el;
      let nz = ex / el;
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      if (pointInRing(mx + nx * 2.5, mz + nz * 2.5, ring)) {
        nx = -nx;
        nz = -nz;
      }
      if (!best || hit.d < best.dist) {
        best = {
          bx: hit.x,
          bz: hit.z,
          nx,
          nz,
          dist: hit.d,
          flowX: ex / el,
          flowZ: ez / el,
        };
      }
    }
  }

  // Station banks fill gaps when ring is coarse / missing.
  if (stations?.length) {
    const step = Math.max(1, Math.floor(stations.length / 220));
    for (let i = 0; i < stations.length; i += step) {
      const st = stations[i];
      const fx = st.flowX || 0;
      const fz = st.flowZ || 1;
      const candidates = [];
      if (Number.isFinite(st.leftX) && Number.isFinite(st.leftZ)) {
        candidates.push({
          bx: st.leftX,
          bz: st.leftZ,
          nx: -(st.x - st.leftX),
          nz: -(st.z - st.leftZ),
          flowX: fx,
          flowZ: fz,
        });
      }
      if (Number.isFinite(st.rightX) && Number.isFinite(st.rightZ)) {
        candidates.push({
          bx: st.rightX,
          bz: st.rightZ,
          nx: -(st.x - st.rightX),
          nz: -(st.z - st.rightZ),
          flowX: fx,
          flowZ: fz,
        });
      }
      if (!candidates.length) {
        const half = Math.max(12, st.halfWidth || 30);
        const px = -fz;
        const pz = fx;
        candidates.push(
          { bx: st.x - px * half, bz: st.z - pz * half, nx: -px, nz: -pz, flowX: fx, flowZ: fz },
          { bx: st.x + px * half, bz: st.z + pz * half, nx: px, nz: pz, flowX: fx, flowZ: fz },
        );
      }
      for (const c of candidates) {
        const nl = Math.hypot(c.nx, c.nz) || 1;
        c.nx /= nl;
        c.nz /= nl;
        // Land normal must point away from river centre.
        const toCenterX = st.x - c.bx;
        const toCenterZ = st.z - c.bz;
        if (c.nx * toCenterX + c.nz * toCenterZ > 0) {
          c.nx = -c.nx;
          c.nz = -c.nz;
        }
        const d = Math.hypot(x - c.bx, z - c.bz);
        if (!best || d < best.dist) {
          best = { bx: c.bx, bz: c.bz, nx: c.nx, nz: c.nz, dist: d, flowX: c.flowX, flowZ: c.flowZ };
        }
      }
    }
  }

  return best;
}

/**
 * Build one BufferGeometry from many ribbons with mitered left/right edges.
 * @param {typeof ribbons} ribbons
 * @param {(r: object) => number} halfFn
 * @param {number} yBias
 */
function buildMergedRibbons(ribbons, halfFn, yBias = 0, stations = null) {
  const positions = [];
  const colors = [];
  const indices = [];
  const c = new THREE.Color();
  const sampleY = (x, z, fallback) =>
    stations?.length ? terrainHeightAt(x, z, stations) + 0.14 + yBias : fallback + yBias;

  for (const r of ribbons) {
    const pts = r.pts;
    if (!pts || pts.length < 2) continue;
    const halfW = halfFn(r);
    c.set(r.color || "#5c6268");
    const base = positions.length / 3;

    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let tx;
      let tz;
      if (i === 0) {
        tx = pts[1].x - p.x;
        tz = pts[1].z - p.z;
      } else if (i === pts.length - 1) {
        tx = p.x - pts[i - 1].x;
        tz = p.z - pts[i - 1].z;
      } else {
        const ax = p.x - pts[i - 1].x;
        const az = p.z - pts[i - 1].z;
        const bx = pts[i + 1].x - p.x;
        const bz = pts[i + 1].z - p.z;
        const al = Math.hypot(ax, az) || 1;
        const bl = Math.hypot(bx, bz) || 1;
        tx = ax / al + bx / bl;
        tz = az / al + bz / bl;
      }
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Left normal in XZ (perpendicular to tangent)
      let nx = -tz;
      let nz = tx;
      let edgeHalf = halfW;

      // Miter at interior vertices so bends stay sealed
      if (i > 0 && i < pts.length - 1) {
        const ax = p.x - pts[i - 1].x;
        const az = p.z - pts[i - 1].z;
        const bx = pts[i + 1].x - p.x;
        const bz = pts[i + 1].z - p.z;
        const al = Math.hypot(ax, az) || 1;
        const bl = Math.hypot(bx, bz) || 1;
        const n1x = -az / al;
        const n1z = ax / al;
        const n2x = -bz / bl;
        const n2z = bx / bl;
        let mx = n1x + n2x;
        let mz = n1z + n2z;
        const ml = Math.hypot(mx, mz);
        if (ml > 1e-5) {
          mx /= ml;
          mz /= ml;
          const dot = mx * n1x + mz * n1z;
          const miter = Math.abs(dot) > 0.2 ? 1 / dot : 1;
          // Tighter miter → cleaner road edges (less flare at bends).
          const miterClamp = Math.min(Math.abs(miter), 1.65) * Math.sign(miter || 1);
          nx = mx;
          nz = mz;
          edgeHalf = halfW * miterClamp;
        }
      }

      const lx = p.x + nx * edgeHalf;
      const lz = p.z + nz * edgeHalf;
      const rx = p.x - nx * edgeHalf;
      const rz = p.z - nz * edgeHalf;
      // Sample DTM independently at edges so cross-slope roads don't float/bury.
      left.push({ x: lx, z: lz, y: sampleY(lx, lz, p.y) });
      right.push({ x: rx, z: rz, y: sampleY(rx, rz, p.y) });
    }

    for (let i = 0; i < pts.length; i++) {
      const L = left[i];
      const R = right[i];
      positions.push(L.x, L.y, L.z, R.x, R.y, R.z);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  if (!indices.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function addMarkingsAlong(pts, halfW, major, medium, edgeSegs, dashSegs) {
  if (!major && !medium) return;
  // Continuous edge strokes along the full run (not broken per tiny segment).
  if (major && pts.length >= 2) {
    for (const side of [-1, 1]) {
      let acc = 0;
      const stroke = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        let tx;
        let tz;
        if (i === 0) {
          tx = pts[1].x - p.x;
          tz = pts[1].z - p.z;
        } else if (i === pts.length - 1) {
          tx = p.x - pts[i - 1].x;
          tz = p.z - pts[i - 1].z;
        } else {
          tx = pts[i + 1].x - pts[i - 1].x;
          tz = pts[i + 1].z - pts[i - 1].z;
        }
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl;
        const nz = tx / tl;
        stroke.push({
          x: p.x + nx * side * halfW * 0.84,
          z: p.z + nz * side * halfW * 0.84,
          y: p.y + 0.08,
        });
        if (i > 0) acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      }
      // Emit as overlapping short segments along the smoothed stroke for a continuous white line.
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1];
        const b = stroke[i];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.6) continue;
        edgeSegs.push({
          x: (a.x + b.x) * 0.5,
          z: (a.z + b.z) * 0.5,
          y: Math.max(a.y, b.y) + 0.02,
          len: len * 1.02,
          w: 0.18,
          rot: Math.atan2(dx, dz),
        });
      }
    }
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.2) continue;
    const y = Math.max(a.y, b.y) + 0.06;
    const rot = Math.atan2(dx, dz);
    const ux = dx / len;
    const uz = dz / len;

    if ((major && len > 4) || (medium && len > 8)) {
      const dashLen = major ? 3.0 : 2.4;
      const gap = major ? 1.8 : 2.8;
      const n = Math.max(1, Math.floor(len / (dashLen + gap)));
      for (let d = 0; d < n; d++) {
        const t = d * (dashLen + gap) + dashLen * 0.5;
        if (t > len - 0.8) break;
        dashSegs.push({
          x: a.x + ux * t,
          z: a.z + uz * t,
          y: y + 0.03,
          len: Math.min(dashLen, len - t),
          w: major ? 0.22 : 0.15,
          rot,
        });
      }
    }
  }
}

function isUnderBridgeDeck(x, z, bridges, stations) {
  if (!bridges?.length) return false;
  const bank = nearestHalf(x, z, stations);
  // Only suppress roads over the wet channel mid-span — keep approach tips drawn.
  if (bank.lat > bank.half * 0.85) return false;
  for (const br of bridges) {
    const verts =
      br.vertices?.length >= 2
        ? br.vertices
        : br.start && br.end
          ? [br.start, br.end]
          : null;
    if (!verts || verts.length < 2) {
      if (Math.hypot((br.midX ?? 0) - x, (br.midZ ?? 0) - z) < 22) return true;
      continue;
    }
    const halfW = Math.max(14, (br.widthM || 12) * 0.65);
    let along = 0;
    let total = 0;
    for (let i = 1; i < verts.length; i++) {
      total += Math.hypot(verts[i].x - verts[i - 1].x, verts[i].z - verts[i - 1].z);
    }
    if (total < 1) continue;
    for (let i = 1; i < verts.length; i++) {
      const ax = verts[i - 1].x;
      const az = verts[i - 1].z;
      const bx = verts[i].x;
      const bz = verts[i].z;
      const segLen = Math.hypot(bx - ax, bz - az) || 1;
      const hit = closestOnSeg(x, z, ax, az, bx, bz);
      if (hit.d < halfW) {
        const t = (along + hit.t * segLen) / total;
        // Mid-deck only — leave ~18% at each tip so road meets bridge cleanly.
        if (t > 0.18 && t < 0.82) return true;
      }
      along += segLen;
    }
  }
  return false;
}

function closestOnSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz || 1;
  let t = ((px - ax) * abx + (pz - az) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + abx * t;
  const z = az + abz * t;
  return { x, z, t, d: Math.hypot(px - x, pz - z) };
}

function nearestHalf(x, z, stations) {
  let best = stations[0];
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(stations.length / 180));
  for (let i = 0; i < stations.length; i += step) {
    const st = stations[i];
    const d2 = (st.x - x) ** 2 + (st.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = st;
    }
  }
  const lat = Math.abs((x - best.x) * -best.flowZ + (z - best.z) * best.flowX);
  return { lat, half: best.halfWidth };
}
