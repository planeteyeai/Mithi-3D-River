/**
 * Adaptive render quality — shared/remote sessions struggle with full GPU settings.
 *
 * Force modes via URL:
 *   ?quality=low    — phones / weak GPU / 8 GB integrated
 *   ?quality=medium — default smooth profile (most users)
 *   ?quality=high   — max detail (powerful local GPU)
 *
 * Runtime: setTier() + noteFrame() auto-downgrade when FPS tanks.
 */

function isLikelySharedOrRemote() {
  const h = location.hostname || "";
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;
  return true;
}

export function isLowMemoryDevice() {
  const memoryGb = Number(navigator.deviceMemory || 0);
  const cores = Number(navigator.hardwareConcurrency || 0);
  const narrowTouchDevice = navigator.maxTouchPoints > 0 && window.innerWidth < 900;
  return (memoryGb > 0 && memoryGb <= 4) || (cores > 0 && cores <= 4) || narrowTouchDevice;
}

/** 8 GB / integrated-class — prefer medium-low defaults when no force flag. */
export function isMidLowLaptop() {
  const memoryGb = Number(navigator.deviceMemory || 0);
  return memoryGb > 0 && memoryGb <= 8 && !isLowMemoryDevice();
}

function readForcedTier() {
  const q = new URLSearchParams(location.search);
  const v = (q.get("quality") || q.get("perf") || "").toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  return null;
}

/** Map render tier → water shader quality preset (geometry unchanged). */
export function waterQualityForTier(tier) {
  if (tier === "low") return "low";
  if (tier === "medium") return "medium";
  return "high";
}

export function createQualityProfile() {
  const forced = readForcedTier();
  // Default medium for smooth UX; low on weak/remote; mid-low laptops stay medium
  let tier =
    forced ||
    (isLowMemoryDevice() || isLikelySharedOrRemote() ? "low" : "medium");

  const settings = () => profileFor(tier);

  let fpsSamples = [];
  let lastAdapt = 0;
  /** @type {Array<(tier: string, profile: object) => void>} */
  const listeners = [];

  function emit() {
    const p = settings();
    for (const fn of listeners) {
      try {
        fn(tier, p);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  return {
    get tier() {
      return tier;
    },
    get forced() {
      return !!forced;
    },
    get() {
      return settings();
    },
    /** Subscribe to tier changes (setTier / auto-adapt). */
    onChange(fn) {
      if (typeof fn === "function") listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    /**
     * Switch quality tier at runtime. Returns applied profile.
     * URL-forced tiers still allow explicit setTier (user Settings).
     */
    setTier(next) {
      const n = String(next || "").toLowerCase();
      const mapped = n === "balanced" ? "medium" : n;
      if (mapped !== "low" && mapped !== "medium" && mapped !== "high") {
        return settings();
      }
      if (mapped === tier) return settings();
      tier = mapped;
      fpsSamples = [];
      console.info(`[perf] Quality → ${tier}`);
      emit();
      return settings();
    },
    /** Call once per rendered frame with dt seconds. Auto-downgrades if FPS tanks. */
    noteFrame(dt) {
      if (forced || tier === "low") return;
      if (!dt || dt <= 0 || dt > 0.25) return;
      const fps = 1 / dt;
      fpsSamples.push(fps);
      if (fpsSamples.length > 40) fpsSamples.shift();
      const now = performance.now();
      if (now - lastAdapt < 2000 || fpsSamples.length < 25) return;
      lastAdapt = now;
      const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
      if (avg < 32 && tier === "high") {
        tier = "medium";
        fpsSamples = [];
        console.info("[perf] Auto quality → medium (avg FPS", avg.toFixed(0), ")");
        emit();
      } else if (avg < 26 && tier === "medium") {
        tier = "low";
        fpsSamples = [];
        console.info("[perf] Auto quality → low (avg FPS", avg.toFixed(0), ")");
        emit();
      }
    },
  };
}

function profileFor(tier) {
  if (tier === "low") {
    return {
      tier,
      pixelRatioMax: 1,
      antialias: false,
      shadows: false,
      shadowMapSize: 512,
      preserveDrawingBuffer: false,
      targetFps: 30,
      labelHz: 6,
      lodHz: 4,
      chainageHz: 8,
      coordLabelHz: 3,
      softShadow: false,
      maxTrees: 1200,
      maxVegTypeTrees: 1800,
      treeShadows: false,
      enableVegApi: false,
      enableFishing: false,
      vegTypeStepM: 72,
      lightTreesOnly: true,
      waterQuality: "low",
      aerowayExtras: false,
      aerowayDensifyM: 16,
      buildingHeroMax: 120,
      buildingNearMax: 2500,
      buildingMidMax: 6000,
    };
  }
  if (tier === "medium") {
    return {
      tier,
      pixelRatioMax: isMidLowLaptop() ? 1.05 : 1.15,
      antialias: true,
      shadows: false,
      shadowMapSize: 1024,
      preserveDrawingBuffer: false,
      targetFps: 50,
      labelHz: 10,
      lodHz: 6,
      chainageHz: 12,
      coordLabelHz: 5,
      softShadow: false,
      maxTrees: 2800,
      maxVegTypeTrees: 3500,
      treeShadows: false,
      enableVegApi: false,
      enableFishing: true,
      vegTypeStepM: 55,
      lightTreesOnly: true,
      waterQuality: "medium",
      aerowayExtras: true,
      aerowayDensifyM: 12,
      buildingHeroMax: 400,
      buildingNearMax: 6000,
      buildingMidMax: 12000,
    };
  }
  return {
    tier: "high",
    pixelRatioMax: 1.25,
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    preserveDrawingBuffer: false,
    targetFps: 60,
    labelHz: 16,
    lodHz: 10,
    chainageHz: 24,
    coordLabelHz: 10,
    softShadow: true,
    maxTrees: 4500,
    maxVegTypeTrees: 5500,
    treeShadows: true,
    enableVegApi: true,
    enableFishing: true,
    vegTypeStepM: 45,
    lightTreesOnly: true,
    waterQuality: "high",
    aerowayExtras: true,
    aerowayDensifyM: 8,
    buildingHeroMax: 600,
    buildingNearMax: 8000,
    buildingMidMax: 18000,
  };
}

/** Simple rate limiter: returns true when enough time elapsed. */
export function createThrottle(hz) {
  let acc = 0;
  let interval = 1 / Math.max(1, hz);
  return {
    setHz(h) {
      interval = 1 / Math.max(1, h);
    },
    ready(dt) {
      acc += dt;
      if (acc < interval) return false;
      acc = 0;
      return true;
    },
  };
}
