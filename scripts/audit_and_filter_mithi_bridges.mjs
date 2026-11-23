/**
 * Audit + filter Mithi OSM bridges for geographical accuracy.
 *
 * Rules (strict):
 *  - Deck centerline = ORIGINAL OSM coordinates only (or the water-crossing
 *    subset of those same vertices — never invented bank-to-bank geometry).
 *  - bridge=yes alone is insufficient; require water intersection evidence
 *    OR an explicit verified EXISTING id.
 *  - Status: EXISTING | UNDER_CONSTRUCTION | PROPOSED | UNVERIFIED
 *  - Default 3D scene renders EXISTING only.
 *
 * Writes:
 *  - public/data/mithi/mithi_bridge_audit.json
 *  - public/data/mithi/mithi_osm_bridges.json
 *  - public/data/mithi/bridges.geojson
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "../public/data/mithi");
const CORRIDOR = path.join(DATA, "osm_mithi_corridor.json");
const AOI = path.join(DATA, "mithi_river.kml");
const OUT_AUDIT = path.join(DATA, "mithi_bridge_audit.json");
const OUT_PACK = path.join(DATA, "mithi_osm_bridges.json");
const OUT_GEO = path.join(DATA, "bridges.geojson");

const M_PER_DEG_LAT = 110540;
const MIN_WATER_M = 25;
const DEDUPE_M = 40;

/**
 * Manually verified against OSM + known Mumbai infrastructure / press.
 * Only these may render as completed bridges (plus dual carriageway peers).
 */
const VERIFIED = {
  // Mahim Causeway — EXISTING (BMC widening/rebuild in progress beside it)
  "46417981": { status: "EXISTING", label: "Mahim Causeway", note: "Historic causeway over Mithi; BMC arch rebuild underway beside existing deck" },
  "48803916": { status: "EXISTING", label: "Mahim Causeway", note: "Dual carriageway of Mahim Causeway" },
  // Western Express Highway river crossing at Mahim
  "46417986": { status: "EXISTING", label: "Western Express Highway", note: "WEH carriageway bridge over Mithi near Mahim" },
  "46417988": { status: "EXISTING", label: "Western Express Highway", note: "WEH dual carriageway over Mithi near Mahim" },
  // Railways Mahim–Bandra
  "107295496": { status: "EXISTING", label: "Western Railway", note: "WR slow lines Bridge No.20 over Mithi (recently reconstructed)" },
  "436692571": { status: "EXISTING", label: "Western Railway", note: "WR parallel track bridge over Mithi" },
  "436692573": { status: "EXISTING", label: "Western Railway", note: "WR parallel track bridge over Mithi" },
  "107295497": { status: "EXISTING", label: "Central Railway Harbour Line", note: "Harbour Line bridge over Mithi near Mahim/Bandra" },
  "107295478": { status: "EXISTING", label: "Central Railway Harbour Line", note: "Harbour Line parallel span" },
  // Sion–Bandra Link Road (Dharavi corridor crossing)
  "107295495": { status: "EXISTING", label: "Sion–Bandra Link Road", note: "Sion–Bandra Link Road over Mithi (Dharavi corridor)" },
  "151938283": { status: "EXISTING", label: "Sion–Bandra Link Road", note: "Dual carriageway of Sion–Bandra Link Road" },
  // BKC road crossings
  "27055934": { status: "EXISTING", label: "Bandra Kurla Complex Road", note: "BKC Road western Mithi crossing" },
  "49037280": { status: "EXISTING", label: "Bandra Kurla Complex Road", note: "BKC Road western dual carriageway" },
  "260786314": { status: "EXISTING", label: "Bandra Kurla Complex Road", note: "BKC Road eastern Mithi crossing" },
  "260786315": { status: "EXISTING", label: "Bandra Kurla Complex Road", note: "BKC Road eastern dual carriageway" },
  // SCLR / Santa Cruz–Chembur
  "1158399732": { status: "EXISTING", label: "Santa Cruz–Chembur Link Road", note: "SCLR trunk bridge over Mithi" },
  "1158399734": { status: "EXISTING", label: "Santa Cruz–Chembur Link Road", note: "SCLR dual carriageway" },
  "1122421036": { status: "EXISTING", label: "SCLR Flyover", note: "SCLR flyover span over Mithi (water-crossing segment of OSM way)" },
  // Kalina–Kurla
  "436370623": { status: "EXISTING", label: "Kalina–Kurla Road", note: "Kalina–Kurla Road over Mithi" },
  "1509555862": { status: "EXISTING", label: "Kalina–Kurla Road", note: "Kalina–Kurla dual carriageway" },
  // BKC Connector elevated road (existing elevated connector; clip to water)
  "618038082": { status: "EXISTING", label: "BKC Connector", note: "BKC Connector elevated way — water-crossing OSM segment only" },
  "746615682": { status: "EXISTING", label: "BKC Connector", note: "BKC Connector dual — water-crossing OSM segment only" },
  "1562122423": { status: "EXISTING", label: "BKC–SCLR Connector", note: "BKC–SCLR connector — water-crossing OSM segment only" },
  "1330234680": { status: "EXISTING", label: "BKC Bridge", note: "Mapped BKC Bridge OSM way over Mithi" },
};

/** Known non-bridge / weak evidence — force UNVERIFIED even if tagged bridge=yes */
const FORCE_UNVERIFIED = new Set([
  "990567496", // anonymous road stub
  "367484575", // residential
  "1122421034", // 2.6 km elevated trunk; only tiny AOI nick — not a discrete river bridge object
]);

/** Proposed (not built as completed structure in default scene) */
const PROPOSED = {
  // BMC Mahim–Bandra flyover over Mithi — tenders/planning, not completed
};

function mLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
function distM(a, b) {
  const lat = (a[1] + b[1]) / 2;
  return Math.hypot((b[0] - a[0]) * mLon(lat), (b[1] - a[1]) * M_PER_DEG_LAT);
}
function lineLengthM(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += distM(coords[i - 1], coords[i]);
  return s;
}
function midpoint(coords) {
  const half = lineLengthM(coords) / 2;
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = distM(coords[i - 1], coords[i]);
    if (walked + seg >= half) {
      const t = seg > 0 ? (half - walked) / seg : 0;
      return {
        lon: coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        lat: coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      };
    }
    walked += seg;
  }
  return { lon: coords[0][0], lat: coords[0][1] };
}
function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const inter = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}
function cross2(ax, ay, bx, by) {
  return ax * by - ay * bx;
}
function interpolateCoord(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function segmentRingIntersections(a, b, ring) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const ts = [0, 1];
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1];
    const d = ring[i];
    const sx = d[0] - c[0];
    const sy = d[1] - c[1];
    const den = cross2(rx, ry, sx, sy);
    if (Math.abs(den) < 1e-14) continue;
    const t = cross2(c[0] - a[0], c[1] - a[1], sx, sy) / den;
    const u = cross2(c[0] - a[0], c[1] - a[1], rx, ry) / den;
    if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) {
      ts.push(Math.max(0, Math.min(1, t)));
    }
  }
  return [...new Set(ts.map((t) => Number(t.toFixed(12))))].sort((x, y) => x - y);
}
function waterOverlapM(coords, ring) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const ts = segmentRingIntersections(a, b, ring);
    for (let j = 1; j < ts.length; j++) {
      const mid = interpolateCoord(a, b, (ts[j - 1] + ts[j]) * 0.5);
      if (pointInPolygon(mid[0], mid[1], ring)) {
        total += distM(interpolateCoord(a, b, ts[j - 1]), interpolateCoord(a, b, ts[j]));
      }
    }
  }
  return total;
}
/** Longest contiguous in-water run using ONLY original OSM vertices/interpolations on those segments. */
function clipToWaterCrossing(coords, ring) {
  const runs = [];
  let active = null;
  const close = () => {
    if (active?.length >= 2) runs.push(active);
    active = null;
  };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const ts = segmentRingIntersections(a, b, ring);
    for (let j = 1; j < ts.length; j++) {
      const t0 = ts[j - 1];
      const t1 = ts[j];
      if (t1 - t0 < 1e-12) continue;
      const mid = interpolateCoord(a, b, (t0 + t1) * 0.5);
      if (!pointInPolygon(mid[0], mid[1], ring)) {
        close();
        continue;
      }
      const start = interpolateCoord(a, b, t0);
      const end = interpolateCoord(a, b, t1);
      const last = active?.[active.length - 1];
      if (!last || distM(last, start) > 0.5) {
        close();
        active = [start];
      }
      if (distM(active[active.length - 1], end) > 0.05) active.push(end);
    }
  }
  close();
  runs.sort((a, b) => lineLengthM(b) - lineLengthM(a));
  return runs[0] || null;
}
function parseAoi(kmlPath) {
  const kml = fs.readFileSync(kmlPath, "utf8");
  const blocks = [];
  const re = /<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi;
  let m;
  while ((m = re.exec(kml))) {
    const pts = m[1]
      .trim()
      .split(/\s+/)
      .map((tok) => {
        const [lon, lat] = tok.split(",").map(Number);
        return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
      })
      .filter(Boolean);
    if (pts.length) blocks.push(pts);
  }
  blocks.sort((a, b) => b.length - a.length);
  return blocks[0];
}
function widthFor(b) {
  if (Number.isFinite(b.widthM) && b.widthM > 0) return b.widthM;
  if (b.railway) return 9;
  const hw = b.highway || "";
  if (hw === "motorway") return 18;
  if (hw === "trunk") return 16;
  if (hw === "primary") return 14;
  if (hw === "secondary") return 12;
  return 10;
}

function classify(b, waterM, srcLen) {
  const id = String(b.id);
  if (FORCE_UNVERIFIED.has(id)) {
    return { status: "UNVERIFIED", label: b.name || `Bridge ${id}`, note: "Insufficient evidence of a discrete river bridge; excluded from default scene" };
  }
  if (PROPOSED[id]) return { ...PROPOSED[id], status: "PROPOSED" };
  if (VERIFIED[id]) return { ...VERIFIED[id] };
  // Unlisted: only EXISTING if strong water evidence + named major class
  if (waterM >= MIN_WATER_M && srcLen <= 400 && (b.railway || /motorway|trunk|primary|secondary/.test(b.highway || "")) && b.name && !/^Bridge /.test(b.name)) {
    return { status: "UNVERIFIED", label: b.name, note: "Has water intersection but not on verified EXISTING whitelist — hidden until confirmed" };
  }
  return { status: "UNVERIFIED", label: b.name || `Bridge ${id}`, note: "Not verified against satellite / infrastructure records" };
}

function main() {
  const corridor = JSON.parse(fs.readFileSync(CORRIDOR, "utf8"));
  const aoi = parseAoi(AOI);
  const bridgesIn = corridor.bridges || [];
  const audit = [];
  const candidates = [];

  for (const b of bridgesIn) {
    const id = String(b.id);
    const src = (b.coordinates || []).map((c) => [c[0], c[1]]);
    if (src.length < 2) continue;
    if (b.highway === "construction" || b.railway === "construction") continue;
    if (b.highway === "footway" || b.highway === "path" || b.highway === "steps") continue;

    const srcLen = lineLengthM(src);
    const waterM = waterOverlapM(src, aoi);
    const verified = VERIFIED[id] || FORCE_UNVERIFIED.has(id) || PROPOSED[id];
    const cls = classify(b, waterM, srcLen);

    // Deck geometry: original OSM only. For long elevated ways, keep water-crossing subset.
    let deckCoords = src;
    let geometryMode = "OSM_FULL";
    if (srcLen > 350 && waterM >= MIN_WATER_M) {
      const clip = clipToWaterCrossing(src, aoi);
      if (clip && lineLengthM(clip) >= MIN_WATER_M) {
        deckCoords = clip;
        geometryMode = "OSM_WATER_CLIP";
      }
    }

    // Satellite-confirmed WEH may have 0 AOI overlap (AOI edge) — keep original OSM.
    if (waterM < MIN_WATER_M && !VERIFIED[id]) {
      audit.push({
        osmId: id,
        name: b.name || null,
        highway: b.highway || null,
        railway: b.railway || null,
        status: cls.status,
        decision: "REJECT_NO_WATER",
        srcLenM: Math.round(srcLen),
        waterOverlapM: Math.round(waterM),
        note: cls.note,
      });
      continue;
    }

    const mid = midpoint(deckCoords);
    const isRail = !!b.railway || b.highway === "railway";
    const row = {
      osmId: id,
      name: cls.label,
      highway: isRail ? "railway" : b.highway || "road",
      railway: b.railway || (isRail ? "rail" : null),
      bridge: b.bridge || "yes",
      status: cls.status,
      note: cls.note,
      srcLenM: Math.round(srcLen * 10) / 10,
      deckLenM: Math.round(lineLengthM(deckCoords) * 10) / 10,
      waterOverlapM: Math.round(waterM * 10) / 10,
      geometryMode,
      midpoint: mid,
      coords: deckCoords,
      sourceCoords: src,
      widthM: widthFor(b),
      verifiedListed: !!VERIFIED[id],
    };

    audit.push({
      osmId: id,
      name: row.name,
      highway: row.highway,
      railway: row.railway,
      status: row.status,
      decision: row.status === "EXISTING" ? "KEEP_EXISTING" : row.status === "UNVERIFIED" ? "HIDE_UNVERIFIED" : row.status,
      srcLenM: row.srcLenM,
      deckLenM: row.deckLenM,
      waterOverlapM: row.waterOverlapM,
      geometryMode,
      midpoint: mid,
      note: row.note,
      first: src[0],
      last: src[src.length - 1],
    });

    if (row.status === "EXISTING" || row.status === "UNDER_CONSTRUCTION" || row.status === "PROPOSED") {
      candidates.push(row);
    }
  }

  // Deduplicate EXISTING clusters: keep up to 2 dual carriageways / twin rails per location.
  candidates.sort((a, b) => {
    const rank = (s) => (s === "EXISTING" ? 0 : s === "UNDER_CONSTRUCTION" ? 1 : 2);
    return rank(a.status) - rank(b.status) || b.waterOverlapM - a.waterOverlapM;
  });
  const kept = [];
  for (const c of candidates) {
    const cRail = !!c.railway;
    const peers = kept.filter((d) => {
      if (!!d.railway !== cRail) return false;
      return distM([d.midpoint.lon, d.midpoint.lat], [c.midpoint.lon, c.midpoint.lat]) < DEDUPE_M;
    });
    if (!peers.length) {
      kept.push(c);
      continue;
    }
    // Mahim rail corridor has multiple parallel EXISTING tracks (WR + Harbour).
    // Roads: allow one dual-carriageway peer. Rails: allow up to 4 parallel spans.
    const maxPeers = cRail ? 4 : 2;
    const sameFamily = peers.some(
      (d) => d.name === c.name || d.highway === c.highway || (cRail && d.railway && c.railway),
    );
    if (peers.length < maxPeers && sameFamily) {
      kept.push(c);
      continue;
    }
    const a = audit.find((x) => x.osmId === c.osmId);
    if (a) {
      a.decision = "REJECT_DUPLICATE";
      a.note = `${a.note || ""} | Duplicate near ${peers.map((p) => p.osmId).join(",")}`;
    }
  }

  kept.sort((a, b) => a.midpoint.lon - b.midpoint.lon || a.midpoint.lat - b.midpoint.lat);

  const pack = kept.map((b, i) => ({
    id: b.osmId,
    osmId: b.osmId,
    name: b.name,
    bridgeType: b.railway ? "railway" : "girder",
    highway: b.highway,
    railway: b.railway,
    widthM: b.widthM,
    lengthM: b.deckLenM,
    sourceWayLengthM: b.srcLenM,
    waterOverlapM: b.waterOverlapM,
    status: b.status,
    verificationNote: b.note,
    geometryMode: b.geometryMode,
    midpoint: { lat: b.midpoint.lat, lon: b.midpoint.lon },
    coords: b.coords,
    sourceCoords: b.sourceCoords,
    source: "MITHI_OSM",
    provenance: "ORIGINAL_OSM_CENTERLINE",
  }));

  const existingCount = pack.filter((b) => b.status === "EXISTING").length;
  const report = {
    generatedAt: new Date().toISOString(),
    river: "Mithi",
    policy: {
      geometry: "Original OSM LineString only (optional water-clip of same way)",
      defaultRender: "EXISTING only",
      inventedBankToBank: false,
      osmPerpCross: false,
    },
    summary: {
      corridorBridgesScanned: bridgesIn.length,
      audited: audit.length,
      packTotal: pack.length,
      existing: existingCount,
      underConstruction: pack.filter((b) => b.status === "UNDER_CONSTRUCTION").length,
      proposed: pack.filter((b) => b.status === "PROPOSED").length,
      unverifiedHidden: audit.filter((b) => b.status === "UNVERIFIED" || b.decision === "REJECT_NO_WATER" || b.decision === "REJECT_DUPLICATE").length,
    },
    features: audit.sort((a, b) => (a.midpoint?.lon || 0) - (b.midpoint?.lon || 0)),
    rendered: pack.map((b) => ({
      osmId: b.osmId,
      name: b.name,
      status: b.status,
      lengthM: b.lengthM,
      waterOverlapM: b.waterOverlapM,
      geometryMode: b.geometryMode,
    })),
  };

  fs.writeFileSync(OUT_AUDIT, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    OUT_PACK,
    JSON.stringify(
      {
        river: "Mithi",
        note: "Geographically verified OSM bridges — original centerlines only; EXISTING rendered by default",
        bridges: pack,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    OUT_GEO,
    JSON.stringify(
      {
        type: "FeatureCollection",
        features: pack.map((b) => ({
          type: "Feature",
          properties: {
            osmId: b.osmId,
            name: b.name,
            status: b.status,
            highway: b.highway,
            railway: b.railway,
            lengthM: b.lengthM,
            waterOverlapM: b.waterOverlapM,
          },
          geometry: { type: "LineString", coordinates: b.coords },
        })),
      },
      null,
      2,
    ),
  );

  console.info("\n========== MITHI BRIDGE AUDIT ==========");
  console.info(JSON.stringify(report.summary, null, 2));
  console.info("\nRENDERED (default scene = EXISTING):");
  for (const b of pack) {
    console.info(`  [${b.status}] ${b.osmId}  ${b.name}  ${b.lengthM}m  water=${b.waterOverlapM}m  ${b.geometryMode}`);
  }
  console.info("\nREJECTED / HIDDEN:");
  for (const a of audit.filter((x) => x.decision !== "KEEP_EXISTING" && x.decision !== "UNDER_CONSTRUCTION" && x.decision !== "PROPOSED")) {
    if (pack.some((p) => p.osmId === a.osmId)) continue;
    console.info(`  [${a.status || a.decision}] ${a.osmId}  ${a.name || "—"}  ${a.decision}  ${a.note || ""}`);
  }
  console.info("\nWrote", OUT_AUDIT);
  console.info("Wrote", OUT_PACK);
}

main();
