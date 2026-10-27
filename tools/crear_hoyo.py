"""
Crea un hoyo jugable a partir de datos abiertos del IGN y un trazado manual.

  python3 tools/crear_hoyo.py datos/sotoverde/hoyo03.json

1. Descarga la ortofoto PNOA (WMS, 25 cm/px) del rectángulo del hoyo.
2. Detecta búnkeres, agua y árboles por color (tools/segmentar_hoyo.py).
3. Añade lo trazado a mano: tee, bandera, green, calles y correcciones.
4. Descarga el modelo digital del terreno de 5 m (WCS) y lo guarda como rejilla de alturas.
5. Escribe campos/<id>.json, una imagen de control y regenera js/campos.js.

Requiere: numpy, opencv-python-headless, pillow. Ortofoto y MDT © IGN (CC BY 4.0).
"""
import glob
import io
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import segmentar_hoyo as seg  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WMS = "https://www.ign.es/wms-inspire/pnoa-ma"
WCS = "https://servicios.idee.es/wcs-inspire/mdt"
UA = {"User-Agent": "golfclash-sotoverde/0.1 (proyecto personal)"}
PX = seg.PX


def fetch(url, tries=4):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # el servicio corta conexiones de vez en cuando
            last = e
    raise last


def cached(path, url):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(fetch(url))
    return path


def ortho(cfg, cache_dir):
    x0, y0 = cfg["geo"]["origin"]
    w, h = cfg["geo"]["width"], cfg["geo"]["height"]
    url = (f"{WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=OI.OrthoimageCoverage&STYLES="
           f"&CRS=EPSG:25830&BBOX={x0},{y0 - h},{x0 + w},{y0}&WIDTH={w * PX}&HEIGHT={h * PX}&FORMAT=image/jpeg")
    path = cached(os.path.join(cache_dir, f"{cfg['id']}_orto.jpg"), url)
    return np.array(Image.open(path).convert("RGB"))


def elevation(cfg, cache_dir, cell=5):
    x0, y0 = cfg["geo"]["origin"]
    w, h = cfg["geo"]["width"], cfg["geo"]["height"]
    m = 20  # margen para interpolar en los bordes
    url = (f"{WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion25830_5"
           f"&SUBSET=x({x0 - m},{x0 + w + m})&SUBSET=y({y0 - h - m},{y0 + m})&FORMAT=application/asc")
    path = cached(os.path.join(cache_dir, f"{cfg['id']}_mdt5.asc"), url)
    text = open(path, encoding="latin1").read()
    head, rows = {}, []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] in ("ncols", "nrows", "xllcorner", "yllcorner", "cellsize", "NODATA_value"):
            head[parts[0]] = float(parts[1])
        elif head.get("ncols") and len(parts) == int(head["ncols"]):
            rows.append([float(v) for v in parts])
    grid = np.array(rows)
    cs = head["cellsize"]
    top = head["yllcorner"] + cs * grid.shape[0]

    def z(lx, ly):
        X, Y = x0 + lx, y0 - ly
        c = (X - head["xllcorner"]) / cs - 0.5
        r = (top - Y) / cs - 0.5
        c0, r0 = int(np.floor(c)), int(np.floor(r))
        fc, fr = c - c0, r - r0
        v = grid[r0:r0 + 2, c0:c0 + 2]
        return (v[0, 0] * (1 - fc) * (1 - fr) + v[0, 1] * fc * (1 - fr)
                + v[1, 0] * (1 - fc) * fr + v[1, 1] * fc * fr)

    cols, nrows = int(w // cell) + 1, int(h // cell) + 1
    vals = np.array([[z(i * cell, j * cell) for i in range(cols)] for j in range(nrows)])
    base = float(np.floor(vals.min()))
    return {
        "cell": cell, "cols": cols, "rows": nrows, "base": base,
        "data": [round(float(v - base), 2) for v in vals.ravel()],
        "source": "MDT05 IGN (WCS Elevacion25830_5), © IGN CC BY 4.0",
    }, z


def poly_area(p):
    return abs(sum(p[i][0] * p[i - 1][1] - p[i - 1][0] * p[i][1] for i in range(len(p)))) / 2


def centroid(p):
    return sum(q[0] for q in p) / len(p), sum(q[1] for q in p) / len(p)


def point_in_poly(pts, x, y):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        (xi, yi), (xj, yj) = pts[i], pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def excluded(poly, points, radius=6):
    cx, cy = centroid(poly)
    return any(point_in_poly(poly, x, y) or np.hypot(cx - x, cy - y) < radius for x, y in points)


def dist_to_poly(poly, x, y):
    best = float("inf")
    for i in range(len(poly)):
        (ax, ay), (bx, by) = poly[i - 1], poly[i]
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, np.hypot(x - ax - t * dx, y - ay - t * dy))
    return best


MAX_GREEN_PCT = 3.0  # los greens rara vez pasan del 3 %; el MDT de 5 m no da para más detalle


def green_slope(cfg, z, water):
    """Plano ajustado a las alturas del green: hacia dónde cae y cuánto.
    Se ignoran los puntos a menos de 8 m del agua: el MDT de 5 m mezcla ahí la orilla."""
    g = cfg["green"]
    xs = [p[0] for p in g]
    ys = [p[1] for p in g]
    pts = [(x, y) for x in np.arange(min(xs), max(xs), 1.0) for y in np.arange(min(ys), max(ys), 1.0)
           if point_in_poly(g, x, y) and all(dist_to_poly(w, x, y) > 8 for w in water)]
    A = np.array([[x, y, 1] for x, y in pts])
    b = np.array([z(x, y) for x, y in pts])
    (gx, gy, _), *_ = np.linalg.lstsq(A, b, rcond=None)
    # la bola cae en sentido contrario al gradiente; ángulo de brújula con y hacia abajo
    dx, dy = -gx, -gy
    angle = (np.degrees(np.arctan2(dx, -dy)) + 360) % 360
    raw = float(np.hypot(gx, gy) * 100)
    pct = min(raw, MAX_GREEN_PCT)
    return {"angle": round(float(angle)), "strength": round(pct / 4.0, 2), "percent": round(pct, 2),
            "mdt_percent": round(raw, 2), "points": len(pts)}


def control_image(crop, hole, path):
    img = Image.fromarray(crop)
    d = ImageDraw.Draw(img, "RGBA")
    P = lambda pts: [(x * PX, y * PX) for x, y in pts]  # noqa: E731
    for p in hole["fairways"]:
        d.polygon(P(p), outline=(120, 255, 80, 255), fill=(120, 255, 80, 40))
    d.polygon(P(hole["green"]), outline=(255, 255, 0, 255), fill=(255, 255, 0, 50))
    for p in hole["bunkers"]:
        d.polygon(P(p), outline=(255, 0, 255, 255))
    for p in hole["water"]:
        d.polygon(P(p), outline=(0, 160, 255, 255))
    for t in hole["trees"]:
        d.ellipse([(t["x"] - t["r"]) * PX, (t["y"] - t["r"]) * PX, (t["x"] + t["r"]) * PX, (t["y"] + t["r"]) * PX],
                  outline=(255, 60, 60, 255))
    if hole.get("teeBox"):
        d.polygon(P(hole["teeBox"]), outline=(255, 255, 255, 255))
    marks = [(hole["pin"], "red")] + [(t, "yellow" if k == "amarillas" else "red" if k == "rojas" else "white")
                                      for k, t in (hole.get("tees") or {"tee": hole["tee"]}).items()]
    for p, col in marks:
        x, y = p["x"] * PX, p["y"] * PX
        d.ellipse([x - 8, y - 8, x + 8, y + 8], outline=col, width=3)
    img.save(path, quality=88)


def write_bundle():
    holes = []
    for f in sorted(glob.glob(os.path.join(ROOT, "campos", "*.json"))):
        holes.append(json.load(open(f, encoding="utf-8")))
    js = ("// Generado por tools/crear_hoyo.py a partir de campos/*.json. No editar a mano.\n"
          "(function (global) {\n  'use strict';\n  const GC = (global.GC = global.GC || {});\n"
          f"  GC.COURSE_HOLES = {json.dumps(holes, ensure_ascii=False, separators=(',', ':'))};\n"
          "})(typeof window !== 'undefined' ? window : globalThis);\n")
    with open(os.path.join(ROOT, "js", "campos.js"), "w", encoding="utf-8") as f:
        f.write(js)
    return len(holes)


def main(cfg_path):
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    data_dir = os.path.dirname(os.path.abspath(cfg_path))
    cache_dir = os.path.join(data_dir, "cache")

    crop = ortho(cfg, cache_dir)
    auto = seg.segment(crop, *cfg["segmentation_roi"])
    ex = cfg.get("exclude_points", [])
    bunkers = [p for p in auto["bunkers"] if not excluded(p, ex)] + cfg.get("extra_bunkers", [])
    water = [p for p in auto["water"] if not excluded(p, ex)] + cfg.get("extra_water", [])
    green = cfg["green"]
    tees = [cfg["tee"]] + list(cfg.get("tees", {}).values())
    box = cfg.get("teeBox")
    k = cfg.get("tree_scale", 1.0)  # la detección se queda corta con copas a contraluz
    trees = [dict(t, r=round(t["r"] * k, 1)) for t in auto["trees"]]
    trees = [t for t in trees
             if not point_in_poly(green, t["x"], t["y"])
             and all(np.hypot(t["x"] - p["x"], t["y"] - p["y"]) > t["r"] + 4 for p in tees)
             and not (box and point_in_poly(box, t["x"], t["y"]))
             and not any(point_in_poly(w, t["x"], t["y"]) for w in water)]
    trees += cfg.get("extra_trees", [])

    elev, z = elevation(cfg, cache_dir)
    hole = {
        "id": cfg["id"], "name": cfg["name"], "number": cfg["number"], "par": cfg["par"],
        "card": cfg.get("card", ""),
        "width": cfg["geo"]["width"], "height": cfg["geo"]["height"],
        "tee": cfg["tee"], "pin": cfg["pin"],
        **({"tees": cfg["tees"]} if "tees" in cfg else {}),
        **({"teeBox": cfg["teeBox"]} if "teeBox" in cfg else {}),
        "fairways": cfg["fairways"], "green": green,
        "bunkers": bunkers, "water": water, "trees": trees,
        "greenSlope": green_slope(cfg, z, water),
        "elevation": elev,
        "geo": cfg["geo"],
        "credits": "Ortofoto PNOA y MDT05 © Instituto Geográfico Nacional (CC BY 4.0)",
    }
    os.makedirs(os.path.join(ROOT, "campos"), exist_ok=True)
    out = os.path.join(ROOT, "campos", f"{cfg['id']}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(hole, f, ensure_ascii=False, indent=1)
    control_image(crop, hole, os.path.join(data_dir, f"{cfg['id']}_control.jpg"))
    Image.fromarray(crop).resize((crop.shape[1] // 2, crop.shape[0] // 2)).save(
        os.path.join(data_dir, f"{cfg['id']}_orto.jpg"), quality=85)

    dz = z(cfg["pin"]["x"], cfg["pin"]["y"]) - z(cfg["tee"]["x"], cfg["tee"]["y"])
    dist = np.hypot(cfg["pin"]["x"] - cfg["tee"]["x"], cfg["pin"]["y"] - cfg["tee"]["y"])
    print(f"{out}: {len(bunkers)} búnkeres, {len(water)} lagos, {len(trees)} árboles")
    print(f"tee→bandera {dist:.1f} m en línea recta, desnivel {dz:+.1f} m; green: {hole['greenSlope']}")
    print(f"js/campos.js regenerado con {write_bundle()} hoyo(s)")


if __name__ == "__main__":
    main(sys.argv[1])
