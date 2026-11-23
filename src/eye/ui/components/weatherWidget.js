import { CloudSun } from "lucide";
import { lucideHtml } from "../icons.js";
import { fetchWeatherAt } from "../../services/weatherService.js";
import {
  fetchBodCodViewerData,
  buildBodCodTimeline,
  defaultTimeIndex,
  sampleReachAt,
} from "../../services/bodCodService.js";
import {
  ensureBodCodPixels,
  sampleBodCodAtChainage,
  sampleBodCodAtLonLat,
} from "../../services/bodCodPixelService.js";
import { getMainBodCodStatus } from "../../services/mainBodCodService.js";
import { getLiveDischargeAtChainage } from "../../services/forecastService.js";
import { getCachedLiveHydrology } from "../../services/hydrology/liveHydrologyService.js";
import { activeRiverPoint, areaTimeZone } from "../../services/areaLive.js";
import { mountWeatherOverview } from "../../weather/WeatherOverview.js";
import { streamBodCodAtPoint } from "../../data/streamsBodCod.js";
import { state } from "../../state.js";

/**
 * Top-right LIVE WEATHER + always-on BOD/COD + chainage-live discharge.
 * Weather icon opens Open-Meteo past/future detail graphs.
 */
export function mountWeatherWidget(root) {
  const el = document.createElement("aside");
  el.className = "hud weather-widget map-chrome";
  el.id = "weather-widget";
  el.innerHTML = `
    <button type="button" class="weather-icon" id="weather-icon-btn" title="Open live weather details" aria-label="Open live weather details">
      ${lucideHtml(CloudSun, { size: 18 })}
    </button>
    <button type="button" class="weather-wq" id="weather-wq-open" aria-label="Live BOD and COD at selected chainage" title="Open BOD–COD along the river">
      <div class="weather-wq-row is-bod">
        <i data-short="BOD">BOD</i>
        <b id="weather-bod">—</b>
        <em>mg/L</em>
      </div>
      <div class="weather-wq-row is-cod">
        <i data-short="COD">COD</i>
        <b id="weather-cod">—</b>
        <em>mg/L</em>
      </div>
    </button>
    <button type="button" class="weather-copy weather-copy-btn" id="weather-open-detail" title="Open live weather details">
      <strong>LIVE WEATHER</strong>
      <b id="weather-temp" class="weather-temp">— °C</b>
      <i id="weather-condition" class="weather-condition">Weather unavailable</i>
      <small id="weather-wind">Wind —</small>
      <small id="weather-location">Station —</small>
    </button>
    <div class="weather-time-block" aria-label="Local date and time">
      <time class="weather-date" datetime="">—</time>
      <time class="weather-time" datetime="">--:--</time>
    </div>
  `;
  root.appendChild(el);

  const detail = mountWeatherOverview(root);
  /** @type {{ lat?:number, lon?:number, label?:string } | null} */
  let lastPoint = null;

  const dateEl = el.querySelector(".weather-date");
  const time = el.querySelector(".weather-time");
  const temperature = el.querySelector("#weather-temp");
  const condition = el.querySelector("#weather-condition");
  const wind = el.querySelector("#weather-wind");
  const location = el.querySelector("#weather-location");
  const dischargeEl = el.querySelector("#weather-discharge");
  const dischargeUnitEl = el.querySelector("#weather-discharge-unit");
  const bodEl = el.querySelector("#weather-bod");
  const codEl = el.querySelector("#weather-cod");

  let requestTimer = 0;
  let requestSerial = 0;
  let lastSuccessful = "";
  let weatherAvailable = false;

  /** @type {object | null} */
  let bodData = null;
  let bodTimeline = { dates: [], historyCount: 0, forecastCount: 0 };
  let bodTimeIndex = 0;
  let lastMeters = null;
  let bodLoadPromise = null;
  let dischargeSerial = 0;
  /** @type {object | null} Selected joining stream — BOD/COD from its lat/lon (or stream table). */
  let lastJoiningRec = null;
  /** Exact BOD/COD from last river click (keeps top bar in sync with popup). */
  let lastClickWq = null;

  const zone = (() => {
    const p = activeRiverPoint();
    const z = p ? areaTimeZone(p.lat, p.lon) : "Asia/Kolkata";
    return z === "auto" ? undefined : z;
  })();
  const dateFmt = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: zone,
  });
  const timeFmt = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: zone,
  });

  const update = () => {
    const now = new Date();
    const iso = now.toISOString();
    dateEl.dateTime = iso;
    dateEl.textContent = dateFmt.format(now);
    if (!weatherAvailable && lastSuccessful) return;
    time.dateTime = iso;
    time.textContent = timeFmt.format(now);
  };
  update();
  const timer = window.setInterval(update, 1000);
  const weatherRefreshTimer = window.setInterval(() => {
    if (lastPoint) updateForChainage(lastPoint);
  }, 5 * 60 * 1000);

  function chainagePoints() {
    return window.__MM_DATASET__?.chainage || window.__MM_SCENE__?.dataset?.chainage || [];
  }

  function ensureBodData() {
    if (bodData?.reaches?.length) return Promise.resolve(bodData);
    if (bodLoadPromise) return bodLoadPromise;
    bodLoadPromise = (async () => {
      // Pixel CSV first — must not wait on Landsat main-bod-cod (can take minutes).
      await ensureBodCodPixels().catch((err) => {
        console.warn("[weather-wq] pixel CSV", err?.message || err);
        return null;
      });
      renderBodCod();
      const data = await fetchBodCodViewerData().catch((err) => {
        console.warn("[weather-wq]", err?.message || err);
        return null;
      });
      if (data?.reaches?.length) {
        // Prefer live JalNetra; otherwise keep first good local load.
        const liveSrc = data._source === "main-bod-cod" || data._viewerId === "main-bod-cod";
        if (liveSrc || !bodData?.reaches?.length) {
          bodData = data;
          bodTimeline = buildBodCodTimeline(data);
          bodTimeIndex = defaultTimeIndex(bodTimeline);
        }
      }
      renderBodCod();
      return bodData || data;
    })().finally(() => {
      bodLoadPromise = null;
    });
    return bodLoadPromise;
  }

  /** Immediate WQ refresh — never blocked by the long live API promise. */
  function refreshBodCodNow() {
    void ensureBodCodPixels()
      .catch(() => null)
      .then(() => renderBodCod());
  }

  function reachAtMeters(meters) {
    const list = bodData?.reaches || [];
    if (!list.length) return null;
    const m = Number(meters);
    if (!Number.isFinite(m)) return list[0];
    const km = m / 1000;
    for (const r of list) {
      const [a, b] = Array.isArray(r.km) ? r.km : [0, 2];
      if (km >= Number(a) && km <= Number(b) + 1e-6) return r;
    }
    let best = list[0];
    let bestD = Infinity;
    for (const r of list) {
      const [a, b] = Array.isArray(r.km) ? r.km : [0, 2];
      const mid = (Number(a) + Number(b)) / 2;
      const d = Math.abs(mid - km);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  function joiningStreamLabel(rec) {
    const raw = String(
      rec?.displayName || rec?.meta?.name || rec?.meta?.nameEn || rec?.name || "",
    ).trim();
    if (!raw || /^unnamed\b/i.test(raw)) return "Joining stream";
    return raw;
  }

  function applyJoiningStreamBodCod(rec) {
    if (!bodEl && !codEl) return false;
    if (!rec) return false;

    const lon = Number(rec.outletLon);
    const lat = Number(rec.outletLat);
    const q = streamBodCodAtPoint(rec, lon, lat);
    if (q) {
      const bodV = Number.isFinite(q.bod) ? q.bod : q.bodMean;
      const codV = Number.isFinite(q.cod) ? q.cod : q.codMean;
      if (bodEl) {
        bodEl.textContent = formatMetricNumber(bodV, 1);
        bodEl.title = `BOD · ${q.name || joiningStreamLabel(rec)} (joining stream)`;
      }
      if (codEl) {
        codEl.textContent = formatMetricNumber(codV, 1);
        codEl.title = `COD · ${q.name || joiningStreamLabel(rec)} (joining stream)`;
      }
      return true;
    }

    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      const fromLl = sampleBodCodAtLonLat(lon, lat);
      if (fromLl) {
        if (bodEl) {
          bodEl.textContent = formatMetricNumber(fromLl.bod, 1);
          bodEl.title = `BOD at joining stream ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
        if (codEl) {
          codEl.textContent = formatMetricNumber(fromLl.cod, 1);
          codEl.title = `COD at joining stream ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
        return true;
      }
    }
    return false;
  }

  function applyExactWq(hit, tip) {
    if (!hit) return false;
    const hasBod = Number.isFinite(hit.bod);
    const hasCod = Number.isFinite(hit.cod);
    if (!hasBod && !hasCod) return false;
    if (bodEl) {
      bodEl.textContent = formatMetricNumber(hit.bod, 1);
      bodEl.title = tip || "BOD at clicked river point";
    }
    if (codEl) {
      codEl.textContent = formatMetricNumber(hit.cod, 1);
      codEl.title = tip || "COD at clicked river point";
    }
    return true;
  }

  function renderBodCod() {
    if (!bodEl && !codEl) return;

    // Joining Streams: prefer that stream's table / outlet lat-lon BOD·COD.
    if (state.joiningStreamsMode && lastJoiningRec && applyJoiningStreamBodCod(lastJoiningRec)) {
      return;
    }

    // River click: show the same BOD/COD as the inspect popup.
    if (
      lastClickWq &&
      applyExactWq(
        lastClickWq,
        Number.isFinite(lastClickWq.lat) && Number.isFinite(lastClickWq.lon)
          ? `BOD/COD at click ${Number(lastClickWq.lat).toFixed(5)}, ${Number(lastClickWq.lon).toFixed(5)}`
          : "BOD/COD at clicked river point",
      )
    ) {
      return;
    }

    const meters =
      lastMeters != null
        ? lastMeters
        : Number.isFinite(state.selectedChainageMeters)
          ? state.selectedChainageMeters
          : 0;

    // Prefer exact click / station lat-lon, then chainage sample.
    const chain = chainagePoints();
    const liveLoading = getMainBodCodStatus() === "loading";
    const fromLl =
      Number.isFinite(lastPoint?.lat) && Number.isFinite(lastPoint?.lon)
        ? sampleBodCodAtLonLat(lastPoint.lon, lastPoint.lat)
        : null;
    const fromChain = sampleBodCodAtChainage(chain, meters);
    const hit =
      (fromLl?.source === "main-bod-cod" &&
      (Number.isFinite(fromLl.bod) || Number.isFinite(fromLl.cod))
        ? fromLl
        : null) ||
      (fromChain?.source === "main-bod-cod" &&
      (Number.isFinite(fromChain.bod) || Number.isFinite(fromChain.cod))
        ? fromChain
        : null) ||
      (fromLl && (Number.isFinite(fromLl.bod) || Number.isFinite(fromLl.cod)) ? fromLl : null) ||
      (fromChain && (Number.isFinite(fromChain.bod) || Number.isFinite(fromChain.cod))
        ? fromChain
        : null);

    if (hit) {
      const live = hit.source === "main-bod-cod";
      const tip = live
        ? hit.interpolated
          ? "BOD/COD live (neighbour average between samples)"
          : "BOD/COD live from JalNetra main-bod-cod"
        : liveLoading
          ? hit.source === "default-kml"
            ? "Default main-bod-cod pixels · live Landsat still loading…"
            : "Survey grid while live BOD/COD loads from JalNetra…"
          : hit.source === "default-kml"
            ? "Default main-bod-cod pixel KML"
            : "BOD/COD survey grid (fallback)";
      if (bodEl) {
        bodEl.textContent = formatMetricNumber(hit.bod, 1);
        bodEl.title = tip;
      }
      if (codEl) {
        codEl.textContent = formatMetricNumber(hit.cod, 1);
        codEl.title = tip;
      }
      return;
    }
    if (liveLoading) {
      if (bodEl) {
        bodEl.textContent = "…";
        bodEl.title = "Loading live BOD/COD from JalNetra…";
      }
      if (codEl) {
        codEl.textContent = "…";
        codEl.title = "Loading live COD from JalNetra…";
      }
      return;
    }

    if (!bodData?.reaches?.length) {
      if (bodEl) bodEl.textContent = "—";
      if (codEl) codEl.textContent = "—";
      return;
    }
    const reach = reachAtMeters(meters);
    const sample = sampleReachAt(reach, bodTimeIndex, bodData, bodTimeline);
    if (bodEl) bodEl.textContent = formatMetricNumber(sample?.p50, 1);
    if (codEl) codEl.textContent = formatMetricNumber(sample?.cod_p50, 1);
  }

  function updateFromJoiningStream(rec) {
    lastJoiningRec = rec || null;
    if (!rec) {
      refreshBodCodNow();
      void ensureBodData();
      return;
    }

    const lon = Number(rec.outletLon);
    const lat = Number(rec.outletLat);
    const label = joiningStreamLabel(rec);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      lastPoint = { lat, lon, label };
      detail.setPoint(lastPoint);
      location.textContent = `${label} · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    } else {
      location.textContent = label;
    }

    const meters = Number(rec.riverChainageMeters ?? rec.nearestChainageMeters);
    if (Number.isFinite(meters)) lastMeters = meters;

    refreshBodCodNow();
    void ensureBodData().then(() => {
      if (!applyJoiningStreamBodCod(lastJoiningRec)) renderBodCod();
    });
    void renderDischarge();
  }

  function formatMetricNumber(v, digits = 1) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return n.toFixed(digits);
  }

  async function renderDischarge() {
    const meters =
      lastMeters != null
        ? lastMeters
        : Number.isFinite(state.selectedChainageMeters)
          ? state.selectedChainageMeters
          : 0;
    const serial = ++dischargeSerial;
    try {
      const q = await getLiveDischargeAtChainage(meters);
      if (serial !== dischargeSerial) return;
      if (dischargeEl) {
        dischargeEl.textContent = formatMetricNumber(q, 1);
        const live = getCachedLiveHydrology();
        dischargeEl.title = live?.provenance?.discharge || `Discharge at this chainage`;
      }
      if (dischargeUnitEl) dischargeUnitEl.hidden = !Number.isFinite(q);
      document.dispatchEvent(
        new CustomEvent("chainage-discharge", { detail: { meters, q } }),
      );
    } catch (err) {
      if (serial !== dischargeSerial) return;
      console.warn("[weather-q]", err?.message || err);
      if (dischargeEl) {
        dischargeEl.textContent = "—";
        dischargeEl.title = "Discharge unavailable";
      }
      if (dischargeUnitEl) dischargeUnitEl.hidden = true;
    }
  }

  function updateBodCodForChainage(point) {
    lastMeters = point?.meters ?? state.selectedChainageMeters ?? null;
    const bod = Number(point?.bodMgL ?? point?.bod);
    const cod = Number(point?.codMgL ?? point?.cod);
    if (Number.isFinite(bod) || Number.isFinite(cod)) {
      lastClickWq = {
        bod: Number.isFinite(bod) ? bod : null,
        cod: Number.isFinite(cod) ? cod : null,
        lat: point?.lat,
        lon: point?.lon,
        meters: lastMeters,
        source: point?.source || "river-click",
      };
    } else {
      // Ruler / non-click chainage, or click without values — resample from lat/lon or chainage.
      lastClickWq = null;
    }
    // Chainage sync from joining-stream select must not wipe stream BOD/COD.
    if (!(state.joiningStreamsMode && lastJoiningRec)) {
      refreshBodCodNow();
      void ensureBodData();
    } else {
      refreshBodCodNow();
      void ensureBodData().then(() => {
        if (!applyJoiningStreamBodCod(lastJoiningRec)) renderBodCod();
      });
    }
    void renderDischarge();
  }

  function onWeatherWqAt(e) {
    const d = e?.detail || {};
    const bod = Number(d.bod);
    const cod = Number(d.cod);
    if (Number.isFinite(d.meters)) lastMeters = d.meters;
    if (Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
      lastPoint = {
        lat: d.lat,
        lon: d.lon,
        label: d.label || lastPoint?.label,
      };
      detail.setPoint(lastPoint);
      if (location && d.label) location.textContent = `Station ${d.label}`;
    }
    if (Number.isFinite(bod) || Number.isFinite(cod)) {
      lastClickWq = {
        bod: Number.isFinite(bod) ? bod : null,
        cod: Number.isFinite(cod) ? cod : null,
        lat: d.lat,
        lon: d.lon,
        meters: d.meters,
        source: d.source || "river-click",
      };
      applyExactWq(
        lastClickWq,
        Number.isFinite(d.lat) && Number.isFinite(d.lon)
          ? `BOD/COD at click ${Number(d.lat).toFixed(5)}, ${Number(d.lon).toFixed(5)}`
          : "BOD/COD at clicked river point",
      );
    } else {
      lastClickWq = null;
      refreshBodCodNow();
    }
  }

  function onBodCodTime(e) {
    if (Number.isFinite(e.detail?.timeIndex)) {
      bodTimeIndex = e.detail.timeIndex;
    }
    if (e.detail?.data?.reaches?.length) {
      bodData = e.detail.data;
      bodTimeline = buildBodCodTimeline(bodData);
    }
    renderBodCod();
  }

  document.addEventListener("bod-cod-time-change", onBodCodTime);

  function onMainBodCodReady(e) {
    // Live JalNetra main-bod-cod replaces local default pixels.
    const live = e?.detail;
    if (live?.reaches?.length) {
      bodData = live;
      bodTimeline = buildBodCodTimeline(live);
      bodTimeIndex = defaultTimeIndex(bodTimeline);
    }
    renderBodCod();
  }
  function onMainBodCodStatus() {
    renderBodCod();
  }
  document.addEventListener("main-bod-cod-ready", onMainBodCodReady);
  document.addEventListener("main-bod-cod-status", onMainBodCodStatus);

  function onBodCodDefaultReady() {
    refreshBodCodNow();
  }
  document.addEventListener("bod-cod-default-ready", onBodCodDefaultReady);

  function onJoiningStreamWq(e) {
    const rec = e.detail?.rec || null;
    const sample = e.detail?.sample || null;
    updateFromJoiningStream(rec);
    if (rec && sample && (bodEl || codEl)) {
      const bodV = Number.isFinite(sample.bod) ? sample.bod : sample.bodMean;
      const codV = Number.isFinite(sample.cod) ? sample.cod : sample.codMean;
      if (bodEl && Number.isFinite(bodV)) {
        bodEl.textContent = formatMetricNumber(bodV, 1);
        bodEl.title = `BOD · ${joiningStreamLabel(rec)} (original pixel)`;
      }
      if (codEl && Number.isFinite(codV)) {
        codEl.textContent = formatMetricNumber(codV, 1);
        codEl.title = `COD · ${joiningStreamLabel(rec)} (original pixel)`;
      }
    }
  }
  document.addEventListener("joining-stream-wq", onJoiningStreamWq);
  document.addEventListener("weather-wq-at", onWeatherWqAt);

  function updateForChainage(point) {
    const river = activeRiverPoint();
    const lat = Number(point?.lat);
    const lon = Number(point?.lon);
    const resolved = Number.isFinite(lat) && Number.isFinite(lon)
      ? point
      : river
        ? { ...point, lat: river.lat, lon: river.lon, label: point?.label || river.label }
        : point;
    // Keep joining-stream lat/lon as the weather station while a stream is selected.
    if (state.joiningStreamsMode && lastJoiningRec) {
      const jLon = Number(lastJoiningRec.outletLon);
      const jLat = Number(lastJoiningRec.outletLat);
      const jLabel = joiningStreamLabel(lastJoiningRec);
      if (Number.isFinite(jLat) && Number.isFinite(jLon)) {
        lastPoint = { lat: jLat, lon: jLon, label: jLabel };
        detail.setPoint(lastPoint);
        location.textContent = `${jLabel} · ${jLat.toFixed(5)}, ${jLon.toFixed(5)}`;
      } else {
        location.textContent = jLabel;
      }
    } else {
      lastPoint = resolved
        ? { lat: resolved.lat, lon: resolved.lon, label: resolved.label }
        : null;
      detail.setPoint(lastPoint);
      location.textContent = resolved?.label ? `Station ${resolved.label}` : (river?.label || "Station —");
    }
    updateBodCodForChainage(point);
    window.clearTimeout(requestTimer);
    const serial = ++requestSerial;
    requestTimer = window.setTimeout(async () => {
      try {
        const weather = await fetchWeatherAt(resolved?.lat, resolved?.lon);
        if (serial !== requestSerial) return;
        temperature.textContent =
          weather.temperature == null ? "— °C" : `${weather.temperature.toFixed(0)}°C`;
        condition.textContent = weather.condition || "Weather unavailable";
        wind.textContent = weather.wind == null ? "Wind —" : `Wind ${weather.wind.toFixed(0)} km/h`;
        lastSuccessful = time.textContent;
        weatherAvailable = true;
        window.__MM_SCENE__?.applyLiveWeather?.(weather);
        state.liveWeather = { ...weather, fetchedAt: new Date().toISOString(), label: point?.label ?? null };
        document.dispatchEvent(new CustomEvent("chainage-weather", { detail: state.liveWeather }));
      } catch (error) {
        if (error?.name === "AbortError" || serial !== requestSerial) return;
        weatherAvailable = false;
        state.liveWeather = { error: error?.message || "Weather unavailable", label: point?.label ?? null };
        document.dispatchEvent(new CustomEvent("chainage-weather", { detail: state.liveWeather }));
        temperature.textContent = "— °C";
        condition.textContent = "Weather unavailable";
        wind.textContent = "Wind —";
        time.textContent = lastSuccessful ? `Last ${lastSuccessful}` : "Unavailable";
        dateEl.textContent = dateFmt.format(new Date());
      }
    }, 600);
  }

  function openDetail() {
    void detail.show(lastPoint);
  }
  el.querySelector("#weather-icon-btn")?.addEventListener("click", openDetail);
  el.querySelector("#weather-open-detail")?.addEventListener("click", openDetail);
  el.querySelector("#weather-wq-open")?.addEventListener("click", (e) => {
    e.stopPropagation();
    document.dispatchEvent(
      new CustomEvent("open-bod-cod", {
        detail: {
          meters:
            lastMeters != null
              ? lastMeters
              : Number.isFinite(state.selectedChainageMeters)
                ? state.selectedChainageMeters
                : 0,
        },
      }),
    );
  });

  // Prefetch twin + live Q so numbers appear without waiting for Water Quality open
  void ensureBodData().then(() => renderBodCod());
  void renderDischarge();

  return {
    el,
    updateForChainage,
    updateFromJoiningStream,
    openDetail,
    dispose: () => {
      window.clearTimeout(requestTimer);
      window.clearInterval(timer);
      window.clearInterval(weatherRefreshTimer);
      document.removeEventListener("bod-cod-time-change", onBodCodTime);
      document.removeEventListener("main-bod-cod-ready", onMainBodCodReady);
      document.removeEventListener("main-bod-cod-status", onMainBodCodStatus);
      document.removeEventListener("bod-cod-default-ready", onBodCodDefaultReady);
      document.removeEventListener("joining-stream-wq", onJoiningStreamWq);
      document.removeEventListener("weather-wq-at", onWeatherWqAt);
      detail.dispose();
    },
  };
}
