// The phone remote: pick a name, search YouTube, queue songs, control playback.

const code = location.pathname.split('/').filter(Boolean).pop()?.toUpperCase() ?? '';
let clientId = store.get('clientId');
if (!clientId) {
  clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store.set('clientId', clientId);
}

const socket = io({ autoConnect: false });
let state = null;
let joined = false;
let playing = true;
let lastResults = [];
const addedIds = new Set();

$('#code').textContent = code;

// ---- joining --------------------------------------------------------------------

async function join(name) {
  try {
    const res = await call(socket, 'remote:join', { code, clientId, name });
    store.set('name', res.name);
    joined = true;
    $('#me').textContent = res.name;
    $('#me').classList.remove('hidden');
    $('#name-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
  } catch (err) {
    // Already in the party: the TV may just not have reconnected after a server restart, so retry quietly.
    if (joined) setTimeout(() => socket.connected && join(name), 3000);
    else toast(err.message, { error: true, ms: 6000 });
  }
}

function askName() {
  $('#app').classList.add('hidden');
  $('#name-screen').classList.remove('hidden');
  $('#name-input').value = store.get('name') ?? '';
  $('#name-input').focus();
}

$('#name-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('#name-input').value.trim();
  if (name) join(name);
});
$('#me').addEventListener('click', askName);

socket.on('connect', () => {
  const name = store.get('name');
  if (name) join(name);
  else askName();
});
socket.on('disconnect', () => toast('Reconnecting to the party…', { error: true }));
socket.on('room:notice', ({ message }) => toast(message));
socket.on('player:status', (s) => {
  playing = s.playing;
  renderPlayPause();
});
socket.on('room:state', (s) => {
  state = s;
  render();
});
socket.connect();

// ---- rendering ------------------------------------------------------------------

function render() {
  const now = state.nowPlaying;
  $('#now-card').classList.toggle('empty', !now);
  $('#now-singer').textContent = now ? now.singerName : 'Nobody yet';
  $('#now-title').textContent = now ? cleanTitle(now.title) : 'Add a song to get things going';
  if (now) $('#now-thumb').src = now.thumbnail;

  const list = state.upcoming;
  $('#queue').innerHTML = list
    .map((e, i) => {
      const mine = e.singerId === clientId;
      return `
        <li class="${mine ? 'mine' : ''}">
          <span class="n">${i + 1}</span>
          <div><div class="who">${esc(mine ? `${e.singerName} (you)` : e.singerName)}</div><div class="what clamp">${esc(cleanTitle(e.title))}</div></div>
          ${mine ? `<button class="remove" data-remove="${esc(e.id)}">Remove</button>` : '<span></span>'}
        </li>`;
    })
    .join('');
  $('#queue-empty').classList.toggle('hidden', list.length > 0);
  $('#queue-badge').textContent = list.length;
  $('#queue-badge').classList.toggle('hidden', list.length === 0);

  const myNext = list.findIndex((e) => e.singerId === clientId);
  const singingNow = now?.singerId === clientId;
  const turn = $('#my-turn');
  turn.classList.toggle('hidden', !singingNow && myNext === -1);
  if (singingNow) turn.innerHTML = "🎤 <strong>You're up!</strong> Grab the mic.";
  else if (myNext === 0) turn.innerHTML = "You're <strong>next</strong> — get ready!";
  else if (myNext > 0) turn.innerHTML = `Your next song is <strong>#${myNext + 1}</strong> in line.`;
}

function renderPlayPause() {
  const btn = $('#playpause');
  btn.textContent = playing ? '❚❚' : '▶';
  btn.title = playing ? 'Pause' : 'Play';
  btn.setAttribute('aria-label', btn.title);
}

function renderResults() {
  $('#results').innerHTML = lastResults
    .map((v, i) => {
      const added = addedIds.has(v.videoId);
      const meta = [v.channel, fmtDuration(v.duration)].filter(Boolean).join(' · ');
      return `
        <li>
          <img class="thumb" src="${esc(v.thumbnail)}" alt="" loading="lazy">
          <div><div class="r-title clamp">${esc(v.title)}</div><div class="r-meta">${esc(meta)}</div></div>
          <button class="btn small add${added ? ' added' : ''}" data-add="${i}">${added ? 'Added' : 'Add'}</button>
        </li>`;
    })
    .join('');
}

// ---- tabs -----------------------------------------------------------------------

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab);
    });
    $('#tab-search').classList.toggle('hidden', tab.dataset.tab !== 'search');
    $('#tab-queue').classList.toggle('hidden', tab.dataset.tab !== 'queue');
  }),
);

// ---- search ---------------------------------------------------------------------

fetch('/api/config')
  .then((r) => r.json())
  .then(({ searchEnabled }) => {
    if (!searchEnabled) {
      $('#q').placeholder = 'Paste a YouTube link';
      $('#search-hint').textContent = 'Search isn’t set up on this party yet. Find the karaoke video in the YouTube app, tap Share → Copy link, and paste it here.';
      $('.toggle').classList.add('hidden');
    } else {
      $('#search-hint').textContent = 'Tip: you can also paste a YouTube link.';
    }
  });

$('#karaoke-only').checked = store.get('karaokeOnly') !== '0';
$('#karaoke-only').addEventListener('change', (ev) => store.set('karaokeOnly', ev.target.checked ? '1' : '0'));

$('#search-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').blur();
  $('#results').innerHTML = '<li class="faint" style="display:block">Searching…</li>';
  try {
    const karaoke = $('#karaoke-only').checked ? '1' : '0';
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&karaoke=${karaoke}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Search failed');
    lastResults = body.results;
    if (!lastResults.length) {
      $('#results').innerHTML = '<li class="faint" style="display:block">No results. Try different words, or turn off “Karaoke versions only”.</li>';
      return;
    }
    renderResults();
  } catch (err) {
    $('#results').innerHTML = '';
    toast(err.message, { error: true, ms: 6000 });
  }
});

$('#results').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-add]');
  if (!btn || btn.disabled) return;
  const video = lastResults[Number(btn.dataset.add)];
  if (addedIds.has(video.videoId) && !confirm('You already added this one. Add it again?')) return;
  btn.disabled = true;
  try {
    const { position } = await call(socket, 'song:add', { video });
    addedIds.add(video.videoId);
    toast(position === 0 ? "You're up right now! 🎤" : `Added — you're #${position} in line`);
    renderResults();
  } catch (err) {
    toast(err.message, { error: true });
    btn.disabled = false;
  }
});

// ---- queue & controls -------------------------------------------------------------

$('#queue').addEventListener('click', (ev) => {
  const id = ev.target.closest('[data-remove]')?.dataset.remove;
  if (id) call(socket, 'song:remove', { entryId: id }).catch((e) => toast(e.message, { error: true }));
});

$('#controls').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || !state?.nowPlaying) return;
  if (btn.id === 'playpause') {
    playing = !playing; // optimistic; the TV confirms with player:status
    renderPlayPause();
    call(socket, 'player:command', { action: playing ? 'play' : 'pause' }).catch((e) => toast(e.message, { error: true }));
  } else if (btn.dataset.cmd === 'skip') {
    const now = state.nowPlaying;
    if (now.singerId !== clientId && !confirm(`Skip ${now.singerName}'s song?`)) return;
    call(socket, 'song:skip', { entryId: now.id }).catch((e) => toast(e.message, { error: true }));
  } else if (btn.dataset.cmd === 'restart') {
    call(socket, 'player:command', { action: 'restart' }).catch((e) => toast(e.message, { error: true }));
  }
});
