import * as THREE from "three";
import { terrainHeightAt } from "../scene/terrain.js";
import { lonLatToLocal } from "../geo/geoReference.js";
import { OSM_ROADS_RENDER_ORDER } from "../scene/drapeDepth.js";

const DRAW = { depthWrite: true };
const AERO_ORDER = OSM_ROADS_RENDER_ORDER + 4;

const WIDTH = { runway: 60, taxiway: 26, apron: 40 };
const COLOR = {
  runway: "#1c2128",
  runwayShoulder: "#2e343c",
  taxiway: "#5a626c",
  apron: "#6e7680",
  mark: "#f4f7fa",
  hold: "#e0b020",
  grass: "#4f7a42",
  fence: "#6a7078",
};

/** CSIA ATC tower (WGS84) — Sahar mid-field. */
const CSIA_TOWER = { lon: 72.86755, lat: 19.08935 };
/** Mid-field label anchor. */
const CSIA_LABEL = { lon: 72.8679, lat: 19.0908 };

/**
 * CSIA aerodrome pavement — AIP-aligned runways/taxiways/aprons with
 * operational markings (centerline, threshold, TDZ, digits, PAPI, lights),
 * grass buffers, perimeter fence, ATC tower and airport label.
 */
export function createAerowaySystem(dataset, opts = {}) {
  const group = new THREE.Group();
  group.name = "aeroway";

  const stations = dataset.corridor?.stations || [];
  const features = dataset.osm?.aeroway || [];
  if (!features.length || !stations.length) return group;
  const densifyM = Number(opts.densifyM) || (opts.lite ? 16 : 10);
  const enableExtras = opts.extras !== false && !opts.lite;

  const runwayRibbons = [];
  const taxiRibbons = [];
  const shoulderRibbons = [];
  const grassRibbons = [];
  const apronPolys = [];
  const markSegs = [];
  const lightPts = [];
  const digitPlanes = [];
  const floodPts = [];

  // Prefer closed apron polygons; treat short open apron ways as ribbons.
  let taxiMarkBudget = 100;
  for (const f of features) {
    const kind = String(f.aeroway || "").toLowerCase();
    const coords = f.vertices || [];
    if (coords.length < 2) continue;
    // Taxiways: ensure overview-readable width (OSM often omits widthM).
    const rawW = Number(f.widthM);
    const widthM =
      kind === "runway"
        ? Math.max(45, rawW || WIDTH.runway)
        : kind === "taxiway"
          ? Math.max(22, rawW || WIDTH.taxiway)
          : Math.max(12, rawW || WIDTH[kind] || 18);

    if (kind === "apron" && coords.length >= 4 && (isClosedRing(coords) || areaHint(coords) > 800)) {
      const ring = isClosedRing(coords) ? coords : [...coords, coords[0]];
      apronPolys.push({ verts: ring, color: COLOR.apron });
      const cx = ring.reduce((s, v) => s + v.x, 0) / ring.length;
      const cz = ring.reduce((s, v) => s + v.z, 0) / ring.length;
      floodPts.push({ x: cx, z: cz });
      continue;
    }

    const pts = densifyPath(
      coords.map((v) => ({
        x: v.x,
        z: v.z,
        y: terrainHeightAt(v.x, v.z, stations) + (kind === "runway" ? 0.16 : 0.12),
      })),
      kind === "runway" ? densifyM : densifyM + 2,
      stations,
    );
    if (pts.length < 2) continue;

    const ribbon = {
      pts,
      halfW: widthM * 0.5,
      color: kind === "runway" ? COLOR.runway : COLOR.taxiway,
      kind,
    };
    if (kind === "runway") runwayRibbons.push(ribbon);
    else taxiRibbons.push(ribbon);

    if (kind === "runway") {
      shoulderRibbons.push({
        pts,
        halfW: widthM * 0.5 + 8.5,
        color: COLOR.runwayShoulder,
        kind: "shoulder",
      });
      grassRibbons.push({
        pts,
        halfW: widthM * 0.5 + 32,
        color: COLOR.grass,
        kind: "grass",
      });
      addRunwayMarks(pts, widthM * 0.5, f, markSegs, lightPts, digitPlanes);
    } else if (kind === "taxiway") {
      if (taxiMarkBudget > 0) {
        addTaxiwayMarks(pts, widthM * 0.5, markSegs);
        taxiMarkBudget -= 1;
      }
      if (pts.length >= 5) {
        grassRibbons.push({
          pts,
          halfW: widthM * 0.5 + 12,
          color: COLOR.grass,
          kind: "grass",
        });
      }
    }
  }

  // Grass under pavement so islands read between taxiways / runways.
  const grassGeo = buildMergedRibbons(grassRibbons, (r) => r.halfW, -0.06);
  if (grassGeo) {
    group.add(
      makeRibbonMesh(grassGeo, "aerowayGrass", AERO_ORDER - 3, {
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3,
        roughness: 0.97,
        metalness: 0,
      }),
    );
  }

  const shoulderGeo = buildMergedRibbons(shoulderRibbons, (r) => r.halfW, -0.03);
  if (shoulderGeo) {
    group.add(
      makeRibbonMesh(shoulderGeo, "aerowayShoulders", AERO_ORDER - 1, {
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        roughness: 0.95,
      }),
    );
  }

  // Separate meshes: dark charcoal runways vs lighter concrete taxiways.
  const taxiGeo = buildMergedRibbons(taxiRibbons, (r) => r.halfW, 0);
  if (taxiGeo) {
    group.add(
      makeRibbonMesh(taxiGeo, "aerowayTaxiways", AERO_ORDER, {
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        roughness: 0.9,
        metalness: 0.04,
      }),
    );
  }
  const runwayGeo = buildMergedRibbons(runwayRibbons, (r) => r.halfW, 0.02);
  if (runwayGeo) {
    group.add(
      makeRibbonMesh(runwayGeo, "aerowayRunways", AERO_ORDER + 1, {
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        roughness: 0.96,
        metalness: 0.02,
      }),
    );
  }

  for (const apron of apronPolys) {
    const mesh = buildApronMesh(apron.verts, stations, apron.color);
    if (mesh) group.add(mesh);
  }

  if (markSegs.length) {
    group.add(buildMarkInstances(markSegs));
  }
  for (const d of digitPlanes) group.add(d);

  let lightsMesh = null;
  if (lightPts.length) {
    lightsMesh = buildRunwayLights(lightPts);
    group.add(lightsMesh);
  }

  if (enableExtras) {
    const fence = buildPerimeterFence(features, stations);
    if (fence) group.add(fence);

    const tower = buildControlTower(stations);
    if (tower) group.add(tower);

    const label = buildAirportLabel(stations);
    if (label) group.add(label);

    const extras = buildAirportExtras(dataset, stations, floodPts);
    if (extras) group.add(extras);
  } else {
    // Low-quality: keep tower + label only (cheap), skip floodlights/jet-bridges/fence.
    const tower = buildControlTower(stations);
    if (tower) group.add(tower);
    const label = buildAirportLabel(stations);
    if (label) group.add(label);
  }

  group.userData.update = (dt) => {
    if (!lightsMesh?.material) return;
    const t = performance.now() * 0.001;
    lightsMesh.material.emissiveIntensity = 0.55 + Math.sin(t * 2.4) * 0.35;
  };

  console.info("[aeroway] CSIA premium pavement", {
    runways: runwayRibbons.length,
    taxiways: taxiRibbons.length,
    aprons: apronPolys.length,
    marks: markSegs.length,
    lights: lightPts.length,
    digits: digitPlanes.length,
  });
  return group;
}

function makeRibbonMesh(geo, name, order, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: opts.roughness ?? 0.94,
    metalness: opts.metalness ?? 0.03,
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: opts.polygonOffsetFactor ?? -2,
    polygonOffsetUnits: opts.polygonOffsetUnits ?? -2,
    ...DRAW,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return mesh;
}

function buildMarkInstances(segs) {
  const unit = new THREE.BoxGeometry(1, 1, 1);
  unit.translate(0, 0.5, 0);
  const dummy = new THREE.Object3D();
  const mat = new THREE.MeshStandardMaterial({
    color: COLOR.mark,
    roughness: 0.62,
    metalness: 0.06,
    emissive: "#1a1e22",
    emissiveIntensity: 0.12,
    polygonOffset: true,
    polygonOffsetFactor: -5,
    polygonOffsetUnits: -5,
    ...DRAW,
  });
  const mesh = new THREE.InstancedMesh(unit, mat, segs.length);
  mesh.name = "aerowayMarks";
  mesh.frustumCulled = false;
  mesh.renderOrder = AERO_ORDER + 2;
  const c = new THREE.Color();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    dummy.position.set(s.x, s.y, s.z);
    dummy.rotation.set(0, s.rot, 0);
    dummy.scale.set(s.w, s.h || 0.045, s.len);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    c.set(s.color || COLOR.mark);
    mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function buildRunwayLights(pts) {
  const geo = new THREE.SphereGeometry(0.35, 6, 6);
  const mat = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    emissive: "#ffe8a0",
    emissiveIntensity: 0.85,
    roughness: 0.4,
    metalness: 0.1,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
  mesh.name = "aerowayLights";
  mesh.frustumCulled = false;
  mesh.renderOrder = AERO_ORDER + 3;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.setScalar(p.scale || 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.pulse = true;
  return mesh;
}

function addRunwayMarks(pts, halfW, feature, out, lights, digitPlanes) {
  const des = feature.designations || parseDesignations(feature.name || feature.ref || "");
  // Edge lines
  for (const side of [-1, 1]) {
    walkSegments(pts, (mid, rot, len) => {
      if (len < 2) return;
      out.push({
        x: mid.x + Math.cos(rot + Math.PI / 2) * (halfW - 0.85) * side,
        y: mid.y + 0.05,
        z: mid.z + Math.sin(rot + Math.PI / 2) * (halfW - 0.85) * side,
        rot,
        w: 0.6,
        len: Math.min(len, 24),
      });
    }, 16);
  }
  // Centerline dashes
  walkSegments(pts, (mid, rot, len) => {
    out.push({
      x: mid.x,
      y: mid.y + 0.055,
      z: mid.z,
      rot,
      w: 0.55,
      len: Math.min(30, len * 0.75),
    });
  }, 45);

  // Edge lights once along the full runway (not per-end — avoids duplicates).
  for (let i = 0; i < pts.length; i += 7) {
    const pt = pts[i];
    const j = Math.min(pts.length - 1, i + 1);
    const rot = Math.atan2(pts[j].z - pt.z, pts[j].x - pt.x);
    const nx = -Math.sin(rot);
    const nz = Math.cos(rot);
    for (const side of [-1, 1]) {
      lights.push({
        x: pt.x + nx * (halfW + 1.2) * side,
        y: pt.y + 0.4,
        z: pt.z + nz * (halfW + 1.2) * side,
        scale: 1,
      });
    }
  }

  // Threshold bars + TDZ + aiming points + designations + PAPI near each end
  for (const end of [0, 1]) {
    const idx = end === 0 ? 0 : pts.length - 1;
    const look = end === 0 ? Math.min(4, pts.length - 1) : Math.max(pts.length - 5, 0);
    const p = pts[idx];
    const q = pts[look];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const rot = Math.atan2(dz, dx);
    const nx = -Math.sin(rot);
    const nz = Math.cos(rot);
    const inward = end === 0 ? 1 : -1;

    // Threshold stripes
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      out.push({
        x: p.x + nx * k * 2.4 + Math.cos(rot) * 22 * inward,
        y: p.y + 0.06,
        z: p.z + nz * k * 2.4 + Math.sin(rot) * 22 * inward,
        rot,
        w: 1.35,
        len: 30,
      });
    }

    // Aiming-point bars (~300 m)
    {
      const dist = 300;
      const cx = p.x + Math.cos(rot) * dist * inward;
      const cz = p.z + Math.sin(rot) * dist * inward;
      for (const side of [-1, 1]) {
        out.push({
          x: cx + nx * side * (halfW * 0.28),
          y: p.y + 0.065,
          z: cz + nz * side * (halfW * 0.28),
          rot,
          w: 3.2,
          len: 45,
        });
      }
    }

    // Touchdown zone bars
    for (let t = 0; t < 5; t++) {
      const dist = 150 + t * 150;
      const cx = p.x + Math.cos(rot) * dist * inward;
      const cz = p.z + Math.sin(rot) * dist * inward;
      const cy = p.y + 0.06;
      for (const side of [-1, 1]) {
        out.push({
          x: cx + nx * side * (halfW * 0.35),
          y: cy,
          z: cz + nz * side * (halfW * 0.35),
          rot,
          w: 1.8,
          len: 22,
        });
      }
    }

    // Holding position (yellow) before threshold
    const hx = p.x + Math.cos(rot) * 95 * inward;
    const hz = p.z + Math.sin(rot) * 95 * inward;
    out.push({
      x: hx,
      y: p.y + 0.07,
      z: hz,
      rot: rot + Math.PI / 2,
      w: halfW * 1.6,
      len: 0.9,
      color: COLOR.hold,
      h: 0.05,
    });
    out.push({
      x: hx + Math.cos(rot) * 4 * inward,
      y: p.y + 0.07,
      z: hz + Math.sin(rot) * 4 * inward,
      rot: rot + Math.PI / 2,
      w: halfW * 1.6,
      len: 0.55,
      color: COLOR.hold,
      h: 0.05,
    });

    // Runway designation digits (09 / 27 / 14 / 32)
    const label = end === 0 ? des.start : des.end;
    if (label) {
      const lx = p.x + Math.cos(rot) * 58 * inward;
      const lz = p.z + Math.sin(rot) * 58 * inward;
      const plane = makeDesignationPlane(label, lx, p.y + 0.08, lz, rot + (end === 1 ? Math.PI : 0));
      if (plane) digitPlanes.push(plane);
    }

    // PAPI — 4 lights left of approach
    for (let i = 0; i < 4; i++) {
      const along = 110 + i * 9;
      lights.push({
        x: p.x + Math.cos(rot) * along * inward + nx * (halfW + 18),
        y: p.y + 0.55,
        z: p.z + Math.sin(rot) * along * inward + nz * (halfW + 18),
        scale: 1.35,
      });
    }
  }
}

function addTaxiwayMarks(pts, _halfW, out) {
  walkSegments(pts, (mid, rot) => {
    out.push({
      x: mid.x,
      y: mid.y + 0.05,
      z: mid.z,
      rot,
      w: 0.35,
      len: 7,
      color: COLOR.hold,
    });
  }, 16);
}

function parseDesignations(ref) {
  const m = String(ref).match(/(\d{2})\s*\/\s*(\d{2})/);
  if (m) return { start: m[1], end: m[2] };
  return { start: "", end: "" };
}

function isClosedRing(verts) {
  if (verts.length < 4) return false;
  const a = verts[0];
  const b = verts[verts.length - 1];
  return Math.hypot(a.x - b.x, a.z - b.z) < 1.5;
}

/** Rough local-space area proxy to detect apron polygons that omit a closing node. */
function areaHint(verts) {
  let a = 0;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    a += verts[j].x * verts[i].z - verts[i].x * verts[j].z;
  }
  return Math.abs(a) * 0.5;
}

function densifyPath(pts, maxStepM, stations = null) {
  if (pts.length < 2) return pts;
  const sampleY = (x, z, fallback) =>
    stations?.length ? terrainHeightAt(x, z, stations) + 0.12 : fallback;
  const out = [
    {
      x: pts[0].x,
      z: pts[0].z,
      y: sampleY(pts[0].x, pts[0].z, pts[0].y),
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
        y: sampleY(x, z, a.y + (b.y - a.y) * t),
      });
    }
  }
  return out;
}

function walkSegments(pts, fn, stepM) {
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.2) continue;
    const rot = Math.atan2(b.z - a.z, b.x - a.x);
    let d = stepM * 0.5 - carry;
    while (d < len) {
      const t = d / len;
      fn(
        {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        },
        rot,
        stepM * 0.55,
      );
      d += stepM;
    }
    carry = (len - (d - stepM)) % stepM;
  }
}

function buildApronMesh(verts, stations, color) {
  if (!verts || verts.length < 4) return null;
  const shape = new THREE.Shape();
  const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length;
  const cz = verts.reduce((s, v) => s + v.z, 0) / verts.length;
  shape.moveTo(verts[0].x - cx, -(verts[0].z - cz));
  for (let i = 1; i < verts.length; i++) {
    shape.lineTo(verts[i].x - cx, -(verts[i].z - cz));
  }
  let geo;
  try {
    geo = new THREE.ShapeGeometry(shape);
  } catch {
    return null;
  }
  geo.rotateX(-Math.PI / 2);
  const y = terrainHeightAt(cx, cz, stations) + 0.09;
  geo.translate(cx, y, cz);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.88,
    metalness: 0.06,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    ...DRAW,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "aerowayApron";
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = AERO_ORDER - 1;
  return mesh;
}

/**
 * Jet bridges at stands, apron floodlight poles, fuel farm tanks (cargo side).
 */
function buildAirportExtras(dataset, stations, floodPts) {
  const root = new THREE.Group();
  root.name = "aerowayExtras";
  const stands = dataset.osm?.stands || [];

  // Passenger boarding bridges — short articulated stubs toward terminal side.
  const bridgeMat = new THREE.MeshStandardMaterial({
    color: "#9aa3ae",
    roughness: 0.45,
    metalness: 0.35,
  });
  const cabinMat = new THREE.MeshStandardMaterial({
    color: "#c5d0dc",
    roughness: 0.3,
    metalness: 0.45,
  });
  let bridges = 0;
  for (const stand of stands) {
    if (stand.type === "ga") continue;
    if (bridges >= 28) break;
    const local = lonLatToLocal(stand.lon, stand.lat, 0);
    if (!Number.isFinite(local.x)) continue;
    const y = terrainHeightAt(local.x, local.z, stations);
    const hdg = THREE.MathUtils.degToRad(90 - (Number(stand.hdg) || 0));
    const g = new THREE.Group();
    g.position.set(local.x, y, local.z);
    g.rotation.y = hdg;
    const tunnel = new THREE.Mesh(new THREE.BoxGeometry(18, 2.2, 2.6), bridgeMat);
    tunnel.position.set(-22, 5.2, 0);
    tunnel.castShadow = true;
    g.add(tunnel);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(4.5, 2.6, 3.2), cabinMat);
    cabin.position.set(-12, 5.0, 0);
    g.add(cabin);
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 5, 6),
      new THREE.MeshStandardMaterial({ color: "#5a6068", roughness: 0.7, metalness: 0.3 }),
    );
    leg.position.set(-22, 2.5, 0);
    g.add(leg);
    root.add(g);
    bridges += 1;
  }

  // Apron floodlight masts
  const poleMat = new THREE.MeshStandardMaterial({ color: "#6a7078", roughness: 0.65, metalness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({
    color: "#fff4d0",
    emissive: "#ffe8a0",
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });
  for (let i = 0; i < Math.min(floodPts.length, 14); i++) {
    const p = floodPts[i];
    const y = terrainHeightAt(p.x, p.z, stations);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 22, 6), poleMat);
    mast.position.set(p.x, y + 11, p.z);
    mast.castShadow = true;
    root.add(mast);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.6, 1.2), lampMat);
    lamp.position.set(p.x, y + 22.2, p.z);
    root.add(lamp);
  }

  // Fuel farm (cargo / west apron — verified CSIA fuel farm vicinity)
  const fuelLocal = lonLatToLocal(72.8588, 19.0912, 0);
  if (Number.isFinite(fuelLocal.x)) {
    const fy = terrainHeightAt(fuelLocal.x, fuelLocal.z, stations);
    const tankMat = new THREE.MeshStandardMaterial({
      color: "#c8c0a8",
      roughness: 0.5,
      metalness: 0.45,
    });
    for (let i = 0; i < 5; i++) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 9, 12), tankMat);
      tank.position.set(fuelLocal.x + (i % 3) * 18, fy + 4.5, fuelLocal.z + Math.floor(i / 3) * 18);
      tank.castShadow = true;
      root.add(tank);
    }
  }

  return root;
}

function buildMergedRibbons(ribbons, halfFn, yBias = 0) {
  const positions = [];
  const colors = [];
  const indices = [];
  const c = new THREE.Color();

  for (const r of ribbons) {
    const pts = r.pts;
    if (!pts || pts.length < 2) continue;
    const halfW = halfFn(r);
    c.set(r.color || "#4a5058");
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
      let nx = -tz;
      let nz = tx;

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
          const miterClamp = Math.min(Math.abs(miter), 1.65) * Math.sign(miter || 1);
          nx = mx;
          nz = mz;
          left.push({
            x: p.x + nx * halfW * miterClamp,
            z: p.z + nz * halfW * miterClamp,
            y: p.y + yBias,
          });
          right.push({
            x: p.x - nx * halfW * miterClamp,
            z: p.z - nz * halfW * miterClamp,
            y: p.y + yBias,
          });
          continue;
        }
      }

      left.push({ x: p.x + nx * halfW, z: p.z + nz * halfW, y: p.y + yBias });
      right.push({ x: p.x - nx * halfW, z: p.z - nz * halfW, y: p.y + yBias });
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

/** Flat canvas digit plate for runway designations (WGS84-aligned). */
function makeDesignationPlane(text, x, y, z, rotY) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 256, 128);
  ctx.fillStyle = "#f4f7fa";
  ctx.font = "bold 96px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(text), 128, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(18, 9), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = -rotY;
  mesh.position.set(x, y, z);
  mesh.name = `rwyDesig-${text}`;
  mesh.renderOrder = AERO_ORDER + 4;
  return mesh;
}

function buildPerimeterFence(features, stations) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const f of features) {
    for (const v of f.vertices || []) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.z)) continue;
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.z);
      maxZ = Math.max(maxZ, v.z);
    }
  }
  if (!Number.isFinite(minX) || maxX - minX < 200) return null;
  const pad = 40;
  minX -= pad;
  maxX += pad;
  minZ -= pad;
  maxZ += pad;
  const corners = [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
    { x: minX, z: minZ },
  ];
  const positions = [];
  const indices = [];
  const h = 2.4;
  let vi = 0;
  for (let i = 0; i < corners.length - 1; i++) {
    const a = corners[i];
    const b = corners[i + 1];
    const y0 = terrainHeightAt(a.x, a.z, stations);
    const y1 = terrainHeightAt(b.x, b.z, stations);
    positions.push(a.x, y0, a.z, a.x, y0 + h, a.z, b.x, y1 + h, b.z, b.x, y1, b.z);
    indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: COLOR.fence,
      roughness: 0.75,
      metalness: 0.35,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = "aerowayFence";
  mesh.castShadow = true;
  mesh.renderOrder = AERO_ORDER + 1;
  return mesh;
}

function buildControlTower(stations) {
  const local = lonLatToLocal(CSIA_TOWER.lon, CSIA_TOWER.lat, 0);
  if (!Number.isFinite(local?.x)) return null;
  const y = terrainHeightAt(local.x, local.z, stations);
  const root = new THREE.Group();
  root.name = "csiaControlTower";
  root.position.set(local.x, y, local.z);

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 4.2, 42, 10),
    new THREE.MeshStandardMaterial({ color: "#c8ced6", roughness: 0.55, metalness: 0.18 }),
  );
  shaft.position.y = 21;
  shaft.castShadow = true;
  root.add(shaft);

  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(6.5, 5.2, 7, 12),
    new THREE.MeshStandardMaterial({
      color: "#9eb4c8",
      roughness: 0.22,
      metalness: 0.55,
      transparent: true,
      opacity: 0.92,
    }),
  );
  cab.position.y = 45;
  cab.castShadow = true;
  root.add(cab);

  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(5.5, 6.5, 1.4, 12),
    new THREE.MeshStandardMaterial({ color: "#5a6068", roughness: 0.7, metalness: 0.25 }),
  );
  roof.position.y = 49.2;
  root.add(roof);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 8, 8),
    new THREE.MeshStandardMaterial({
      color: "#ffffff",
      emissive: "#ff6060",
      emissiveIntensity: 1.2,
    }),
  );
  beacon.position.y = 51;
  root.add(beacon);
  return root;
}

function buildAirportLabel(stations) {
  const local = lonLatToLocal(CSIA_LABEL.lon, CSIA_LABEL.lat, 0);
  if (!Number.isFinite(local?.x)) return null;
  const y = terrainHeightAt(local.x, local.z, stations) + 8;
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1024, 160);
  ctx.fillStyle = "rgba(12,16,22,0.72)";
  ctx.fillRect(24, 28, 976, 104);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 28, 976, 104);
  ctx.fillStyle = "#f4f7fa";
  ctx.font = "bold 42px Segoe UI, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CHHATRAPATI SHIVAJI MAHARAJ INTERNATIONAL AIRPORT (BOM)", 512, 80);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(local.x, y + 55, local.z);
  sprite.scale.set(420, 66, 1);
  sprite.name = "csiaAirportLabel";
  sprite.renderOrder = 40;
  return sprite;
}
