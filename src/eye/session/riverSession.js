/** In-memory river session. The uploaded KML is posted once; results stay on this object. */

const session = {
  /** Twin + JalNetra AOI — real mithi_river.kml polygon (never the box KML). */
  kmlText: "",
  /** Optional alternate API KML; normally unused (same as kmlText). */
  apiKmlText: "",
  filename: "mithi_river.kml",
  riverName: "River",
  start_date: "",
  end_date: "",
  centroid: null,
  catchmentKm2: null,
  mainStemKml: "",
  fishingKmlText: "",
  results: {},
  errors: {},
  pending: {},
  /** endpointId → "YYYY-MM|YYYY-MM|…" so same silt dates skip refetch */
  siltDateFingerprints: {},
};

export function getRiverSession() {
  return session;
}

export function bindRiverSession(next) {
  Object.assign(session, {
    kmlText: next.kmlText || "",
    apiKmlText: next.apiKmlText || "",
    filename: next.filename || "river.kml",
    riverName: next.riverName || "River",
    start_date: next.start_date || "",
    end_date: next.end_date || "",
    centroid: next.centroid || null,
    catchmentKm2: next.catchmentKm2 ?? null,
    mainStemKml: next.mainStemKml || "",
    fishingKmlText: next.fishingKmlText || "",
    results: next.results || {},
    errors: next.errors || {},
    pending: next.pending || {},
    siltDateFingerprints: next.siltDateFingerprints || {},
  });
  window.__RIVER_SESSION__ = session;
  return session;
}

export function patchRiverSession(partial) {
  Object.assign(session, partial);
  window.__RIVER_SESSION__ = session;
  return session;
}

window.__RIVER_SESSION__ = session;
