/**
 * Sea / mouth connection stub.
 *
 * Mandovi water must follow ONLY the user-provided live_water_mithi.kml
 * (water_extent.png). Do not invent Aguada Bay polygons or corridor aprons.
 */
import * as THREE from "three";

export const MANDOVI_SEA_MOUTH = {
  lon: 72.83456,
  lat: 19.04938,
  station67: { lon: 72.8418, lat: 19.0506 },
  liveWaterWest: 72.83306075355661,
  liveWaterSouth: 19.0436493272577,
  liveWaterNorth: 19.0893267244805,
};

/**
 * @param {object} _dataset
 * @param {{ liveWaterMask?: object }} [opts]
 */
export function createSeaConnectionLayer(_dataset, opts = {}) {
  const group = new THREE.Group();
  group.name = "seaConnection";
  group.visible = false;
  group.userData = {
    built: false,
    stats: {
      built: false,
      reason: "live_water_mithi.kml is the only water extent — no invented sea apron / bay fill",
      liveWater: !!opts.liveWaterMask?.available,
      source: "live_water_mithi.kml",
    },
    setVisible() {},
  };
  console.info("[seaConnection] skipped inventing water — using live_water_mithi.kml only", group.userData.stats);
  return group;
}
