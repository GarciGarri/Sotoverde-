"""
Traza las calles de los hoyos sobre la ortofoto (en lugar de la franja aproximada del plano).

  python3 tools/calles_desde_orto.py 4 5 6 …        # escribe "fairways" en datos/sotoverde/hoyoNN.json
  python3 tools/calles_desde_orto.py --prueba 9     # solo la imagen de control, sin tocar nada

La calle es hierba segada: más verde, clara y uniforme que el rough. Para cada hoyo:
1. Toma el color de referencia en ventanas de 3 m a lo largo de la línea de juego (las más lisas y verdes).
2. Marca los píxeles de color parecido y textura lisa dentro de un pasillo alrededor del hoyo.
3. Quita agua, búnkeres, árboles, green y tee (de campos/sotoverde-NN.json) y lo de fuera del campo.
4. Se queda con la mancha conectada a la línea de juego, la rellena y la suaviza.
Si el resultado es incoherente (muy pequeño o desbordado), deja la franja anterior y lo dice.
Imagen de control: datos/sotoverde/calles/NN.jpg (nueva en verde, anterior en rojo, semillas en amarillo).
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "datos", "sotoverde")
PX = 4  # px/m de la ortofoto de cada hoyo


def poly_px(pts):
    return np.round(np.array([[p["x"], p["y"]] if isinstance(p, dict) else p for p in pts], float) * PX).astype(np.int32)


def fill(shape, polys):
    m = np.zeros(shape, np.uint8)
    for p in polys:
        if len(p) >= 3:
            cv2.fillPoly(m, [poly_px(p)], 1)
    return m


def path_points(cfg, hole):
    tee = hole["tees"]["amarillas"] if "amarillas" in hole.get("tees", {}) else hole["tee"]
    pts = [np.array([tee["x"], tee["y"]], float)]
    if cfg.get("via"):
        pts.append(np.array(cfg["via"], float))
    pts.append(np.array([hole["pin"]["x"], hole["pin"]["y"]], float))
    return pts


def sample_path(pts, t0, t1, n):
    seg = [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)]
    L = sum(seg)
    out = []
    for k in range(n):
        d = L * (t0 + (t1 - t0) * k / max(1, n - 1))
        for i, s in enumerate(seg):
            if d <= s or i == len(seg) - 1:
                out.append(pts[i] + (pts[i + 1] - pts[i]) * min(1, d / s))
                break
            d -= s
    return out, L


def detect(n, write):
    cfg_path = os.path.join(DATA, f"hoyo{n:02d}.json")
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    hole = json.load(open(os.path.join(ROOT, "campos", f"sotoverde-{n:02d}.json"), encoding="utf-8"))
    img = cv2.imread(os.path.join(DATA, "cache", f"sotoverde-{n:02d}_orto.jpg"))
    H, W = img.shape[:2]
    lab = cv2.cvtColor(cv2.GaussianBlur(img, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    Lc = lab[..., 0]
    mean = cv2.blur(Lc, (9, 9))
    tex = np.sqrt(np.maximum(cv2.blur(Lc * Lc, (9, 9)) - mean * mean, 0))

    # lo que no puede ser calle
    block = fill((H, W), hole["water"] + hole["bunkers"] + [hole["green"]] + ([hole["teeBox"]] if hole.get("teeBox") else []))
    for t in hole["trees"]:
        cv2.circle(block, (int(t["x"] * PX), int(t["y"] * PX)), int(t["r"] * PX * 1.1), 1, -1)
    if hole.get("course"):
        block |= 1 - fill((H, W), [hole["course"]])
    block = cv2.dilate(block, np.ones((5, 5), np.uint8))

    par = hole["par"]
    pts = path_points(cfg, hole)
    # pasillo y zona de semillas: en pares 4-5 desde la caída del drive; en pares 3, el antegreen
    t0, t1 = (0.3, 0.9) if par >= 4 else (0.62, 0.93)
    seeds, L = sample_path(pts, t0, t1, 24)
    corridor = np.zeros((H, W), np.uint8)
    line_pts, _ = sample_path(pts, 0.18 if par >= 4 else 0.55, 1.0, 60)
    for p in line_pts:
        cv2.circle(corridor, (int(p[0] * PX), int(p[1] * PX)), int((34 if par >= 4 else 22) * PX), 1, -1)

    # color de referencia: ventanas lisas y verdes sobre la línea
    wins = []
    for p in seeds:
        x, y = int(p[0] * PX), int(p[1] * PX)
        x0, x1, y0, y1 = max(0, x - 6), min(W, x + 6), max(0, y - 6), min(H, y + 6)
        if x1 <= x0 or y1 <= y0 or block[y0:y1, x0:x1].mean() > 0.2:
            continue
        w = lab[y0:y1, x0:x1].reshape(-1, 3)
        green = 128 - np.median(w[:, 1])  # a* negativo = verde
        wins.append((float(tex[y0:y1, x0:x1].mean()), green, np.median(w, 0), (x, y)))
    if len(wins) < 4:
        return None, "pocas semillas válidas"
    wins.sort(key=lambda w: w[0] - 0.6 * w[1])
    good = wins[: max(4, len(wins) // 2)]
    ref = np.median(np.array([w[2] for w in good]), 0)
    tex_ref = float(np.median([w[0] for w in good]))

    d = np.sqrt(0.35 * (lab[..., 0] - ref[0]) ** 2 + (lab[..., 1] - ref[1]) ** 2 + (lab[..., 2] - ref[2]) ** 2)
    cand = ((d < 11) & (tex < max(5.5, tex_ref * 1.8)) & (corridor > 0) & (block == 0)).astype(np.uint8)
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    cand = cv2.morphologyEx(cand, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    cnt, lab_cc = cv2.connectedComponents(cand, 8)
    keep = np.zeros_like(cand)
    for (_, _, _, (x, y)) in wins:
        k = lab_cc[min(H - 1, y), min(W - 1, x)]
        if k:
            keep[lab_cc == k] = 1
    # rellenar huecos (árboles sueltos, marcas) y suavizar el borde
    cs, _ = cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    keep = np.zeros_like(keep)
    cv2.drawContours(keep, cs, -1, 1, -1)
    keep = cv2.morphologyEx(keep, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    keep = (cv2.GaussianBlur(keep.astype(np.float32), (0, 0), 9) > 0.5).astype(np.uint8)
    keep[block > 0] = 0
    cs, _ = cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cs = [c for c in cs if cv2.contourArea(c) / PX ** 2 > (250 if par >= 4 else 60)]
    if not cs:
        return None, "sin mancha conectada a la línea de juego"
    polys = [[[round(float(p[0][0]) / PX, 1), round(float(p[0][1]) / PX, 1)] for p in cv2.approxPolyDP(c, 0.8 * PX, True)] for c in cs]
    area = sum(cv2.contourArea(c) for c in cs) / PX ** 2
    old = sum(cv2.contourArea(poly_px(p)) for p in cfg["fairways"]) / PX ** 2
    info = {"area": round(area), "antes": round(old), "manchas": len(cs), "ref": [round(float(v)) for v in ref]}
    ok = 0.25 * old < area < 4.5 * old
    # control
    ctl = img.copy()
    for p in cfg["fairways"]:
        cv2.polylines(ctl, [poly_px(p)], True, (0, 0, 255), 2)
    for p in polys:
        cv2.polylines(ctl, [poly_px(p)], True, (60, 255, 60), 3)
    for (_, _, _, (x, y)) in good:
        cv2.circle(ctl, (x, y), 6, (0, 255, 255), -1)
    cv2.polylines(ctl, [np.round(np.array(pts) * PX).astype(np.int32)], False, (255, 255, 255), 2)
    cv2.circle(ctl, tuple(int(v * PX) for v in pts[0]), 14, (255, 120, 0), -1)
    cv2.circle(ctl, tuple(int(v * PX) for v in pts[-1]), 14, (0, 0, 255), -1)
    cv2.putText(ctl, f"{n}", (12, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 4)
    os.makedirs(os.path.join(DATA, "calles"), exist_ok=True)
    cv2.imwrite(os.path.join(DATA, "calles", f"{n:02d}.jpg"), ctl, [cv2.IMWRITE_JPEG_QUALITY, 78])
    if not ok:
        return None, f"resultado incoherente {info}"
    if write:
        cfg["fairways"] = polys
        cfg["fairway_source"] = "ortofoto: hierba segada detectada por color y textura (tools/calles_desde_orto.py)"
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=1)
    return polys, info


def main(args):
    write = "--prueba" not in args
    for a in [a for a in args if a != "--prueba"]:
        polys, info = detect(int(a), write)
        print(f"hoyo {int(a):2d}: {'calle trazada' if polys else 'se queda la franja'} · {info}")


if __name__ == "__main__":
    main(sys.argv[1:])
