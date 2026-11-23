import * as THREE from "three";
import { loadFishingLocations, parseFishingLocationsKml } from "./FishingLocationLoader.js";
import { buildFishingZones } from "./FishingZoneSystem.js";
import { createFishingMarkerLayer } from "./FishingMarkerLayer.js";
import { createSurfaceActivitySystem } from "./SurfaceActivitySystem.js";
import { createMultiFishRiverSystem } from "./MultiFishRiverSystem.js";
import { createFishingPointFishSystem } from "./FishingPointFishSystem.js";
import { sampleDepthAt } from "./FishingZoneSystem.js";
import { state } from "../../state.js";

/**
 * Two fish systems:
 * 1) Global river school (MultiFishRiverSystem)
 * 2) Guaranteed fish + jumps at every fishing point (KML / continuous corridor)
 * Markers stay always-on; live JalNetra fishing-point KML upgrades them when ready.
 */
export async function createFishingSystem(dataset, canvas, camera, uiRoot, extras = {}) {
  const resolveCam = () => (typeof camera === "function" ? camera() : camera);
  const group = new THREE.Group();
  group.name = "fishingSystem";

  const ripples = createSurfaceActivitySystem();
  group.add(ripples.group);

  const riverFish = await createMultiFishRiverSystem(dataset);
  group.add(riverFish.group);

  let zones = [];
  let markers = null;
  let pointFish = { group: new THREE.Group(), update() {}, dispose() {}, pointZones: [] };

  async function applyZones(nextZones, sourceLabel) {
    if (!nextZones?.length) return false;

    if (markers?.group) {
      group.remove(markers.group);
      markers = null;
    }
    if (pointFish?.group && pointFish.group.parent === group) {
      group.remove(pointFish.group);
    }
    pointFish.dispose?.();

    zones = nextZones;
    dataset.fishingZones = zones;

    pointFish = await createFishingPointFishSystem(dataset, zones, {
      ripples,
      waterEffects: extras.waterEffects || null,
      uiRoot,
    });
    group.add(pointFish.group);

    markers = createFishingMarkerLayer(zones);
    group.add(markers.group);

    console.info("Fishing system ready", {
      source: sourceLabel,
      zones: zones.length,
      riverFish: riverFish.agents?.length || 0,
      fishingPointFish: pointFish.pointZones?.reduce((n, p) => n + p.fish.length, 0) || 0,
    });
    return true;
  }

  try {
    let raw = dataset.fishingLocationsRaw?.length ? dataset.fishingLocationsRaw : null;
    if (!raw?.length) {
      // Demo / history fishing points first, then legacy bundled KML.
      const fishingCandidates = [
        "/data/mithi/jalnetra-history/fishing-point1_21-10-2026__18-11-2026.kml",
        "/data/mithi/fishing_points.kml",
        "/data/Fishing_Locations.kml",
      ];
      for (const url of fishingCandidates) {
        try {
          raw = await loadFishingLocations(url);
          if (raw?.length) {
            console.info("[fishing] loaded", url, raw.length);
            break;
          }
        } catch {
          /* try next */
        }
      }
    }
    if (!raw?.length) raw = await loadFishingLocations("/data/Fishing_Locations.kml");
    dataset.fishingLocationsRaw = raw;
    const built = dataset.fishingZones?.length
      ? dataset.fishingZones
      : buildFishingZones(raw, dataset);
    await applyZones(built, built[0]?.id?.startsWith?.("FP-") ? "continuous-corridor" : "kml");
  } catch (err) {
    console.warn("Fishing locations unavailable:", err.message);
    const fallback = buildFishingZones([], dataset);
    if (fallback.length) {
      await applyZones(fallback, "continuous-corridor");
    } else {
      console.info("River multi-fish active", { count: riverFish.agents?.length || 0 });
    }
  }

  // Always show fishing points — continuous presence on the twin.
  state.showFish = true;

  const panel = createFishingPanel(uiRoot);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selected = null;
  let liveUpgradeBusy = false;

  async function upgradeFromLiveKml() {
    if (liveUpgradeBusy) return;
    const text = typeof window !== "undefined" ? window.__RIVER_SESSION__?.fishingKmlText : null;
    if (!text) return;
    const raw = parseFishingLocationsKml(text);
    if (!raw.length) return;
    liveUpgradeBusy = true;
    try {
      const next = buildFishingZones(raw, dataset);
      // Prefer live KML only when points land in AOI; otherwise keep continuous markers.
      if (next.length && !next[0]?.id?.startsWith?.("FP-")) {
        dataset.fishingLocationsRaw = raw;
        await applyZones(next, "jalnetra-fishing-point");
      }
    } catch (err) {
      console.warn("Fishing live upgrade:", err.message);
    } finally {
      liveUpgradeBusy = false;
    }
  }

  function onEndpoint(e) {
    if (e?.detail?.id === "fishing-point" && e.detail.ok) {
      upgradeFromLiveKml();
    }
  }
  window.addEventListener("planeteye-endpoint", onEndpoint);

  function onClick(e) {
    if (!state.showFish || !markers) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, resolveCam());
    const hits = raycaster.intersectObjects(markers.pickables(), false);
    if (!hits.length) {
      selected = null;
      panel.hide();
      return;
    }
    const zone = hits[0].object.userData.zone;
    selected = zone;
    panel.show(zone, sampleDepthAt(zone.x, zone.z, dataset));
  }
  canvas.addEventListener("click", onClick);

  let proximityZone = null;

  function update(dt, cam) {
    // Keep fishing points continuously visible.
    state.showFish = true;
    group.visible = true;

    riverFish.update(dt, cam);
    pointFish.update(dt, cam);
    ripples.update(dt);
    markers?.updateLod?.(cam);

    const riverVis = riverFish.getVisibleCount?.(cam) ?? 0;
    let pointVis = 0;
    let pointFishTotal = 0;
    let jumpActive = 0;
    for (const pz of pointFish.pointZones || []) {
      pointFishTotal += pz.fish.length;
      if (pz.presentation) pointVis += pointFish.getScreenVisibleCount?.(cam, pz.id) ?? 0;
      jumpActive += pz.fish.filter((a) => a.jumpState !== "swim").length;
    }
    state.validationStats = {
      riverAgents: riverFish.agents?.length || 0,
      riverVisible: riverVis,
      fishingPoints: zones.length,
      fishingPointFish: pointFishTotal,
      fishingPointVisible: pointVis,
      jumpActive,
      underwaterOk: !state.cinematicUnderwater || riverVis >= 14,
    };

    if (selected) {
      panel.show(selected, sampleDepthAt(selected.x, selected.z, dataset));
    } else if (zones.length && cam.position.y < 80) {
      let nearest = null;
      let best = 95;
      for (const z of zones) {
        const d = Math.hypot(cam.position.x - z.x, cam.position.z - z.z);
        if (d < best) {
          best = d;
          nearest = z;
        }
      }
      if (nearest && best < 95) {
        if (proximityZone !== nearest.id) {
          proximityZone = nearest.id;
          panel.show(nearest, sampleDepthAt(nearest.x, nearest.z, dataset));
        }
      } else {
        proximityZone = null;
        panel.hide();
      }
    } else if (!selected) {
      proximityZone = null;
      panel.hide();
    }
  }

  function dispose() {
    canvas.removeEventListener("click", onClick);
    window.removeEventListener("planeteye-endpoint", onEndpoint);
    panel.hide();
    riverFish.dispose();
    pointFish.dispose();
  }

  return {
    group,
    get zones() {
      return zones;
    },
    get pointZones() {
      return pointFish.pointZones;
    },
    riverFish,
    get pointFish() {
      return pointFish;
    },
    update,
    dispose,
  };
}

function createFishingPanel(root) {
  const el = document.createElement("div");
  el.className = "hud fishing-panel";
  el.hidden = true;
  root.appendChild(el);
  return {
    show(zone, depth) {
      el.hidden = false;
      el.innerHTML = `
        <h3>Fishing Location</h3>
        ${zone.waterValid === false ? `<div class="kv invalid"><span class="k">Status</span><span class="v">${zone.invalidReason || "INVALID"}</span></div>` : ""}
        <div class="kv"><span class="k">ID</span><span class="v">${zone.name}</span></div>
        <div class="kv"><span class="k">Longitude</span><span class="v">${Number(zone.lon).toFixed(6)}°</span></div>
        <div class="kv"><span class="k">Latitude</span><span class="v">${Number(zone.lat).toFixed(6)}°</span></div>
        <div class="kv"><span class="k">Depth</span><span class="v">${Number(depth).toFixed(3)} m</span></div>
        <div class="kv"><span class="k">Species</span><span class="v">${(zone.dominant || []).join(", ") || "—"}</span></div>
        <div class="kv"><span class="k">Activity</span><span class="v">${zone.activity}</span></div>
      `;
    },
    hide() {
      el.hidden = true;
    },
  };
}
