# Sotoverde Clash

Hoyos de golf reales en vista cenital, al estilo **Golf Clash**, hechos con HTML5 Canvas y JavaScript sin dependencias.
El primer hoyo replicado es el **hoyo 3 del campo de Golf Sotoverde** (Arroyo de la Encomienda, Valladolid).

## Jugar

Abre `index.html` en el navegador (doble clic vale) o sírvelo en local:

```bash
python3 -m http.server 8000   # y abre http://localhost:8000
```

Controles:

1. **Apuntar**: arrastra por el mapa para mover la diana. Con potencia máxima la bola cae ahí (antes del viento).
2. **Potencia**: toca la bola y tira hacia atrás; suelta.
3. **Precisión**: para la aguja en la franja blanca (toque o barra espaciadora) para un **¡PERFECTO!**.
4. **Viento**: la flecha de arriba a la derecha indica hacia dónde sopla; corrige con los anillos de la diana.
5. **Efecto**: atrás / normal / adelante cambia la rodadura tras el bote.
6. **Green**: el putter no tiene aguja; las flechas animadas marcan la caída.
7. `V` o 🔭: ver el hoyo entero.
8. `P` o **2D**: plano topográfico con curvas de nivel cada metro, altitud del tee, del green y de la bola,
   desnivel tee → green y perfil de alturas (toca el perfil para leer la altura en cada punto).

Agua o fuera de límites: +1 golpe y se repite desde donde estaba la bola.

La bola sigue el relieve real: al botar en una ladera sale despedida hacia el lado bajo y, si la pendiente
empuja más de lo que frena la hierba, sigue rodando (por ejemplo, del talud derecho del hoyo 3 a la calle).

## Cómo se replica un hoyo real

Todo sale de datos abiertos del **Instituto Geográfico Nacional**:

| Qué | Fuente | Resolución |
|---|---|---|
| Forma del hoyo y distancias | Ortofoto PNOA (WMS `pnoa-ma`) | 25 cm/px, georreferenciada |
| Relieve | MDT05 (WCS `Elevacion25830_5`) | rejilla de 5 m |
| Par y metros de tarjeta | Tarjeta del club | — |
| Posición del tee | Marcador del jugador (Google Earth) y zona de salida marcada sobre la imagen de control | — |

El proceso (`tools/crear_hoyo.py`):

1. Se define el rectángulo del hoyo en UTM 30N y se traza a mano lo que el color no distingue bien:
   tee, bandera, green, calle y correcciones (`datos/sotoverde/hoyo03.json`).
2. El script descarga la ortofoto y el MDT, detecta **búnkeres, agua y árboles** por color
   (`tools/segmentar_hoyo.py`), aplica las correcciones y calcula la **caída del green** ajustando un plano al MDT.
3. Escribe `campos/<id>.json`, una imagen de control (`datos/sotoverde/<id>_control.jpg`) y regenera `js/campos.js`.

```bash
pip install numpy opencv-python-headless pillow
python3 tools/crear_hoyo.py datos/sotoverde/hoyo03.json
node tests/check-holes.js
```

Para otro hoyo: copia `hoyo03.json`, cambia `geo.origin`/tamaño, el tee (por ejemplo, con un marcador de Google Earth
pasado a UTM), la bandera, el green y la calle, y vuelve a ejecutar el script. Revisa la imagen de control.

### Limitaciones conocidas

- El MDT de 5 m da bien el desnivel general (en el hoyo 3, el green está unos 6 m por debajo del tee),
  pero no las ondulaciones finas de los greens: la caída del green es un plano aproximado (máx. 3 %).
  Para más detalle haría falta la nube de puntos LiDAR del CNIG o comprobarlo en el campo.
- La detección de árboles por color subestima las copas y se pierde algunos ejemplares sueltos.
- La posición de la bandera es fija (centro del green).

## Formato de un hoyo

Metros, origen arriba a la izquierda, `y` hacia abajo. Ángulos de brújula: 0 = norte (arriba), 90 = este.

```jsonc
{
  "id": "sotoverde-03", "name": "Sotoverde", "number": 3, "par": 4,
  "width": 340, "height": 150,
  "tee": {"x": 314, "y": 58}, "pin": {"x": 55, "y": 91},
  "tees": {"amarillas": {"x": 314, "y": 58, "label": "Amarillas"}, "rojas": {"x": 296, "y": 63, "label": "Rojas"}},
  "teeBox": [[x, y], ...],                              // zona de salida (opcional)
  "fairways": [[[x, y], ...]], "green": [[x, y], ...],
  "bunkers": [[[x, y], ...]], "water": [[[x, y], ...]],
  "trees": [{"x": 0, "y": 0, "r": 4}],
  "greenSlope": {"angle": 331, "strength": 0.28},      // hacia dónde cae; 1 = 4 %
  "elevation": {"cell": 5, "cols": 69, "rows": 31, "base": 706, "data": [...]},
  "wind": {"speed": 12, "angle": 90}                     // opcional; si falta es aleatorio
}
```

## Estructura

```
index.html, juego.html     menú y juego
css/style.css
js/core.js                 geometría, superficies, palos, cámara y dibujo
js/physics.js              vuelo con viento, bote, rodadura con pendiente
js/game.js                 controles y lógica del juego
js/holes.js                hoyos de ejemplo (inventados)
js/campos.js               generado: hoyos reales de campos/*.json
campos/                    hoyos reales en JSON
datos/sotoverde/           trazados manuales, imágenes de control y fuentes
tools/                     scripts de extracción (Python)
tests/check-holes.js       comprobaciones (node)
```

Ortofoto PNOA y MDT05 © Instituto Geográfico Nacional, licencia CC BY 4.0.
