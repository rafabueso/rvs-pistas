'use strict';
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const FORMATS = new Set(['mp3', 'm4a']);

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

module.exports = { youtubeUrl, FORMATS };
