import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { Room, makeRoomCode, isHostKey } from './room.js';
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
app.get('/a/:code', (_req, res) => res.sendFile(path.resolve('public/audience.html')));

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
  let role = null; // 'tv' (main screen) | 'remote' (phone) | 'audience' (second screen)
  let isAdmin = false; // the TV, or a phone that opened the host link
  let clientId = null;

  const requireRoom = () => {
    if (!room) throw new Error('Not in a party');
    return room;
  };
  const requireAdmin = () => {
    if (!isAdmin) throw new Error('Only the host can do that');
    return requireRoom();
  };
  const sendToTv = (event, data) => io.to(`${room.code}:tv`).emit(event, data);

  socket.on('host:open', handle(({ code, hostKey }) => {
    // Reopen the TV's previous party if it proves it owns it (hostKey). After a server restart,
    // recreate it under the same code and key so phones, including the host's, keep working.
    const wanted = String(code ?? '').toUpperCase();
    const existing = rooms.get(wanted);
    if (existing && existing.hostKey === hostKey) room = existing;
    else if (!existing && /^[A-Z]{4}$/.test(wanted) && isHostKey(hostKey)) room = new Room(wanted, hostKey);
    else room = new Room(makeRoomCode(new Set(rooms.keys())));
    rooms.set(room.code, room);
    role = 'tv';
    isAdmin = true;
    socket.join(room.code);
    socket.join(`${room.code}:tv`);
    room.touch();
    socket.emit('room:state', room.snapshot());
    return { code: room.code, hostKey: room.hostKey };
  }));

  socket.on('remote:join', handle(({ code, clientId: id, name, hostKey }) => {
    const r = rooms.get(String(code ?? '').toUpperCase());
    if (!r) throw new Error('No party with that code — check the code on the TV');
    if (!/^[\w-]{8,64}$/.test(String(id))) throw new Error('Bad client id');
    room = r;
    role = 'remote';
    clientId = id;
    isAdmin = Boolean(hostKey) && hostKey === r.hostKey;
    const singer = room.upsertSinger(clientId, name);
    socket.join(room.code);
    broadcast(room);
    if (room.playback) socket.emit('player:status', room.playback);
    return { name: singer.name, isAdmin };
  }));

  socket.on('audience:join', handle(({ code }) => {
    const r = rooms.get(String(code ?? '').toUpperCase());
    if (!r) throw new Error('No party with that code');
    room = r;
    role = 'audience';
    socket.join(room.code);
    socket.emit('room:state', room.snapshot());
    // age lets the audience screen work out where the video is now, not when this was reported.
    if (room.playback) socket.emit('player:status', { ...room.playback, age: (Date.now() - room.playback.at) / 1000 });
    return { code: room.code };
  }));

  socket.on('song:add', handle(({ video, forSinger }) => {
    const r = requireRoom();
    if (role !== 'remote') throw new Error('Only singers can add songs');
    let singerId = clientId;
    if (forSinger) {
      // The host can add songs for other people, including guests without a phone.
      requireAdmin();
      if (forSinger.id && r.singers.has(forSinger.id)) singerId = forSinger.id;
      else singerId = r.upsertGuest(forSinger.name).id;
    }
    const entry = r.addSong(singerId, video);
    const startNow = !r.nowPlaying;
    if (startNow) r.advance();
    broadcast(r);
    const position = startNow ? 0 : r.upcoming().findIndex((e) => e.id === entry.id) + 1;
    return { position, singerName: r.singers.get(singerId).name };
  }));

  socket.on('song:replace', handle(({ entryId, video }) => {
    const r = requireRoom();
    r.replaceSong(entryId, video, { singerId: clientId, isHost: isAdmin });
    broadcast(r);
  }));

  socket.on('song:remove', handle(({ entryId }) => {
    const r = requireRoom();
    r.removeSong(entryId, { singerId: clientId, isHost: isAdmin });
    broadcast(r);
  }));

  socket.on('admin:move', handle(({ entryId, toIndex }) => {
    const r = requireAdmin();
    r.moveSong(entryId, toIndex);
    broadcast(r);
  }));

  socket.on('admin:fair', handle(() => {
    const r = requireAdmin();
    r.useFairOrder();
    broadcast(r);
  }));

  socket.on('admin:display', handle(({ sidebar }) => {
    const r = requireAdmin();
    r.display = { ...r.display, sidebar: Boolean(sidebar) };
    broadcast(r);
  }));

  // Anyone at the party can pause, resume or skip — it's a party.
  socket.on('player:command', handle(({ action }) => {
    requireRoom();
    if (!['play', 'pause', 'restart'].includes(action)) throw new Error('Unknown action');
    sendToTv('player:command', { action });
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
    if (role !== 'tv' || r.nowPlaying?.id !== entryId) return;
    if (error) io.to(r.code).emit('room:notice', { message: `Couldn't play “${r.nowPlaying.title}” (${error}) — skipping` });
    r.advance();
    broadcast(r);
  }));

  // The TV reports what it's playing; phones show play/pause and the audience screen syncs to it.
  socket.on('player:status', (s) => {
    if (role !== 'tv' || !room) return;
    room.playback = {
      entryId: String(s?.entryId ?? ''),
      videoId: String(s?.videoId ?? ''),
      playing: Boolean(s?.playing),
      time: Number(s?.time) || 0,
      at: Date.now(),
    };
    socket.to(room.code).emit('player:status', room.playback);
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
