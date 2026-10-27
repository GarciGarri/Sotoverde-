"""
Genera js/campo3d.js: relieve de todo el campo (MDT05 del IGN, rejilla de 5 m) y su contorno,
para el recorrido en 3D de la portada.

  python3 tools/campo_3d.py
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from crear_hoyo import WCS, cached, is_asc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "datos", "sotoverde")
X0, X1, Y0, Y1 = 349080, 349880, 4608730, 4609290  # múltiplos de 5 m


def main():
    url = (f"{WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion25830_5"
           f"&SUBSET=x({X0},{X1})&SUBSET=y({Y0},{Y1})&FORMAT=application/asc")
    path = cached(os.path.join(DATA, "cache", "campo_mdt5.asc"), url, is_asc)
    head, rows = {}, []
    for line in open(path, encoding="latin1").read().splitlines():
        p = line.split()
        if len(p) == 2 and p[0] in ("ncols", "nrows", "xllcorner", "yllcorner", "cellsize", "dx", "dy"):
            head[p[0]] = float(p[1])
        elif head.get("ncols") and len(p) == int(head["ncols"]):
            rows.append([float(v) for v in p])
    z = np.array(rows)  # fila 0 = norte
    base = float(np.floor(z.min()))
    ring = json.load(open(os.path.join(DATA, "contorno_campo.json"), encoding="utf-8"))["ring"]
    out = {
        "origin": [X0, Y1],  # esquina noroeste, x hacia el este, y hacia el sur
        "cell": head.get("cellsize", 5.0),
        "cols": int(z.shape[1]),
        "rows": int(z.shape[0]),
        "base": base,
        "dm": [int(round((v - base) * 10)) for v in z.ravel()],  # decímetros sobre la base
        "ring": [[round(X - X0, 1), round(Y1 - Y, 1)] for X, Y in ring],
        "source": "MDT05 © IGN (CC BY 4.0); contorno © OpenStreetMap (ODbL)",
    }
    js = ("// Generado por tools/campo_3d.py. No editar a mano.\n"
          "(function (global) {\n  'use strict';\n  const GC = (global.GC = global.GC || {});\n"
          f"  GC.COURSE_3D = {json.dumps(out, separators=(',', ':'))};\n"
          "})(typeof window !== 'undefined' ? window : globalThis);\n")
    with open(os.path.join(ROOT, "js", "campo3d.js"), "w", encoding="utf-8") as f:
        f.write(js)
    print(f"{out['cols']}x{out['rows']} celdas, base {base} m, desnivel {z.max() - z.min():.1f} m, {len(js) // 1024} KB")


if __name__ == "__main__":
    main()
