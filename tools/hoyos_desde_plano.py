"""
Genera las configuraciones datos/<campo>/hoyoNN.json de los hoyos que aún no tienen trazado manual
a partir del plano del club (líneas tee → green), la ortofoto y la tarjeta.

  python3 tools/hoyos_desde_plano.py            # escribe hoyo04.json … hoyo18.json
  python3 tools/crear_hoyo.py datos/sotoverde/hoyo04.json …

Pasos por hoyo:
1. Ajusta el plano a la ortofoto con una semejanza usando puntos de control conocidos
   (tees y greens de los hoyos ya trazados y los centros de los lagos).
2. Busca en la ortofoto el green más cercano al previsto (zonas lisas, claras y compactas).
3. Coloca las barras a la distancia de tarjeta en la dirección del plano (con codo si el hoyo lo tiene).
4. Calle aproximada: franja de ancho fijo a lo largo del hoyo en pares 4 y 5; antegreen en pares 3.
"""
import json
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from crear_hoyo import cached, is_jpeg, WMS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "datos", "sotoverde")

# Ortofoto de todo el campo (UTM 30N), 0,25 m/px
BBOX = (349100, 4608700, 349950, 4609300)
MPP = 0.25

# Tarjeta: par, metros desde amarillas y desde rojas (rojas solo conocidas en la ida)
CARD = {
    4: (3, 122, 116), 5: (3, 151, 131), 6: (4, 261, 240), 7: (3, 111, 96), 8: (3, 194, 171),
    9: (4, 285, 257), 10: (3, 152, None), 11: (3, 73, None), 12: (3, 132, None), 13: (3, 109, None),
    14: (5, 444, None), 15: (3, 86, None), 16: (4, 262, None), 17: (3, 121, None), 18: (3, 166, None),
}

# Puntos de control plano (px) → UTM: hoyos 1-3 ya trazados y centros de los lagos
CONTROL = [
    ((620, 570), (349470.5, 4609053.6)), ((503.5, 648.5), (349380.5, 4609026.5)),
    ((459, 740), (349334.8, 4608995.1)), ((650, 619), (349495.0, 4609011.0)),
    ((721.5, 634), (349539.0, 4608987.0)), ((404, 841), (349280.0, 4608954.0)),
    ((296.8, 834.4), (349222.5, 4608982.7)),   # lago grande del oeste (con su lóbulo)
    ((354.7, 935.6), (349229.4, 4608911.0)),   # lago bajo el anterior
    ((537.5, 979.7), (349300.7, 4608844.0)),   # lago del sur
    ((819.0, 688.5), (349569.4, 4608921.3)),   # lago del este
]

# Greens que el detector no encuentra: centro = previsto + desplazamiento (m, este/norte) y semiejes
MANUAL_GREENS = {15: ((6, 4), (10, 9)), 16: ((0, 1), (11, 9))}

LAKES_UTM = [(349215, 4608985), (349269, 4608967), (349229, 4608911), (349300, 4608844), (349569, 4608921)]


def fit_similarity(pairs):
    A, b = [], []
    for (x, y), (X, Y) in pairs:
        y = -y  # la y del plano crece hacia abajo
        A += [[x, -y, 1, 0], [y, x, 0, 1]]
        b += [X, Y]
    p, *_ = np.linalg.lstsq(np.array(A, float), np.array(b, float), rcond=None)
    return lambda pt: np.array([p[0] * pt[0] + p[1] * pt[1] + p[2], p[1] * pt[0] - p[0] * pt[1] + p[3]])


def course_ortho():
    x0, y0, x1, y1 = BBOX
    w, h = int((x1 - x0) / MPP), int((y1 - y0) / MPP)
    url = (f"{WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=OI.OrthoimageCoverage&STYLES="
           f"&CRS=EPSG:25830&BBOX={x0},{y0},{x1},{y1}&WIDTH={w}&HEIGHT={h}&FORMAT=image/jpeg")
    path = cached(os.path.join(DATA, "cache", "campo_orto.jpg"), url, is_jpeg)
    return np.array(Image.open(path).convert("RGB"))


def detect_greens(img):
    """Manchas lisas, claras y verdes de 150–1500 m²: candidatas a green. Devuelve contornos en UTM."""
    sm = cv2.medianBlur(img, 9).astype(np.int32)
    R, G, B = sm[..., 0], sm[..., 1], sm[..., 2]
    lum = (0.3 * R + 0.59 * G + 0.11 * B).astype(np.float32)
    mu = cv2.blur(lum, (9, 9))
    sd = np.sqrt(np.maximum(cv2.blur(lum * lum, (9, 9)) - mu * mu, 0))
    m = ((G - R) >= 12) & (lum > 104) & (lum < 140) & (sd < 7) & ((G - B) > 18)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        area = st[i, 4] * MPP * MPP
        if not 150 < area < 1500:
            continue
        comp = cv2.dilate((lab == i).astype(np.uint8), np.ones((5, 5), np.uint8))  # recupera ~0,5 m de borde
        cs, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        c = max(cs, key=cv2.contourArea)
        hull = cv2.convexHull(c)
        if cv2.contourArea(c) / max(cv2.contourArea(hull), 1) < 0.75:
            continue
        c = cv2.approxPolyDP(c, 2, True)[:, 0, :]
        utm = [(BBOX[0] + x * MPP, BBOX[3] - y * MPP) for x, y in c]
        cx, cy = BBOX[0] + cen[i][0] * MPP, BBOX[3] - cen[i][1] * MPP
        out.append({"center": (cx, cy), "poly": utm})
    return out


def unit(v):
    return v / (np.hypot(*v) or 1)


def main():
    lines = json.load(open(os.path.join(DATA, "plano", "lineas.json")))
    to_utm = fit_similarity(CONTROL)
    greens = detect_greens(course_ortho())

    for n, (par, yellow, red) in CARD.items():
        ln = lines[str(n)]
        g_pred = to_utm(ln["green"])
        t_pred = to_utm(ln["tee"])
        via = to_utm(ln["via"]) if "via" in ln else None

        if n in MANUAL_GREENS:
            (dx, dy), (rx, ry) = MANUAL_GREENS[n]
            gc = g_pred + np.array([dx, dy])
            ang = math.atan2(*(unit((via if via is not None else t_pred) - gc))[::-1])
            gpoly = [(gc[0] + math.cos(a) * rx * math.cos(ang) - math.sin(a) * ry * math.sin(ang),
                      gc[1] + math.cos(a) * rx * math.sin(ang) + math.sin(a) * ry * math.cos(ang))
                     for a in np.linspace(0, 2 * math.pi, 14, endpoint=False)]
            source = "elipse situada a mano sobre la ortofoto"
        else:
            best = min(greens, key=lambda b: np.hypot(*(np.array(b["center"]) - g_pred)))
            off = np.hypot(*(np.array(best["center"]) - g_pred))
            if off > 30:
                raise SystemExit(f"hoyo {n}: no hay green a menos de 30 m del previsto ({off:.0f} m)")
            gc = np.array(best["center"])
            gpoly = best["poly"]
            source = f"detectado en la ortofoto a {off:.0f} m de la posición del plano"

        # barras a la distancia de tarjeta en la dirección del plano
        def tee_at(dist):
            if via is None:
                return gc + unit(t_pred - gc) * dist
            leg = np.hypot(*(via - gc))
            return via + unit(t_pred - via) * (dist - leg)

        tees = {"amarillas": tee_at(yellow)}
        if red:
            tees["rojas"] = tee_at(red)
        ty = tees["amarillas"]
        back = unit(ty - (via if via is not None else gc))
        front = tees.get("rojas", ty - back * 6) - back * 4
        rear = ty + back * 4
        nrm = np.array([-back[1], back[0]]) * 4.5
        teebox = [rear + nrm, rear - nrm, front - nrm, front + nrm]

        # marco del hoyo
        pts = [ty, gc] + ([via] if via is not None else []) + list(tees.values())
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        ox, oy = math.floor(min(xs) - 35), math.ceil(max(ys) + 35)
        w, h = math.ceil(max(xs) + 35 - ox), math.ceil(oy - (min(ys) - 35))
        L = lambda p: [round(p[0] - ox, 1), round(oy - p[1], 1)]  # noqa: E731

        # calle aproximada (pares 4 y 5) o antegreen (pares 3)
        path = [ty] + ([via] if via is not None else []) + [gc]
        if par >= 4:
            start = ty + unit(path[1] - ty) * 45
            center = [start] + path[1:-1] + [gc - unit(gc - path[-2]) * 10]
            width = 28
        else:
            d = unit(gc - path[-2])
            center = [gc - d * 26, gc - d * 9]
            width = 18
        fair = ribbon(center, width)

        lakes_near = [L(p) for p in LAKES_UTM if -40 < p[0] - ox < w + 40 and -40 < oy - p[1] < h + 40]
        cfg = {
            "id": f"sotoverde-{n:02d}", "name": "Sotoverde", "number": n, "par": par,
            "card": f"Tarjeta: {yellow} m desde amarillas" + (f", {red} m desde rojas" if red else ""),
            "geo": {"crs": "EPSG:25830", "origin": [ox, oy], "width": w, "height": h,
                    "note": "origin = esquina superior izquierda en UTM 30N; x hacia el este, y hacia el sur, en metros"},
            "segmentation_roi": [3, 3, w - 3, h - 3],
            "tee": dict(zip("xy", L(ty))),
            "tees": {k: dict(zip("xy", L(v)), label=k.capitalize()) for k, v in tees.items()},
            "teeBox": [L(p) for p in teebox],
            "tee_source": "Dirección del plano del club; barras a la distancia de tarjeta desde el centro del green",
            "pin": dict(zip("xy", L(gc))),
            "green": [L(p) for p in gpoly],
            "green_source": source,
            "fairways": [[L(p) for p in fair]],
            "fairway_source": "aproximada: franja de ancho fijo a lo largo del hoyo",
            "tree_scale": 1.3,
            "water_keep": lakes_near,
            "course_utm": "contorno_campo.json",
        }
        prev = os.path.join(DATA, f"hoyo{n:02d}.json")
        if os.path.exists(prev):
            old = json.load(open(prev, encoding="utf-8"))
            for k in ("exclude_points", "exclude_rects", "extra_trees", "extra_bunkers", "extra_water"):
                if k in old:
                    cfg[k] = old[k]  # conserva las correcciones hechas a mano
        with open(prev, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=1)
        dist = np.hypot(*(ty - (via if via is not None else gc))) + (np.hypot(*(via - gc)) if via is not None else 0)
        print(f"hoyo {n:2d}: par {par}, {dist:.0f} m (tarjeta {yellow}), green {source}")


def ribbon(center, width):
    left, right = [], []
    for i, p in enumerate(center):
        a = center[max(0, i - 1)]
        b = center[min(len(center) - 1, i + 1)]
        d = unit(np.array(b) - np.array(a))
        nrm = np.array([-d[1], d[0]]) * width / 2
        left.append(p + nrm)
        right.append(p - nrm)
    return left + right[::-1]


if __name__ == "__main__":
    main()
