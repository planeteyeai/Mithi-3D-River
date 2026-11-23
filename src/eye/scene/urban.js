import * as THREE from "three";
import { createBuildingSystem } from "../urban/buildingSystem.js";
import { createRoadSystem } from "../urban/roadSystem.js";
import { createAerowaySystem } from "../urban/aerowaySystem.js";
import { createAircraftOpsLayer } from "../urban/aircraftOpsLayer.js";
import { updateBuildingLodVisibility, cacheLodGroupCenters } from "../urban/buildingLodTiers.js";

/**
 * Geospatial urban layer: OSM footprints → classify → GLB (near) / extrusion LOD (far) + roads.
 * CSIA aeroway pavement + apron aircraft ops are separate layers (WGS84-aligned).
 */
export async function createUrban(dataset, opts = {}) {
  const group = new THREE.Group();
  group.name = "urban";

  const q = opts.quality || {};
  const aeroOpts = {
    densifyM: q.aerowayDensifyM,
    extras: q.aerowayExtras !== false,
    lite: dataset.lite === true || q.tier === "low",
  };

  const [buildings, roads, aeroway] = await Promise.all([
    createBuildingSystem(dataset, {
      heroMax: q.buildingHeroMax,
      nearMax: q.buildingNearMax,
      midMax: q.buildingMidMax,
    }),
    Promise.resolve(createRoadSystem(dataset)),
    Promise.resolve(createAerowaySystem(dataset, aeroOpts)),
  ]);
  const aircraftOps = createAircraftOpsLayer(dataset, {
    lite: aeroOpts.lite,
  });
  buildings.name = "osmBuildings";
  roads.name = "osmRoads";
  aeroway.name = "osmAeroway";
  aircraftOps.group.name = "aircraftOps";
  group.add(aeroway);
  group.add(buildings);
  group.add(roads);
  group.add(aircraftOps.group);
  group.userData.buildings = buildings;
  group.userData.roads = roads;
  group.userData.aeroway = aeroway;
  group.userData.aircraftOps = aircraftOps;
  group.userData.updateLod = (camera) => updateBuildingLodVisibility(buildings, camera);
  group.userData.updateAircraft = (dt) => {
    aircraftOps.update?.(dt);
    aeroway?.userData?.update?.(dt);
  };
  cacheLodGroupCenters(buildings);
  return group;
}
