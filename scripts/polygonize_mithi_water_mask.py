"""
Extract Sentinel-2 MNDWI water mask from src/data/water_depth (1).kml,
write public overlays + clean KML, polygonize to GeoJSON, emit validation report.

Authoritative upload (user 2026-11-19):
  Live Water - 2026-11-07 · Frequency 0.5 · Window 2026-10-13..2026-11-12
  Water area metadata: 72.48201756266876 ha · 1497×1428 · LatLonBox below
"""
from __future__ import annotations

import base64
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    import subprocess
    import sys

    subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow", "-q"])
    from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC_KML = ROOT / "src" / "data" / "water_depth (1).kml"
OUT = ROOT / "public" / "data" / "mithi"
VERIFY = ROOT / ".verify"

BOUNDS = {
    "north": 19.08782672,
    "south": 19.04514933,
    "east": 72.87929619,
    "west": 72.83456075,
}
KML_AREA_HA = 72.48201756266876
# Alpha threshold calibrated on the uploaded PNG (nearest metadata area, not forced).
MIN_ALPHA = 77


def parse_kml(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    name_m = re.search(r"<(?:[\w.]+:)?name>([^<]+)</(?:[\w.]+:)?name>", text, re.I)
    desc_m = re.search(
        r"<(?:[\w.]+:)?description>([^<]*)</(?:[\w.]+:)?description>", text, re.I
    )
    box = {}
    for k in ("north", "south", "east", "west"):
        m = re.search(rf"<(?:[\w.]+:)?{k}>([^<]+)</(?:[\w.]+:)?{k}>", text, re.I)
        if not m:
            raise RuntimeError(f"Missing LatLonBox.{k} in {path}")
        box[k] = float(m.group(1))
    href_m = re.search(r"<(?:[\w.]+:)?href>([^<]+)</(?:[\w.]+:)?href>", text, re.I)
    if not href_m:
        raise RuntimeError(f"Missing GroundOverlay href in {path}")
    href = href_m.group(1).strip()
    return {
        "doc_name": name_m.group(1) if name_m else path.name,
        "description": desc_m.group(1) if desc_m else "",
        "box": box,
        "href": href,
        "text": text,
    }


def decode_png(href: str) -> bytes:
    if not href.startswith("data:image/png;base64,"):
        raise RuntimeError("Expected embedded data:image/png;base64 GroundOverlay")
    return base64.b64decode(re.sub(r"\s+", "", href.split(",", 1)[1]))


def is_water_pixel(r: int, g: int, b: int, a: int, amin: int = MIN_ALPHA) -> bool:
    if a < amin:
        return False
    # Overlay is pure/near-pure blue with varying alpha.
    if b >= 180 and r <= 40 and g <= 60:
        return True
    if b > 120 and b >= r + 40 and b >= g + 30:
        return True
    return False


def box_area_m2(box: dict) -> float:
    mid_lat = ((box["north"] + box["south"]) * 0.5 * math.pi) / 180.0
    return (
        abs(box["east"] - box["west"])
        * 111320.0
        * math.cos(mid_lat)
        * abs(box["north"] - box["south"])
        * 110540.0
    )


def pixel_center_lonlat(ix: int, iy: int, w: int, h: int, box: dict) -> tuple[float, float]:
    """Pixel-center geographic mapping (north-up GroundOverlay)."""
    u = (ix + 0.5) / w
    v = (iy + 0.5) / h
    lon = box["west"] + u * (box["east"] - box["west"])
    lat = box["north"] - v * (box["north"] - box["south"])
    return lon, lat


def build_mask(im: Image.Image, box: dict) -> tuple[list[int], dict]:
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.tobytes()
    mask = [0] * (w * h)
    water = 0
    alpha_hist = defaultdict(int)
    for i in range(w * h):
        o = i * 4
        r, g, b, a = px[o], px[o + 1], px[o + 2], px[o + 3]
        alpha_hist[a] += 1
        if is_water_pixel(r, g, b, a):
            mask[i] = 1
            water += 1
    area_ha = box_area_m2(box) * water / (w * h) / 10000.0
    stats = {
        "width": w,
        "height": h,
        "waterPixels": water,
        "areaHa": round(area_ha, 6),
        "kmlAreaHa": KML_AREA_HA,
        "areaDeltaHa": round(area_ha - KML_AREA_HA, 6),
        "minAlpha": MIN_ALPHA,
        "alphaNonZeroTop": sorted(
            ((a, c) for a, c in alpha_hist.items() if a > 0),
            key=lambda t: -t[1],
        )[:12],
    }
    return mask, stats


def remove_tiny_components(
    mask: list[int], w: int, h: int, min_px: int
) -> tuple[list[int], list[dict], list[dict]]:
    n = w * h
    seen = [0] * n
    out = [0] * n
    comps: list[dict] = []
    for i in range(n):
        if not mask[i] or seen[i]:
            continue
        stack = [i]
        seen[i] = 1
        cells = []
        while stack:
            cur = stack.pop()
            cells.append(cur)
            x = cur % w
            y = cur // w
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    continue
                ni = ny * w + nx
                if not mask[ni] or seen[ni]:
                    continue
                seen[ni] = 1
                stack.append(ni)
        comps.append({"pixels": len(cells), "cells": cells})
    comps.sort(key=lambda c: -c["pixels"])
    kept = []
    for idx, c in enumerate(comps):
        if c["pixels"] < min_px:
            continue
        for cell in c["cells"]:
            out[cell] = 1
        kept.append(
            {
                "id": idx + 1,
                "pixels": c["pixels"],
                "areaHaApprox": None,  # filled by caller
            }
        )
    return out, kept, comps


def min_speckle_px(box: dict, w: int, h: int) -> int:
    px_m2 = box_area_m2(box) / max(1, w * h)
    return max(8, int(round(400.0 / max(1.0, px_m2))))


# --- Marching squares → rings (pixel edge space) ---

SEGMENTS = {
    1: [(0.5, 1.0), (0.0, 0.5)],
    2: [(1.0, 0.5), (0.5, 1.0)],
    3: [(1.0, 0.5), (0.0, 0.5)],
    4: [(0.5, 0.0), (1.0, 0.5)],
    5: [(0.5, 0.0), (0.0, 0.5), (0.5, 1.0), (1.0, 0.5)],  # saddle split A
    6: [(0.5, 0.0), (0.5, 1.0)],
    7: [(0.5, 0.0), (0.0, 0.5)],
    8: [(0.0, 0.5), (0.5, 0.0)],
    9: [(0.5, 1.0), (0.5, 0.0)],
    10: [(0.0, 0.5), (0.5, 1.0), (1.0, 0.5), (0.5, 0.0)],  # saddle split B
    11: [(1.0, 0.5), (0.5, 0.0)],
    12: [(0.0, 0.5), (1.0, 0.5)],
    13: [(0.5, 1.0), (1.0, 0.5)],
    14: [(0.0, 0.5), (0.5, 1.0)],
}


def _q(v: float) -> float:
    return round(v, 6)


def collect_edges(mask: list[int], w: int, h: int) -> dict:
    """Map undirected edge endpoints → neighbour (for ring tracing)."""
    adj: dict[tuple[float, float], list[tuple[float, float]]] = defaultdict(list)

    def add(a, b):
        adj[a].append(b)
        adj[b].append(a)

    for y in range(h - 1):
        for x in range(w - 1):
            tl = mask[y * w + x]
            tr = mask[y * w + x + 1]
            bl = mask[(y + 1) * w + x]
            br = mask[(y + 1) * w + x + 1]
            code = (tl << 3) | (tr << 2) | (br << 1) | bl
            segs = SEGMENTS.get(code)
            if not segs:
                continue
            pts = [(_q(x + px), _q(y + py)) for px, py in segs]
            if code in (5, 10):
                add(pts[0], pts[1])
                add(pts[2], pts[3])
            else:
                add(pts[0], pts[1])
    return adj


def trace_rings(adj: dict) -> list[list[tuple[float, float]]]:
    used = set()
    rings = []

    def edge_key(a, b):
        return (a, b) if a <= b else (b, a)

    for start in list(adj.keys()):
        for nxt in adj[start]:
            ek = edge_key(start, nxt)
            if ek in used:
                continue
            ring = [start]
            prev, cur = start, nxt
            used.add(ek)
            guard = 0
            while cur != start and guard < 2_000_000:
                guard += 1
                ring.append(cur)
                nbrs = adj[cur]
                advanced = False
                for cand in nbrs:
                    if cand == prev:
                        continue
                    kek = edge_key(cur, cand)
                    if kek in used:
                        continue
                    used.add(kek)
                    prev, cur = cur, cand
                    advanced = True
                    break
                if not advanced:
                    break
            if len(ring) >= 4:
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                rings.append(ring)
    return rings


def ring_area_px(ring: list[tuple[float, float]]) -> float:
    a = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        a += x0 * y1 - x1 * y0
    return 0.5 * a


def simplify_ring(ring: list[tuple[float, float]], tol: float = 0.35) -> list[tuple[float, float]]:
    """Ramer–Douglas–Peucker on closed ring (keeps closure)."""
    if len(ring) <= 5:
        return ring
    closed = ring[0] == ring[-1]
    pts = ring[:-1] if closed else list(ring)

    def perp(a, b, p):
        ax, ay = a
        bx, by = b
        px, py = p
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return math.hypot(px - ax, py - ay)
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    def rdp(seq):
        if len(seq) < 3:
            return seq
        a, b = seq[0], seq[-1]
        max_d = -1.0
        idx = 0
        for i in range(1, len(seq) - 1):
            d = perp(a, b, seq[i])
            if d > max_d:
                max_d = d
                idx = i
        if max_d > tol:
            left = rdp(seq[: idx + 1])
            right = rdp(seq[idx:])
            return left[:-1] + right
        return [a, b]

    out = rdp(pts)
    if closed:
        if out[0] != out[-1]:
            out.append(out[0])
    return out


def rings_to_geojson_features(
    rings: list[list[tuple[float, float]]],
    w: int,
    h: int,
    box: dict,
    px_m2: float,
) -> tuple[list[dict], list[dict]]:
    """Classify exterior / holes by signed area; attach holes to parents by containment."""
    prepared = []
    for ring in rings:
        simp = simplify_ring(ring, tol=0.45)
        if len(simp) < 4:
            continue
        area_px = ring_area_px(simp)
        # Convert pixel-edge coords → lon/lat using same affine as pixel centers
        # Edge (x,y) maps as continuous image space: lon = W + (x/w)*(E-W), lat = N - (y/h)*(N-S)
        coords = []
        for x, y in simp:
            lon = box["west"] + (x / w) * (box["east"] - box["west"])
            lat = box["north"] - (y / h) * (box["north"] - box["south"])
            coords.append([round(lon, 8), round(lat, 8)])
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        prepared.append(
            {
                "coords": coords,
                "area_px": abs(area_px),
                "signed_px": area_px,
                "ccw": area_px > 0,  # image y-down: positive area = CW in geo after flip? handle below
            }
        )

    # With y-down image space, positive shoelace is clockwise on screen = CCW in lon/lat
    # after lat = N - y*... (y flip). Force GeoJSON exteriors CCW, holes CW.
    exteriors = []
    holes = []
    for p in prepared:
        # After lat flip, reverse winding relative to image shoelace.
        lonlat = p["coords"]
        # Ensure exterior candidates use larger area
        if p["signed_px"] >= 0:
            # image CCW → likely hole after flip; reverse for lon/lat CCW exterior later
            winding = "image_ccw"
        else:
            winding = "image_cw"
        entry = {
            "coords": lonlat,
            "area_m2": p["area_px"] * px_m2,
            "area_ha": p["area_px"] * px_m2 / 10000.0,
            "winding": winding,
            "signed_px": p["signed_px"],
        }
        # Treat larger rings as exteriors tentatively by absolute area + orientation heuristic:
        # water is 1-bits inside; marching exterior typically CW in image (signed < 0).
        if p["signed_px"] < 0:
            exteriors.append(entry)
        else:
            holes.append(entry)

    exteriors.sort(key=lambda e: -e["area_ha"])
    holes.sort(key=lambda e: -e["area_ha"])

    def point_in_ring(pt, ring):
        x, y = pt
        inside = False
        for i in range(len(ring) - 1):
            x0, y0 = ring[i]
            x1, y1 = ring[i + 1]
            if ((y0 > y) != (y1 > y)) and (
                x < (x1 - x0) * (y - y0) / (y1 - y0 + 1e-18) + x0
            ):
                inside = not inside
        return inside

    features = []
    used_holes = set()
    for ei, ext in enumerate(exteriors):
        # GeoJSON: exterior CCW. Image CW (signed<0) after lat flip → already CCW-ish;
        # verify and reverse if needed.
        ring = ext["coords"]
        # Compute lon/lat shoelace
        a = 0.0
        for i in range(len(ring) - 1):
            a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
        if a < 0:
            ring = list(reversed(ring))
            ext["coords"] = ring

        poly_holes = []
        for hi, hole in enumerate(holes):
            if hi in used_holes:
                continue
            # hole representative point
            hx = sum(p[0] for p in hole["coords"][:-1]) / max(1, len(hole["coords"]) - 1)
            hy = sum(p[1] for p in hole["coords"][:-1]) / max(1, len(hole["coords"]) - 1)
            if not point_in_ring((hx, hy), ring):
                continue
            hring = hole["coords"]
            ha = 0.0
            for i in range(len(hring) - 1):
                ha += hring[i][0] * hring[i + 1][1] - hring[i + 1][0] * hring[i][1]
            # holes should be CW (negative area)
            if ha > 0:
                hring = list(reversed(hring))
            poly_holes.append(hring)
            used_holes.add(hi)

        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": ei + 1,
                    "kind": "water",
                    "area_ha": round(ext["area_ha"], 6),
                    "hole_count": len(poly_holes),
                    "source": "water_depth (1).kml MNDWI",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [ext["coords"], *poly_holes],
                },
            }
        )

    # Orphan holes → skip (invalid) but report
    orphan_holes = [holes[i] for i in range(len(holes)) if i not in used_holes]
    return features, orphan_holes


def write_clean_kml(path: Path, name: str, desc: str, box: dict, href_rel: str):
    path.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<kml xmlns="http://www.opengis.net/kml/2.2">',
                "  <Document>",
                f"    <name>{name}</name>",
                f"    <description>{desc}</description>",
                "    <GroundOverlay>",
                f"      <name>{name}</name>",
                "      <color>ccffffff</color>",
                f"      <Icon><href>{href_rel}</href></Icon>",
                "      <LatLonBox>",
                f"        <north>{box['north']}</north>",
                f"        <south>{box['south']}</south>",
                f"        <east>{box['east']}</east>",
                f"        <west>{box['west']}</west>",
                "        <rotation>0</rotation>",
                "      </LatLonBox>",
                "    </GroundOverlay>",
                "  </Document>",
                "</kml>",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    VERIFY.mkdir(parents=True, exist_ok=True)
    if not SRC_KML.exists():
        raise SystemExit(f"Missing uploaded KML: {SRC_KML}")

    parsed = parse_kml(SRC_KML)
    box = parsed["box"]
    # Prefer LatLonBox from file; fall back to known constants if needed
    for k, v in BOUNDS.items():
        if box.get(k) is None:
            box[k] = v

    png_bytes = decode_png(parsed["href"])
    im = Image.open(BytesIO(png_bytes))
    print(f"PNG size: {im.size} mode={im.mode}")

    # Write authoritative overlays (water, not depth)
    (OUT / "mithi_river_water_overlay.png").write_bytes(png_bytes)
    (OUT / "live_water_overlay.png").write_bytes(png_bytes)
    (OUT / "live_water_extent.png").write_bytes(png_bytes)
    # Keep a clearly named copy of the uploaded water product
    (OUT / "water_depth_mndwi_overlay.png").write_bytes(png_bytes)

    desc = parsed["description"] or (
        "Sentinel-2 MNDWI live water (blue). Frequency threshold: 0.5. "
        "Window: 2026-10-13 to 2026-11-12. Water area: 72.48201756266876 ha."
    )
    write_clean_kml(
        OUT / "mithi_river_water.kml",
        "Mithi River Water (MNDWI)",
        desc,
        box,
        "mithi_river_water_overlay.png",
    )
    write_clean_kml(
        OUT / "live_water_extent.kml",
        "Mithi River Water (MNDWI)",
        desc,
        box,
        "live_water_extent.png",
    )
    write_clean_kml(
        OUT / "water_depth_mndwi.kml",
        "Mithi River Water (MNDWI)",
        desc,
        box,
        "water_depth_mndwi_overlay.png",
    )
    # Preserve raw upload next to public assets for provenance
    (OUT / "water_depth_mndwi_src.kml").write_bytes(SRC_KML.read_bytes())

    mask, stats = build_mask(im, box)
    w, h = stats["width"], stats["height"]
    min_px = min_speckle_px(box, w, h)
    cleaned, kept_meta, all_comps = remove_tiny_components(mask, w, h, min_px)
    px_m2 = box_area_m2(box) / max(1, w * h)
    for c in kept_meta:
        c["areaHaApprox"] = round(c["pixels"] * px_m2 / 10000.0, 6)

    cleaned_count = sum(cleaned)
    cleaned_ha = cleaned_count * px_m2 / 10000.0

    adj = collect_edges(cleaned, w, h)
    rings = trace_rings(adj)
    features, orphan_holes = rings_to_geojson_features(rings, w, h, box, px_m2)
    total_poly_ha = sum(f["properties"]["area_ha"] for f in features)

    fc = {
        "type": "FeatureCollection",
        "name": "mithi_mndwi_water_polygons",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "properties": {
            "sourceKml": "src/data/water_depth (1).kml",
            "bounds": box,
            "rasterSize": [w, h],
            "minAlpha": MIN_ALPHA,
            "kmlAreaHa": KML_AREA_HA,
            "maskAreaHa": round(cleaned_ha, 6),
            "polygonAreaHa": round(total_poly_ha, 6),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "features": features,
    }
    geo_path = OUT / "mithi_mndwi_water_polygons.geojson"
    geo_path.write_text(json.dumps(fc), encoding="utf-8")

    water_meta = {
        "river": "Mithi",
        "product": "Sentinel-2 MNDWI live water",
        "bounds": box,
        "overlay": "/data/mithi/mithi_river_water_overlay.png",
        "kml": "/data/mithi/mithi_river_water.kml",
        "polygons": "/data/mithi/mithi_mndwi_water_polygons.geojson",
        "source": "src/data/water_depth (1).kml (Live Water - 2026-11-07)",
        "frequencyThreshold": 0.5,
        "window": ["2026-10-13", "2026-11-12"],
        "kmlAreaHa": KML_AREA_HA,
        "maskAreaHa": round(cleaned_ha, 6),
        "rasterSize": [w, h],
        "minAlpha": MIN_ALPHA,
        "updatedAt": "2026-11-19",
    }
    (OUT / "live_water_extent.json").write_text(
        json.dumps(water_meta, indent=2), encoding="utf-8"
    )

    report = {
        "extractedWaterMaskDimensions": [w, h],
        "kmlGeographicalBounds": box,
        "kmlMetadataAreaHa": KML_AREA_HA,
        "minAlpha": MIN_ALPHA,
        "maskWaterPixelsRaw": stats["waterPixels"],
        "maskAreaHaRaw": stats["areaHa"],
        "maskAreaHaAfterSpeckleFilter": round(cleaned_ha, 6),
        "speckleMinPixels": min_px,
        "connectedComponentsTotal": len(all_comps),
        "connectedComponentsKept": len(kept_meta),
        "mainConnectedWaterComponent": kept_meta[0] if kept_meta else None,
        "smallerDisconnectedWaterComponents": kept_meta[1:] if len(kept_meta) > 1 else [],
        "extractedPolygonCount": len(features),
        "totalPolygonAreaHa": round(total_poly_ha, 6),
        "orphanHoleRings": len(orphan_holes),
        "polygonRingCount": len(rings),
        "note": "Area is not forced to match KML metadata; delta is reported as-is.",
        "areaDeltaHa_mask_vs_kml": round(cleaned_ha - KML_AREA_HA, 6),
        "outputs": {
            "overlay": str((OUT / "mithi_river_water_overlay.png").relative_to(ROOT)),
            "kml": str((OUT / "mithi_river_water.kml").relative_to(ROOT)),
            "geojson": str(geo_path.relative_to(ROOT)),
            "meta": str((OUT / "live_water_extent.json").relative_to(ROOT)),
        },
    }
    (VERIFY / "MNDWI_WATER_POLYGON_REPORT.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )

    print(json.dumps(report, indent=2))
    print("Done.")


if __name__ == "__main__":
    main()
