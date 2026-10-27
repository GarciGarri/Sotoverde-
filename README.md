# Sotoverde Clash

**Mis vueltas** (`index.html`): apunta los golpes de una vuelta real en Golf Sotoverde tocando en el mapa de
cada hoyo dónde quedó la bola (palo, distancia y lie automáticos), con penalizaciones, putts, tarjeta y
estadísticas (calles, greens en regulación, distancia media por palo).

Vista del hoyo a pantalla completa. Para apuntar un golpe: toca el mapa donde quedó la bola y aparece una
bola provisional con el lie y la distancia; arrástrala (con lupa ×3) para afinarla y pulsa «Apuntar golpe».
Mantener pulsado también abre la lupa. Pellizca o usa + / − para el zoom, arrastra el mapa para moverte,
«Todo» enseña el hoyo entero y «Auto» vuelve al encuadre bola-green. En el green, «Putts / green» cambia el
panel a putts y «Embocada · terminar». Mientras hay una bola provisional el panel se pliega y el mapa queda fijo.

Modo **Trazar** (tracer): arrastra el dedo desde la bola dibujando el vuelo; se pinta con un trazo luminoso
animado, se guarda simplificado y se clasifica la curva (recto, draw, fade, gancho, slice; para zurdos se
invierte desde Mi bolsa). La tarjeta muestra el vuelo trazado más repetido por palo y Mi bolsa propone usarlo
como vuelo habitual.

Resultado respecto al par: el número de golpe lleva el color de lo que harías si embocas con él
(«golpe para birdie», «para par», «para bogey»…: verde, gris, ámbar, rojo). Al llegar al green sale
«Putt para…», al quedarte sin opción de par un aviso ámbar o rojo, y al terminar el hoyo un cartel con el
resultado. En la tarjeta las filas bajo par van en verde y las de sobre par en rojo.

La app se abre siempre en modo claro; el oscuro solo si se elige expresamente en el visor.

**Mi bolsa**: cada palo con su distancia habitual, vuelo (recto, draw, fade, gancho, slice), altura de bola y
fallo más repetido. En cada golpe recomienda palo y punto de mira según la distancia que juega el golpe:
desnivel real del MDT (1 m de subida ≈ 1 m más), viento (+0,62 %/km/h de cara, −0,31 %/km/h a favor; ×1,3 con
bola alta y ×0,7 con bola baja), temperatura (−0,2 %/°C sobre la de referencia) y deriva por viento cruzado
y por el vuelo habitual; avisa si el fallo habitual acaba en agua, búnker o fuera de límites.
Son reglas de campo aproximadas, no un modelo balístico. En la página publicada las vueltas se
guardan en la cuenta de cada persona; abierto en local, en el navegador. El botón GPS funciona donde el
navegador da la ubicación (no dentro de claude.ai).

**Conoce el campo**: en la portada, un recorrido 3D de unos 2,5 minutos generado en el navegador con three.js
(se carga de cdnjs, con copia en `vendor/` por si falla). El terreno es la ortofoto PNOA (25 cm/px en el campo,
1 m/px en los alrededores) sobre el relieve del MDT05 (exagerado ×1,3). Encima van los edificios en volumen
(plantas de OpenStreetMap, con tejado de la ortofoto y tejado a cuatro aguas en las casas), la casa club, el
edificio de los puestos de la cancha de prácticas, los cuatro lagos con su nivel del MDT, el puente, ~500 árboles
con el color de su copa en la ortofoto, banderas y tees. Tras la introducción enseña las instalaciones (casa club,
cancha de prácticas y puente, con datos calculados: hoyos cercanos, superficie y fondo de la cancha, largo del
puente) y luego recorre cada hoyo del tee al green con su ficha: par, metros, hándicap, tipo de hoyo, desnivel,
agua, búnkeres y un consejo. Se puede pausar y saltar de tramo.
`tools/campo_3d.py` genera `js/campo3d.js`, las texturas de `img/` y `datos/sotoverde/campo3d_control.jpg`
(control de lo extraído sobre la ortofoto). Alturas de los edificios supuestas (casas 5,6 m más tejado).

**Resumen 3D**: en la tarjeta, «Resumen 3D» repasa la vuelta en la misma escena del recorrido 3D y el botón «3D»
de cada fila (o «Ver en 3D» al terminar un hoyo) repasa un solo hoyo. La cámara se pone detrás de la bola en
cada golpe, la bola vuela con su estela (siguiendo la línea trazada si el golpe se dibujó; en rojo si acabó en
agua o fuera), queda una marca numerada donde paró y una ficha explica el golpe: palo, metros, de dónde a dónde,
lo que quedaba a bandera, desnivel y vuelo, con un icono del lie (calle, rough, búnker, green, agua, fuera) en la
ficha y en la marca 3D donde quedó la bola. Luego las penalizaciones con su drop, los putts y el resultado del
hoyo; la vuelta empieza y acaba con el resumen (golpes, resultado al par, pares, bogeys, putts, mejor hoyo).
Los hoyos de tarjetas importadas sin golpes en el mapa se enseñan con su resultado.

**Modo juego** (`jugar.html`): los mismos hoyos al estilo Golf Clash.

Hoyos de golf reales en vista cenital, al estilo **Golf Clash**, hechos con HTML5 Canvas y JavaScript sin dependencias.
Los **18 hoyos** del campo de **Golf Sotoverde** (Arroyo de la Encomienda, Valladolid), par 60, 3.185 m desde amarillas.

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

Para otro hoyo: copia `hoyo01.json`/`hoyo03.json`, cambia `geo.origin`/tamaño, el tee (por ejemplo, con un marcador de Google Earth
pasado a UTM), la bandera, el green y la calle, y vuelve a ejecutar el script. Revisa la imagen de control: si la detección por color confunde
arboledas con agua o edificios con búnkeres, corrígelo con `exclude_points`, `exclude_rects`, `extra_trees`
o `extra_bunkers`.

### Hoyos 4 a 18: a partir del plano del club

Los hoyos 1-3 se trazaron a mano con las marcas del jugador. Para el resto, `tools/hoyos_desde_plano.py`:

1. Lee las líneas tee → green del plano del club (`datos/sotoverde/plano/lineas.json`, en píxeles del plano).
2. Ajusta el plano a la ortofoto con una semejanza usando los hoyos 1-3 y los cuatro lagos como puntos de control.
   El plano es esquemático (3-19 m de error), así que solo dice **dónde** está cada hoyo.
3. Busca el green en la ortofoto (zona lisa, clara y compacta más cercana a la prevista; el 15 y el 16 se
   situaron a mano).
4. Coloca las barras a la distancia exacta de tarjeta en la dirección del plano (el 6 tiene codo).
5. Escribe `datos/sotoverde/hoyoNN.json`; después `tools/crear_hoyo.py` hace el resto (búnkeres, agua, árboles,
   relieve, contorno del campo).

```bash
python3 tools/hoyos_desde_plano.py
for n in $(seq -w 1 18); do python3 tools/crear_hoyo.py datos/sotoverde/hoyo$n.json; done
```

Fuera del contorno del campo (OpenStreetMap, `datos/sotoverde/contorno_campo.json`) es fuera de límites.

### Limitaciones conocidas

- Calles de los hoyos 4-18: franja de ancho fijo a lo largo del hoyo (pares 4 y 5) o antegreen (pares 3);
  en esta ortofoto el rough está segado y no se distingue bien de la calle. Los hoyos 1-3 están trazados a mano.
- Barras rojas solo en la ida (la tarjeta de rojas de la vuelta no está disponible).

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
index.html                 Mis vueltas (portada, hoyos, tarjeta, bolsa)
jugar.html, juego.html     menú y juego
css/style.css
js/core.js                 geometría, superficies, palos, cámara y dibujo
js/physics.js              vuelo con viento, bote, rodadura con pendiente
js/game.js                 controles y lógica del juego
js/holes.js                hoyos de ejemplo (inventados)
js/campos.js               generado: hoyos reales de campos/*.json
js/campo3d.js              generado: relieve de todo el campo para el recorrido 3D
js/tour.js                 recorrido 3D de la portada (three.js)
img/                       generado: ortofotos para el recorrido 3D
vendor/three.min.js        three.js r128 (MIT), por si no carga la CDN
campos/                    hoyos reales en JSON
datos/sotoverde/           trazados manuales, imágenes de control y fuentes
tools/                     scripts de extracción (Python)
tests/check-holes.js       comprobaciones (node)
```

Ortofoto PNOA y MDT05 © Instituto Geográfico Nacional, licencia CC BY 4.0.
