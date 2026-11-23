import * as THREE from "three";
import { lonLatToLocal } from "../geo/geoReference.js";
import { terrainHeightAt } from "../scene/terrain.js";

const TYPE_SCALE = {
  ga: 0.7,
  narrow: 1.35,
  wide: 1.85,
};

/**
 * CSIA apron stands + slow taxi animation + GSE fleet.
 * Aircraft are procedural and locked to WGS84 stand / taxi coords.
 */
export function createAircraftOpsLayer(dataset, opts = {}) {
  const group = new THREE.Group();
  group.name = "aircraftOps";

  const stations = dataset.corridor?.stations || [];
  const stands = dataset.osm?.stands || [];
  const taxiRoutes = dataset.osm?.taxiRoutes || [];
  if (!stands.length && !taxiRoutes.length) return { group, update() {}, setVisible() {} };
  const lite = !!opts.lite;
  const standLimit = lite ? Math.min(stands.length, 24) : stands.length;
  const taxiLimit = lite ? Math.min(taxiRoutes.length, 2) : taxiRoutes.length;

  const aircraft = [];
  const gse = [];
  const template = buildAircraftTemplate();

  for (let si = 0; si < standLimit; si++) {
    const stand = stands[si];
    const local = lonLatToLocal(stand.lon, stand.lat, 0);
    if (!Number.isFinite(local.x) || !Number.isFinite(local.z)) continue;
    const y = terrainHeightAt(local.x, local.z, stations) + 0.2;
    const scale = TYPE_SCALE[stand.type] || 1;
    const root = template.clone(true);
    root.name = `ac-${stand.id}`;
    root.position.set(local.x, y, local.z);
    root.rotation.y = THREE.MathUtils.degToRad(90 - (Number(stand.hdg) || 0));
    root.scale.setScalar(scale);
    root.userData.stand = stand;
    root.userData.kind = "parked";
    enableNavLights(root);
    group.add(root);
    aircraft.push(root);

    if (stand.type === "ga") continue;
    const hdg = THREE.MathUtils.degToRad(90 - (Number(stand.hdg) || 0));
    const fleet = [
      buildGseTruck("#c9a227", "#3a6ea5"),
      buildGseBus(),
      buildBaggageCart(),
      buildFuelTanker(),
    ];
    const pick = fleet[si % fleet.length];
    const side = (si % 2 === 0 ? 1 : -1) * (24 + (si % 3) * 4);
    const forward = 10 + (si % 4) * 3;
    pick.position.set(
      local.x + Math.cos(hdg) * forward + Math.sin(hdg) * side,
      y,
      local.z + Math.sin(hdg) * forward - Math.cos(hdg) * side,
    );
    pick.rotation.y = hdg + Math.PI / 2;
    pick.userData.kind = "gse";
    pick.userData.homeX = pick.position.x;
    pick.userData.homeZ = pick.position.z;
    pick.userData.phase = si * 0.7;
    group.add(pick);
    gse.push(pick);
  }

  for (let i = 0; i < taxiLimit; i++) {
    const route = taxiRoutes[i];
    const pts = (route.coordinates || [])
      .map(([lon, lat]) => {
        const local = lonLatToLocal(lon, lat, 0);
        return {
          x: local.x,
          z: local.z,
          y: terrainHeightAt(local.x, local.z, stations) + 0.2,
        };
      })
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
    if (pts.length < 2) continue;
    const root = template.clone(true);
    root.name = `taxi-${route.id || i}`;
    root.scale.setScalar(0.95 + (i % 2) * 0.2);
    root.userData.kind = "taxi";
    root.userData.path = pts;
    root.userData.t = (i * 0.37) % 1;
    root.userData.speed = 0.01 + i * 0.003;
    enableNavLights(root);
    placeOnPath(root, pts, root.userData.t);
    group.add(root);
    aircraft.push(root);
  }

  console.info("[aircraftOps]", { parked: stands.length, taxi: taxiRoutes.length, gse: gse.length });

  return {
    group,
    update(dt) {
      const time = performance.now() * 0.001;
      for (const ac of aircraft) {
        const lights = ac.userData.navLights || [];
        for (const L of lights) {
          const on = Math.sin(time * L.freq + L.phase) > 0.35;
          L.mat.emissiveIntensity = on ? L.on : L.off;
        }
        if (ac.userData.kind !== "taxi") continue;
        const path = ac.userData.path;
        if (!path?.length) continue;
        ac.userData.t = (ac.userData.t + ac.userData.speed * dt) % 1;
        placeOnPath(ac, path, ac.userData.t);
      }
      // Subtle service-loop drift (not random teleport).
      for (let i = 0; i < gse.length; i++) {
        const v = gse[i];
        const ph = v.userData.phase || 0;
        v.position.x = v.userData.homeX + Math.sin(time * 0.22 + ph) * 4.5;
        v.position.z = v.userData.homeZ + Math.cos(time * 0.18 + ph) * 3.2;
      }
    },
    setVisible(on) {
      group.visible = !!on;
    },
  };
}

function placeOnPath(obj, path, t) {
  const total = path.length - 1;
  const f = t * total;
  const i = Math.min(total - 1, Math.floor(f));
  const u = f - i;
  const a = path[i];
  const b = path[i + 1];
  obj.position.set(
    a.x + (b.x - a.x) * u,
    a.y + (b.y - a.y) * u,
    a.z + (b.z - a.z) * u,
  );
  obj.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
}

function buildAircraftTemplate() {
  const root = new THREE.Group();
  root.name = "aircraftTemplate";

  const bodyMat = new THREE.MeshStandardMaterial({
    color: "#e8eef4",
    roughness: 0.38,
    metalness: 0.42,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: "#1f4a7a",
    roughness: 0.45,
    metalness: 0.3,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: "#1a1e24",
    roughness: 0.7,
    metalness: 0.2,
  });
  const windowMat = new THREE.MeshStandardMaterial({
    color: "#1a3048",
    roughness: 0.15,
    metalness: 0.6,
    emissive: "#0a1828",
    emissiveIntensity: 0.25,
  });

  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.4, 38, 12), bodyMat);
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.y = 3.2;
  fuselage.castShadow = true;
  root.add(fuselage);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(2.1, 12, 8), bodyMat);
  nose.position.set(19, 3.2, 0);
  nose.scale.set(1.4, 1, 1);
  root.add(nose);

  const windows = new THREE.Mesh(new THREE.BoxGeometry(22, 0.55, 3.9), windowMat);
  windows.position.set(2, 3.6, 0);
  root.add(windows);

  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 8, 8), bodyMat);
  tailCone.rotation.z = -Math.PI / 2;
  tailCone.position.set(-22, 3.2, 0);
  root.add(tailCone);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(10, 0.45, 34), accentMat);
  wing.position.set(1, 2.6, 0);
  wing.castShadow = true;
  root.add(wing);

  const stab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.35, 12), accentMat);
  stab.position.set(-20, 4.2, 0);
  root.add(stab);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(5, 7, 0.4), accentMat);
  fin.position.set(-20, 7.2, 0);
  root.add(fin);

  const engL = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 5, 8), darkMat);
  engL.rotation.z = Math.PI / 2;
  engL.position.set(2, 1.4, -8);
  root.add(engL);
  const engR = engL.clone();
  engR.position.z = 8;
  root.add(engR);

  for (const z of [0, -6, 6]) {
    const gear = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.2, 6), darkMat);
    gear.position.set(z === 0 ? 8 : 0, 1.1, z);
    root.add(gear);
  }

  return root;
}

function enableNavLights(root) {
  const lights = [];
  const mk = (x, y, z, color, freq, phase) => {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.2,
      roughness: 0.4,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 6), mat);
    mesh.position.set(x, y, z);
    root.add(mesh);
    lights.push({ mat, freq, phase, on: 1.4, off: 0.15 });
  };
  mk(0, 3.2, 17, "#ff3030", 3.2, 0);
  mk(0, 3.2, -17, "#30ff60", 3.2, 1.5);
  mk(-20, 10, 0, "#ffffff", 1.6, 0.4);
  root.userData.navLights = lights;
}

function buildGseTruck(bodyColor = "#c9a227", cabColor = "#3a6ea5") {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 1.4, 1.6),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.7, metalness: 0.15 }),
  );
  body.position.y = 1;
  g.add(body);
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.55),
    new THREE.MeshStandardMaterial({ color: cabColor, roughness: 0.55, metalness: 0.2 }),
  );
  cab.position.set(1.2, 1.7, 0);
  g.add(cab);
  return g;
}

function buildGseBus() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(7.5, 2.6, 2.4),
    new THREE.MeshStandardMaterial({ color: "#d8dde4", roughness: 0.55, metalness: 0.2 }),
  );
  body.position.y = 1.5;
  g.add(body);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(6.4, 1.1, 2.35),
    new THREE.MeshStandardMaterial({
      color: "#2a4058",
      roughness: 0.2,
      metalness: 0.5,
      transparent: true,
      opacity: 0.85,
    }),
  );
  glass.position.set(0.2, 2.3, 0);
  g.add(glass);
  return g;
}

function buildBaggageCart() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: "#c45c28", roughness: 0.75, metalness: 0.1 });
  for (let i = 0; i < 3; i++) {
    const cart = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 1.2), mat);
    cart.position.set(-i * 2.1, 0.7, 0);
    g.add(cart);
  }
  return g;
}

function buildFuelTanker() {
  const g = new THREE.Group();
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 2.0, 2.0),
    new THREE.MeshStandardMaterial({ color: "#d4a017", roughness: 0.6, metalness: 0.2 }),
  );
  cab.position.set(2.4, 1.2, 0);
  g.add(cab);
  const tank = new THREE.Mesh(
    new THREE.CylinderGeometry(1.05, 1.05, 5.5, 10),
    new THREE.MeshStandardMaterial({ color: "#e8e0c8", roughness: 0.45, metalness: 0.35 }),
  );
  tank.rotation.z = Math.PI / 2;
  tank.position.set(-0.6, 1.3, 0);
  g.add(tank);
  return g;
}
