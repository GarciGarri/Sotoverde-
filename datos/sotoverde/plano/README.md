# Plano del club → coordenadas

`lineas.json` son los extremos de las líneas rojas tee → green de cada hoyo, leídos en píxeles sobre una
captura del plano del campo de la app del club (recorte de 1050 × 1006 px; la imagen no se incluye).
El plano es un dibujo esquemático: tras ajustarlo a la ortofoto con una semejanza (escala, giro y
desplazamiento) los puntos quedan a 3–19 m de su posición real, por lo que solo se usa para saber
**dónde** está cada hoyo. El green se busca después en la ortofoto y el tee se coloca a la distancia
de tarjeta en la dirección que marca el plano (ver `tools/hoyos_desde_plano.py`).
