/**
 * Continuous visible 3D bridge decks for Mithi OSM crossings.
 * Single ribbon mesh per deck (no segmented white strips) + piers / railings.
 */
import * as THREE from "three";
import { SURFACE_Y } from "./river.js";
import { terrainHeightAt } from "./terrain.js";

function stdMat(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.08,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    flatShading: false,
    ...opts,
  });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  m.side = THREE.DoubleSide;
  return m;
}

function polylineLength(verts) {
  let s = 0;
  for (let i = 1; i < verts.length; i++) {
    s += Math.hypot(verts[i].x - verts[i - 1].x, verts[i].z - verts[i - 1].z);
  }
  return s;
}

function isBridgeTaggedRoad(r) {
  if (!r) return false;
  if (r.bridge === true || r.bridge === "yes") return true;
  return /bridge|flyover|viaduct|causeway/i.test(
    String(r.name || r.highway || r.tags || ""),
  );
}

function nearestPointOnPolyline(px, pz, verts) {
  let bestD = Infinity;
  let bestP = null;
  let bestSeg = -1;
  for (let i = 0; i < verts.length - 1; i++) {
    const ax = verts[i].x;
    const az = verts[i].z;
    const bx = verts[i + 1].x;
    const bz = verts[i + 1].z;
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz;
    if (len2 === 0) continue;
    let t = ((px - ax) * abx + (pz - az) * abz) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cz = az + abz * t;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < bestD) {
      bestD = d;
      bestP = { x: cx, z: cz };
      bestSeg = i;
    }
  }
  if (!bestP) return null;
  const ax = verts[bestSeg].x;
  const az = verts[bestSeg].z;
  const bx = verts[bestSeg + 1].x;
  const bz = verts[bestSeg + 1].z;
  let tx = bx - ax;
  let tz = bz - az;
  const l = Math.hypot(tx, tz) || 1;
  return {
    point: bestP,
    distance: bestD,
    tangent: { x: tx / l, z: tz / l },
    widthM: null,
  };
}

/**
 * Push incomplete OSM decks all the way across the channel onto both banks.
 * Fixes railway / highway spans that stop mid-river.
 */
function extendPolylineToBanks(verts, ringLocal, stations, landPadM = 24) {
  if (!verts?.length || verts.length < 2) {
    return verts?.map((v) => ({ x: v.x, z: v.z })) || [];
  }
  const out = verts.map((v) => ({ x: v.x, z: v.z }));
  const maxReach = 260;
  const step = 2.0;

  const tipOnLand = (x, z) => {
    if (ringLocal?.length >= 3) return !isOverWater(x, z, ringLocal);
    if (!stations?.length) return true;
    const st = nearestStationXZ(x, z, stations);
    if (!st) return true;
    const half = Math.max(
      12,
      Number(st.wetHalfLeft ?? st.wetHalfRight ?? st.halfWidth) || 30,
    );
    const lat = Math.abs((x - st.x) * -(st.flowZ || 0) + (z - st.z) * (st.flowX || 1));
    return lat > half + 1.5;
  };

  const extendTip = (tipIdx, inwardIdx, prepend) => {
    const tip = out[tipIdx];
    const inward = out[inwardIdx];
    let ox = tip.x - inward.x;
    let oz = tip.z - inward.z;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;

    let landX = null;
    let landZ = null;

    if (tipOnLand(tip.x, tip.z)) {
      // Already on land — ensure enough pad past the bank edge.
      let inland = landPadM + 5;
      for (let d = step; d <= landPadM + 40; d += step) {
        const x = tip.x - ox * d;
        const z = tip.z - oz * d;
        if (!tipOnLand(x, z)) {
          inland = d;
          break;
        }
      }
      if (inland < landPadM) {
        landX = tip.x + ox * (landPadM - inland);
        landZ = tip.z + oz * (landPadM - inland);
      }
    } else {
      // Tip in water — walk out until bank, then landPad beyond.
      let prevWet = true;
      for (let d = step; d <= maxReach; d += step) {
        const x = tip.x + ox * d;
        const z = tip.z + oz * d;
        const wet = !tipOnLand(x, z);
        if (prevWet && !wet) {
          landX = x + ox * landPadM;
          landZ = z + oz * landPadM;
          break;
        }
        prevWet = wet;
      }
      // Station fallback if ring/wet test never clears.
      if (landX == null && stations?.length) {
        const st = nearestStationXZ(tip.x, tip.z, stations);
        if (st) {
          const half = Math.max(
            14,
            Number(st.wetHalfLeft ?? st.wetHalfRight ?? st.halfWidth) || 30,
          );
          const nx = -(st.flowZ || 0);
          const nz = st.flowX || 1;
          const nl = Math.hypot(nx, nz) || 1;
          const side = (tip.x - st.x) * (nx / nl) + (tip.z - st.z) * (nz / nl);
          const bankSide = side >= 0 ? 1 : -1;
          // Prefer continuing along bridge outward if it agrees with bank side.
          const alongBank = ox * (nx / nl) * bankSide + oz * (nz / nl) * bankSide;
          const ux = alongBank >= 0 ? ox : -ox;
          const uz = alongBank >= 0 ? oz : -oz;
          const need = half + landPadM - Math.abs(side);
          if (need > 1) {
            landX = tip.x + ux * need;
            landZ = tip.z + uz * need;
          }
        }
      }
    }

    if (landX == null || !Number.isFinite(landX)) return;
    const pt = { x: landX, z: landZ };
    if (prepend) out.unshift(pt);
    else out.push(pt);
  };

  extendTip(0, 1, true);
  extendTip(out.length - 1, out.length - 2, false);
  return out;
}

function nearestStationXZ(x, z, stations) {
  let best = null;
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(stations.length / 220));
  for (let i = 0; i < stations.length; i += step) {
    const st = stations[i];
    const d2 = (st.x - x) ** 2 + (st.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = st;
    }
  }
  return best;
}

/** Last-chance push so deck tips never sit mid-channel. */
function forceTipsOntoLand(verts, ringLocal, stations, landPadM = 22) {
  if (!verts || verts.length < 2) return;
  for (const end of [0, verts.length - 1]) {
    const tip = verts[end];
    const inward = verts[end === 0 ? 1 : verts.length - 2];
    let ox = tip.x - inward.x;
    let oz = tip.z - inward.z;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    const wet =
      ringLocal?.length >= 3
        ? isOverWater(tip.x, tip.z, ringLocal)
        : (() => {
            const st = nearestStationXZ(tip.x, tip.z, stations);
            if (!st) return false;
            const half = Math.max(12, Number(st.halfWidth) || 30);
            const lat = Math.abs(
              (tip.x - st.x) * -(st.flowZ || 0) + (tip.z - st.z) * (st.flowX || 1),
            );
            return lat < half;
          })();
    if (!wet) continue;
    for (let d = 2; d <= 240; d += 2) {
      const x = tip.x + ox * d;
      const z = tip.z + oz * d;
      const stillWet =
        ringLocal?.length >= 3
          ? isOverWater(x, z, ringLocal)
          : false;
      if (!stillWet) {
        tip.x = x + ox * landPadM;
        tip.z = z + oz * landPadM;
        break;
      }
    }
  }
}

/**
 * Extend both deck tips to the nearest land road so endings match the road network.
 * Skips bridge-tagged ways (those are the deck itself).
 */
function extendPolylineToRoads(verts, roads, maxDist = 95) {
  if (!verts?.length || verts.length < 2 || !roads?.length) {
    return { verts: verts?.map((v) => ({ x: v.x, z: v.z })) || [], snaps: {} };
  }
  const landRoads = roads.filter((r) => r.vertices?.length >= 2 && !isBridgeTaggedRoad(r));
  const out = verts.map((v) => ({ x: v.x, z: v.z }));
  const snaps = { start: null, end: null };

  const tryExtend = (tipIdx, inwardIdx, key) => {
    const tip = out[tipIdx];
    const inward = out[inwardIdx];
    const ox = tip.x - inward.x;
    const oz = tip.z - inward.z;
    const ol = Math.hypot(ox, oz) || 1;
    const outward = { x: ox / ol, z: oz / ol };

    let best = null;
    for (const r of landRoads) {
      const snap = nearestPointOnPolyline(tip.x, tip.z, r.vertices);
      if (!snap || snap.distance < 1.2 || snap.distance > maxDist) continue;
      const toX = snap.point.x - tip.x;
      const toZ = snap.point.z - tip.z;
      const sl = Math.hypot(toX, toZ) || 1;
      const dot = (outward.x * toX + outward.z * toZ) / sl;
      // Prefer snaps outward along the bridge axis (onto the approach road).
      if (dot < 0.05 && snap.distance > 22) continue;
      const score = snap.distance - (dot > 0.25 ? 28 : 0) - (dot > 0.55 ? 22 : 0);
      if (!best || score < best.score) {
        best = {
          ...snap,
          score,
          widthM: Number(r.widthM) || 10,
          roadName: r.name || r.highway || "",
        };
      }
    }
    if (!best) return;
    snaps[key] = best;
    const pt = { x: best.point.x, z: best.point.z };
    if (key === "start") out.unshift(pt);
    else out.push(pt);
  };

  tryExtend(0, 1, "start");
  tryExtend(out.length - 1, out.length - 2, "end");
  return { verts: out, snaps };
}

function resamplePolyline(verts, spacing = 4) {
  const total = polylineLength(verts);
  if (total < 1 || verts.length < 2) return verts.slice();
  const out = [{ x: verts[0].x, z: verts[0].z }];
  let walked = 0;
  let target = spacing;
  for (let i = 1; i < verts.length; i++) {
    const ax = verts[i - 1].x;
    const az = verts[i - 1].z;
    const bx = verts[i].x;
    const bz = verts[i].z;
    const seg = Math.hypot(bx - ax, bz - az) || 1e-6;
    let segStart = walked;
    while (target <= walked + seg && target < total - 0.05) {
      const t = (target - segStart) / seg;
      out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t });
      target += spacing;
    }
    walked += seg;
  }
  const last = verts[verts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last.x - prev.x, last.z - prev.z) > 0.4) out.push({ x: last.x, z: last.z });
  return out;
}

function pointAt(verts, dist) {
  if (!verts.length) return { x: 0, z: 0, tx: 1, tz: 0 };
  if (dist <= 0) {
    const dx = verts[1]?.x - verts[0].x || 1;
    const dz = verts[1]?.z - verts[0].z || 0;
    const l = Math.hypot(dx, dz) || 1;
    return { x: verts[0].x, z: verts[0].z, tx: dx / l, tz: dz / l };
  }
  let walked = 0;
  for (let i = 1; i < verts.length; i++) {
    const dx = verts[i].x - verts[i - 1].x;
    const dz = verts[i].z - verts[i - 1].z;
    const seg = Math.hypot(dx, dz) || 1e-6;
    if (walked + seg >= dist) {
      const t = (dist - walked) / seg;
      return { x: verts[i - 1].x + dx * t, z: verts[i - 1].z + dz * t, tx: dx / seg, tz: dz / seg };
    }
    walked += seg;
  }
  const n = verts.length;
  const dx = verts[n - 1].x - (verts[n - 2]?.x ?? verts[n - 1].x - 1);
  const dz = verts[n - 1].z - (verts[n - 2]?.z ?? verts[n - 1].z);
  const l = Math.hypot(dx, dz) || 1;
  return { x: verts[n - 1].x, z: verts[n - 1].z, tx: dx / l, tz: dz / l };
}

function isOverWater(x, z, ringLocal) {
  if (!ringLocal?.length) return true;
  let inside = false;
  for (let i = 0, j = ringLocal.length - 1; i < ringLocal.length; j = i++) {
    const xi = ringLocal[i].x;
    const zi = ringLocal[i].z;
    const xj = ringLocal[j].x;
    const zj = ringLocal[j].z;
    const inter = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-15) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

/**
 * Square the first/last stations so deck tips are a perfect straight cut
 * (perpendicular to the end tangent) — no OSM zig-zag / staircase ends.
 */
function squarePolylineEnds(verts, tipLen = 10) {
  if (!verts || verts.length < 3) return verts?.slice?.() || [];
  const out = verts.map((v) => ({ x: v.x, z: v.z }));
  const total = polylineLength(out);
  const tip = Math.min(tipLen, total * 0.22);

  // Start: project first ~tip metres onto the initial tangent.
  {
    const a = out[0];
    const b = out[Math.min(out.length - 1, 2)] || out[1];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    let walked = 0;
    for (let i = 1; i < out.length && walked < tip; i++) {
      const seg = Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
      const d = Math.min(tip, walked + seg);
      out[i].x = a.x + tx * d;
      out[i].z = a.z + tz * d;
      walked += seg;
    }
  }

  // End: project last ~tip metres onto the final tangent.
  {
    const n = out.length;
    const a = out[n - 1];
    const b = out[Math.max(0, n - 3)] || out[n - 2];
    let tx = a.x - b.x;
    let tz = a.z - b.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    let walked = 0;
    for (let i = n - 2; i >= 0 && walked < tip; i--) {
      const seg = Math.hypot(out[i + 1].x - out[i].x, out[i + 1].z - out[i].z);
      const d = Math.min(tip, walked + seg);
      out[i].x = a.x - tx * d;
      out[i].z = a.z - tz * d;
      walked += seg;
    }
  }
  return out;
}

/** Build a continuous solid ribbon (deck slab) along centerline. */
function buildRibbonMesh(verts, halfW, yBottom, yTop, material) {
  const n = verts.length;
  if (n < 2) return null;
  const positions = [];
  const normals = [];
  const indices = [];

  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    // Ends use ONLY the terminal segment tangent → perfectly straight end line.
    let dx;
    let dz;
    if (i === 0) {
      dx = verts[1].x - verts[0].x;
      dz = verts[1].z - verts[0].z;
    } else if (i === n - 1) {
      dx = verts[n - 1].x - verts[n - 2].x;
      dz = verts[n - 1].z - verts[n - 2].z;
    } else {
      const prev = verts[i - 1];
      const next = verts[i + 1];
      dx = next.x - prev.x;
      dz = next.z - prev.z;
    }
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    left.push({ x: verts[i].x + nx * halfW, z: verts[i].z + nz * halfW });
    right.push({ x: verts[i].x - nx * halfW, z: verts[i].z - nz * halfW });
  }

  // Vertex order per station: L-bottom, R-bottom, R-top, L-top
  for (let i = 0; i < n; i++) {
    const L = left[i];
    const R = right[i];
    positions.push(L.x, yBottom, L.z, R.x, yBottom, R.z, R.x, yTop, R.z, L.x, yTop, L.z);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    // bottom
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    // top
    indices.push(a + 3, a + 2, b + 3, a + 2, b + 2, b + 3);
    // left
    indices.push(a, a + 3, b, a + 3, b + 3, b);
    // right
    indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  // start cap
  indices.push(0, 1, 2, 0, 2, 3);
  // end cap
  const e = (n - 1) * 4;
  indices.push(e, e + 2, e + 1, e, e + 3, e + 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 18;
  return { mesh, left, right };
}

export function addMithiPolylineDeck(bridge, group, opts) {
  const {
    vertices,
    widthM = 12,
    deckY,
    stations,
    ringLocal,
    railway = false,
    name = "Bridge",
    minD = SURFACE_Y - 8,
    roads = [],
  } = opts;

  const raw = (vertices || []).filter((v) => Number.isFinite(v?.x) && Number.isFinite(v?.z));
  if (raw.length < 2) {
    console.warn("[mithi-bridge] no vertices", name);
    return null;
  }

  // 1) Bank-to-bank (fixes mid-river stubs) → 2) snap tips to land roads → 3) square ends.
  const banked = extendPolylineToBanks(raw, ringLocal, stations, railway ? 20 : 26);
  const extended = extendPolylineToRoads(banked, roads, railway ? 130 : 140);
  const resampled = resamplePolyline(
    extended.verts,
    Math.min(5, Math.max(2.5, polylineLength(extended.verts) / 24)),
  );
  const verts = squarePolylineEnds(resampled, 14);
  // Pin tips exactly on snapped road points so endings match the road network.
  if (extended.snaps.start?.point && verts.length >= 2) {
    verts[0].x = extended.snaps.start.point.x;
    verts[0].z = extended.snaps.start.point.z;
  }
  if (extended.snaps.end?.point && verts.length >= 2) {
    const n = verts.length - 1;
    verts[n].x = extended.snaps.end.point.x;
    verts[n].z = extended.snaps.end.point.z;
  }
  // Final safety: if a tip is still wet, push it onto land.
  forceTipsOntoLand(verts, ringLocal, stations, 22);
  const totalLen = polylineLength(verts);
  if (totalLen < 8) {
    console.warn("[mithi-bridge] tiny length", name, totalLen);
    return null;
  }
  console.info("[mithi-bridge] span locked", {
    name,
    rawLen: polylineLength(raw).toFixed(1),
    bankedLen: polylineLength(banked).toFixed(1),
    finalLen: totalLen.toFixed(1),
    startDist: extended.snaps.start?.distance?.toFixed?.(1) ?? null,
    endDist: extended.snaps.end?.distance?.toFixed?.(1) ?? null,
    startRoad: extended.snaps.start?.roadName || null,
    endRoad: extended.snaps.end?.roadName || null,
  });

  const halfW = Math.max(4.0, widthM * 0.5);
  const deckW = Math.max(8, widthM);
  const slabThick = railway ? 1.05 : 1.25;
  const roadThick = railway ? 0 : 0.32;

  // Realistic road/rail colours — avoid bright white emissive strips
  const concrete = stdMat("#9a9288", { roughness: 0.86, metalness: 0.04 });
  const asphalt = stdMat("#2e3238", { roughness: 0.94, metalness: 0.02 });
  const steel = stdMat("#6e7680", { metalness: 0.42, roughness: 0.45 });
  const railSteel = stdMat("#c5ccd4", { metalness: 0.55, roughness: 0.4 });
  const sleeper = stdMat("#5a4634", { roughness: 0.9 });
  const pierMat = stdMat("#8e867c", { roughness: 0.88 });
  const stripeMat = stdMat("#d8d2c0", { roughness: 0.7 });
  const xAxis = new THREE.Vector3(1, 0, 0);

  const safeDeckY = Math.max(deckY, SURFACE_Y + (railway ? 9.5 : 7.5));
  const yTop = safeDeckY;
  const yBot = safeDeckY - slabThick;

  const debug = {
    centerline: verts.map((v) => ({ x: v.x, z: v.z })),
    outline: [],
    endpoints: [
      { x: verts[0].x, z: verts[0].z },
      { x: verts[verts.length - 1].x, z: verts[verts.length - 1].z },
    ],
    waterHits: [],
    deckY: safeDeckY,
    lengthM: totalLen,
    widthM: deckW,
    railway: !!railway,
    name,
    meshCount: 0,
  };

  let meshCount = 0;

  // Continuous girder / slab ribbon
  const girder = buildRibbonMesh(verts, halfW + 0.35, yBot - 0.35, yBot + 0.15, steel);
  if (girder) {
    bridge.add(girder.mesh);
    meshCount++;
  }
  const slab = buildRibbonMesh(verts, halfW, yBot, yTop, concrete);
  if (slab) {
    bridge.add(slab.mesh);
    meshCount++;
    debug.outline = [...slab.left, ...[...slab.right].reverse()];
  }

  if (!railway) {
    const road = buildRibbonMesh(verts, halfW * 0.92, yTop, yTop + roadThick, asphalt);
    if (road) {
      bridge.add(road.mesh);
      meshCount++;
    }
    // Center stripe as thin continuous ribbon
    const stripe = buildRibbonMesh(verts, 0.18, yTop + roadThick, yTop + roadThick + 0.05, stripeMat);
    if (stripe) {
      bridge.add(stripe.mesh);
      meshCount++;
    }
    // Side railings — continuous thin ribbons
    for (const side of [-1, 1]) {
      const railPts = verts.map((v, i) => {
        const prev = verts[Math.max(0, i - 1)];
        const next = verts[Math.min(verts.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const l = Math.hypot(dx, dz) || 1;
        return {
          x: v.x + (-dz / l) * side * (halfW - 0.15),
          z: v.z + (dx / l) * side * (halfW - 0.15),
        };
      });
      const rail = buildRibbonMesh(railPts, 0.12, yTop + 0.15, yTop + 1.15, railSteel);
      if (rail) {
        bridge.add(rail.mesh);
        meshCount++;
      }
    }
  } else {
    for (const lane of [-0.9, 0.9]) {
      const railPts = verts.map((v, i) => {
        const prev = verts[Math.max(0, i - 1)];
        const next = verts[Math.min(verts.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const l = Math.hypot(dx, dz) || 1;
        return {
          x: v.x + (-dz / l) * lane,
          z: v.z + (dx / l) * lane,
        };
      });
      const rail = buildRibbonMesh(railPts, 0.09, yTop, yTop + 0.18, railSteel);
      if (rail) {
        bridge.add(rail.mesh);
        meshCount++;
      }
    }
    for (let d = 0.5; d < totalLen - 0.4; d += 0.7) {
      const p = pointAt(verts, d);
      const sleeperMesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, deckW * 0.86), sleeper);
      sleeperMesh.position.set(p.x, yTop + 0.02, p.z);
      sleeperMesh.quaternion.setFromUnitVectors(xAxis, new THREE.Vector3(p.tx, 0, p.tz));
      sleeperMesh.renderOrder = 19;
      sleeperMesh.frustumCulled = false;
      bridge.add(sleeperMesh);
      meshCount++;
    }
  }

  // Support piers only over water
  const pierSpacing = railway ? 15 : Math.max(11, Math.min(24, deckW * 1.35));
  for (let d = pierSpacing * 0.45; d < totalLen - pierSpacing * 0.3; d += pierSpacing) {
    const p = pointAt(verts, d);
    if (ringLocal?.length && !isOverWater(p.x, p.z, ringLocal)) continue;
    debug.waterHits.push({ x: p.x, z: p.z });
    // Seat pier bottoms on sampled DTM / channel bed — do not force an arbitrary
    // SURFACE_Y offset that sinks piers through the rendered terrain mesh.
    const ground = terrainHeightAt(p.x, p.z, stations);
    const bed = Number.isFinite(ground) ? ground : Math.min(SURFACE_Y - 3, minD);
    const pierH = Math.max(4.5, yBot - bed);
    const r = railway ? 1.05 : Math.max(0.75, deckW * 0.055);
    const pier = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.25, pierH, 14), pierMat);
    pier.position.set(p.x, bed + pierH * 0.5, p.z);
    pier.castShadow = true;
    pier.renderOrder = 17;
    pier.frustumCulled = false;
    bridge.add(pier);
    meshCount++;
    // Pier cap
    const cap = new THREE.Mesh(new THREE.BoxGeometry(r * 3.2, 0.45, deckW * 0.72), concrete);
    cap.position.set(p.x, yBot - 0.15, p.z);
    cap.quaternion.setFromUnitVectors(xAxis, new THREE.Vector3(p.tx, 0, p.tz));
    cap.renderOrder = 17;
    cap.frustumCulled = false;
    bridge.add(cap);
    meshCount++;
    group.userData.piers.push({
      x: p.x,
      z: p.z,
      y: pier.position.y,
      h: pierH,
      deckY: yBot,
      bedY: bed,
      bridgeName: name,
      mesh: pier,
      // Cylinder already has real height — skip per-frame unit-box rescale.
      terrainSeated: true,
    });
  }

  // Clean square abutments + approach pads that meet snapped land roads.
  for (const end of [
    { outward: -1, snap: extended.snaps.start },
    { outward: 1, snap: extended.snaps.end },
  ]) {
    const p0 = end.outward < 0 ? verts[0] : verts[verts.length - 1];
    const p1 = end.outward < 0 ? verts[1] : verts[verts.length - 2];
    const dx = p0.x - p1.x;
    const dz = p0.z - p1.z;
    const l = Math.hypot(dx, dz) || 1;
    const tx = dx / l;
    const tz = dz / l;

    // Always seat abutments on land — nudge tip outward if still wet.
    let ax0 = p0.x;
    let az0 = p0.z;
    if (ringLocal?.length && isOverWater(ax0, az0, ringLocal)) {
      for (let d = 2; d <= 120; d += 2) {
        const x = p0.x + tx * d;
        const z = p0.z + tz * d;
        if (!isOverWater(x, z, ringLocal)) {
          ax0 = x + tx * 8;
          az0 = z + tz * 8;
          break;
        }
      }
    }

    const ground = terrainHeightAt(ax0, az0, stations);
    const groundY = Number.isFinite(ground) ? ground : SURFACE_Y;
    const abutH = Math.max(2.2, safeDeckY - groundY + 0.4);
    const roadW = Math.max(deckW * 0.92, (end.snap?.widthM || deckW) * 1.05);

    // Abutment under the tip.
    const abut = new THREE.Mesh(new THREE.BoxGeometry(8.5, abutH, roadW + 1.0), concrete);
    abut.position.set(ax0 + tx * 2.8, safeDeckY - abutH * 0.5, az0 + tz * 2.8);
    abut.quaternion.setFromUnitVectors(xAxis, new THREE.Vector3(tx, 0, tz));
    abut.castShadow = true;
    abut.frustumCulled = false;
    abut.renderOrder = 17;
    bridge.add(abut);
    meshCount++;

    // Flat end-cap plate flush with the squared tip.
    const endCap = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, slabThick + roadThick + 0.25, roadW + 0.45),
      railway ? concrete : asphalt,
    );
    endCap.position.set(p0.x + tx * 0.15, yTop + roadThick * 0.5, p0.z + tz * 0.15);
    endCap.quaternion.setFromUnitVectors(xAxis, new THREE.Vector3(tx, 0, tz));
    endCap.castShadow = true;
    endCap.frustumCulled = false;
    endCap.renderOrder = 19;
    bridge.add(endCap);
    meshCount++;

    // Approach pad: long enough to cover the snap gap and sit on the road surface.
    const padLen = Math.max(14, Math.min(65, (end.snap?.distance || 12) + 16));
    const padThick = Math.max(0.4, roadThick + 0.28);
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(padLen, padThick, roadW),
      railway ? concrete : asphalt,
    );
    const padOuterY = groundY + padThick * 0.55;
    const padInnerY = yTop + roadThick * 0.5;
    const padY = (padInnerY + padOuterY) * 0.5;
    const drop = padInnerY - padOuterY;
    const slope = end.outward * -Math.atan2(Math.max(0, drop), padLen);
    pad.position.set(ax0 + tx * (padLen * 0.5), padY, az0 + tz * (padLen * 0.5));
    pad.quaternion.setFromUnitVectors(xAxis, new THREE.Vector3(tx, 0, tz));
    pad.rotateZ(slope);
    pad.receiveShadow = true;
    pad.frustumCulled = false;
    pad.renderOrder = 18;
    bridge.add(pad);
    meshCount++;

    // Center stripe continuing onto the approach so it visually joins the road.
    if (!railway) {
      const stripePad = new THREE.Mesh(
        new THREE.BoxGeometry(padLen * 0.92, 0.06, 0.22),
        stripeMat,
      );
      stripePad.position.set(
        ax0 + tx * (padLen * 0.5),
        padY + padThick * 0.45,
        az0 + tz * (padLen * 0.5),
      );
      stripePad.quaternion.copy(pad.quaternion);
      stripePad.frustumCulled = false;
      stripePad.renderOrder = 19;
      bridge.add(stripePad);
      meshCount++;
    }
  }

  if (!debug.waterHits.length) {
    for (let d = 0; d <= totalLen; d += Math.max(8, totalLen / 10)) {
      const p = pointAt(verts, d);
      if (!ringLocal?.length || isOverWater(p.x, p.z, ringLocal)) debug.waterHits.push({ x: p.x, z: p.z });
    }
  }

  debug.meshCount = meshCount;
  bridge.userData.mithiPolylineDebug = debug;
  bridge.userData.modelLengthM = totalLen;
  bridge.userData.modelWidthM = deckW;
  bridge.userData.modelDeckY = safeDeckY;
  bridge.userData.modelStructureType = railway ? "railway girder ribbon" : "road girder ribbon";
  bridge.renderOrder = 18;

  console.info("[mithi-bridge]", {
    name,
    osmLen: totalLen.toFixed(1),
    width: deckW,
    deckY: safeDeckY.toFixed(2),
    surfaceY: SURFACE_Y,
    clearance: (safeDeckY - SURFACE_Y).toFixed(2),
    meshes: meshCount,
    verts: verts.length,
    railway,
    ends: debug.endpoints,
  });

  return debug;
}

/** Debug overlay: RED centerline, GREEN deck outline, YELLOW ends, BLUE water, WHITE piers. */
export function createMithiBridgeDebugOverlay(bridgesGroup) {
  const root = new THREE.Group();
  root.name = "mithiBridgeDebug";
  root.visible = false;

  const line = (pts, color, y) => {
    if (!pts?.length) return null;
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, y, p.z)));
    const obj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 }));
    obj.renderOrder = 60;
    obj.frustumCulled = false;
    return obj;
  };
  const dots = (pts, color, y, r) => {
    const g = new THREE.Group();
    const m = stdMat(color, { emissive: color, emissiveIntensity: 0.55 });
    for (const p of pts || []) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), m);
      mesh.position.set(p.x, y, p.z);
      mesh.renderOrder = 61;
      mesh.frustumCulled = false;
      g.add(mesh);
    }
    return g;
  };

  for (const child of bridgesGroup?.children || []) {
    const dbg = child.userData?.mithiPolylineDebug;
    if (!dbg) continue;
    const pack = new THREE.Group();
    pack.name = `debug:${dbg.name}`;
    const cl = line(dbg.centerline, 0xff2222, dbg.deckY + 2.5);
    const ol = line(dbg.outline, 0x22ff66, dbg.deckY + 1.2);
    if (cl) pack.add(cl);
    if (ol) pack.add(ol);
    pack.add(dots(dbg.endpoints, 0xffee33, dbg.deckY + 3.0, 2.2));
    pack.add(dots(dbg.waterHits, 0x3388ff, SURFACE_Y + 1.0, 1.4));
    for (const p of dbg.waterHits || []) {
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, Math.max(3, dbg.deckY - SURFACE_Y), 6),
        stdMat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.6 }),
      );
      stem.position.set(p.x, SURFACE_Y + Math.max(1.5, (dbg.deckY - SURFACE_Y) * 0.5), p.z);
      stem.renderOrder = 62;
      stem.frustumCulled = false;
      pack.add(stem);
    }
    root.add(pack);
  }
  return root;
}
