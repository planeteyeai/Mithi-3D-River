/**
 * Casino vessels layer — disabled for Mithi (Mandovi/Goa ships removed).
 * Keeps a no-op API so world.js / ships UI keep working.
 */
import * as THREE from "three";

export function createCasinoShipsLayer(_scene, _dataset) {
  const group = new THREE.Group();
  group.name = "casinoShips";
  group.visible = false;

  return {
    group,
    ready: Promise.resolve(),
    setVisible() {},
    isVisible() {
      return false;
    },
    setThematicSuppressed() {},
    pick() {
      return null;
    },
    select() {},
    update() {},
    dispose() {
      group.clear();
    },
  };
}
