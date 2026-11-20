import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE = path.resolve('data/search-cache.json');

// Searches cost 100 of the default 10,000 daily quota units, so cache them on disk.
const cache = new Map();
let saveTimer = null;

export async function loadCache() {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) if (now - v.at < CACHE_TTL_MS) cache.set(k, v);
  } catch {
    // no cache yet
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
  }, 2000);
}

export const hasApiKey = () => Boolean(process.env.YOUTUBE_API_KEY);

/** Pulls an 11-character video id out of a YouTube URL, or returns null. */
export function parseVideoId(input) {
  const s = String(input ?? '').trim();
  // A bare id only counts if it has a digit, - or _, so an 11-letter search word isn't mistaken for one.
  if (/^[\w-]{11}$/.test(s) && /[\d_-]/.test(s)) return s;
  try {
    const url = new URL(s);
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return url.pathname.slice(1, 12) || null;
    if (host === 'youtube.com') {
      if (url.searchParams.get('v')) return url.searchParams.get('v');
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    // not a URL
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

async function api(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    const err = new Error(reason === 'quotaExceeded' ? 'YouTube search quota used up for today — paste a link instead' : body?.error?.message || `YouTube API error ${res.status}`);
    err.status = reason === 'quotaExceeded' ? 429 : 502;
    throw err;
  }
  return body;
}

export async function search(query, { karaoke = true } = {}) {
  const q = karaoke && !/karaoke|instrumental/i.test(query) ? `${query} karaoke` : query;
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = cache.get(key);
  if (hit) return hit.results;

  if (!hasApiKey()) {
    const err = new Error('Search is not set up (no YOUTUBE_API_KEY) — paste a YouTube link instead');
    err.status = 503;
    throw err;
  }

  const found = await api('search', {
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '15',
    q,
  });
  const ids = found.items.map((i) => i.id.videoId).filter(Boolean);
  const durations = new Map();
  if (ids.length) {
    const details = await api('videos', { part: 'contentDetails', id: ids.join(',') });
    for (const v of details.items) durations.set(v.id, parseIsoDuration(v.contentDetails?.duration));
  }

  const results = found.items
    .filter((i) => i.id.videoId && i.snippet.liveBroadcastContent === 'none')
    .map((i) => ({
      videoId: i.id.videoId,
      title: decodeEntities(i.snippet.title),
      channel: decodeEntities(i.snippet.channelTitle),
      thumbnail: i.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`,
      duration: durations.get(i.id.videoId) ?? null,
    }));

  cache.set(key, { at: Date.now(), results });
  scheduleSave();
  return results;
}

/** Looks up a single video by id. Uses oEmbed, which needs no API key or quota. */
export async function lookup(videoId) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'That video does not allow embedding' : 'Video not found');
    err.status = 404;
    throw err;
  }
  const o = await res.json();
  return {
    videoId,
    title: o.title,
    channel: o.author_name,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration: null,
  };
}
