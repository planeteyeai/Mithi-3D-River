/**
 * Fetch CSIA / Santa Cruz aeroway + hangar/terminal footprints for Mithi twin.
 * Writes public/data/mithi/osm_mithi_aeroway.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../public/data/mithi/osm_mithi_aeroway.json");

/** Extends north of corridor pack so CSIA runway / apron are included. */
const BOUNDS = {
  west: 72.833,
  south: 19.078,
  east: 72.885,
  north: 19.0985,
};

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function wayCoords(el) {
  return (el.geometry || [])
    .map((g) => [Number(g.lon), Number(g.lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function aerowayWidth(kind, tags = {}) {
  const w = Number(String(tags.width || "").replace(/m$/i, ""));
  if (Number.isFinite(w) && w > 0) return w;
  if (kind === "runway") return 45;
  if (kind === "taxiway") return 18;
  if (kind === "apron") return 40;
  if (kind === "hangar") return 24;
  return 12;
}

async function fetchJson(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function main() {
  const b = `${BOUNDS.south},${BOUNDS.west},${BOUNDS.north},${BOUNDS.east}`;
  const query = `[out:json][timeout:180];
(
  way["aeroway"~"^(runway|taxiway|apron|hangar|terminal)$"](${b});
  way["building"~"^(hangar|terminal|transportation)$"](${b});
  way["building"="yes"]["name"~"(?i)hangar|terminal|aviation|airport"](${b});
);
out body geom;`;

  let data = null;
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      console.info("[aeroway] try", url);
      data = await fetchJson(url, query);
      console.info("[aeroway] ok elements=", (data.elements || []).length);
      break;
    } catch (err) {
      lastErr = err;
      console.warn("[aeroway]", err?.message || err);
    }
  }
  if (!data) {
    console.warn("[aeroway] Overpass unavailable — writing curated CSIA fallback");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [path.join(__dirname, "write_csia_aeroway_fallback.mjs")], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw lastErr || new Error("Overpass unavailable and fallback failed");
    return;
  }

  const aeroway = [];
  const buildings = [];
  for (const el of data.elements || []) {
    if (el.type !== "way") continue;
    const tags = el.tags || {};
    const coords = wayCoords(el);
    if (coords.length < 2) continue;

    const kind = String(tags.aeroway || "").toLowerCase();
    if (kind === "runway" || kind === "taxiway" || kind === "apron") {
      aeroway.push({
        id: String(el.id),
        name: tags.name || tags.ref || kind,
        aeroway: kind,
        surface: tags.surface || "asphalt",
        widthM: aerowayWidth(kind, tags),
        coordinates: coords,
      });
      continue;
    }

    if (
      kind === "hangar" ||
      /hangar|terminal|transportation/i.test(tags.building || "") ||
      /hangar|terminal|aviation|airport/i.test(tags.name || "")
    ) {
      if (coords.length >= 3) {
        buildings.push({
          id: String(el.id),
          name: tags.name || "",
          building: tags.building || kind || "hangar",
          aeroway: kind || null,
          amenity: tags.amenity || null,
          levels: tags["building:levels"] || tags.levels || null,
          heightM: tags.height ? Number(tags.height) : null,
          coordinates: coords,
        });
      }
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: "OPENSTREETMAP",
    note: "CSIA / Santa Cruz aeroway for Mithi twin",
    bounds: BOUNDS,
    aeroway,
    buildings,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.info("[aeroway] wrote", OUT, {
    aeroway: aeroway.length,
    buildings: buildings.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
