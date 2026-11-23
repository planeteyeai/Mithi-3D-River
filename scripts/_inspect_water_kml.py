"""Inspect water/depth KML sources and PNG masks."""
from __future__ import annotations

import base64
import re
from collections import Counter
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def strip_ns(tag: str) -> str:
    return re.sub(r"^\{[^}]+\}", "", tag)


def info_kml(path: Path):
    raw = path.read_bytes()
    # detect encoding / BOM
    text = raw.decode("utf-8", errors="replace")
    print(f"\n=== {path.relative_to(ROOT)} ({len(raw)} bytes) ===")
    print("head:", repr(text[:200]))
    # namespaced or plain
    names = re.findall(r"<(?:[\w.]+:)?name>([^<]+)</(?:[\w.]+:)?name>", text, re.I)
    descs = re.findall(r"<(?:[\w.]+:)?description>([^<]*)</(?:[\w.]+:)?description>", text, re.I)
    box = {}
    for k in ("north", "south", "east", "west"):
        m = re.search(rf"<(?:[\w.]+:)?{k}>([^<]+)</(?:[\w.]+:)?{k}>", text, re.I)
        box[k] = float(m.group(1)) if m else None
    href_m = re.search(r"<(?:[\w.]+:)?href>([^<]+)</(?:[\w.]+:)?href>", text, re.I)
    href = href_m.group(1).strip() if href_m else ""
    print("names:", names[:4])
    print("desc:", (descs[0][:260] if descs else None))
    print("box:", box)
    if href.startswith("data:image"):
        print("href: embedded", href.split(",", 1)[0], "b64len", len(href.split(",", 1)[-1]))
        return text, box, href
    print("href:", href[:120] if href else None)
    return text, box, href


def analyze_png(path: Path | None = None, data: bytes | None = None, label: str = ""):
    if path:
        data = path.read_bytes()
        label = str(path.relative_to(ROOT))
    im = Image.open(BytesIO(data)).convert("RGBA")
    w, h = im.size
    px = list(im.getdata())
    n = len(px)
    alpha_hist = Counter()
    waterish = 0
    opaque = 0
    for r, g, b, a in px:
        alpha_hist[a // 16] += 1
        if a >= 80:
            opaque += 1
        if a >= 80 and b >= 180 and r <= 40 and g <= 60:
            waterish += 1
        elif a >= 80 and b > 120 and b >= r + 40 and b >= g + 30:
            waterish += 1
    # area estimate with same bounds
    north, south, east, west = 19.08782672, 19.04514933, 72.87929619, 72.83456075
    mid_lat = ((north + south) * 0.5 * 3.141592653589793) / 180
    box_m2 = abs(east - west) * 111320 * __import__("math").cos(mid_lat) * abs(north - south) * 110540
    area_ha = box_m2 * waterish / n / 10000
    print(f"PNG {label}: {w}x{h} waterish@a>=80={waterish} ({100*waterish/n:.2f}%) areaHa≈{area_ha:.3f}")
    print("  alpha buckets /16:", dict(sorted(alpha_hist.items())[:8]), "...")
    # top colors among a>=80
    cols = Counter()
    for r, g, b, a in px:
        if a < 80:
            continue
        cols[(r // 16 * 16, g // 16 * 16, b // 16 * 16, a // 16 * 16)] += 1
    print("  top opaque colors:", cols.most_common(6))
    return im, waterish, area_ha


def main():
    files = [
        ROOT / "src/data/water_depth (1).kml",
        ROOT / "src/data/mithi_river_water.kml",
        ROOT / "src/data/mithi_river_depth.kml",
        ROOT / "public/data/mithi/mithi_river_water.kml",
        ROOT / "public/data/mithi/mithi_river_water_src.kml",
        ROOT / "public/data/mithi/mithi_river_depth_src.kml",
        ROOT / "public/data/mithi/jalnetra-history/water-depth1_21-10-2026__18-11-2026.kml",
        ROOT / "public/data/mithi/jalnetra-history/live-water1_21-10-2026__18-11-2026.kml",
    ]
    for f in files:
        if f.exists():
            info_kml(f)

    for png in [
        ROOT / "public/data/mithi/mithi_river_water_overlay.png",
        ROOT / "public/data/mithi/live_water_extent.png",
        ROOT / "public/data/mithi/water_depth_overlay.png",
        ROOT / "public/data/mithi/mithi_river_depth_overlay.png",
    ]:
        if png.exists():
            analyze_png(path=png)

    # Extract embedded from src water_depth (1) and mithi_river_water
    for name in ["water_depth (1).kml", "mithi_river_water.kml"]:
        p = ROOT / "src/data" / name
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"data:image/png;base64,([A-Za-z0-9+/=\s]+)", text, re.I)
        if not m:
            print(f"NO embedded PNG in {name}")
            # maybe gzip/kmz?
            print("first 80 bytes hex:", p.read_bytes()[:80].hex())
            continue
        data = base64.b64decode(re.sub(r"\s+", "", m.group(1)))
        analyze_png(data=data, label=f"embedded:{name}")


if __name__ == "__main__":
    main()
