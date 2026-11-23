/**
 * HARD VISUAL LOCK — trees, bridges, buildings must not be retuned.
 *
 * User command (2026-11-17): "NOW NEVER CHANGE THE TREES AND THE BRIDGES AND BUILDINGS"
 * Only change these if the user names that layer explicitly again.
 */
export const VISUAL_LOCK = Object.freeze({
  LOCKED: true,

  /** Unlocked 2026-11-19: user asked to restore trees on the rejoined bank park. */
  freezeTrees: false,
  // Unlocked 2026-11-19: user asked pier→DTM attach (deck clearance preserved).
  freezeBridges: false,
  // Unlocked 2026-11-19: user asked building foundations on DTM + CSIA airport.
  freezeBuildings: false,

  vegetation: Object.freeze({
    maxInstances: 18000,
    stepM: 10,
    seed: 0x51e9a01,
    buildingClearM: 16,
    buildingFootprintPadM: 10,
    roadClearM: 4,
    bridgeClearM: 14,
    // Clear only near the main channel — mangrove flats stay plantable.
    riverClearFrac: 0.55,
    maxBankOutM: 320,
    alongStepM: 8,
    inlandKeepChance: 0.72,
    farInlandKeepChance: 0.58,
    nearBankKeepChance: 0.88,
    flatFillKeepChance: 0.7,
    overlayDensNear: 0.92,
    overlayDensMid: 0.82,
    overlayDensFar: 0.68,
    vacantNoHitChance: 0.45,
    osmGreenAreaDiv: 90,
    osmGreenMaxN: 40,
    osmGreenKeepChance: 0.7,
  }),

  water: Object.freeze({
    maxDilatePx: 28,
  }),

  buildings: Object.freeze({
    preserveOsmFootprints: true,
  }),

  bridges: Object.freeze({
    preserveSpans: true,
  }),

  river: Object.freeze({
    /**
     * When true: primary water surface is the uploaded MNDWI GroundOverlay
     * (water_depth (1).kml → live sheet). Corridor ribbon is hidden so the
     * scene does not show an artificial bank-to-bank polygon.
     */
    kmlOnlyLiveWater: true,
    waterPreset: "calmRealistic",
    bridgeApronM: 120,
    channelSealAlongM: 280,
  }),
});

export function isVisualLocked() {
  return VISUAL_LOCK.LOCKED === true;
}

export function isTreesFrozen() {
  return VISUAL_LOCK.LOCKED && VISUAL_LOCK.freezeTrees;
}

export function isBridgesFrozen() {
  return VISUAL_LOCK.LOCKED && VISUAL_LOCK.freezeBridges;
}

export function isBuildingsFrozen() {
  return VISUAL_LOCK.LOCKED && VISUAL_LOCK.freezeBuildings;
}
