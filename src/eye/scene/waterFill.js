import * as THREE from "three";
import { SURFACE_Y } from "./river.js";

/** Keep volume top well below the waving sheet — prevents z-fight “shake”. */
const TOP_Y = SURFACE_Y - 1.15;
/** Bed floor of the water column — matches deepened DTM carve. */
const DTM_FLOOR_Y = SURFACE_Y - 8.2;

/**
 * Water column under the surface sheet so low-angle views see a filled channel
 * (not empty air above the carved DTM).
 *
 * Prefers live permanent-water surface geometry when provided; otherwise corridor.
 */
export function createWaterFill(_terrainMesh, river, _dataset, _landCover, _osmWater, liveSurface = null) {
  const surfGeo = liveSurface?.geometry || river?.mesh?.geometry;
  const bedGeo = liveSurface ? null : river?.bed?.geometry;
  const sAttr = surfGeo?.attributes?.position;
  const index = surfGeo?.index;
  if (!sAttr || !index) return null;

  const sPos = sAttr.array;
  const bPos = bedGeo?.attributes?.position?.array;
  const idx = index.array;
  const n = sAttr.count;
  if (n < 3 || idx.length < 3) return null;

  const pos = new Float32Array(n * 6);
  const col = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = sPos[i * 3];
    const z = sPos[i * 3 + 2];
    let bed = bPos && bPos.length >= (i + 1) * 3 ? bPos[i * 3 + 1] : DTM_FLOOR_Y;
    if (!Number.isFinite(bed)) bed = DTM_FLOOR_Y;
    const bot = Math.min(bed - 0.2, DTM_FLOOR_Y);
    pos[i * 3] = x;
    pos[i * 3 + 1] = TOP_Y;
    pos[i * 3 + 2] = z;
    pos[(n + i) * 3] = x;
    pos[(n + i) * 3 + 1] = bot;
    pos[(n + i) * 3 + 2] = z;
    // Cerulean surface → navy deep volume.
    col[i * 3] = 0.31;
    col[i * 3 + 1] = 0.78;
    col[i * 3 + 2] = 0.92;
    col[(n + i) * 3] = 0.04;
    col[(n + i) * 3 + 1] = 0.18;
    col[(n + i) * 3 + 2] = 0.42;
  }

  const tris = [];
  // Bottom + bank walls — top sheet is the live/corridor water surface.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    tris.push(a + n, c + n, b + n);
  }

  const edgeCount = new Map();
  const addEdge = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = edgeCount.get(key) || { a, b, count: 0 };
    e.count++;
    edgeCount.set(key, e);
  };
  for (let t = 0; t < idx.length; t += 3) {
    addEdge(idx[t], idx[t + 1]);
    addEdge(idx[t + 1], idx[t + 2]);
    addEdge(idx[t + 2], idx[t]);
  }
  for (const { a, b, count } of edgeCount.values()) {
    if (count !== 1) continue;
    tris.push(a, b, b + n, a, b + n, a + n);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(tris);
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "riverWaterVolume";
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  console.info("[water-fill] column under water surface", {
    verts: n,
    tris: tris.length / 3,
    live: !!liveSurface,
  });
  return mesh;
}
