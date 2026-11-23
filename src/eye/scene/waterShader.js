import * as THREE from "three";
import { state } from "../state.js";
import { DEFAULT_WATER_PRESET, WATER_PRESETS } from "./water/waterPresets.js";

const PIER_MAX = 16;

/**
 * Continuous river-wave field on corridor params (aAlong, aAcross).
 * Phase uses station/across — NOT world·aFlow — so curves stay seamless
 * (world·flow is discontinuous when flow direction changes per station).
 */
const WAVE_GLSL = /* glsl */ `
  float riverWaveHeight(float along, float across, float t) {
    float pSpd = uPrimaryWaveSpeed * (0.55 + uFlowSpeed * 0.6);
    float sSpd = uSecondaryWaveSpeed * (0.5 + uFlowSpeed * 0.7);
    float rSpd = uRippleSpeed * (0.45 + uFlowSpeed * 0.55);

    float downAlong = 1.0 - along;
    // Very long wavelengths → calm natural water, no choppy lattice.
    float s = downAlong * 14.0;
    float c = (across - 0.5) * 2.4;

    float primary =
        sin(s * 0.22 - t * pSpd * 1.1) * 0.65
      + sin(s * 0.12 + c * 0.04 - t * pSpd * 0.7 + 1.6) * 0.35;
    primary *= uPrimaryWaveAmplitude;

    float secondary =
        sin(s * 0.38 - t * sSpd * 1.3) * 0.55
      + sin(s * 0.52 + c * 0.08 - t * sSpd * 0.95 + 0.9) * 0.28
      + sin(c * 0.28 + t * sSpd * 0.18) * 0.1;
    secondary *= uSecondaryWaveAmplitude * uFlowStrength;

    // Barely-there ripples — real calm river, not glitter.
    float rip = 0.0;
    if (uQuality > 0.5) {
      float wx = s * 0.9 - t * rSpd * 1.2;
      float wz = c * 1.0 + t * rSpd * 0.35;
      rip = sin(wx) * cos(wz) * 0.35 + sin(wx * 0.85 + 0.7) * 0.18;
      rip *= uRippleAmplitude;
    }

    return primary + secondary + rip;
  }

  vec2 riverWaveSlope(float along, float across, float t) {
    float pSpd = uPrimaryWaveSpeed * (0.55 + uFlowSpeed * 0.6);
    float sSpd = uSecondaryWaveSpeed * (0.5 + uFlowSpeed * 0.7);
    float rSpd = uRippleSpeed * (0.45 + uFlowSpeed * 0.55);
    float downAlong = 1.0 - along;
    float s = downAlong * 14.0;
    float c = (across - 0.5) * 2.4;
    float dsda = -14.0;
    float dcdc = 2.4;

    float dS =
        cos(s * 0.22 - t * pSpd * 1.1) * 0.22 * 0.65 * uPrimaryWaveAmplitude
      + cos(s * 0.12 + c * 0.04 - t * pSpd * 0.7 + 1.6) * 0.12 * 0.35 * uPrimaryWaveAmplitude
      + cos(s * 0.38 - t * sSpd * 1.3) * 0.38 * 0.55 * uSecondaryWaveAmplitude * uFlowStrength
      + cos(s * 0.52 + c * 0.08 - t * sSpd * 0.95 + 0.9) * 0.52 * 0.28 * uSecondaryWaveAmplitude * uFlowStrength;

    float dC =
        cos(s * 0.12 + c * 0.04 - t * pSpd * 0.7 + 1.6) * 0.04 * 0.35 * uPrimaryWaveAmplitude
      + cos(s * 0.52 + c * 0.08 - t * sSpd * 0.95 + 0.9) * 0.08 * 0.28 * uSecondaryWaveAmplitude * uFlowStrength
      + cos(c * 0.28 + t * sSpd * 0.18) * 0.28 * 0.1 * uSecondaryWaveAmplitude * uFlowStrength;

    if (uQuality > 0.5) {
      float wx = s * 0.9 - t * rSpd * 1.2;
      float wz = c * 1.0 + t * rSpd * 0.35;
      dS += cos(wx) * 0.9 * cos(wz) * 0.35 * uRippleAmplitude;
      dC += sin(wx) * (-sin(wz) * 1.0) * 0.35 * uRippleAmplitude;
    }

    return vec2(dS * dsda, dC * dcdc);
  }
`;

/**
 * Calm cinematic river surface — multi-layer GPU sine waves.
 * Replaces value-noise/fbm (rectangular patches) and world·flow phase (curve seams).
 */
const vert = /* glsl */ `
  uniform float uTime;
  uniform float uAnimEnabled;
  uniform float uOverallSpeed;
  uniform float uPrimaryWaveSpeed;
  uniform float uPrimaryWaveAmplitude;
  uniform float uSecondaryWaveSpeed;
  uniform float uSecondaryWaveAmplitude;
  uniform float uRippleSpeed;
  uniform float uRippleAmplitude;
  uniform float uFlowSpeed;
  uniform float uFlowStrength;
  uniform float uQuality;

  attribute float aDepth;
  attribute float aAlong;
  attribute float aAcross;
  attribute vec2 aFlow;
  attribute float aNarrow;
  attribute float aEdgeDist;
  attribute float aRiverDist;

  varying float vDepth;
  varying float vAlong;
  varying float vAcross;
  varying float vNarrow;
  varying vec2  vFlow;
  varying vec3  vWorld;
  varying vec2  vXZ;
  varying float vWave;
  varying float vEdgeDist;
  varying float vRiverDist;

  ${WAVE_GLSL}

  void main(){
    vDepth = aDepth;
    vAlong = aAlong;
    vAcross = aAcross;
    vNarrow = aNarrow;
    vFlow = normalize(aFlow + vec2(1e-5));
    vEdgeDist = aEdgeDist;
    vRiverDist = aRiverDist;
    vXZ = position.xz;

    float t = uTime * max(0.15, uOverallSpeed);
    float edge = abs(aAcross * 2.0 - 1.0);
    float bankFade = mix(1.0, 0.55, smoothstep(0.88, 0.995, edge));
    float anim = step(0.5, uAnimEnabled);

    float narrowBoost = 1.0 + aNarrow * 0.12;
    float wave = riverWaveHeight(aAlong, aAcross, t) * bankFade * narrowBoost * anim;
    vWave = wave;

    vec3 pos = position;
    pos.y += wave;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const frag = /* glsl */ `
  uniform float uTime;
  uniform float uAnimEnabled;
  uniform float uOverallSpeed;
  uniform float uPrimaryWaveSpeed;
  uniform float uPrimaryWaveAmplitude;
  uniform float uSecondaryWaveSpeed;
  uniform float uSecondaryWaveAmplitude;
  uniform float uRippleSpeed;
  uniform float uRippleAmplitude;
  uniform float uFlowSpeed;
  uniform float uFlowStrength;
  uniform float uShowDepth;
  uniform float uBathymetryMode;
  uniform float uCutaway;
  uniform float uMinDepth;
  uniform float uMaxDepth;
  uniform float uShowFlowVis;
  uniform float uOpacity;
  uniform float uReveal;
  uniform float uRevealSoft;
  uniform float uReflectionStrength;
  uniform float uWaveHighlight;
  uniform float uQuality;
  uniform vec3  uLightDir;
  uniform vec3  uSkyColor;
  uniform vec3  uC0;
  uniform vec3  uC1;
  uniform vec3  uC2;
  uniform vec3  uC3;
  uniform vec3  uEdgeGlow;
  uniform vec4  uPiers[16];
  uniform float uPierCount;
  uniform float uIsFlood;
  uniform float uFloodProgressDist;
  uniform float uFrontLine;
  uniform vec3  uFrontColor;

  uniform float uSiltMode;
  uniform vec2  uSiltP0;
  uniform vec2  uSiltP1;
  uniform vec2  uSiltP2;
  uniform vec2  uSiltP3;

  varying float vDepth;
  varying float vAlong;
  varying float vAcross;
  varying float vNarrow;
  varying vec2  vFlow;
  varying vec3  vWorld;
  varying vec2  vXZ;
  varying float vWave;
  varying float vEdgeDist;
  varying float vRiverDist;

  ${WAVE_GLSL}

  // Live-water bathymetry: four legend classes (absolute metres).
  // uC0=Shallow(<1.5) uC1=Moderate(1.5–3) uC2=Medium-Deep(3–4.5) uC3=Deep(>4.5)
  vec3 depthColor(float d){
    float depthM = max(d, 0.0);

    if (uIsFlood > 0.5) {
      float t = clamp((depthM - uMinDepth) / max(0.001, uMaxDepth - uMinDepth), 0.0, 1.0);
      float te = smoothstep(0.0, 1.0, pow(t, 0.85));
      vec3 c = mix(uC1, uC2, smoothstep(0.0, 0.45, te));
      c = mix(c, uC3, smoothstep(0.40, 1.0, te));
      return c;
    }

    if (uBathymetryMode > 0.5 || uShowDepth > 0.5) {
      // Soft class bands — bright cerulean scale (never crush to navy).
      vec3 c = uC0;
      c = mix(c, uC1, smoothstep(1.35, 1.65, depthM));
      c = mix(c, uC2, smoothstep(2.85, 3.15, depthM));
      c = mix(c, uC3, smoothstep(4.35, 4.65, depthM));
      // Lift overall so deep stays sky-blue, not ink.
      c = mix(c, uC1, 0.12);
      c = max(c, vec3(0.12, 0.42, 0.62));
      return c;
    }

    float t = clamp((depthM - uMinDepth) / max(0.001, uMaxDepth - uMinDepth), 0.0, 1.0);
    float te = smoothstep(0.0, 1.0, pow(t, 0.85));
    vec3 s0 = uC1;
    vec3 s1 = uC2;
    vec3 s2 = uC3;
    vec3 c = mix(s0, s1, smoothstep(0.0, 0.42, te));
    c = mix(c, s2, smoothstep(0.38, 1.0, te));
    return mix(s1, c, clamp(uShowDepth, 0.0, 1.0));
  }

  void main(){
    if (vDepth < 0.0) discard;
    float depthT = clamp((vDepth - uMinDepth) / max(0.001, uMaxDepth - uMinDepth), 0.0, 1.0);
    depthT = smoothstep(0.0, 1.0, pow(depthT, 0.78));
    vec2 fdir = vFlow;
    float t = uTime * max(0.15, uOverallSpeed);
    float anim = step(0.5, uAnimEnabled);
    float flow = t * (0.22 + uFlowSpeed * 0.48) * max(0.35, uFlowStrength);

    // Analytical normals from sine slopes (corridor -> world via aFlow).
    vec2 slope = riverWaveSlope(vAlong, vAcross, t) * anim;
    vec2 perp = vec2(-fdir.y, fdir.x);
    float nBoost = 0.85 + uWaveHighlight * 0.75 + uPrimaryWaveAmplitude * 3.0;
    vec3 N = normalize(vec3(
      -(slope.x * fdir.x + slope.y * perp.x) * nBoost * 0.01,
      1.0,
      -(slope.x * fdir.y + slope.y * perp.y) * nBoost * 0.01
    ));

    vec3 col = depthColor(vDepth);
    vec3 baseCol = col;
    // Bathymetry live-water: keep class colours dominant; light motion only.
    float bathyLive = step(0.5, uBathymetryMode);

    // Soft flow bands — long wavelength only (smooth natural water).
    float downAlong = 1.0 - vAlong;
    float s = downAlong * 14.0;
    float c = (vAcross - 0.5) * 2.4;
    float streak =
        sin(s * 0.22 - flow * 0.7) * 0.7
      + sin(s * 0.34 - flow * 0.95 + 1.2) * 0.3;
    float lightBand = pow(0.5 + 0.5 * streak, 3.2);
    // Dense sun-sparkle field like the reference glassy sheet
    float rSpd = uRippleSpeed * (0.45 + uFlowSpeed * 0.55);
    float wx = s * 2.8 - t * rSpd * 2.4;
    float wz = c * 3.2 + t * rSpd * 0.85;
    float chop = sin(wx) * cos(wz);
    float chop2 = sin(wx * 1.65 + 0.9) * cos(wz * 1.4 - 0.5);
    float crest = pow(max(chop, 0.0), 2.2) * 0.7 + pow(max(chop2, 0.0), 2.8) * 0.45;
    float sparkle = pow(max(chop * chop2, 0.0), 1.6);

    if (uIsFlood > 0.5) {
      float floodWaveHighlight = clamp(vWave * 3.0, 0.0, 0.1) * uWaveHighlight;
      col += vec3(1.0, 0.45, 0.45) * (lightBand * 0.08 * anim + floodWaveHighlight);
    } else {
      vec3 flowTint = vec3(0.05, 0.22, 0.28);
      float motionAmp = mix(1.0, 0.28, bathyLive);
      col += flowTint * lightBand * 0.045 * anim * motionAmp;
      col += flowTint * clamp(vWave * 1.1, 0.0, 0.035) * uWaveHighlight * motionAmp;
      col = mix(col, vec3(0.42, 0.92, 0.97), crest * 0.07 * uWaveHighlight * anim * motionAmp);
      col = mix(col, baseCol, mix(depthT * 0.15, 0.55, bathyLive));
    }

    // Shoreline factor: aAcross→0 at bank (from mask distance), mid-channel ≈ 0.5.
    float edge = abs(vAcross * 2.0 - 1.0);
    float shore = smoothstep(0.55, 0.98, edge);
    float foam = shore * (1.0 - depthT) * 0.04
               + vNarrow * 0.01 * (0.5 + 0.5 * sin(s * 1.2 - flow));

    // Downstream wake trails behind bridge piers
    vec2 downFdir = -fdir;
    float wake = 0.0;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uPierCount) break;
      vec2 dlt = vXZ - uPiers[i].xy;
      float d = length(dlt);
      float rad = max(5.0, uPiers[i].z);
      float near = exp(-d * d / (rad * rad * 3.2));
      float behind = max(0.0, -dot(normalize(dlt + vec2(1e-4)), downFdir));
      wake += near * (0.3 + behind * 0.85);
    }
    foam += wake * 0.08;

    float soft = max(0.02, uRevealSoft);
    float revealMask = 1.0 - smoothstep(uReveal - soft, uReveal + soft * 0.35, vAlong);
    float front = exp(-pow((vAlong - uReveal) / max(0.02, soft * 1.4), 2.0));
    front *= step(0.01, uReveal) * step(uReveal, 1.08);
    foam += front * 0.12;

    // Premium neon-glass: Fresnel + cyan reflections + soft luminous highlights.
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uLightDir);
    float rSpdN = uRippleSpeed * (0.45 + uFlowSpeed * 0.55);
    float wxN = s * 0.85 - t * rSpdN * 1.1;
    float wzN = c * 0.95 + t * rSpdN * 0.35;
    float nAmp = (0.08 + uRippleAmplitude * 2.2) * anim * (1.0 - uIsFlood);
    vec3 Nw = normalize(N + vec3(
      cos(wxN) * cos(wzN) * nAmp * 0.28,
      0.0,
      -sin(wxN) * sin(wzN) * nAmp * 0.28
    ));
    vec3 H = normalize(L + V);
    float NdV = max(dot(Nw, V), 0.0);
    float fresnel = mix(0.04, 0.55, pow(1.0 - NdV, 2.6));
    fresnel *= uReflectionStrength * mix(1.0, 0.85, uIsFlood);
    float spec = pow(max(dot(Nw, H), 0.0), 96.0) * 0.22 * uWaveHighlight * anim
               + pow(max(dot(Nw, H), 0.0), 32.0) * 0.1 * uReflectionStrength;
    spec = min(spec, 0.28);

    col = mix(baseCol, col, mix(0.88, 0.97, bathyLive));
    // Cyan glass sky bounce — dialled down in bathymetry so depth classes stay true.
    vec3 skyRefl = mix(uSkyColor, vec3(0.45, 0.92, 1.0), 0.55);
    skyRefl = mix(skyRefl, vec3(1.0, 0.84, 0.84), uIsFlood);
    float reflAmt = mix(1.0, 0.22, bathyLive);
    col = col * (1.0 - fresnel * 0.32 * (1.0 - uIsFlood) * reflAmt)
        + skyRefl * fresnel * mix(0.62, 0.2, uIsFlood) * reflAmt
        + vec3(0.55, 0.95, 1.0) * spec * mix(1.0, 0.25, bathyLive);
    col = mix(col, vec3(0.35, 0.9, 0.98), fresnel * 0.16 * (1.0 - uIsFlood) * reflAmt);
    col = mix(col, vec3(0.4, 0.94, 1.0), crest * 0.08 * uWaveHighlight * anim * (1.0 - uIsFlood) * mix(1.0, 0.2, bathyLive));

    // Soft bank glow — weaker in bathymetry so shallow class stays light-blue, not neon.
    float edgeGlow = shore * shore * (0.35 + 0.65 * fresnel);
    col = mix(col, uEdgeGlow, edgeGlow * mix(0.38, 0.12, bathyLive) * (1.0 - uIsFlood));
    foam = min(foam, 0.12);
    col = mix(col, uEdgeGlow, foam * mix(0.12, 0.04, bathyLive) * (1.0 - uIsFlood));

    // Controlled glass transparency / refraction feel (depth-based).
    float depthM = max(vDepth, 0.0);
    float absorb = 1.0 - exp(-depthM * 0.09);
    float alpha = mix(0.72, 0.92, smoothstep(0.02, 0.9, depthT)) * uOpacity;
    alpha = mix(alpha, mix(0.78, 0.94, absorb), 0.55);

    float surfaceFeatures = clamp(fresnel * 1.2 + spec * 1.8, 0.0, 1.0);
    alpha = max(alpha, surfaceFeatures * 0.35);
    // Keep terrain from reading through, but preserve glass translucency.
    alpha = clamp(alpha, 0.78, 0.96);

    // Soft shoreline alpha only — no white rim, no holes.
    alpha *= 1.0 - shore * 0.06;

    alpha = mix(alpha, mix(0.12, 0.32, depthT) * uOpacity, uCutaway);
    alpha *= mix(0.08, 1.0, revealMask);
    alpha *= mix(1.0, 0.92, clamp(wake * 0.35, 0.0, 1.0));


    // API flood: FILL the extent with flowing water (not an empty outline).
    if (uIsFlood > 0.5) {
      // Solid fill inside the polygon — only a tiny soft tip at the shoreline
      // Near-opaque: blue river water or dark ground showing through turned the red to wine.
      alpha = clamp(mix(0.90, 0.96, depthT) * uOpacity, 0.88, 0.96);
      alpha *= mix(0.9, 1.0, smoothstep(0.0, 4.0, vEdgeDist));
      float ahead = vRiverDist - uFloodProgressDist;
      float aa = max(fwidth(vRiverDist), 1e-3);
      // Growing wet front from river → banks (water flows outward into flood lines)
      float wet = 1.0 - smoothstep(-0.8 * aa, 1.5 * aa, ahead);
      if (wet < 0.002) discard;
      alpha *= mix(0.75, 1.0, smoothstep(0.0, 12.0, -ahead));
      // No hard rim stroke
      float frontPx = -ahead / aa;
      float frontLine = (1.0 - smoothstep(1.5, 5.0, frontPx)) * uFrontLine;
      col = mix(col, uFrontColor, frontLine * 0.25);
      alpha *= wet;
    }

    // SILT ANALYSIS MODE OVERRIDE — only when looking down onto the sheet.
    // From underneath, the surface stays a water ceiling.
    if (uSiltMode > 0.5 && gl_FrontFacing) {
      vec2 p = vWorld.xz;
      vec2 poly[4];
      poly[0] = uSiltP0;
      poly[1] = uSiltP1;
      poly[2] = uSiltP2;
      poly[3] = uSiltP3;
      
      bool inside = false;
      int j = 3;
      for (int i = 0; i < 4; i++) {
        if (((poly[i].y > p.y) != (poly[j].y > p.y)) &&
            (p.x < (poly[j].x - poly[i].x) * (p.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x)) {
          inside = !inside;
        }
        j = i;
      }
      
      if (inside) {
        alpha = min(alpha, 0.05);
        col = mix(col, vec3(0.10, 0.16, 0.18), 0.04);
      } else {
        // More subtle transparency outside the polygon so the river remains present but subdued
        alpha = min(alpha, 0.65);
      }
    }

    // Camera under the sheet: the back face is the water surface above you, not a hole onto the DTM.
    if (!gl_FrontFacing && uIsFlood < 0.5) {
      col = vec3(0.10, 0.48, 0.62);
      alpha = 0.92;
    }

    gl_FragColor = vec4(col, alpha);
  }
`;

function qualityToFloat(q) {
  if (q === "low") return 0;
  if (q === "high") return 2;
  return 1;
}

/** Flood water colour — identical to the flood legend swatch (floodComparePanel.js, #ff3030). */
export const FLOOD_RED = "#FF3030";

export function createWaterMaterial(dataset) {
  const preset = WATER_PRESETS[state.waterPreset || DEFAULT_WATER_PRESET] || WATER_PRESETS.calmRealistic;
  const piers = Array.from({ length: PIER_MAX }, () => new THREE.Vector4());
  
  const isFlood = !!dataset?.isFlood;
  // Neon-glass: edge glow / shallow / normal / deep.
  const c0 = isFlood ? new THREE.Color(FLOOD_RED) : new THREE.Color("#8BFFFF");
  const c1 = isFlood ? new THREE.Color(FLOOD_RED) : new THREE.Color("#36E6E8");
  const c2 = isFlood ? new THREE.Color(FLOOD_RED) : new THREE.Color("#00B8D9");
  const c3 = isFlood ? new THREE.Color(FLOOD_RED) : new THREE.Color("#087FA8");
  const edgeGlow = isFlood ? new THREE.Color(FLOOD_RED) : new THREE.Color("#8BFFFF");

  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    // Write depth so coarse terrain faces behind the sheet cannot show through.
    depthWrite: true,
    // Keep olive ground fog off the sheet — fog was milking the river white/green.
    fog: false,
    clipping: true,
    // FrontSide only — DoubleSide made triangle edges glitter as white X seams.
    side: THREE.FrontSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    uniforms: {
      uTime: { value: 0 },
      uAnimEnabled: { value: preset.waterAnimEnabled !== false ? 1 : 0 },
      uOverallSpeed: { value: preset.waterOverallSpeed ?? 0.55 },
      uPrimaryWaveSpeed: { value: preset.primaryWaveSpeed ?? 0.035 },
      uPrimaryWaveAmplitude: { value: preset.primaryWaveAmplitude ?? 0.06 },
      uSecondaryWaveSpeed: { value: preset.secondaryWaveSpeed ?? 0.05 },
      uSecondaryWaveAmplitude: { value: preset.secondaryWaveAmplitude ?? 0.035 },
      uRippleSpeed: { value: preset.rippleSpeed ?? 0.07 },
      uRippleAmplitude: { value: preset.rippleAmplitude ?? 0.015 },
      uFlowSpeed: { value: preset.flowSpeed ?? state.flowSpeed },
      uFlowStrength: { value: preset.flowStrength ?? 0.85 },
      uShowDepth: { value: 1 },
      uBathymetryMode: { value: 0 },
      uCutaway: { value: 0 },
      uShowFlowVis: { value: state.flowVisibility ?? 0.55 },
      uOpacity: { value: preset.waterOpacity ?? state.waterOpacity ?? 0.88 },
      uReveal: { value: 1.2 },
      uRevealSoft: { value: 0.045 },
      uReflectionStrength: { value: preset.reflectionStrength ?? 0.78 },
      uWaveHighlight: { value: preset.waveHighlight ?? 0.36 },
      uQuality: { value: qualityToFloat(state.waterQuality || "high") },
      uSiltMode: { value: 0 },
      uSiltP0: { value: new THREE.Vector2() },
      uSiltP1: { value: new THREE.Vector2() },
      uSiltP2: { value: new THREE.Vector2() },
      uSiltP3: { value: new THREE.Vector2() },
      // Use the actual survey range so measured differences remain visible.
      uMinDepth: { value: Number.isFinite(dataset.minDepth) ? dataset.minDepth : 0.5 },
      uMaxDepth: { value: Number.isFinite(dataset.maxDepth) ? dataset.maxDepth : 2.0 },
      uLightDir: { value: new THREE.Vector3(-0.42, 0.8, 0.3).normalize() },
      uSkyColor: { value: new THREE.Color("#9ee9f8") },
      uC0: { value: c0 },
      uC1: { value: c1 },
      uC2: { value: c2 },
      uC3: { value: c3 },
      uEdgeGlow: { value: edgeGlow },
      uPiers: { value: piers },
      uPierCount: { value: 0 },
      uIsFlood: { value: dataset.isFlood ? 1.0 : 0.0 },
      uFloodProgressDist: { value: 10000.0 },
      uFrontLine: { value: 0 },
      uFrontColor: { value: new THREE.Color("#FF3030") },
    },
  });
}

/** Push current state / preset into material uniforms (call each frame or on UI change). */
export function syncWaterMaterial(material) {
  if (!material?.uniforms) return;
  const u = material.uniforms;
  const preset = WATER_PRESETS[state.waterPreset] || null;
  const isFlood = (u.uIsFlood?.value ?? 0) > 0.5;

  const num = (key, fallback) => {
    const v = state[key];
    return v != null ? v : fallback;
  };

  u.uAnimEnabled.value = state.waterAnimEnabled !== false ? 1 : 0;
  u.uOverallSpeed.value = num("waterOverallSpeed", preset?.waterOverallSpeed ?? 0.55);

  u.uPrimaryWaveSpeed.value = num("primaryWaveSpeed", preset?.primaryWaveSpeed ?? 0.035);
  u.uPrimaryWaveAmplitude.value = num("primaryWaveAmplitude", preset?.primaryWaveAmplitude ?? 0.06);
  u.uSecondaryWaveSpeed.value = num("secondaryWaveSpeed", preset?.secondaryWaveSpeed ?? 0.05);
  u.uSecondaryWaveAmplitude.value = num(
    "secondaryWaveAmplitude",
    preset?.secondaryWaveAmplitude ?? 0.035,
  );
  u.uRippleSpeed.value = num("rippleSpeed", preset?.rippleSpeed ?? 0.07);
  u.uRippleAmplitude.value = num("rippleAmplitude", preset?.rippleAmplitude ?? 0.015);
  u.uFlowSpeed.value = num("flowSpeed", preset?.flowSpeed ?? 0.45);
  u.uFlowStrength.value = num("flowStrength", preset?.flowStrength ?? 0.85);
  u.uShowFlowVis.value = state.flowVisibility ?? 0.55;
  u.uQuality.value = qualityToFloat(state.waterQuality || "high");

  // Flood sheet: keep flowing water motion + filled body (not a static outline).
  if (isFlood) {
    u.uAnimEnabled.value = 1.0;
    u.uOverallSpeed.value = Math.max(u.uOverallSpeed.value, 0.95);
    u.uFlowSpeed.value = Math.max(u.uFlowSpeed.value, 0.85);
    u.uFlowStrength.value = Math.max(u.uFlowStrength.value, 1.05);
    u.uPrimaryWaveAmplitude.value = Math.max(u.uPrimaryWaveAmplitude.value, 0.12);
    u.uSecondaryWaveAmplitude.value = Math.max(u.uSecondaryWaveAmplitude.value, 0.08);
    u.uRippleAmplitude.value = Math.max(u.uRippleAmplitude.value, 0.04);
    u.uWaveHighlight.value = Math.max(u.uWaveHighlight?.value ?? 0, 0.9);
    return;
  }

  u.uOpacity.value = num("waterOpacity", preset?.waterOpacity ?? 0.88);
  u.uReflectionStrength.value = num("reflectionStrength", preset?.reflectionStrength ?? 0.78);
  u.uWaveHighlight.value = num("waveHighlight", preset?.waveHighlight ?? 0.36);

  // Live bathymetry classes when always-on Mithi depth / bathymetry mode.
  const bathyLive = !!(state.mithiDepthAlwaysOn || state.bathymetryMode || state.showDepthZones);
  if (u.uBathymetryMode) u.uBathymetryMode.value = bathyLive ? 1 : 0;

  const veryShallowHex = bathyLive
    ? "#8FEAF8"
    : state.veryShallowWaterColor || preset?.veryShallowColor || "#8BFFFF";
  const shallowHex = bathyLive
    ? "#55C4EE"
    : state.shallowWaterColor || preset?.shallowColor || "#36E6E8";
  const mediumHex = bathyLive
    ? "#3AA0D6"
    : state.mediumWaterColor || preset?.mediumColor || "#00B8D9";
  const deepHex = bathyLive
    ? "#2B86C0"
    : state.deepWaterColor || preset?.deepColor || "#087FA8";
  const edgeGlowHex = bathyLive
    ? "#B8F2FF"
    : state.edgeGlowWaterColor || preset?.edgeGlowColor || veryShallowHex || "#8BFFFF";

  u.uC0.value.set(veryShallowHex);
  u.uC1.value.set(shallowHex);
  u.uC2.value.set(mediumHex);
  u.uC3.value.set(deepHex);
  if (u.uEdgeGlow) u.uEdgeGlow.value.set(edgeGlowHex);
  if (u.uSkyColor) u.uSkyColor.value.set("#9ee9f8");

  // Lock depth range to product envelope so class breaks stay at 1.5 / 3.0 / 4.5 m.
  if (bathyLive) {
    if (u.uMinDepth) u.uMinDepth.value = 0.2;
    if (u.uMaxDepth) u.uMaxDepth.value = 5.5;
    if (u.uShowDepth) u.uShowDepth.value = 1;
  }
}

/** Keep material depth range in sync when corridor bathymetry updates. */
export function syncWaterDepthRange(material, dataset) {
  if (!material?.uniforms || !dataset) return;
  if (Number.isFinite(dataset.minDepth)) material.uniforms.uMinDepth.value = dataset.minDepth;
  if (Number.isFinite(dataset.maxDepth)) material.uniforms.uMaxDepth.value = dataset.maxDepth;
}

export function applyWaterPreset(name) {
  const p = WATER_PRESETS[name];
  if (!p) return;
  state.waterPreset = name;
  state.waterAnimEnabled = p.waterAnimEnabled !== false;
  state.waterOverallSpeed = p.waterOverallSpeed;
  state.primaryWaveAmplitude = p.primaryWaveAmplitude;
  state.primaryWaveSpeed = p.primaryWaveSpeed;
  state.secondaryWaveAmplitude = p.secondaryWaveAmplitude;
  state.secondaryWaveSpeed = p.secondaryWaveSpeed;
  state.rippleAmplitude = p.rippleAmplitude;
  state.rippleSpeed = p.rippleSpeed;
  state.flowSpeed = p.flowSpeed;
  state.flowStrength = p.flowStrength;
  state.waterOpacity = p.waterOpacity;
  state.reflectionStrength = p.reflectionStrength;
  state.waveHighlight = p.waveHighlight;
  state.shallowWaterColor = p.shallowColor;
  state.deepWaterColor = p.deepColor;
  state.veryShallowWaterColor = p.veryShallowColor || "#8BFFFF";
  state.mediumWaterColor = p.mediumColor || "#00B8D9";
  state.edgeGlowWaterColor = p.edgeGlowColor || "#8BFFFF";
}

export function fillPierUniforms(material, dataset) {
  const arr = material.uniforms.uPiers.value;
  let n = 0;
  for (const g of dataset.bridges || []) {
    const pierTs = g.lengthM > 80 ? [0.28, 0.5, 0.72] : [0.33, 0.67];
    for (const t of pierTs) {
      if (n >= PIER_MAX) break;
      const x = g.start.x + (g.end.x - g.start.x) * t;
      const z = g.start.z + (g.end.z - g.start.z) * t;
      arr[n].set(x, z, Math.max(6, g.widthM * 0.55), 0);
      n++;
    }
  }
  material.uniforms.uPierCount.value = n;
}

/** Debug snapshot for water system (dev only). */
export function getWaterDebugInfo(material, dataset) {
  const u = material?.uniforms || {};
  return {
    abcSource: "Untitled 2.abc",
    abcObject: "Plane__Copy / Plane__CopyShape",
    abcAnimationDetected: true,
    abcNote: "Square sim plane with mesh-cache; motion applied to KML river mesh via GPU",
    waveModel: "multi-layer sine on aAlong/aAcross (no value-noise, no world·flow phase)",
    riverTriangles: dataset?.bathymetry?.indices?.length
      ? Math.floor(dataset.bathymetry.indices.length / 3)
      : null,
    flowSpeed: u.uFlowSpeed?.value,
    overallSpeed: u.uOverallSpeed?.value,
    primaryWaveSpeed: u.uPrimaryWaveSpeed?.value,
    secondaryWaveSpeed: u.uSecondaryWaveSpeed?.value,
    rippleSpeed: u.uRippleSpeed?.value,
    quality: state.waterQuality,
    preset: state.waterPreset,
  };
}

export function setWaterSiltMode(material, active, points) {
  if (!material?.uniforms) return;
  if (!material.uniforms.uSiltMode) {
    // If uniforms are missing (e.g. hot reload where material was created before the uniform was added),
    // inject them dynamically to prevent crashing and allow testing.
    material.uniforms.uSiltMode = { value: 0 };
    material.uniforms.uSiltP0 = { value: new THREE.Vector2() };
    material.uniforms.uSiltP1 = { value: new THREE.Vector2() };
    material.uniforms.uSiltP2 = { value: new THREE.Vector2() };
    material.uniforms.uSiltP3 = { value: new THREE.Vector2() };
    material.needsUpdate = true;
  }
  
  material.uniforms.uSiltMode.value = active ? 1 : 0;
  if (active && points && points.length >= 4) {
    material.uniforms.uSiltP0.value.set(points[0].x, points[0].z);
    material.uniforms.uSiltP1.value.set(points[1].x, points[1].z);
    material.uniforms.uSiltP2.value.set(points[2].x, points[2].z);
    material.uniforms.uSiltP3.value.set(points[3].x, points[3].z);
  }
}
