/**
 * Smooth animated bank-erosion ribbon material.
 * Null/black stays clear so live water shows; calm green is translucent;
 * hot yellow/orange/red stay readable.
 */
import * as THREE from "three";
import { applyDrapeDepth } from "../drapeDepth.js";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.06) discard;

  // JalNetra class rasters use opaque black for "no data" — punch those out
  // so the live water sheet stays visible underneath.
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float peak = max(c.r, max(c.g, c.b));
  if (luma < 0.08 && peak < 0.12) discard;

  // Hotness from palette: green=calm, yellow/orange/red=active
  float greenBias = c.g - c.r;
  float hot = clamp((c.r - c.g) * 1.55 + max(0.0, c.r - 0.55) * 0.9, 0.0, 1.0);
  float calm = clamp(greenBias * 1.2 + 0.15, 0.0, 1.0);

  float pulse = 1.0 + hot * (0.10 * sin(uTime * 1.05) + 0.04 * sin(uTime * 2.1 + vUv.x * 12.0));
  float flow = 1.0 + hot * 0.05 * sin(vUv.x * 34.0 - uTime * 0.65);
  float soft = 1.0 + calm * 0.03 * sin(uTime * 0.45 + vUv.y * 8.0);

  vec3 col = c.rgb * pulse * flow * soft;
  // Soft warm bloom on moderate+
  col += vec3(1.0, 0.42, 0.08) * (hot * hot) * (0.07 + 0.05 * sin(uTime * 1.3));

  // Calm green = very translucent (water must read through).
  // Hot classes keep stronger alpha so erosion hotspots still pop.
  float a = c.a * uOpacity;
  float classAlpha = mix(0.16 + calm * 0.10, 0.72, hot);
  a = clamp(a * classAlpha, 0.0, 1.0);
  // Extra fade for near-black leftovers that survived the discard.
  a *= smoothstep(0.08, 0.22, luma);
  gl_FragColor = vec4(col, a);
}
`;

/**
 * @param {THREE.Texture} texture
 * @param {{ opacity?: number }} [opts]
 */
export function createBankErosionMaterial(texture, opts = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      uTime: { value: 0 },
      uOpacity: { value: Number.isFinite(Number(opts.opacity)) ? Number(opts.opacity) : 0.55 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  applyDrapeDepth(mat);
  mat.userData.bankErosionAnim = true;
  return mat;
}

/**
 * @param {THREE.Material} mat
 * @param {number} timeSec
 */
export function updateBankErosionMaterial(mat, timeSec) {
  if (!mat?.uniforms?.uTime) return;
  mat.uniforms.uTime.value = timeSec;
}
