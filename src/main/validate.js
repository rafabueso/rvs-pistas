'use strict';
// Validaciones compartidas. El motor vuelve a validar todo por su cuenta.
const path = require('path');

const PROJECT_ID = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
const STEM_FILES = new Set(['voz.flac', 'coros.flac', 'musica.flac', 'project.json']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.webm']);
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const EXPORT_FORMATS = new Set(['wav', 'mp3']);

function isProjectId(id) { return typeof id === 'string' && PROJECT_ID.test(id); }

function isAudioPath(p) {
  return typeof p === 'string' && p.length < 1024 && path.isAbsolute(p) && AUDIO_EXT.has(path.extname(p).toLowerCase());
}

function youtubeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !YT_HOSTS.has(u.hostname) || u.username || u.password) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (u.hostname === 'youtu.be' && parts.length === 1) id = parts[0];
  else if (parts[0] === 'watch') id = u.searchParams.get('v');
  else if (parts.length === 2 && ['shorts', 'embed', 'live'].includes(parts[0])) id = parts[1];
  return id && VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

function safeFileName(name) {
  const base = String(name || 'pista').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || 'pista';
}

module.exports = { isProjectId, isAudioPath, youtubeUrl, safeFileName, STEM_FILES, EXPORT_FORMATS, PROJECT_ID };
