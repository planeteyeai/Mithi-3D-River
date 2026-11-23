"""Extract mithi_river_depth.kml + mithi_river_water.kml into public/data/mithi."""
from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow", "-q"])
    from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "data"
OUT = ROOT / "public" / "data" / "mithi"

# Blue depth classes — matched to mithi_river_depth.kml product range 0.2–5.5 m
BLUE_CLASSES = [
    {"id": "shallow", "label": "Shallow (<1.5 m)", "color": "#7AD4F0", "range": "< 1.5 m"},
    {"id": "moderate", "label": "Moderate (1.5–3.0 m)", "color": "#3AA0D6", "range": "1.5–3.0 m"},
    {
        "id": "medium_deep",
        "label": "Medium-Deep (3.0–4.5 m)",
        "color": "#1E6EAA",
        "range": "3.0–4.5 m",
    },
    {"id": "deep", "label": "Deep (>4.5 m)", "color": "#0C4A7A", "range": "> 4.5 m"},
]


def parse(name: str):
    text = (SRC / name).read_text(encoding="utf-8", errors="replace")
    name_m = re.search(r"<[^>]*name>([^<]+)", text, re.I)
    desc_m = re.search(r"<[^>]*description>([^<]*)", text, re.I)
    box = {
        k: float(re.search(rf"<[^>]*{k}>([^<]+)", text, re.I).group(1))
        for k in ("north", "south", "east", "west")
    }
    href = re.search(r"<[^>]*href>([^<]+)</[^>]*href>", text, re.I).group(1).strip()
    print("===", name)
    print("  name:", name_m.group(1) if name_m else None)
    print("  desc:", (desc_m.group(1)[:180] if desc_m else None))
    print("  box:", box)
    print("  href len:", len(href), "bytes:", len(text))
    return {
        "file": name,
        "doc_name": name_m.group(1) if name_m else name,
        "description": desc_m.group(1) if desc_m else "",
        "box": box,
        "href": href,
        "text": text,
    }


def extract_png(href: str, dest: Path):
    assert href.startswith("data:image/png;base64,"), href[:40]
    data = base64.b64decode(href.split(",", 1)[1])
    dest.write_bytes(data)
    im = Image.open(BytesIO(data))
    small = im.convert("RGBA").resize((64, 64), Image.NEAREST)
    colors = sorted(small.getcolors(64 * 64) or [], key=lambda x: -x[0])
    top = []
    for count, rgba in colors:
        if rgba[3] <= 20:
            continue
        top.append((count, "#%02x%02x%02x" % rgba[:3], rgba[3]))
        if len(top) >= 8:
            break
    print(f"  wrote {dest.name} {im.size} colors={top}")
    return im.size


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


def pick_by_content(a, b):
    """Return (depth_src, water_src) by GroundOverlay / Document name."""
    def is_depth(p):
        n = (p["doc_name"] or "").lower()
        return "depth" in n or "green" in n or "bathym" in n

    def is_water(p):
        n = (p["doc_name"] or "").lower()
        return "live water" in n or (n.startswith("water") and "depth" not in n) or "mndwi" in n

    if is_depth(a) and not is_depth(b):
        return a, b
    if is_depth(b) and not is_depth(a):
        return b, a
    if is_water(a) and not is_water(b):
        return b, a
    if is_water(b) and not is_water(a):
        return a, b
    # Fallback: larger PNG / file is usually the depth raster
    return (a, b) if len(a["text"]) >= len(b["text"]) else (b, a)


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    depth_file = parse("mithi_river_depth.kml")
    # Prefer the user-uploaded MNDWI water product when present.
    water_name = (
        "water_depth (1).kml"
        if (SRC / "water_depth (1).kml").exists()
        else "mithi_river_water.kml"
    )
    water_file = parse(water_name)
    depth_src, water_src = pick_by_content(depth_file, water_file)

    print("\nResolved by content:")
    print("  DEPTH <-", depth_src["file"], "|", depth_src["doc_name"])
    print("  WATER <-", water_src["file"], "|", water_src["doc_name"])

    # Keep raw src copies for debugging
    shutil.copy2(SRC / "mithi_river_depth.kml", OUT / "mithi_river_depth_src.kml")
    shutil.copy2(SRC / "mithi_river_water.kml", OUT / "mithi_river_water_src.kml")

    print("\nExtracting PNGs…")
    extract_png(depth_src["href"], OUT / "mithi_river_depth_overlay.png")
    extract_png(water_src["href"], OUT / "mithi_river_water_overlay.png")

    # Legacy aliases used elsewhere in the twin
    extract_png(depth_src["href"], OUT / "water_depth_overlay.png")
    extract_png(water_src["href"], OUT / "live_water_overlay.png")
    extract_png(water_src["href"], OUT / "live_water_extent.png")

    write_clean_kml(
        OUT / "mithi_river_depth.kml",
        "Mithi River Depth",
        depth_src["description"]
        or "Water Depth · relative band-ratio estimate · 2026-11-12",
        depth_src["box"],
        "mithi_river_depth_overlay.png",
    )
    write_clean_kml(
        OUT / "mithi_river_water.kml",
        "Mithi River Water",
        water_src["description"] or "Live Water · Sentinel-2 MNDWI",
        water_src["box"],
        "mithi_river_water_overlay.png",
    )
    write_clean_kml(
        OUT / "water_depth.kml",
        "Mithi River Depth",
        depth_src["description"] or "Water Depth · relative band-ratio estimate",
        depth_src["box"],
        "water_depth_overlay.png",
    )
    write_clean_kml(
        OUT / "live_water_extent.kml",
        "Mithi River Water",
        water_src["description"] or "Live Water · Sentinel-2 MNDWI",
        water_src["box"],
        "live_water_extent.png",
    )

    meta = {
        "river": "Mithi",
        "bounds": depth_src["box"],
        "overlay": "/data/mithi/mithi_river_depth_overlay.png",
        "kml": "/data/mithi/mithi_river_depth.kml",
        "waterOverlay": "/data/mithi/mithi_river_water_overlay.png",
        "waterKml": "/data/mithi/mithi_river_water.kml",
        "source": {
            "depth": f"src/data/{depth_src['file']} ({depth_src['doc_name']})",
            "water": f"src/data/{water_src['file']} ({water_src['doc_name']})",
        },
        "minDepth": 0.2,
        "maxDepth": 5.5,
        "unit": "m",
        "palette": "blue_shades",
        "productDepthRange": [0.2, 5.5],
        "classes": BLUE_CLASSES,
        "alwaysOn": True,
        "updatedAt": "2026-11-16",
    }
    (OUT / "mithi_river_water_depth.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (OUT / "water_depth.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    water_meta = {
        "river": "Mithi",
        "bounds": water_src["box"],
        "overlay": "/data/mithi/mithi_river_water_overlay.png",
        "kml": "/data/mithi/mithi_river_water.kml",
        "source": f"src/data/{water_src['file']} ({water_src['doc_name']})",
        "updatedAt": "2026-11-16",
    }
    (OUT / "live_water_extent.json").write_text(json.dumps(water_meta, indent=2), encoding="utf-8")
    print("\nDone ->", OUT)


if __name__ == "__main__":
    main()
