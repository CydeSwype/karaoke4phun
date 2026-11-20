import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { Room, makeRoomCode } from './room.js';
import { search, lookup, parseVideoId, loadCache, hasApiKey } from './youtube.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_MS = 12 * 60 * 60 * 1000;

/** The address phones should use: PUBLIC_URL if set, else this machine's LAN IP. */
function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}

const rooms = new Map();
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.resolve('public'), { extensions: ['html'] }));
app.get('/r/:code', (_req, res) => res.sendFile(path.resolve('public/remote.html')));

app.get('/api/config', (_req, res) => res.json({ baseUrl: publicBaseUrl(), searchEnabled: hasApiKey() }));

app.get('/api/qr', async (req, res) => {
  const url = String(req.query.url ?? '').slice(0, 300);
  if (!/^https?:\/\//.test(url)) return res.status(400).end();
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'max-age=3600').send(svg);
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 150);
  if (!q) return res.json({ results: [] });
  try {
    const id = parseVideoId(q);
    const results = id ? [await lookup(id)] : await search(q, { karaoke: req.query.karaoke !== '0' });
    res.json({ results });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ---- realtime -------------------------------------------------------------

function broadcast(room) {
  io.to(room.code).emit('room:state', room.snapshot());
}

/** Wraps a socket handler so thrown errors go back to the caller instead of crashing. */
const handle = (fn) => async (payload, ack) => {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    reply({ ok: true, ...(await fn(payload ?? {})) });
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
};

io.on('connection', (socket) => {
  let room = null;
  let role = null; // 'host' | 'remote'
  let clientId = null;

  const requireRoom = () => {
    if (!room) throw new Error('Not in a party');
    return room;
  };
  const sendToHost = (event, data) => io.to(`${room.code}:host`).emit(event, data);

  socket.on('host:open', handle(({ code }) => {
    // Reuse the TV's previous code when possible, so phones keep working after a server restart.
    const wanted = String(code ?? '').toUpperCase();
    room = rooms.get(wanted) ?? null;
    if (!room) {
      room = new Room(/^[A-Z]{4}$/.test(wanted) ? wanted : makeRoomCode(new Set(rooms.keys())));
      rooms.set(room.code, room);
    }
    role = 'host';
    socket.join(room.code);
    socket.join(`${room.code}:host`);
    room.touch();
    socket.emit('room:state', room.snapshot());
    return { code: room.code };
  }));

  socket.on('remote:join', handle(({ code, clientId: id, name }) => {
    const r = rooms.get(String(code ?? '').toUpperCase());
    if (!r) throw new Error('No party with that code — check the code on the TV');
    if (!/^[\w-]{8,64}$/.test(String(id))) throw new Error('Bad client id');
    room = r;
    role = 'remote';
    clientId = id;
    const singer = room.upsertSinger(clientId, name);
    socket.join(room.code);
    broadcast(room);
    return { name: singer.name };
  }));

  socket.on('song:add', handle(({ video }) => {
    const r = requireRoom();
    if (role !== 'remote') throw new Error('Only singers can add songs');
    const entry = r.addSong(clientId, video);
    const startNow = !r.nowPlaying;
    if (startNow) r.advance();
    broadcast(r);
    const position = startNow ? 0 : r.upcoming().findIndex((e) => e.id === entry.id) + 1;
    return { position };
  }));

  socket.on('song:remove', handle(({ entryId }) => {
    const r = requireRoom();
    r.removeSong(entryId, { singerId: clientId, isHost: role === 'host' });
    broadcast(r);
  }));

  // Anyone at the party can pause, resume or skip — it's a party.
  socket.on('player:command', handle(({ action }) => {
    requireRoom();
    if (!['play', 'pause', 'restart'].includes(action)) throw new Error('Unknown action');
    sendToHost('player:command', { action });
  }));

  socket.on('song:skip', handle(({ entryId }) => {
    const r = requireRoom();
    // entryId guards against two phones pressing skip at once and skipping two songs.
    if (r.nowPlaying && (!entryId || r.nowPlaying.id === entryId)) {
      r.advance();
      broadcast(r);
    }
  }));

  // Sent by the TV when a video finishes or YouTube refuses to play it.
  socket.on('player:ended', handle(({ entryId, error }) => {
    const r = requireRoom();
    if (role !== 'host' || r.nowPlaying?.id !== entryId) return;
    if (error) io.to(r.code).emit('room:notice', { message: `Couldn't play “${r.nowPlaying.title}” (${error}) — skipping` });
    r.advance();
    broadcast(r);
  }));

  socket.on('player:status', (status) => {
    if (role === 'host' && room) socket.to(room.code).emit('player:status', { playing: Boolean(status?.playing) });
  });
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_IDLE_MS;
  for (const [code, r] of rooms) if (r.lastActivity < cutoff) rooms.delete(code);
}, 10 * 60 * 1000).unref();

await loadCache();
server.listen(PORT, () => {
  console.log(`\n🎤 karaoke4phun running`);
  console.log(`   TV screen:  http://localhost:${PORT}/host`);
  console.log(`   Phones join at ${publicBaseUrl()} (shown as a QR code on the TV)`);
  if (!hasApiKey()) console.log('   ⚠ No YOUTUBE_API_KEY set — search is off; people can still paste YouTube links.');
  console.log('');
});
