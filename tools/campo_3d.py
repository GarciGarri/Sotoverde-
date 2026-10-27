"""
Genera los datos del recorrido 3D de la portada:

  js/campo3d.js            relieve (MDT05), edificios, lagos, árboles, puente, cancha de prácticas y puntos de interés
  img/campo_orto.jpg       ortofoto PNOA del campo (25 cm/px) para la textura del terreno
  img/campo_alrededor.jpg  ortofoto de los alrededores (1 m/px)
  img/campo_poster.jpg     ortofoto reducida para el póster del vídeo
  datos/sotoverde/campo3d_control.jpg  control: lo extraído dibujado sobre la ortofoto

Fuentes:
  - Ortofoto PNOA y MDT05 del IGN (CC BY 4.0).
  - Teselas del mapa estándar de OpenStreetMap (ODbL) a zoom 18: plantas de edificios, lagos y la zona de la
    cancha de prácticas, leídas por su color. La API de OSM y Catastro no son accesibles desde aquí.
  - Árboles: copas oscuras de la ortofoto (mismo criterio que tools/segmentar_hoyo.py).
  - Puente y edificio de los puestos de la cancha: medidos sobre la ortofoto (no están en OSM).

  python3 tools/campo_3d.py
"""
import json
import math
import os
import sys
import time
import urllib.request

import cv2
import numpy as np
import pyproj

sys.path.insert(0, os.path.dirname(__file__))
from crear_hoyo import WCS, WMS, cached, is_asc, is_jpeg  # noqa: E402
from segmentar_hoyo import trees_from_mask  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "datos", "sotoverde")
CACHE = os.path.join(DATA, "cache")
# campo (textura fina) y alrededores (textura gruesa y relieve); múltiplos de 5 m
X0, X1, Y0, Y1 = 349080, 349880, 4608730, 4609290
M = 250
OX0, OX1, OY0, OY1 = X0 - M, X1 + M, Y0 - M, Y1 + M
PX = 4  # px/m de la ortofoto del campo
Z = 18  # zoom de las teselas de OSM

# Medidos sobre la ortofoto, en metros locales (x este, y sur desde la esquina NO del campo).
BRIDGE = {"a": [160.0, 332.5], "b": [198.5, 301.0], "w": 2.6}
POIS = [
    {"name": "Casa club", "x": 327, "y": 205, "h": 14},
    {"name": "Cancha de prácticas", "x": 545, "y": 235, "h": 10},
    {"name": "Puestos de prácticas", "x": 462, "y": 288, "h": 12},
    {"name": "Puente", "x": 179, "y": 317, "h": 9},
    {"name": "Aparcamiento", "x": 252, "y": 140, "h": 8},
]
# techo marrón de los puestos cubiertos de la cancha (6 × 54 m)
RANGE_BAYS = [[442.2, 267.6], [447.2, 264.4], [476.0, 310.4], [471.0, 313.6]]
HEIGHTS = {"clubhouse": 5.5, "house": 5.6, "big": 9.0, "shed": 4.5, "range": 4.2}


def fetch(url, path, check):
    return cached(path, url, check)


def ortho(x0, y0, x1, y1, w, h, name):
    url = (f"{WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=OI.OrthoimageCoverage&STYLES="
           f"&CRS=EPSG:25830&BBOX={x0},{y0},{x1},{y1}&WIDTH={w}&HEIGHT={h}&FORMAT=image/jpeg")
    return cv2.imread(fetch(url, os.path.join(CACHE, name), is_jpeg))


def dem():
    url = (f"{WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion25830_5"
           f"&SUBSET=x({OX0},{OX1})&SUBSET=y({OY0},{OY1})&FORMAT=application/asc")
    path = fetch(url, os.path.join(CACHE, "campo_mdt5_amplio.asc"), is_asc)
    head, rows = {}, []
    for line in open(path, encoding="latin1").read().splitlines():
        p = line.split()
        if len(p) == 2 and p[0] in ("ncols", "nrows", "xllcorner", "yllcorner", "cellsize", "dx", "dy"):
            head[p[0]] = float(p[1])
        elif head.get("ncols") and len(p) == int(head["ncols"]):
            rows.append([float(v) for v in p])
    z = np.array(rows)  # fila 0 = norte
    cell = head.get("cellsize") or head.get("dx") or 5.0
    xll, yll = head["xllcorner"], head["yllcorner"]
    yul = yll + cell * z.shape[0]
    # centro de la celda NO en metros locales del campo
    return z, cell, (xll + cell / 2 - X0, Y1 - (yul - cell / 2))


def osm_mosaic():
    to_ll = pyproj.Transformer.from_crs(25830, 4326, always_xy=True)
    lon0, lat1 = to_ll.transform(OX0, OY1)
    lon1, lat0 = to_ll.transform(OX1, OY0)
    n = 2 ** Z

    def tile(lon, lat):
        return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n

    ax, ay = tile(lon0, lat1)
    bx, by = tile(lon1, lat0)
    tx0, tx1, ty0, ty1 = int(ax), int(bx), int(ay), int(by)
    rows = []
    for ty in range(ty0, ty1 + 1):
        row = []
        for tx in range(tx0, tx1 + 1):
            path = os.path.join(CACHE, "osm", f"{Z}-{tx}-{ty}.png")
            if not os.path.exists(path):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                req = urllib.request.Request(f"https://tile.openstreetmap.org/{Z}/{tx}/{ty}.png",
                                             headers={"User-Agent": "SotoverdeGolf/1.0 (proyecto personal)"})
                with urllib.request.urlopen(req, timeout=30) as r, open(path, "wb") as f:
                    f.write(r.read())
                time.sleep(0.2)
            row.append(cv2.imread(path))
        rows.append(np.hstack(row))
    mosaic = np.vstack(rows)
    to_utm = pyproj.Transformer.from_crs(4326, 25830, always_xy=True)

    def to_local(px, py):
        gx = tx0 * 256 + np.asarray(px, float)
        gy = ty0 * 256 + np.asarray(py, float)
        lon = gx / (256 * n) * 360 - 180
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * gy / (256 * n)))))
        X, Y = to_utm.transform(lon, lat)
        return np.stack([np.asarray(X) - X0, Y1 - np.asarray(Y)], -1)

    return mosaic, to_local


def color_mask(img, rgb, tol=4):
    bgr = np.array(rgb[::-1], np.int32)
    return (np.abs(img.astype(np.int32) - bgr).max(-1) <= tol).astype(np.uint8)


def polys(mask, to_local, min_m2, eps_px=1.0):
    out = []
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    for c in cs:
        ap = cv2.approxPolyDP(c, eps_px, True).reshape(-1, 2).astype(float)
        if len(ap) < 3:
            continue
        pts = to_local(ap[:, 0] + 0.5, ap[:, 1] + 0.5)
        x, y = pts[:, 0], pts[:, 1]
        area = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
        if area >= min_m2:
            out.append((pts, area))
    return out


def inside_ring(pts, ring_px):
    c = pts.mean(0) * PX
    return cv2.pointPolygonTest(ring_px, (float(c[0]), float(c[1])), False) >= 0


def main():
    os.makedirs(os.path.join(ROOT, "img"), exist_ok=True)
    ring = json.load(open(os.path.join(DATA, "contorno_campo.json"), encoding="utf-8"))["ring"]
    ring_l = np.array([[X - X0, Y1 - Y] for X, Y in ring])
    ring_px = (ring_l * PX).astype(np.float32).reshape(-1, 1, 2)

    z, cell, (gx, gy) = dem()
    base = float(np.floor(z.min()))

    orto = ortho(X0, Y0, X1, Y1, (X1 - X0) * PX, (Y1 - Y0) * PX, "campo_orto_25cm.jpg")
    around = ortho(OX0, OY0, OX1, OY1, OX1 - OX0, OY1 - OY0, "campo_alrededor_1m.jpg")

    # ---- OSM: edificios, lagos y cancha de prácticas ----
    mosaic, to_local = osm_mosaic()
    bmask = color_mask(mosaic, (217, 208, 201), 3) | color_mask(mosaic, (196, 182, 171), 6)
    bmask = cv2.morphologyEx(bmask, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
    buildings = []
    for pts, area in polys(bmask, to_local, 12):
        if inside_ring(pts, ring_px):
            kind = "clubhouse" if area > 300 else "shed"
        else:
            kind = "big" if area > 900 else "house"
        buildings.append({"p": [[round(x, 1), round(y, 1)] for x, y in pts], "h": HEIGHTS[kind], "k": kind})
    water = []
    wmask = cv2.morphologyEx(color_mask(mosaic, (170, 211, 223), 3), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    for pts, area in polys(wmask, to_local, 250):
        if not inside_ring(pts, ring_px):
            continue
        # nivel del agua: mediana del MDT dentro del lago
        m = np.zeros(z.shape, np.uint8)
        cv2.fillPoly(m, [np.round((pts - [gx, gy]) / cell).astype(np.int32)], 1)
        level = float(np.median(z[m > 0])) if m.any() else base
        water.append({"p": [[round(x, 1), round(y, 1)] for x, y in pts], "z": round(level, 2)})
    gmask = color_mask(mosaic, (205, 235, 176), 3)
    gmask = cv2.morphologyEx(gmask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    range_area = None
    for pts, area in sorted(polys(gmask, to_local, 5000, 2.0), key=lambda t: -t[1]):
        if inside_ring(pts, ring_px):
            range_area = [[round(x, 1), round(y, 1)] for x, y in pts]
            break

    buildings.append({"p": RANGE_BAYS, "h": HEIGHTS["range"], "k": "range"})
    rgb = orto[..., ::-1].astype(np.int32)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    # ---- árboles: copas oscuras de la ortofoto, lejos de edificios y agua ----
    V = rgb.max(-1)
    block = np.zeros(R.shape, np.uint8)
    for b in buildings:
        cv2.fillPoly(block, [np.round(np.array(b["p"]) * PX).astype(np.int32)], 1)
    block = cv2.dilate(block, np.ones((4 * PX, 4 * PX), np.uint8))
    for w in water:
        cv2.fillPoly(block, [np.round(np.array(w["p"]) * PX).astype(np.int32)], 1)
    tree = ((V < 62) & (B >= R) & (block == 0)).astype(np.uint8)
    # fuera las manchas oscuras enormes (césped artificial de los campos de fútbol)
    n, lab, st, _ = cv2.connectedComponentsWithStats(cv2.morphologyEx(tree, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)), 8)
    inside = np.zeros(R.shape, np.uint8)
    cv2.fillPoly(inside, [np.round(ring_l * PX).astype(np.int32)], 1)
    share = np.bincount(lab.ravel(), weights=inside.ravel(), minlength=n) / np.maximum(st[:, cv2.CC_STAT_AREA], 1)
    big = (st[:, cv2.CC_STAT_AREA] > 250 * PX * PX) & (share < 0.5)
    big[0] = False
    tree[big[lab]] = 0
    trees = []
    blur = cv2.blur(orto, (9, 9))
    for t in trees_from_mask(tree):
        x, y = t["x"], t["y"]
        # el color de la copa, algo aclarado (la sombra lo oscurece)
        bb, gg, rr = blur[min(int(y * PX), blur.shape[0] - 1), min(int(x * PX), blur.shape[1] - 1)]
        k = 1.35
        col = "%02x%02x%02x" % tuple(int(min(255, v * k + 12)) for v in (rr, gg, bb))
        trees.append([x, y, t["r"], col])

    # ---- texturas ----
    cv2.imwrite(os.path.join(ROOT, "img", "campo_orto.jpg"), orto, [cv2.IMWRITE_JPEG_QUALITY, 80])
    cv2.imwrite(os.path.join(ROOT, "img", "campo_alrededor.jpg"), around, [cv2.IMWRITE_JPEG_QUALITY, 72])
    cv2.imwrite(os.path.join(ROOT, "img", "campo_poster.jpg"), cv2.resize(orto, (1000, 700), interpolation=cv2.INTER_AREA),
                [cv2.IMWRITE_JPEG_QUALITY, 78])

    out = {
        "origin": [X0, Y1],
        "size": [X1 - X0, Y1 - Y0],
        "around": {"x": OX0 - X0, "y": Y1 - OY1, "w": OX1 - OX0, "h": OY1 - OY0},
        "tex": {"course": "img/campo_orto.jpg", "around": "img/campo_alrededor.jpg", "poster": "img/campo_poster.jpg"},
        "dem": {"x": round(gx, 2), "y": round(gy, 2), "cell": cell, "cols": int(z.shape[1]), "rows": int(z.shape[0]),
                "base": base, "dm": [int(round((v - base) * 10)) for v in z.ravel()]},
        "ring": [[round(x, 1), round(y, 1)] for x, y in ring_l],
        "buildings": buildings,
        "water": water,
        "range": range_area,
        "bridge": BRIDGE,
        "trees": trees,
        "pois": POIS,
        "source": "Ortofoto PNOA y MDT05 © IGN (CC BY 4.0); edificios, lagos y contorno © OpenStreetMap (ODbL)",
    }
    js = ("// Generado por tools/campo_3d.py. No editar a mano.\n"
          "(function (global) {\n  'use strict';\n  const GC = (global.GC = global.GC || {});\n"
          f"  GC.COURSE_3D = {json.dumps(out, separators=(',', ':'), ensure_ascii=False)};\n"
          "})(typeof window !== 'undefined' ? window : globalThis);\n")
    with open(os.path.join(ROOT, "js", "campo3d.js"), "w", encoding="utf-8") as f:
        f.write(js)

    # ---- control ----
    ctl = orto.copy()
    P = lambda pts: np.round(np.array(pts) * PX).astype(np.int32)  # noqa: E731
    for b in buildings:
        cv2.polylines(ctl, [P(b["p"])], True, (0, 0, 255) if b["k"] != "house" else (0, 140, 255), 3)
    for w in water:
        cv2.polylines(ctl, [P(w["p"])], True, (255, 200, 0), 3)
    if range_area:
        cv2.polylines(ctl, [P(range_area)], True, (255, 0, 255), 3)
    for x, y, r, _ in trees:
        cv2.circle(ctl, (int(x * PX), int(y * PX)), int(r * PX), (0, 255, 0), 2)
    cv2.line(ctl, tuple(P(BRIDGE["a"])), tuple(P(BRIDGE["b"])), (0, 255, 255), 6)
    for p in POIS:
        cv2.putText(ctl, p["name"], (int(p["x"] * PX), int(p["y"] * PX)), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 4)
    cv2.imwrite(os.path.join(DATA, "campo3d_control.jpg"), cv2.resize(ctl, (1600, 1120)), [cv2.IMWRITE_JPEG_QUALITY, 80])
    print(f"relieve {z.shape[1]}x{z.shape[0]} ({cell} m), base {base}, {len(buildings)} edificios, {len(water)} lagos, "
          f"{len(trees)} árboles, cancha {'sí' if range_area else 'no'}, {len(js) // 1024} KB")


if __name__ == "__main__":
    main()
