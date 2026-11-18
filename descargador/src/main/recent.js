'use strict';
// Lista corta de las últimas descargas (se guarda en el mismo archivo de ajustes) y nombres de salida del karaoke.
const path = require('path');

const MAX = 12;
const MODES = { karaoke: 'karaoke', voz: 'solo voz' };
const SUFFIX = / \((?:karaoke|solo voz)\)$/i;
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.webm']);

const stemOf = (p) => path.basename(p, path.extname(p));
const isAudio = (p) => typeof p === 'string' && AUDIO_EXT.has(path.extname(p).toLowerCase());
const isProcessed = (p) => SUFFIX.test(stemOf(p));

// Misma regla que el motor: misma carpeta y nombre + «(karaoke)» o «(solo voz)»; mp3 salvo que el original sea m4a.
function outputPath(src, mode) {
  if (!MODES[mode]) return null;
  const ext = path.extname(src).toLowerCase() === '.m4a' ? '.m4a' : '.mp3';
  return path.join(path.dirname(src), `${stemOf(src).replace(SUFFIX, '')} (${MODES[mode]})${ext}`);
}

function add(list, p) {
  const rest = list.filter((x) => x !== p);
  return [p, ...rest].slice(0, MAX);
}

function clean(list) {
  return (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string' && p.length < 1000 && path.isAbsolute(p) && isAudio(p)).slice(0, MAX);
}

module.exports = { MAX, MODES, isAudio, isProcessed, outputPath, add, clean, stemOf };
