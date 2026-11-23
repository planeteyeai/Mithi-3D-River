import * as THREE from "three";

/**
 * Rotate imported GLB models (Z-up / X-up) so the trunk aligns with Three.js Y-up.
 * Skip when the model already has most of its extent on Y, or when it is a wide
 * but upright canopy (width > height) — tipping those lays trees on the ground.
 */
export function standTreeUpright(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);

  // Already Y-up (tall or wide canopy sitting on Y).
  if (size.y >= size.x * 0.55 && size.y >= size.z * 0.55) return;
  // Base near y=0 and crown above → designed/upright even if wide.
  if (box.min.y > -0.35 && box.max.y > Math.max(size.x, size.z) * 0.35) return;

  if (size.z >= size.x && size.z >= size.y) {
    root.rotation.x = -Math.PI / 2;
  } else {
    root.rotation.z = Math.PI / 2;
  }
  root.updateMatrixWorld(true);
}

export function treeTargetHeight(assetId, placementScale = 1) {
  const s = Math.max(0.6, Number(placementScale) || 1);
  if (assetId === "grass") return 2.0 * s;
  if (assetId === "coastal_shrub") return Math.max(1.6, Math.min(3.4, s * 2.4));
  if (assetId === "canopy_clump") return Math.max(9, Math.min(20, s * 13));
  if (assetId === "palm" || assetId === "coconut") return Math.max(9, Math.min(18, s * 12));
  if (assetId === "avicennia") return Math.max(5, Math.min(10, s * 7.5));
  if (assetId === "rhizophora") return Math.max(6, Math.min(11, s * 8.2));
  if (assetId === "neem") return Math.max(8, Math.min(14, s * 10.5));
  if (assetId === "banyan") return Math.max(10, Math.min(18, s * 13));
  if (assetId === "conifer") return Math.max(10, Math.min(20, s * 13));
  if (assetId === "birch") return Math.max(8, Math.min(15, s * 10));
  return Math.max(9, Math.min(18, s * 11.5));
}
