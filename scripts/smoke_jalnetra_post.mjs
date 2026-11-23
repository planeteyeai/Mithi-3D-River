/**
 * Quick smoke: POST a tiny Mithi bbox to a few JalNetra endpoints.
 * Confirms the live server accepts multipart KML (not just GET routes).
 */
const base = "https://jalnetra-software-production.up.railway.app";
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<Polygon><outerBoundaryIs><LinearRing>
<coordinates>72.85,19.04,0 72.87,19.04,0 72.87,19.06,0 72.85,19.06,0 72.85,19.04,0</coordinates>
</LinearRing></outerBoundaryIs></Polygon>
</Placemark></Document></kml>`;

async function post(path, extra = {}, timeoutMs = 60000) {
  const form = new FormData();
  form.append("kml", new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }), "probe.kml");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const text = await res.text();
    let keys = null;
    try {
      keys = Object.keys(JSON.parse(text) || {}).slice(0, 12);
    } catch {
      keys = null;
    }
    return {
      path,
      status: res.status,
      ms: Date.now() - started,
      ok: res.ok,
      keys,
      head: text.slice(0, 160).replace(/\s+/g, " "),
    };
  } catch (err) {
    return {
      path,
      status: 0,
      ms: Date.now() - started,
      ok: false,
      error: err.name || err.message,
    };
  } finally {
    clearTimeout(t);
  }
}

const results = [];
// Fast-ish probes (EE jobs may still take tens of seconds)
results.push(await post("/api/fishing-point", {}, 90000));
results.push(
  await post(
    "/api/flood-water-dated",
    { start_date: "2026-10-01", end_date: "2026-10-07" },
    90000,
  ),
);
results.push(await post("/api/water-depth", { depth_min_m: "1.5", depth_max_m: "8.0" }, 90000));

console.log(JSON.stringify({ health: "see prior", results }, null, 2));
