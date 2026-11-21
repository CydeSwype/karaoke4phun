import { randomUUID, randomBytes } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, which get misread

export function makeRoomCode(taken = new Set()) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
}

export const isHostKey = (k) => /^[a-f0-9]{16}$/.test(String(k ?? ''));

/**
 * One karaoke party. By default songs play in a fair rotation: every singer gets one
 * turn per round, and someone who joins mid-round goes to the back of it. Once the host
 * reorders the queue by hand it switches to a custom order, where new songs go to the end,
 * until the host switches back.
 */
export class Room {
  constructor(code, hostKey) {
    this.code = code;
    this.hostKey = isHostKey(hostKey) ? hostKey : randomBytes(8).toString('hex');
    this.singers = new Map(); // id -> { id, name, turnKey, sung }
    this.pending = []; // in 'fair' mode: the order songs were added; in 'custom' mode: play order
    this.mode = 'fair';
    this.display = { sidebar: true, music: true }; // what the TV shows; set from the host's phone
    this.nowPlaying = null;
    this.history = [];
    this.clock = 0; // increases every time someone takes a turn or joins the rotation
    this.joiners = 0; // people who joined during the current song, to keep their join order
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  upsertSinger(id, name) {
    const clean = String(name ?? '').trim().slice(0, 24) || 'Singer';
    const existing = this.singers.get(id);
    if (existing) existing.name = clean;
    else this.singers.set(id, { id, name: clean, turnKey: null, sung: 0 });
    this.touch();
    return this.singers.get(id);
  }

  addSong(singerId, video) {
    const singer = this.singers.get(singerId);
    if (!singer) throw new Error('Join the party before adding songs');
    const fields = this.#videoFields(video);

    // Someone not in the rotation joins it at the back of the current round: after everyone
    // still waiting, but before the current singer comes round again.
    if (singer.turnKey === null) {
      const current = this.nowPlaying && this.singers.get(this.nowPlaying.singerId);
      singer.turnKey = current?.turnKey != null ? current.turnKey - 1 + ++this.joiners * 1e-6 : ++this.clock;
    }

    const entry = {
      id: randomUUID(),
      singerId,
      ...fields,
      addedAt: Date.now(),
    };
    this.pending.push(entry);
    this.touch();
    return entry;
  }

  /** A singer added by the host by name, for someone without a phone. Same name, same singer. */
  upsertGuest(name) {
    const clean = String(name ?? '').trim().slice(0, 24);
    if (!clean) throw new Error('Enter a name');
    return this.upsertSinger(`guest:${clean.toLowerCase()}`, clean);
  }

  /** Host moves a song to a new position in the upcoming list; switches to custom order. */
  moveSong(entryId, toIndex) {
    const order = this.upcoming();
    const from = order.findIndex((e) => e.id === entryId);
    if (from === -1) throw new Error('That song is no longer in the queue');
    const to = Math.max(0, Math.min(order.length - 1, Math.trunc(Number(toIndex) || 0)));
    order.splice(to, 0, ...order.splice(from, 1));
    this.pending = order;
    this.mode = 'custom';
    this.touch();
  }

  /** Back to automatic fair rotation. */
  useFairOrder() {
    this.mode = 'fair';
    this.touch();
  }

  /** Swap a queued song's video (e.g. a better karaoke version), keeping its singer and place. */
  replaceSong(entryId, video, { singerId, isHost = false } = {}) {
    const entry = this.pending.find((e) => e.id === entryId);
    if (!entry) throw new Error('That song is no longer in the queue');
    if (!isHost && entry.singerId !== singerId) throw new Error('You can only change your own songs');
    Object.assign(entry, this.#videoFields(video));
    this.touch();
    return entry;
  }

  #videoFields(video) {
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) throw new Error('Invalid video');
    return {
      videoId: video.videoId,
      title: String(video.title ?? 'Untitled').slice(0, 200),
      channel: String(video.channel ?? '').slice(0, 100),
      thumbnail: video.thumbnail ?? `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
      duration: Number.isFinite(video.duration) ? video.duration : null,
    };
  }

  removeSong(entryId, { singerId, isHost = false } = {}) {
    const idx = this.pending.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    if (!isHost && this.pending[idx].singerId !== singerId) throw new Error('You can only remove your own songs');
    this.pending.splice(idx, 1);
    this.touch();
    return true;
  }

  /** Pending entries in the order they will play. */
  upcoming() {
    if (this.mode === 'custom') return [...this.pending];
    const bySinger = new Map();
    for (const e of this.pending) {
      if (!bySinger.has(e.singerId)) bySinger.set(e.singerId, []);
      bySinger.get(e.singerId).push(e);
    }
    const keys = new Map();
    for (const id of bySinger.keys()) keys.set(id, this.singers.get(id)?.turnKey ?? 0);

    const order = [];
    let simClock = this.clock;
    while (bySinger.size) {
      let pick = null;
      for (const id of bySinger.keys()) if (pick === null || keys.get(id) < keys.get(pick)) pick = id;
      const list = bySinger.get(pick);
      order.push(list.shift());
      if (list.length) keys.set(pick, ++simClock);
      else bySinger.delete(pick);
    }
    return order;
  }

  /** Move the next song into "now playing". Returns it, or null when the queue is empty. */
  advance() {
    if (this.nowPlaying) this.history.unshift({ ...this.nowPlaying, endedAt: Date.now() });
    this.history.length = Math.min(this.history.length, 50);

    const [next] = this.upcoming();
    this.nowPlaying = next ?? null;
    if (next) {
      this.pending = this.pending.filter((e) => e.id !== next.id);
      const singer = this.singers.get(next.singerId);
      if (singer) {
        singer.turnKey = ++this.clock;
        singer.sung += 1;
      }
    }
    this.joiners = 0;
    // Singers with nothing left queued drop out of the rotation; they rejoin at the back.
    for (const s of this.singers.values()) {
      if (!this.pending.some((e) => e.singerId === s.id) && s.id !== next?.singerId) s.turnKey = null;
    }
    this.touch();
    return this.nowPlaying;
  }

  snapshot() {
    const name = (id) => this.singers.get(id)?.name ?? 'Someone';
    const withName = (e) => e && { ...e, singerName: name(e.singerId) };
    return {
      code: this.code,
      nowPlaying: withName(this.nowPlaying),
      upcoming: this.upcoming().map(withName),
      history: this.history.slice(0, 10).map(withName),
      mode: this.mode,
      display: this.display,
      singers: [...this.singers.values()].map((s) => ({
        id: s.id,
        name: s.name,
        sung: s.sung,
        queued: this.pending.filter((e) => e.singerId === s.id).length,
        guest: s.id.startsWith('guest:'),
      })),
    };
  }
}
