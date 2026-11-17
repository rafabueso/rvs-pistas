# Pistas · Rafa Vocal Studio

Programa de escritorio (Windows y macOS) para practicar con tus canciones:

1. Pegas un enlace de YouTube (o eliges un archivo de audio).
2. Se separa en tres pistas: **voz principal**, **coros** y **música**.
3. Cambias la **velocidad** (50–150 %) y el **tono** (±6 semitonos) sin que se deforme el sonido.
4. Silencias o dejas en solo cada pista, usas mezclas rápidas (karaoke, karaoke con coros…) y exportas en WAV o MP3.

Todo ocurre en tu ordenador: el audio no se sube a ningún servidor.

## Cómo está hecho

- **Interfaz:** Electron con aislamiento completo (sin Node en la página, protocolo propio `rvs://`, política de seguridad estricta, permisos denegados, navegación externa bloqueada).
- **Motor de audio:** Python empaquetado con PyInstaller, lanzado sin shell. Descarga con `yt-dlp` (solo enlaces de YouTube, un vídeo, máximo 20 min) y decodifica con ffmpeg.
- **Separación:** modelos MDX-Net en ONNX (`Voc_FT` para la voz y `KARA_2` para separar coros). Se comprueba su huella sha256. La música es la mezcla menos la voz, así que las tres pistas suman exactamente la canción original.
- **Tempo y tono:** SoundTouch (`soundtouchjs`, licencia LGPL) en un AudioWorklet; el mismo motor sirve para escuchar y para exportar.
- **Tempo (BPM) y tonalidad:** estimados con análisis propio.

> Nota: se eligió MDX-Net en lugar de Demucs porque Demucs exige PyTorch (1–2 GB y empaquetado delicado en Windows/Mac). Se puede añadir más adelante como segundo motor.

## Desarrollo

```bash
npm ci
pip install -r engine/requirements.txt
python scripts/fetch_models.py     # modelos en build/models (o RVS_MODELS=/ruta)
npm start
npm test                           # DSP
python -m unittest discover -s engine/tests -t engine
```

## Compilar

`.github/workflows/build.yml` ejecuta las pruebas y genera el instalador de Windows (.exe) y los de macOS (.dmg, Apple Silicon e Intel) como artefactos. Con una etiqueta `v*` también se puede publicar una versión.

## Avisos

- Las aplicaciones **no están firmadas**: Windows mostrará SmartScreen ("Más información → Ejecutar de todos modos") y macOS pedirá abrirla con clic derecho → Abrir la primera vez.
- YouTube cambia a menudo: si falla una descarga, hay que recompilar con la última versión de `yt-dlp`.
- Descargar de YouTube puede incumplir sus condiciones de servicio y los derechos de autor del material. Úsalo solo con contenido propio o con permiso. Por eso el repositorio es **privado**.
