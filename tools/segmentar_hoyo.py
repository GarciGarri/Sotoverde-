"""
Extrae búnkeres, agua y árboles de un recorte de ortofoto (4 px/m) por color.
Uso suelto: python3 tools/segmentar_hoyo.py recorte.npy roi_x0 roi_y0 roi_x1 roi_y1 > elementos.json
(roi en metros locales). Calle, green, tee y bandera se trazan a mano.
"""
import json
import sys

import cv2
import numpy as np

PX = 4  # píxeles por metro del recorte
MIN_SAND_V = 162  # brillo medio mínimo de un búnker (las calvas secas se quedan en 150-160)


def poly_from_mask(mask, min_area_m2, eps_m=0.6, min_solidity=0.0):
    m = mask.astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA] / PX ** 2
        if area < min_area_m2:
            continue
        comp = (lab == i).astype(np.uint8)
        cs, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        c = max(cs, key=cv2.contourArea)
        hull = cv2.convexHull(c)
        if cv2.contourArea(c) / max(cv2.contourArea(hull), 1) < min_solidity:
            continue
        ap = cv2.approxPolyDP(c, eps_m * PX, True)
        if len(ap) < 3:
            continue
        out.append([[round(p[0][0] / PX, 1), round(p[0][1] / PX, 1)] for p in ap])
    return out


def trees_from_mask(mask, min_area_m2=3.0):
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, stats, cents = cv2.connectedComponentsWithStats(m, 8)
    trees = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA] / PX ** 2
        if area < min_area_m2:
            continue
        ys, xs = np.nonzero(lab == i)
        pts = np.stack([xs, ys], 1).astype(np.float32) / PX
        k = max(1, int(round(area / (np.pi * 3.5 ** 2))))
        if k == 1:
            centers = [pts.mean(0)]
            labels = np.zeros(len(pts), int)
        else:
            crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.1)
            _, labels, centers = cv2.kmeans(pts, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
            labels = labels.ravel()
        for j, cxy in enumerate(centers):
            a = (labels == j).sum() / PX ** 2
            r = np.sqrt(a / np.pi) * 0.9  # la sombra infla un poco la copa
            if r < 1.2:
                continue
            trees.append({"x": round(float(cxy[0]), 1), "y": round(float(cxy[1]), 1), "r": round(float(r), 1)})
    return trees


def segment(crop, x0, y0, x1, y1):
    """Devuelve {"bunkers", "water", "trees"} en metros locales dentro del rectángulo roi."""
    crop = crop.astype(np.int32)
    R, G, B = crop[..., 0], crop[..., 1], crop[..., 2]
    V = crop.max(-1)
    roi = np.zeros(R.shape, bool)
    roi[int(y0 * PX):int(y1 * PX), int(x0 * PX):int(x1 * PX)] = True

    sand = (R > 140) & (G > 120) & (R >= G - 2) & (R - B > 25) & roi
    sand = cv2.morphologyEx(sand.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    sand = cv2.morphologyEx(sand, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    # agua: verde azulado oscuro (más azul que la hierba) o muy oscura, en manchas grandes
    wet = ((V < 120) & (G - R > 22) & (B - R > 8)) | ((V < 75) & (B >= R))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(wet.astype(np.uint8), 8)
    water = np.zeros(R.shape, bool)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] / PX ** 2 > 150:
            water |= lab == i
    water = cv2.morphologyEx(water.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    water = cv2.morphologyEx(water, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8)).astype(bool)

    # copas: muy oscuras y algo azuladas
    tree = (V < 62) & (B >= R) & roi & ~water

    # la arena es más clara que las calvas de hierba seca, que tienen un color parecido
    V8 = crop.max(-1).astype(np.float32)
    bunkers = []
    for p in poly_from_mask(sand, 6, min_solidity=0.3):
        m = np.zeros(R.shape, np.uint8)
        cv2.fillPoly(m, [np.array([[x * PX, y * PX] for x, y in p], np.int32)], 1)
        inner = V8[cv2.erode(m, np.ones((5, 5), np.uint8)) > 0]
        if len(inner) and inner.mean() >= MIN_SAND_V:
            bunkers.append(p)

    return {
        "bunkers": bunkers,
        "water": poly_from_mask(water & roi, 100, eps_m=0.8),
        "trees": trees_from_mask(tree),
    }


def main():
    crop = np.load(sys.argv[1])
    print(json.dumps(segment(crop, *(float(v) for v in sys.argv[2:6]))))


if __name__ == "__main__":
    main()
