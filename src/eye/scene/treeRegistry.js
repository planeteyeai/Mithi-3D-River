import { loadGltf, prefetchGlbUrls } from "../utils/gltfLoader.js";
import * as THREE from "three";
import { mergeMeshesForInstancing } from "../urban/geometryMerge.js";
import { standTreeUpright } from "./treeOrient.js";

/** Bust prototype cache after visual / perf upgrades. */
const CACHE_VERSION = 15;
const cache = new Map();

/**
 * Light designed silhouettes only — meshopt GLBs are 40k–200k verts each and
 * destroy frame time when instanced thousands of times.
 * Species IDs map to GLB filenames when USE_GLB_MESHES is enabled.
 */
const USE_GLB_MESHES = false;

function treeAssetUrl(file) {
  const base = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
  const root = String(base).endsWith("/") ? base : `${base}/`;
  return `${root}assets/trees/${file}`;
}

export const TREE_MANIFEST = [
  { id: "palm", url: treeAssetUrl("palm.glb"), nativeW: 6, nativeD: 6, nativeH: 10, tags: ["palm", "coconut"] },
  { id: "coconut", url: treeAssetUrl("palm.glb"), nativeW: 5.5, nativeD: 5.5, nativeH: 12, tags: ["coconut", "palm"] },
  { id: "broadleaf", url: treeAssetUrl("broadleaf.glb"), nativeW: 8, nativeD: 8, nativeH: 9.5, tags: ["broadleaf", "neem"] },
  { id: "neem", url: treeAssetUrl("broadleaf.glb"), nativeW: 7, nativeD: 7, nativeH: 10, tags: ["neem"] },
  { id: "banyan", url: treeAssetUrl("broadleaf.glb"), nativeW: 14, nativeD: 14, nativeH: 12, tags: ["banyan", "ficus"] },
  { id: "avicennia", url: treeAssetUrl("broadleaf.glb"), nativeW: 6, nativeD: 6, nativeH: 7, tags: ["mangrove", "avicennia"] },
  { id: "rhizophora", url: treeAssetUrl("broadleaf.glb"), nativeW: 7, nativeD: 7, nativeH: 8, tags: ["mangrove", "rhizophora"] },
  { id: "conifer", url: treeAssetUrl("conifer.glb"), nativeW: 10, nativeD: 10, nativeH: 11, tags: ["conifer"] },
  { id: "birch", url: treeAssetUrl("birch.glb"), nativeW: 4.5, nativeD: 4.5, nativeH: 8.5, tags: ["birch"] },
  { id: "grass", url: treeAssetUrl("grass.glb"), nativeW: 2, nativeD: 2, nativeH: 1.6, tags: ["grass"] },
  { id: "coastal_shrub", url: treeAssetUrl("grass.glb"), nativeW: 3.2, nativeD: 3.2, nativeH: 2.4, tags: ["shrub", "coastal"] },
  /** Dense rounded canopy mound — riverside greenery patches (stylized puffy clumps). */
  { id: "canopy_clump", url: treeAssetUrl("broadleaf.glb"), nativeW: 9, nativeD: 9, nativeH: 5.5, tags: ["canopy", "clump", "forest"] },
];

/** Fresh canopy greens — readable at city scale (not near-black mangroves). */
const FOLIAGE_HEX = {
  grass: "#7db85a",
  coastal_shrub: "#6fb04e",
  canopy_clump: "#5cb044",
  conifer: "#4f9a48",
  palm: "#62b04a",
  coconut: "#5eac48",
  birch: "#7ec85a",
  broadleaf: "#5eb048",
  neem: "#5cb044",
  banyan: "#52a440",
  avicennia: "#4aa048",
  rhizophora: "#46a04a",
};

const FOLIAGE_DARK = {
  grass: "#5a9440",
  coastal_shrub: "#4f8c3a",
  canopy_clump: "#3f8a32",
  conifer: "#3a7a36",
  palm: "#458a38",
  coconut: "#428636",
  birch: "#5aa044",
  broadleaf: "#428838",
  neem: "#408636",
  banyan: "#3a7c32",
  avicennia: "#368038",
  rhizophora: "#327c36",
};

const TRUNK_HEX = {
  palm: "#7a5a3c",
  coconut: "#6e5236",
  broadleaf: "#4a3426",
  neem: "#4c3728",
  banyan: "#3a2a1e",
  avicennia: "#3d3328",
  rhizophora: "#3a3024",
  conifer: "#3d2e22",
  birch: "#d4ccc0",
  grass: "#4a5a32",
  coastal_shrub: "#4a5530",
};

export function foliageHex(id) {
  return FOLIAGE_HEX[id] || FOLIAGE_HEX.broadleaf;
}

export function prefetchTreeAssets() {
  prefetchGlbUrls(TREE_MANIFEST.map((t) => t.url));
}

export function classifyTreeAsset(props = {}, kind = "osm", rng = () => 0.5) {
  const text = [
    props.genus,
    props.species,
    props.natural,
    props.landuse,
    props.leisure,
    props.leaf_type,
    props.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Shrubs / understorey
  if (/grass|shrub|bush|hedge|scrub|bamboo|reed|coastal/.test(text) || kind === "shrub") {
    return rng() < 0.65 ? "coastal_shrub" : "grass";
  }

  // Named Mithi coastal mangrove species
  if (/avicennia/.test(text)) return "avicennia";
  if (/rhizophora/.test(text)) return "rhizophora";
  if (/mangrove|wetland|sonneratia|bruguiera|nypa/.test(text) || kind === "mangrove") {
    return rng() < 0.55 ? "avicennia" : "rhizophora";
  }

  // Goa / Mithi corridor species → silhouette mapping
  if (/cocos|coconut/.test(text)) return "coconut";
  if (/palm|areca|royal|borassus|palmyra|livistona/.test(text)) return "coconut";
  if (/neem|azadirachta/.test(text)) return "neem";
  if (/banyan|ficus|peepal/.test(text)) return "banyan";
  if (/mango|mangifera|cashew|anacardium|jackfruit|artocarpus|terminalia|teak|tectona|jamun|syzygium|guava|psidium/.test(text)) {
    return rng() < 0.45 ? "neem" : "broadleaf";
  }
  if (/pinus|cedrus|conifer|spruce|fir|juniper|casuarina|she-oak|sheoak/.test(text)) return "conifer";
  if (/betula|birch|eucalyptus|acacia|albizia/.test(text)) return "birch";
  if (/orchard|plantation/.test(text)) return rng() < 0.55 ? "coconut" : "neem";
  if (/wetland|marsh/.test(text)) return rng() < 0.35 ? "coastal_shrub" : "avicennia";

  // Mandovi / Mithi bank mix: mangroves + coconut + neem / banyan
  if (kind === "riparian" || kind === "bank") {
    const r = rng();
    if (r < 0.28) return "avicennia";
    if (r < 0.48) return "rhizophora";
    if (r < 0.68) return "coconut";
    if (r < 0.82) return "neem";
    if (r < 0.92) return "banyan";
    return "coastal_shrub";
  }
  if (kind === "forest") {
    const r = rng();
    if (r < 0.2) return "coconut";
    if (r < 0.45) return "neem";
    if (r < 0.62) return "banyan";
    if (r < 0.78) return "avicennia";
    if (r < 0.9) return "broadleaf";
    return "coastal_shrub";
  }
  if (kind === "park") {
    const r = rng();
    if (r < 0.28) return "coconut";
    if (r < 0.55) return "neem";
    if (r < 0.72) return "banyan";
    if (r < 0.88) return "coastal_shrub";
    return "broadleaf";
  }

  const roll = rng();
  if (roll < 0.18) return "coconut";
  if (roll < 0.36) return "neem";
  if (roll < 0.5) return "banyan";
  if (roll < 0.64) return "avicennia";
  if (roll < 0.76) return "rhizophora";
  if (roll < 0.88) return "coastal_shrub";
  return "broadleaf";
}

/**
 * Trunk / canopy color with soft foliage variation (radial + vertical).
 */
function paintFoliageColors(geometry, id) {
  const pos = geometry.getAttribute("position");
  if (!pos) return;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const minY = box.min.y;
  const spanY = Math.max(0.001, box.max.y - minY);
  const cx = (box.min.x + box.max.x) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  const maxR = Math.max(0.001, Math.hypot(box.max.x - cx, box.max.z - cz));

  const trunkRatio =
    id === "grass" || id === "coastal_shrub" || id === "canopy_clump"
      ? 0.06
      : id === "palm" || id === "coconut"
        ? 0.48
        : id === "rhizophora"
          ? 0.22
          : id === "conifer"
            ? 0.18
            : 0.3;

  const trunk = new THREE.Color(TRUNK_HEX[id] || TRUNK_HEX.broadleaf);
  const leafA = new THREE.Color(FOLIAGE_HEX[id] || FOLIAGE_HEX.broadleaf);
  const leafB = new THREE.Color(FOLIAGE_DARK[id] || FOLIAGE_DARK.broadleaf);
  const lime = new THREE.Color(id === "canopy_clump" ? "#9ec84a" : "#9ccc5a");
  const c = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = (y - minY) / spanY;
    const r = Math.hypot(x - cx, z - cz) / maxR;
    const trunkMix = THREE.MathUtils.smoothstep(t, trunkRatio, trunkRatio + 0.14);
    // Hash-like variation from position
    const n = Math.abs(Math.sin(x * 12.9898 + z * 78.233 + y * 37.719) * 43758.5453) % 1;
    // Prefer bright leafA — avoid near-black canopies at city scale.
    c.copy(leafA).lerp(leafB, 0.12 + r * 0.22 + n * 0.12);
    c.lerp(trunk, 1 - trunkMix);
    // Soft sun-hit on upper canopy for all species.
    if (t > 0.45) c.lerp(lime, 0.22 * (t - 0.45) + n * 0.04);
    if (t > 0.7) c.offsetHSL(0.03, 0.08, 0.07 * (t - 0.7));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
}

export function makeGlbTreeMaterial(id) {
  return new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: 0.78,
    metalness: 0,
    vertexColors: true,
    emissive: new THREE.Color(FOLIAGE_HEX[id] || "#4a9a40"),
    emissiveIntensity: 0.14,
    flatShading: false,
    side: THREE.FrontSide,
  });
}

/**
 * High-quality stylized trees (birch/grass + GLB fallback).
 * Organic canopy clusters, tapered trunks — not lollipops / star fans.
 */
function buildDesignedTree(id) {
  const root = new THREE.Group();
  const trunkCol = TRUNK_HEX[id] || TRUNK_HEX.broadleaf;
  const leafCol = FOLIAGE_HEX[id] || FOLIAGE_HEX.broadleaf;
  const leafDark = FOLIAGE_DARK[id] || FOLIAGE_DARK.broadleaf;

  const trunkMat = new THREE.MeshStandardMaterial({
    color: trunkCol,
    roughness: 0.95,
    metalness: 0,
  });
  const leafMat = new THREE.MeshStandardMaterial({
    color: leafCol,
    roughness: 0.86,
    metalness: 0,
    flatShading: id === "conifer",
  });
  const leafMat2 = new THREE.MeshStandardMaterial({
    color: leafDark,
    roughness: 0.9,
    metalness: 0,
  });

  if (id === "palm" || id === "coconut") {
    // Soft tapered trunk (lathe) + arched frond clusters (coconut palms taller)
    const tall = id === "coconut" ? 1.18 : 1;
    const trunkProfile = [
      new THREE.Vector2(0.28, 0),
      new THREE.Vector2(0.24, 1.5 * tall),
      new THREE.Vector2(0.2, 3.5 * tall),
      new THREE.Vector2(0.16, 5.5 * tall),
      new THREE.Vector2(0.18, 6.8 * tall),
    ];
    const trunk = new THREE.Mesh(new THREE.LatheGeometry(trunkProfile, 10), trunkMat);
    root.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), trunkMat);
    crown.position.y = 6.9 * tall;
    root.add(crown);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const frond = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), i % 2 ? leafMat : leafMat2);
      frond.position.set(Math.cos(a) * 1.6, (6.2 + Math.sin(i) * 0.25) * tall, Math.sin(a) * 1.6);
      frond.scale.set(1.6, 0.28, 0.55);
      frond.lookAt(0, 5.2 * tall, 0);
      root.add(frond);
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.7, 7, 5), leafMat);
      tip.position.set(Math.cos(a) * 0.6, 7.15 * tall, Math.sin(a) * 0.6);
      tip.scale.set(1.1, 0.55, 1.0);
      root.add(tip);
    }
  } else if (id === "avicennia") {
    // Dense coastal mangrove — multi-stem + compact dark canopy
    for (let s = 0; s < 3; s++) {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 3.4, 6), trunkMat);
      stem.position.set((s - 1) * 0.35, 1.7, (s % 2) * 0.2 - 0.1);
      stem.rotation.z = (s - 1) * 0.12;
      root.add(stem);
    }
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 4.4, 0, 1.7, 1.35, 1.55],
      [0.9, 4.1, 0.45, 1.15, 0.95, 1.05],
      [-0.85, 4.2, -0.4, 1.1, 0.9, 1.0],
      [0.25, 5.1, -0.2, 1.05, 0.85, 0.95],
      [-0.35, 3.85, 0.7, 0.95, 0.8, 0.9],
    ]);
  } else if (id === "rhizophora") {
    // Prop-root mangrove — arched stilts + elevated crown
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 3.6, 7), trunkMat);
    trunk.position.y = 3.0;
    root.add(trunk);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rootLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.1, 2.6, 5), trunkMat);
      rootLeg.position.set(Math.cos(a) * 0.95, 1.2, Math.sin(a) * 0.95);
      rootLeg.rotation.z = Math.cos(a) * 0.55;
      rootLeg.rotation.x = Math.sin(a) * 0.55;
      root.add(rootLeg);
    }
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 5.4, 0, 1.8, 1.4, 1.65],
      [1.0, 5.1, 0.5, 1.15, 0.95, 1.05],
      [-0.95, 5.2, -0.45, 1.1, 0.9, 1.0],
      [0.35, 6.0, -0.35, 1.0, 0.85, 0.95],
      [-0.4, 4.85, 0.7, 0.95, 0.8, 0.9],
    ]);
  } else if (id === "neem") {
    // Medium tropical tree — upright trunk, open irregular crown
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, 4.4, 8), trunkMat);
    trunk.position.y = 2.2;
    root.add(trunk);
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 5.5, 0, 1.75, 1.45, 1.65],
      [1.1, 5.2, 0.55, 1.15, 0.95, 1.05],
      [-1.05, 5.3, -0.5, 1.1, 0.9, 1.0],
      [0.4, 6.2, -0.45, 1.0, 0.85, 0.95],
      [-0.45, 4.95, 0.75, 0.95, 0.8, 0.9],
      [0.15, 5.85, 0.55, 0.9, 0.75, 0.85],
    ]);
  } else if (id === "banyan") {
    // Wide irregular canopy + hanging aerial-root hints
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.75, 4.2, 10), trunkMat);
    trunk.position.y = 2.1;
    root.add(trunk);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.2;
      const aerial = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.07, 2.4, 4), trunkMat);
      aerial.position.set(Math.cos(a) * 1.8, 3.4, Math.sin(a) * 1.8);
      root.add(aerial);
    }
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 5.6, 0, 2.6, 1.7, 2.45],
      [1.9, 5.2, 0.9, 1.55, 1.2, 1.45],
      [-1.85, 5.3, -0.8, 1.5, 1.15, 1.4],
      [0.7, 5.25, -1.85, 1.45, 1.1, 1.35],
      [-0.85, 5.1, 1.75, 1.4, 1.05, 1.3],
      [0.25, 6.7, 0.2, 1.6, 1.25, 1.5],
      [1.3, 6.15, -1.0, 1.2, 0.95, 1.1],
      [-1.25, 6.2, 0.85, 1.25, 1.0, 1.15],
    ]);
  } else if (id === "conifer") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.45, 2.8, 8), trunkMat);
    trunk.position.y = 1.4;
    root.add(trunk);
    const layers = [2.6, 2.15, 1.75, 1.35, 0.95, 0.55];
    let y = 2.6;
    for (let i = 0; i < layers.length; i++) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(layers[i], 1.65 - i * 0.08, 9),
        i % 2 ? leafMat : leafMat2,
      );
      cone.position.y = y;
      cone.rotation.y = i * 0.35;
      root.add(cone);
      y += 1.05;
    }
  } else if (id === "birch") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.26, 5.2, 8), trunkMat);
    trunk.position.y = 2.6;
    root.add(trunk);
    for (const side of [-1, 1]) {
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 1.6, 5), trunkMat);
      br.position.set(side * 0.5, 4.4, 0.1 * side);
      br.rotation.z = side * 0.7;
      root.add(br);
    }
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 6.0, 0, 1.55, 1.35, 1.45],
      [0.85, 5.7, 0.45, 1.05, 0.9, 1.0],
      [-0.8, 5.85, -0.4, 1.0, 0.88, 0.95],
      [0.35, 6.7, -0.35, 0.9, 0.75, 0.85],
      [-0.4, 5.35, 0.55, 0.85, 0.7, 0.8],
      [0.15, 6.35, 0.5, 0.8, 0.7, 0.75],
    ]);
  } else if (id === "canopy_clump") {
    // Popcorn canopy tree: short trunk + stacked rounded crowns (reference look).
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.38, 2.4, 7), trunkMat);
    trunk.position.y = 1.2;
    root.add(trunk);
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 4.0, 0, 2.6, 2.15, 2.45],
      [1.55, 3.7, 0.65, 1.7, 1.45, 1.6],
      [-1.5, 3.8, -0.55, 1.65, 1.4, 1.55],
      [0.55, 3.65, -1.55, 1.6, 1.35, 1.5],
      [-0.7, 3.55, 1.5, 1.55, 1.3, 1.45],
      [1.15, 4.85, -0.85, 1.4, 1.2, 1.3],
      [-1.1, 4.9, 0.8, 1.45, 1.25, 1.35],
      [0.15, 5.45, 0.1, 1.85, 1.55, 1.75],
      [0.9, 4.55, 1.2, 1.25, 1.1, 1.2],
      [-0.95, 4.5, -1.1, 1.3, 1.15, 1.25],
      [0.05, 3.15, 0.05, 2.1, 1.15, 2.0],
    ]);
  } else if (id === "grass" || id === "coastal_shrub") {
    const shrub = id === "coastal_shrub";
    const blades = shrub ? 10 : 8;
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2;
      const h = shrub ? 1.35 + (i % 3) * 0.25 : 1.15 + (i % 3) * 0.2;
      const blade = new THREE.Mesh(new THREE.ConeGeometry(shrub ? 0.14 : 0.1, h, 4), leafMat);
      blade.position.set(Math.cos(a) * (shrub ? 0.45 : 0.32), shrub ? 0.7 : 0.55, Math.sin(a) * (shrub ? 0.45 : 0.32));
      blade.rotation.z = Math.cos(a) * 0.4;
      blade.rotation.x = Math.sin(a) * 0.4;
      root.add(blade);
    }
    addCanopyCluster(
      root,
      leafMat,
      leafMat2,
      shrub
        ? [
            [0.45, 0.95, 0.25, 0.75, 0.55, 0.7],
            [-0.4, 1.05, -0.3, 0.7, 0.5, 0.65],
            [0.15, 0.85, -0.45, 0.65, 0.48, 0.6],
            [-0.2, 1.15, 0.4, 0.6, 0.45, 0.55],
            [0.05, 1.35, 0.05, 0.7, 0.5, 0.65],
          ]
        : [
            [0.35, 0.65, 0.2, 0.55, 0.4, 0.5],
            [-0.3, 0.7, -0.25, 0.5, 0.38, 0.48],
            [0.1, 0.55, -0.35, 0.48, 0.35, 0.45],
            [-0.15, 0.8, 0.3, 0.45, 0.35, 0.42],
          ],
    );
  } else {
    // broadleaf — dense irregular crown
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.55, 3.8, 9), trunkMat);
    trunk.position.y = 1.9;
    root.add(trunk);
    addCanopyCluster(root, leafMat, leafMat2, [
      [0, 5.2, 0, 2.0, 1.7, 1.9],
      [1.35, 4.9, 0.7, 1.35, 1.15, 1.25],
      [-1.25, 5.0, -0.55, 1.3, 1.1, 1.2],
      [0.55, 5.05, -1.3, 1.25, 1.05, 1.2],
      [-0.7, 4.85, 1.2, 1.2, 1.0, 1.15],
      [0.2, 6.35, 0.15, 1.35, 1.15, 1.25],
      [0.95, 5.9, -0.75, 1.05, 0.9, 1.0],
      [-0.9, 6.0, 0.6, 1.1, 0.95, 1.05],
    ]);
  }

  return root;
}

function addCanopyCluster(root, matA, matB, specs) {
  for (let i = 0; i < specs.length; i++) {
    const [x, y, z, sx, sy, sz] = specs[i];
    // Low-poly spheres (cheaper than icosahedron when instanced × thousands)
    const blob = new THREE.Mesh(
      new THREE.SphereGeometry(1, 7, 5),
      i % 2 ? matA : matB,
    );
    blob.position.set(x, y, z);
    blob.scale.set(sx, sy, sz);
    root.add(blob);
  }
}

function createProceduralPrototype(id) {
  const root = buildDesignedTree(id);
  // Designed trees are already Y-up. standTreeUpright() tips wide canopies
  // (banyan / canopy_clump) onto their side because width > height.
  root.updateMatrixWorld(true);
  const merged = mergeMeshesForInstancing(root);
  paintFoliageColors(merged.geometry, id);
  // Seat geometry so instance Y=0 is the trunk base (no floating / tip-over).
  const geo = merged.geometry;
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (box) {
    geo.translate(0, -box.min.y, 0);
    geo.computeBoundingBox();
    merged.nativeH = Math.max(0.5, geo.boundingBox.max.y - geo.boundingBox.min.y);
  }
  return {
    id,
    geometry: geo,
    material: makeGlbTreeMaterial(id),
    nativeW: merged.nativeW,
    nativeD: merged.nativeD,
    nativeH: merged.nativeH,
    source: "designed",
  };
}

function looksCollapsed(bw, bh, bd) {
  return Math.abs(bw - 2) < 0.25 && Math.abs(bh - 2) < 0.25 && Math.abs(bd - 2) < 0.25;
}

function prototypeFromGlb(id, merged, entry) {
  paintFoliageColors(merged.geometry, id);
  return {
    id,
    geometry: merged.geometry,
    material: makeGlbTreeMaterial(id),
    nativeW: merged.nativeW || entry.nativeW,
    nativeD: merged.nativeD || entry.nativeD,
    nativeH: merged.nativeH || entry.nativeH,
    source: "glb",
  };
}

export async function loadTreePrototype(id) {
  const key = `${CACHE_VERSION}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const entry = TREE_MANIFEST.find((t) => t.id === id);
  if (!entry) throw new Error(`Unknown tree asset: ${id}`);

  const promise = (async () => {
    // Procedural silhouettes for all Mithi species (GLB optional later).
    if (
      !USE_GLB_MESHES ||
      id === "birch" ||
      id === "grass" ||
      id === "coastal_shrub" ||
      id === "canopy_clump" ||
      id === "avicennia" ||
      id === "rhizophora" ||
      id === "neem" ||
      id === "banyan" ||
      id === "coconut"
    ) {
      return createProceduralPrototype(id);
    }

    try {
      const gltf = await loadGltf(entry.url);
      standTreeUpright(gltf.scene);
      let vertCount = 0;
      gltf.scene.traverse((o) => {
        if (o.isMesh) vertCount += o.geometry?.attributes?.position?.count || 0;
      });
      const merged = mergeMeshesForInstancing(gltf.scene);
      const bb = merged.geometry.boundingBox;
      const bw = bb ? bb.max.x - bb.min.x : merged.nativeW;
      const bh = bb ? bb.max.y - bb.min.y : merged.nativeH;
      const bd = bb ? bb.max.z - bb.min.z : merged.nativeD;

      if (looksCollapsed(bw, bh, bd) || vertCount < 500 || bh < 3) {
        console.warn(`[trees] ${id} GLB rejected — designed fallback`, { bw, bh, bd, vertCount });
        return createProceduralPrototype(id);
      }

      console.info(`[trees] GLB ${id}`, {
        verts: vertCount,
        size: [bw, bh, bd].map((n) => Math.round(n * 10) / 10),
      });
      return prototypeFromGlb(id, merged, entry);
    } catch (err) {
      console.warn("[trees] GLB failed", id, err?.message || err);
      return createProceduralPrototype(id);
    }
  })();

  cache.set(key, promise);
  return promise;
}

export function clearTreePrototypeCache() {
  cache.clear();
}

export async function preloadTreeAssets(ids) {
  const out = new Map();
  const unique = [...new Set(ids.length ? ids : TREE_MANIFEST.map((t) => t.id))];
  await Promise.all(
    unique.map(async (id) => {
      const proto = await loadTreePrototype(id);
      if (proto) out.set(id, proto);
    }),
  );
  return out;
}

if (import.meta.hot) {
  import.meta.hot.accept(() => cache.clear());
  import.meta.hot.dispose(() => cache.clear());
}
