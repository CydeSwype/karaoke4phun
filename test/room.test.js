import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, makeRoomCode } from '../server/room.js';

const vid = (n) => ({ videoId: `vid${String(n).padStart(8, '0')}`, title: `Song ${n}` });
const order = (room) => room.upcoming().map((e) => `${room.singers.get(e.singerId).name}:${e.title}`);

function party(...names) {
  const room = new Room('TEST');
  for (const n of names) room.upsertSinger(n, n);
  return room;
}

test('round-robin across singers regardless of how many songs each queued', () => {
  const room = party('A', 'B', 'C');
  room.addSong('A', vid(1));
  room.addSong('A', vid(2));
  room.addSong('A', vid(3));
  room.addSong('B', vid(4));
  room.addSong('C', vid(5));
  room.addSong('C', vid(6));
  assert.deepEqual(order(room), ['A:Song 1', 'B:Song 4', 'C:Song 5', 'A:Song 2', 'C:Song 6', 'A:Song 3']);
});

test('a newcomer joins at the back of the current round', () => {
  const room = party('A', 'B', 'C');
  room.addSong('A', vid(1));
  room.addSong('A', vid(2));
  room.addSong('B', vid(3));
  room.advance(); // A sings
  room.addSong('C', vid(4));
  assert.equal(room.nowPlaying.title, 'Song 1');
  assert.deepEqual(order(room), ['B:Song 3', 'C:Song 4', 'A:Song 2']);
});

test('several newcomers keep their join order, all before the current singer comes round', () => {
  const room = party('A', 'B', 'C', 'D');
  room.addSong('A', vid(1));
  room.addSong('A', vid(2));
  room.addSong('B', vid(3));
  room.advance(); // A sings
  room.addSong('D', vid(4));
  room.addSong('C', vid(5));
  assert.deepEqual(order(room), ['B:Song 3', 'D:Song 4', 'C:Song 5', 'A:Song 2']);
});

test('someone who just sang and adds another song waits for everyone else', () => {
  const room = party('A', 'B');
  room.addSong('A', vid(1));
  room.addSong('B', vid(2));
  room.advance(); // A sings, has nothing left
  room.addSong('A', vid(3));
  assert.deepEqual(order(room), ['B:Song 2', 'A:Song 3']);
});

test('advance walks the queue and records history, then empties', () => {
  const room = party('A', 'B');
  room.addSong('A', vid(1));
  room.addSong('B', vid(2));
  assert.equal(room.advance().title, 'Song 1');
  assert.equal(room.advance().title, 'Song 2');
  assert.equal(room.advance(), null);
  assert.deepEqual(room.history.map((e) => e.title), ['Song 2', 'Song 1']);
});

test('only the owner or host can remove a song', () => {
  const room = party('A', 'B');
  const e = room.addSong('A', vid(1));
  assert.throws(() => room.removeSong(e.id, { singerId: 'B' }));
  assert.equal(room.removeSong(e.id, { singerId: 'A' }), true);
  const e2 = room.addSong('A', vid(2));
  assert.equal(room.removeSong(e2.id, { isHost: true }), true);
  assert.equal(room.pending.length, 0);
});

test('rejects unknown singers and malformed video ids', () => {
  const room = party('A');
  assert.throws(() => room.addSong('nobody', vid(1)));
  assert.throws(() => room.addSong('A', { videoId: 'bad id' }));
});

test('room codes avoid taken codes and confusing letters', () => {
  const code = makeRoomCode(new Set(['AAAA']));
  assert.match(code, /^[A-HJ-NP-Z]{4}$/);
});

test('host reordering switches to custom order; new songs go to the end', () => {
  const room = party('A', 'B', 'C');
  room.addSong('A', vid(1));
  room.addSong('A', vid(2));
  room.addSong('B', vid(3));
  room.addSong('C', vid(4));
  // fair: A1 B3 C4 A2 -> move C4 to the top
  const c4 = room.upcoming()[2];
  room.moveSong(c4.id, 0);
  assert.equal(room.mode, 'custom');
  room.addSong('B', vid(5));
  assert.deepEqual(order(room), ['C:Song 4', 'A:Song 1', 'B:Song 3', 'A:Song 2', 'B:Song 5']);
  assert.equal(room.advance().title, 'Song 4');
});

test('switching back to fair order restores the rotation', () => {
  const room = party('A', 'B');
  room.addSong('A', vid(1));
  room.addSong('A', vid(2));
  room.addSong('B', vid(3));
  room.moveSong(room.upcoming()[2].id, 2); // no-op move still switches mode
  room.moveSong(room.upcoming()[1].id, 2); // A1 A2 B3
  assert.deepEqual(order(room), ['A:Song 1', 'A:Song 2', 'B:Song 3']);
  room.useFairOrder();
  assert.deepEqual(order(room), ['A:Song 1', 'B:Song 3', 'A:Song 2']);
});

test('guests added by name are one singer, and sung counts add up', () => {
  const room = party('A');
  const g1 = room.upsertGuest('Mom');
  const g2 = room.upsertGuest(' mom ');
  assert.equal(g1, g2);
  room.addSong(g1.id, vid(1));
  room.addSong('A', vid(2));
  room.advance();
  room.advance();
  const counts = Object.fromEntries(room.snapshot().singers.map((s) => [s.name, s.sung]));
  assert.deepEqual(counts, { A: 1, mom: 1 });
});

test('replacing a song keeps its singer and place; only owner or host may', () => {
  const room = party('A', 'B');
  const a = room.addSong('A', vid(1));
  room.addSong('B', vid(2));
  assert.throws(() => room.replaceSong(a.id, vid(9), { singerId: 'B' }));
  room.replaceSong(a.id, vid(9), { isHost: true });
  assert.deepEqual(order(room), ['A:Song 9', 'B:Song 2']);
  room.replaceSong(a.id, vid(8), { singerId: 'A' });
  assert.equal(room.upcoming()[0].videoId, vid(8).videoId);
});
