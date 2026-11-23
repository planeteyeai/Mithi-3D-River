import * as THREE from "three";

/**
 * Authentic Goan & Portuguese coastal architectural palette for Mithi River.
 * Based on traditional Fontainhas, Panaji, Ribandar, and Old Goa heritage houses.
 */
/** Mumbai suburban plaster / concrete — used for Mithi corridor (not Goan heritage). */
export const MUMBAI_URBAN_PALETTE = [
  "#c8c2b6",
  "#b8b0a4",
  "#d0cbc0",
  "#a8a296",
  "#9a958c",
  "#d8d2c6",
  "#8e8a82",
  "#b0a89c",
  "#c4b8a8",
  "#7a8690",
  "#6e7a84",
  "#e0dcd4",
  "#948c80",
  "#acb0b4",
];

/** Kept for non-Mithi rivers that still use coastal heritage look. */
export const GOAN_HERITAGE_PALETTE = MUMBAI_URBAN_PALETTE;

export const TERRACOTTA_ROOF_PALETTE = [
  "#b44226", // Classic Mangalore clay tile
  "#c04a2e", // Burnt terracotta
  "#9e361c", // Aged earth red
  "#ca5234", // Sun-baked clay
  "#aa3e22", // Weathered terracotta
  "#8f2c14", // Deep red earthen tile
];

export const PUNE_PALETTE = MUMBAI_URBAN_PALETTE;

const STYLE = {
  house: 0,
  row: 1,
  apartment_low: 2,
  apartment_mid: 3,
  apartment_high: 4,
  commercial: 5,
  warehouse: 6,
  hangar: 6,
  terminal: 5,
};

/** Concrete / glass airport facade tones (CSIA hangars & terminals). */
export const AIRPORT_FACADE_PALETTE = [
  "#b8c4d0",
  "#a8b4c2",
  "#c5d0dc",
  "#9eb0c4",
  "#d0d8e0",
  "#8a9aac",
  "#e0e6ec",
  "#7a8a9a",
];

/**
 * Shared PBR facade materials (one per style) with procedural windows / weathering.
 * Safe for InstancedMesh + instanceColor.
 */
const cache = new Map();

export function getBuildingMaterial(styleClass) {
  const key = styleClass || "house";
  if (cache.has(key)) return cache.get(key);

  const preset = materialPreset(key);
  const mat = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: preset.roughness,
    metalness: preset.metalness,
    envMapIntensity: 0.55,
  });
  mat.name = `facade_${key}`;
  mat.userData.styleId = STYLE[key] ?? 0;
  mat.userData.floorsHint = preset.floorsHint;
  mat.userData.winScale = preset.winScale;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStyleId = { value: mat.userData.styleId };
    shader.uniforms.uWinScale = { value: mat.userData.winScale };
    shader.uniforms.uFloorsHint = { value: mat.userData.floorsHint };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vBldgLocal;
        varying vec3 vBldgNormal;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        vBldgNormal = objectNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vBldgLocal = position;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uStyleId;
        uniform float uWinScale;
        uniform float uFloorsHint;
        varying vec3 vBldgLocal;
        varying vec3 vBldgNormal;

        float hash21(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise2(vec2 p){
          vec2 i = floor(p); vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec3 nAbs = abs(normalize(vBldgNormal));
          float isRoof = step(0.72, nAbs.y);
          float isWall = 1.0 - isRoof;

          // Object-space facade axes (scale-stable on prototype)
          float wallU = (nAbs.x > nAbs.z) ? vBldgLocal.z : vBldgLocal.x;
          float wallV = vBldgLocal.y;

          float floorH = max(2.6, 3.05);
          float floors = max(1.0, uFloorsHint);
          float winW = mix(2.4, 3.2, step(3.5, uStyleId)) * uWinScale;
          float winH = 1.35;

          float fx = fract(wallU / winW);
          float fy = fract((wallV - 0.9) / floorH);
          float inWinX = step(0.18, fx) * step(fx, 0.82);
          float inWinY = step(0.28, fy) * step(fy, 0.78);
          float windowMask = inWinX * inWinY * isWall * step(1.1, wallV);

          // Balcony band for apartments
          float balcony = 0.0;
          if (uStyleId >= 2.0 && uStyleId <= 4.0) {
            float by = fract((wallV - 0.4) / floorH);
            balcony = smoothstep(0.08, 0.14, by) * (1.0 - smoothstep(0.18, 0.26, by)) * isWall;
          }

          // Commercial ground-floor glazing
          float shop = 0.0;
          if (uStyleId >= 5.0 && uStyleId < 6.0) {
            shop = step(wallV, 3.2) * step(0.4, wallV) * isWall * 0.85;
          }

          // Warehouse vertical panels / corrugation cue
          float panel = 0.0;
          if (uStyleId >= 6.0) {
            panel = 0.08 * sin(wallU * 2.8) * isWall;
          }

          vec3 glass = vec3(0.42, 0.52, 0.58);
          vec3 darkGlass = vec3(0.32, 0.40, 0.46);
          float glassPick = hash21(floor(vec2(wallU / winW, wallV / floorH)));
          vec3 winCol = mix(glass, darkGlass, step(0.55, glassPick));

          diffuseColor.rgb = mix(diffuseColor.rgb, winCol, windowMask * 0.72);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.92, balcony * 0.4);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(winCol, diffuseColor.rgb, 0.45), shop);

          // Concrete / plaster micro-noise
          float n = noise2(vec2(wallU, wallV) * 0.35);
          diffuseColor.rgb *= mix(1.02, 1.08, n);

          // Base dirt + roof edge weathering (keep light)
          float dirt = smoothstep(0.0, 2.2, 2.2 - wallV) * 0.05 * isWall;
          float roofDirt = isRoof * (0.03 + 0.04 * noise2(vBldgLocal.xz * 0.4));
          diffuseColor.rgb *= (1.0 - dirt - roofDirt);

          // Edge darkening
          float edge = pow(1.0 - abs(dot(normalize(vBldgNormal), vec3(0.0, 1.0, 0.0))), 1.4);
          diffuseColor.rgb *= mix(1.0, 0.96, edge * isWall * 0.25);

          diffuseColor.rgb += panel * 0.35;

          // Roof tone — terracotta houses / metal hangars / pale terminal roofs
          if (isRoof > 0.5) {
            if (uStyleId >= 6.0) {
              float corr = 0.5 + 0.5 * sin(vBldgLocal.x * 6.0);
              diffuseColor.rgb = mix(vec3(0.55, 0.58, 0.62), vec3(0.68, 0.70, 0.74), corr);
            } else if (uStyleId >= 5.0 && uStyleId < 6.0) {
              // Terminal flat roof — light metal / membrane (not terracotta)
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.80, 0.84), 0.85);
            } else {
              vec3 terracotta = vec3(0.72, 0.27, 0.16);
              diffuseColor.rgb = mix(diffuseColor.rgb, terracotta, 0.88);
            }
          }

          // Terminal curtain-wall: denser glazing + cool glass tint
          if (uStyleId >= 5.0 && uStyleId < 6.0) {
            float tfx = fract(wallU / (winW * 0.72));
            float tfy = fract((wallV - 0.6) / (floorH * 0.92));
            float tWin = step(0.08, tfx) * step(tfx, 0.92) * step(0.12, tfy) * step(tfy, 0.88) * isWall;
            vec3 termGlass = vec3(0.55, 0.68, 0.78);
            diffuseColor.rgb = mix(diffuseColor.rgb, termGlass, tWin * 0.78);
          }
        }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        {
          vec3 nAbs = abs(normalize(vBldgNormal));
          float isRoof = step(0.72, nAbs.y);
          float wallU = (nAbs.x > nAbs.z) ? vBldgLocal.z : vBldgLocal.x;
          float wallV = vBldgLocal.y;
          float floorH = 3.05;
          float winW = 2.8 * uWinScale;
          float fx = fract(wallU / winW);
          float fy = fract((wallV - 0.9) / floorH);
          float windowMask = step(0.18, fx) * step(fx, 0.82) * step(0.28, fy) * step(fy, 0.78)
            * (1.0 - isRoof) * step(1.1, wallV);
          roughnessFactor = mix(roughnessFactor, 0.18, windowMask * 0.85);
          roughnessFactor = mix(roughnessFactor, 0.78, isRoof * 0.4);
        }`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `#include <metalnessmap_fragment>
        {
          vec3 nAbs = abs(normalize(vBldgNormal));
          float isRoof = step(0.72, nAbs.y);
          float wallU = (nAbs.x > nAbs.z) ? vBldgLocal.z : vBldgLocal.x;
          float wallV = vBldgLocal.y;
          float floorH = 3.05;
          float winW = 2.8 * uWinScale;
          float fx = fract(wallU / winW);
          float fy = fract((wallV - 0.9) / floorH);
          float windowMask = step(0.18, fx) * step(fx, 0.82) * step(0.28, fy) * step(fy, 0.78)
            * (1.0 - isRoof) * step(1.1, wallV);
          metalnessFactor = mix(metalnessFactor, 0.45, windowMask * 0.7);
          if (uStyleId >= 6.0) metalnessFactor = mix(metalnessFactor, 0.35, isRoof * 0.5);
        }`,
      );
  };

  mat.customProgramCacheKey = () => `pune_facade_${key}_v4_csia`;
  cache.set(key, mat);
  return mat;
}

function materialPreset(cls) {
  switch (cls) {
    case "apartment_high":
      return { roughness: 0.72, metalness: 0.06, floorsHint: 12, winScale: 0.95 };
    case "apartment_mid":
      return { roughness: 0.76, metalness: 0.05, floorsHint: 7, winScale: 1.0 };
    case "apartment_low":
      return { roughness: 0.8, metalness: 0.04, floorsHint: 4, winScale: 1.05 };
    case "commercial":
      return { roughness: 0.62, metalness: 0.12, floorsHint: 4, winScale: 0.85 };
    case "warehouse":
      return { roughness: 0.88, metalness: 0.18, floorsHint: 2, winScale: 1.4 };
    case "hangar":
      return { roughness: 0.78, metalness: 0.28, floorsHint: 1, winScale: 1.8 };
    case "terminal":
      // Glass curtain-wall passenger terminals (T1 / T2) — premium CSIA look
      return { roughness: 0.22, metalness: 0.62, floorsHint: 5, winScale: 0.48 };
    case "row":
      return { roughness: 0.82, metalness: 0.04, floorsHint: 3, winScale: 1.1 };
    default:
      return { roughness: 0.86, metalness: 0.03, floorsHint: 2, winScale: 1.15 };
  }
}

/** Deterministic Goan heritage plaster color from building id / seed. */
export function paletteColor(seed) {
  const i = Math.abs(Math.floor(seed)) % GOAN_HERITAGE_PALETTE.length;
  return new THREE.Color(GOAN_HERITAGE_PALETTE[i]);
}

/** Authentic Mangalore terracotta clay tile roof color */
export function terracottaRoofColor(seed) {
  const i = Math.abs(Math.floor(seed)) % TERRACOTTA_ROOF_PALETTE.length;
  return new THREE.Color(TERRACOTTA_ROOF_PALETTE[i]);
}

/** Neighborhood-clustered palette — authentic contrasting facades along Goan streets. */
export function neighborhoodPaletteColor(seed, x, z) {
  // Goan settlements like Fontainhas feature vibrant contrasting colors house-by-house
  const base = paletteColor(seed);
  return base;
}

export function airportFacadeColor(seed) {
  const i = Math.abs(Math.floor(seed)) % AIRPORT_FACADE_PALETTE.length;
  return new THREE.Color(AIRPORT_FACADE_PALETTE[i]);
}

export function metalRoofColor(seed) {
  const greys = ["#6a7078", "#747a82", "#5e646c", "#7c828a"];
  return new THREE.Color(greys[Math.abs(Math.floor(seed)) % greys.length]);
}

export function styleClassFromClassification(classification) {
  return classification?.class || "house";
}

/** Distant LOD: cheaper standard material, muted variation via vertex colors. */
export function getFarLodMaterial() {
  if (cache.has("__far")) return cache.get("__far");
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.04,
  });
  mat.name = "facade_far";
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vFarLocal;
        varying vec3 vFarN;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        vFarN = objectNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vFarLocal = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vFarLocal;
        varying vec3 vFarN;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec3 nAbs = abs(normalize(vFarN));
          float isWall = 1.0 - step(0.72, nAbs.y);
          float u = (nAbs.x > nAbs.z) ? vFarLocal.z : vFarLocal.x;
          float v = vFarLocal.y;
          float fx = fract(u / 3.4);
          float fy = fract(v / 3.2);
          float win = step(0.2, fx) * step(fx, 0.8) * step(0.3, fy) * step(fy, 0.75) * isWall * step(2.0, v);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.18, 0.24, 0.28), win * 0.75);
          diffuseColor.rgb *= mix(1.0, 0.9, smoothstep(0.0, 3.0, 3.0 - v) * isWall * 0.5);
        }`,
      );
  };
  mat.customProgramCacheKey = () => "pune_facade_far";
  cache.set("__far", mat);
  return mat;
}

/** Mid-distance footprint extrusions — vertex colors, simplified windows. */
export function getMidLodMaterial() {
  if (cache.has("__mid")) return cache.get("__mid");
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.05,
  });
  mat.name = "facade_mid";
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vMidL;\nvarying vec3 vMidN;`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\nvMidN = objectNormal;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvMidL = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vMidL;\nvarying vec3 vMidN;`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec3 nAbs = abs(normalize(vMidN));
          float isRoof = step(0.62, nAbs.y);
          float isWall = 1.0 - isRoof;
          float u = (nAbs.x > nAbs.z) ? vMidL.z : vMidL.x;
          float v = vMidL.y;
          float win = step(0.22, fract(u/3.2)) * step(fract(u/3.2), 0.78) * step(0.32, fract(v/3.0)) * step(fract(v/3.0), 0.72) * isWall * step(2.5, v);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.28, 0.32), win * 0.55);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.82, isRoof * 0.45);
          diffuseColor.rgb *= mix(1.0, 0.88, isWall * 0.35);
        }`,
      );
  };
  mat.customProgramCacheKey = () => "pune_facade_mid";
  cache.set("__mid", mat);
  return mat;
}
