import "./eye/style.css";
import "./eye/styles/gis-ui.css";
import "./eye/weather/weather.css";
import "./eye/styles/layers-panel.css";
import "./eye/styles/silt-pro.css";
import "./upload.css";

import { createWorld } from "./eye/scene/world.js";
import { createTooltip, mountCinematicOverlays, mountUI } from "./eye/ui/overlay.js";
import { createLoadingScene } from "./eye/loadingScene.js";
import { FALLBACK_WEATHER_LL } from "./eye/services/weatherService.js";
import { AQI_FALLBACK_LL } from "./eye/services/aqiService.js";
import { bindRiverSession } from "./eye/session/riverSession.js";
import {
  jalnetraEndpointIds,
  runJalNetra,
  hydrateHistoryIntoSession,
  tifDownloadUrl,
} from "./eye/session/jalnetraClient.js";
import { clearLiveOverlay } from "./eye/session/liveLayers.js";
import { buildDatasetFromKml, prepareRiverUpload } from "./eye/geo/datasetFromKml.js";
import { loadFabdemDtmWithTimeout } from "./eye/geo/dtm.js";
import { ensureMainBodCodLive } from "./eye/services/mainBodCodService.js";
import { ensureBodCodPixels } from "./eye/services/bodCodPixelService.js";

const DB_NAME = "planet-eye-mithi";
const STORE = "session";

function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function yesterday() {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}
function shiftDays(ymdText, days) {
  const [y, m, d] = ymdText.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + days));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadSaved() {
  try {
    const db = await openDb();
    const saved = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get("current");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    // Drop cached box-AOI sessions — twin must use real mithi_river.kml only.
    if (saved?.kmlText && /box polygon|Silt AOI/i.test(saved.kmlText)) {
      console.warn("[boot] Ignoring saved box KML session; using mithi_river.kml");
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

async function saveSession(session) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(
        {
          kmlText: session.kmlText,
          filename: session.filename,
          riverName: session.riverName,
          start_date: session.start_date,
          end_date: session.end_date,
          centroid: session.centroid,
          catchmentKm2: session.catchmentKm2,
          mainStemKml: session.mainStemKml,
          fishingKmlText: session.fishingKmlText,
          results: session.results,
          errors: session.errors,
          siltDateFingerprints: session.siltDateFingerprints || {},
          ring: session.ring,
          line: session.line,
        },
        "current",
      );
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("Could not store the river session", err);
  }
}

async function clearSaved() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete("current");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function watchRiverName(name) {
  let label = String(name || "Mithi River").trim();
  label = label.replace(/\s+points\b/gi, "").replace(/\s+river\b/gi, "").trim();
  const title = label.toUpperCase();
  const apply = (node) => {
    if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) return;
    const next = node.nodeValue.replace(/mula[\s\u2013\u2014-]*mutha/gi, title);
    if (next !== node.nodeValue) node.nodeValue = next;
  };
  const walk = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      apply(n);
      n = walker.nextNode();
    }
  };
  const brand = document.getElementById("river-name-label");
  if (brand) brand.textContent = `${title} RIVER`;
  const heading = document.getElementById("load-title");
  if (heading) heading.textContent = `${title.split(/\s+[–—-]\s+/)[0].trim()} RIVER 3D`;
  document.title = `${label} — Planet Eye AI River Intelligence`;
  walk(document.body);
  const obs = new MutationObserver(() => walk(document.body));
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });
}

function formatJalnetraLabel(id) {
  return String(id || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "Layer";
}

/**
 * Brief one-at-a-time JalNetra toast above river-stage HUD:
 * white medium text, red underline while fetching, green underline when loaded (~1s), then hide.
 */
function statusPill() {
  let el = document.getElementById("api-status");
  if (!el) {
    el = document.createElement("div");
    el.id = "api-status";
    document.body.appendChild(el);
  }
  el.className = "jalnetra-layer-toast";
  el.setAttribute("aria-live", "polite");
  el.hidden = true;

  // Prefer sitting above river-stage / brand telemetry once UI mounts.
  const host =
    document.getElementById("ui-root") ||
    document.getElementById("hud-brand")?.parentElement ||
    document.body;
  if (el.parentElement !== host) host.appendChild(el);

  const ids = jalnetraEndpointIds();
  const states = Object.fromEntries(ids.map((id) => [id, "wait"]));
  let hideTimer = 0;
  let flashTimer = 0;
  let currentId = null;

  const remaining = () =>
    ids.filter((id) => states[id] === "wait" || states[id] === "running").length;

  const clearTimers = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = 0;
    }
  };

  const hideSoon = (ms = 900) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("is-fetching", "is-loaded", "is-failed");
      el.textContent = "";
      hideTimer = 0;
    }, ms);
  };

  const showLine = (text, mode) => {
    clearTimers();
    el.hidden = false;
    el.classList.remove("is-fetching", "is-loaded", "is-failed");
    el.classList.add(mode);
    el.textContent = text;
  };

  return {
    update(evt) {
      const id = evt?.id;
      if (!id) return;
      // Track main-bod-cod too even if not in batch list
      if (!(id in states)) states[id] = "wait";

      // Instant DB/session paint — mark ready so UI isn't stuck on "wait".
      if (evt.hydrated || (evt.ok === true && evt.fromCache && evt.state == null && !evt.live)) {
        states[id] = "ok";
        if (!currentId) {
          showLine(`Ready · ${formatJalnetraLabel(id)} (saved)`, "is-loaded");
          hideSoon(700);
        }
        return;
      }

      if (evt.state === "running" || evt.state === "pending") {
        states[id] = "running";
        currentId = id;
        const left = Math.max(0, remaining() - 1);
        const rem = left > 0 ? ` · ${left} remaining` : "";
        const verb = evt.refreshing ? "Updating" : "Fetching";
        showLine(`${verb} · ${formatJalnetraLabel(id)}${rem}`, "is-fetching");
        return;
      }

      if (evt.state === "ok" || evt.ok === true) {
        states[id] = "ok";
        currentId = id;
        const label = formatJalnetraLabel(id);
        const text = evt.fromCache
          ? `Saved · ${label}`
          : evt.liveReplace
            ? `Updated · ${label}`
            : `Loaded · ${label}`;
        showLine(text, "is-loaded");
        // Brief success flash, then clear unless another fetch starts.
        flashTimer = setTimeout(() => {
          flashTimer = 0;
          if (currentId === id && states[id] === "ok") hideSoon(200);
        }, 1000);
        return;
      }

      if (evt.state === "error") {
        states[id] = "error";
        currentId = id;
        showLine(`Failed · ${formatJalnetraLabel(id)}`, "is-failed");
        flashTimer = setTimeout(() => {
          flashTimer = 0;
          if (currentId === id && states[id] === "error") hideSoon(200);
        }, 1100);
      }
    },
    show() {
      // Don't keep a continuous summary on screen — wait for first endpoint event.
      el.hidden = true;
    },
  };
}

async function getDefaultMandoviRiver() {
  try {
    // Real river outline only — never mithi_river_box / bbox substitutes.
    const res = await fetch(`/data/mithi/mithi_river.kml?v=${Date.now()}`);
    if (!res.ok) throw new Error("Could not fetch default KML");
    const text = await res.text();
    if (/box polygon/i.test(text)) {
      throw new Error("Default KML is still the box polygon — replace public/data/mithi/mithi_river.kml");
    }
    const maxDay = yesterday();
    const initialResults = {};
    try {
      const [wqRes, wdRes] = await Promise.all([
        fetch("/data/mithi/water_quality.json"),
        fetch("/data/mithi/water_depth.json"),
      ]);
      if (wqRes.ok) initialResults["water-quality"] = await wqRes.json();
      if (wdRes.ok) initialResults["water-depth"] = await wdRes.json();
    } catch {}
    return {
      saved: false,
      fileText: text,
      filename: "mithi_river.kml",
      start_date: shiftDays(maxDay, -29),
      end_date: maxDay,
      initialResults,
    };
  } catch (err) {
    console.warn("Default KML fetch error", err);
    return null;
  }
}

function askForKml(saved) {
  const gate = document.getElementById("upload-gate");
  const loading = document.getElementById("loading");
  const endInput = document.getElementById("kml-end");
  const savedBox = document.getElementById("saved-river");
  loading.classList.add("hidden");
  gate.hidden = false;
  const maxDay = yesterday();
  endInput.max = maxDay;
  endInput.value = maxDay;
  if (saved?.riverName) {
    savedBox.hidden = false;
    savedBox.innerHTML = `<p>Saved river: <strong>${saved.riverName}</strong></p><button type="button" class="gate-continue gate-go" id="continue-river">Continue ${saved.riverName}</button>`;
  }
  return new Promise((resolve) => {
    document.getElementById("continue-river")?.addEventListener("click", () => {
      gate.hidden = true;
      loading.classList.remove("hidden");
      resolve({ saved: true });
    });
    document.getElementById("upload-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = document.getElementById("kml-file").files?.[0];
      if (!file) return;
      let end = endInput.value || maxDay;
      if (end >= ymd(new Date())) end = maxDay;
      const start = shiftDays(end, -29);
      const text = await file.text();
      gate.hidden = true;
      loading.classList.remove("hidden");
      resolve({
        saved: false,
        fileText: text,
        filename: file.name,
        start_date: start,
        end_date: end,
      });
    });
  });
}

async function dtmFromBody(dataset, body) {
  if (!body) return null;
  const refs = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.tif_id || node.tif_download_url || node.download_url) refs.push(node);
    if (Array.isArray(node)) node.forEach(walk);
    else Object.values(node).forEach((v) => {
      if (v && typeof v === "object") walk(v);
    });
  };
  walk(body);
  const ref = refs[0];
  const url = tifDownloadUrl("fabdem-dtm", ref?.tif_download_url || ref?.download_url || ref?.tif_id);
  if (!url) return null;
  return loadFabdemDtmWithTimeout(
    url,
    dataset.frame,
    dataset.corridor,
    () => {},
    120000,
    { maxSampleDim: 512 },
  );
}

async function maybeDtm(dataset, session) {
  // First load prebundled high-res Mithi FABDEM DTM with full 3D topography
  try {
    const localDtm = await loadFabdemDtmWithTimeout(
      "/data/mithi/fabdem_dtm.tif",
      dataset.frame,
      dataset.corridor,
      () => {},
      15000,
      { maxSampleDim: 512 }
    );
    if (localDtm) {
      dataset.dtm = localDtm;
      console.info("Loaded high-resolution Mithi FABDEM DTM:", localDtm);
      return;
    }
  } catch (err) {
    console.warn("Local DTM load notice:", err.message);
  }

  const body = session.results?.["fabdem-dtm"];
  if (!body) return;
  try {
    dataset.dtm = await dtmFromBody(dataset, body);
  } catch (err) {
    console.warn("FABDEM terrain skipped", err.message);
  }
}

function pointWeather(session) {
  if (session?.centroid) {
    FALLBACK_WEATHER_LL.lat = session.centroid.lat;
    FALLBACK_WEATHER_LL.lon = session.centroid.lon;
    AQI_FALLBACK_LL.lat = session.centroid.lat;
    AQI_FALLBACK_LL.lon = session.centroid.lon;
  } else {
    // Mithi River, Mumbai, Maharashtra
    FALLBACK_WEATHER_LL.lat = 19.0665;
    FALLBACK_WEATHER_LL.lon = 72.8569;
    AQI_FALLBACK_LL.lat = 19.0665;
    AQI_FALLBACK_LL.lon = 72.8569;
  }
}

async function boot() {
  const loading = document.getElementById("loading");
  const loadMsg = document.getElementById("load-msg");
  const loadBar = document.getElementById("load-bar");
  const loadPercent = document.getElementById("load-percent");
  const canvas = document.getElementById("scene");
  const uiRoot = document.getElementById("ui-root");
  const loadingScene = createLoadingScene(document.getElementById("loading-scene"));
  const pill = statusPill();

  let target = 0;
  let shown = 0;
  let frame = 0;
  function paint() {
    shown += (target - shown) * 0.12;
    if (Math.abs(target - shown) < 0.08) shown = target;
    if (loadBar) loadBar.style.width = `${shown}%`;
    if (loadPercent) loadPercent.textContent = `${Math.round(shown)}%`;
    if (shown !== target || !loading.classList.contains("hidden")) frame = requestAnimationFrame(paint);
    else frame = 0;
  }
  function progress(p, msg) {
    target = Math.max(0, Math.min(100, Number(p) * 100));
    if (msg && loadMsg) loadMsg.textContent = msg;
    if (!frame) frame = requestAnimationFrame(paint);
  }

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const forceUpload = urlParams.get("upload") === "true";

    const saved = await loadSaved();
    let choice = null;

    if (!forceUpload) {
      const defaultChoice = await getDefaultMandoviRiver();
      if (defaultChoice) {
        choice = defaultChoice;
      } else if (saved?.kmlText) {
        choice = { saved: true };
      }
    }

    if (!choice) {
      choice = await askForKml(saved);
    }

    let prepared;
    let session;
    if (choice.saved && saved?.kmlText) {
      prepared = prepareRiverUpload(saved.kmlText, saved.filename);
      const kmlChanged = prepared.kmlText !== saved.kmlText;
      const results = kmlChanged ? {} : { ...(saved.results || {}) };
      const errors = kmlChanged ? {} : { ...(saved.errors || {}) };
      // Keep saved JalNetra bodies (incl. lithology / WQ / pollution) so reload
      // does not re-queue every live API and stick on the fetch wait toast.
      for (const id of ["bank-erosion", "water-depth", "lulc", "silt", "silt-classification", "silt-volume"]) {
        if (/GeometryCollection|Unsupported geometry/i.test(String(errors[id] || ""))) {
          delete results[id];
          delete errors[id];
        }
      }
      // Drop legacy combined silt cache — classification + volume are separate routes now.
      if (results.silt && !results["silt-classification"]) {
        results["silt-classification"] = results.silt;
      }
      delete results.silt;
      delete errors.silt;
      clearLiveOverlay();
      session = bindRiverSession({
        ...prepared,
        riverName: prepared.riverName || "Mithi River",
        start_date: saved.start_date,
        end_date: saved.end_date,
        results,
        errors,
        siltDateFingerprints: kmlChanged ? {} : { ...(saved.siltDateFingerprints || {}) },
        fishingKmlText: kmlChanged ? "" : (saved.fishingKmlText || ""),
        pending: {},
      });
    } else {
      prepared = prepareRiverUpload(choice.fileText, choice.filename);
      clearLiveOverlay();
      session = bindRiverSession({
        ...prepared,
        riverName: prepared.riverName || "Mithi River",
        start_date: choice.start_date,
        end_date: choice.end_date,
        results: choice.initialResults || {},
        errors: {},
        siltDateFingerprints: {},
        pending: {},
      });
    }

    watchRiverName(session.riverName);
    if (!session.results["water-depth"]) {
      try {
        const wdRes = await fetch("/data/mithi/water_depth.json");
        if (wdRes.ok) session.results["water-depth"] = await wdRes.json();
      } catch {}
    }
    pointWeather(session);
    pill.show();
    // 1) Paint latest DB/session immediately  2) Background live refresh swaps in when ready.
    void hydrateHistoryIntoSession(session)
      .then((h) => {
        for (const id of h?.filled || []) {
          pill.update({ id, ok: true, fromCache: true, hydrated: true });
        }
      })
      .catch(() => {})
      .finally(() => {
        runJalNetra((evt) => {
          pill.update(evt);
          if (evt.state === "ok" || evt.state === "error") saveSession(session);
        });
      });

    progress(0.15, `Reading ${session.riverName}…`);
    const dataset = await buildDatasetFromKml(prepared, progress);
    window.__RIVER_DATASET__ = dataset;

    // Default BOD/COD pixels open immediately; live main-bod-cod runs in background
    // without fighting the one-by-one JalNetra toast queue.
    void ensureBodCodPixels().catch((err) => {
      console.warn("[boot] default BOD/COD KML", err?.message || err);
    });

    void ensureMainBodCodLive({ chainage: dataset.chainage })
      .then((live) => {
        if (session.results) {
          session.results["main-bod-cod"] = {
            fetchedAt: live.fetchedAt,
            summary: live.summary,
            streams: live.streams,
            points: live.series?.length || 0,
            source: "POST /api/main-bod-cod",
          };
          saveSession(session);
        }
      })
      .catch((err) => {
        console.warn("[boot] main-bod-cod", err?.message || err);
      });

    progress(0.45, "Loading full 3D elevation topography…");
    await maybeDtm(dataset, session);

    progress(0.85, "Constructing 3D river digital twin…");

    const tooltip = createTooltip(uiRoot);
    mountCinematicOverlays(uiRoot, dataset);
    let sceneReady = false;
    const app = await createWorld(canvas, dataset, tooltip, {
      onCoreReady() {
        if (sceneReady) return;
        sceneReady = true;
        progress(1, "Ready");
        loading.classList.add("hidden");
        loadingScene.setVisible(false);
      },
    });
    if (!sceneReady) {
      progress(1, "Ready");
      loading.classList.add("hidden");
      loadingScene.setVisible(false);
    }

    mountUI(uiRoot, {
      dataset,
      onCamera: (mode) => app.setCamera(mode),
      onCompass: (dir) => app.rotateCompass(dir),
      onResetOrientation: () => app.resetOrientation(),
      onZoomIn: () => app.zoomIn(),
      onZoomOut: () => app.zoomOut(),
      onStartWaterFlow: () => app.startWaterFlow(),
      onTogglePauseWaterFlow: () => app.togglePauseWaterFlow(),
      isCinematicActive: () => app.isCinematicActive(),
      isCinematicPaused: () => app.isCinematicPaused(),
    });

    // Upload / Change KML control removed from the brand bar (Mandovi is fixed).
    watchRiverName(session.riverName);
    if (!session.results["water-depth"]) {
      try {
        const wdRes = await fetch("/data/mithi/water_depth.json");
        if (wdRes.ok) session.results["water-depth"] = await wdRes.json();
      } catch {}
    }

    let last = performance.now();
    let budget = 0;
    function loop(now) {
      requestAnimationFrame(loop);
      const raw = (now - last) / 1000;
      last = now;
      const q = app.getQuality?.() || { targetFps: 60 };
      const minDt = 1 / Math.max(20, q.targetFps || 60);
      budget += raw;
      if (budget < minDt * 0.92) return;
      const dt = Math.min(0.05, budget);
      budget = 0;
      app.update(dt);
    }
    requestAnimationFrame(loop);
    saveSession(session);
  } catch (err) {
    console.error(err);
    if (loadMsg) loadMsg.textContent = err?.message || String(err);
    target = 100;
    if (loadBar) {
      loadBar.style.width = "100%";
      loadBar.style.background = "#c45";
    }
  }
}

boot();
