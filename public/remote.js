// The phone remote: pick a name, search YouTube, preview and queue songs, control playback.
// Opened from the TV's host QR code (#host=…), it also gets host tools: reorder the queue,
// add songs for other people, swap versions, and control what the TV shows.

const code = location.pathname.split('/').filter(Boolean).pop()?.toUpperCase() ?? '';
let clientId = store.get('clientId');
if (!clientId) {
  clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store.set('clientId', clientId);
}

// Take the host key out of the URL so it isn't shared by accident, and remember it for this party.
const hashKey = new URLSearchParams(location.hash.slice(1)).get('host');
if (hashKey) {
  store.set(`hostKey:${code}`, hashKey);
  history.replaceState(null, '', location.pathname);
}
const hostKey = store.get(`hostKey:${code}`);

const socket = io({ autoConnect: false });
let state = null;
let joined = false;
let isAdmin = false;
let playing = true;
let lastResults = [];
let replacing = null; // queue entry whose video is being swapped
let openActions = null; // queue entry whose action row is open
let previewing = null; // { video, action }
const addedIds = new Set();

$('#code').textContent = code;

// ---- joining --------------------------------------------------------------------

async function join(name) {
  try {
    const res = await call(socket, 'remote:join', { code, clientId, name, hostKey });
    store.set('name', res.name);
    joined = true;
    isAdmin = res.isAdmin;
    if (hostKey && !isAdmin) toast('That host link is out of date. Scan the host QR code on the TV again (press H).', { error: true, ms: 6000 });
    $('#me').textContent = res.name;
    $('#me').classList.remove('hidden');
    $('#host-badge').classList.toggle('hidden', !isAdmin);
    $('#host-tab').classList.toggle('hidden', !isAdmin);
    $('#name-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    if (state) render();
    Install.offer();
  } catch (err) {
    // Already in the party: the TV may just not have reconnected after a server restart, so retry quietly.
    if (joined) setTimeout(() => socket.connected && join(name), 3000);
    else {
      toast(err.message, { error: true, ms: 6000 });
      $('#other-party').classList.remove('hidden');
    }
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
  if (replacing && !s.upcoming.some((e) => e.id === replacing.id)) stopReplacing();
  render();
});
socket.connect();

// ---- rendering ------------------------------------------------------------------

function render() {
  renderNow();
  renderQueue();
  renderForSinger();
  if (isAdmin) renderHostTab();
}

function renderNow() {
  const now = state.nowPlaying;
  $('#now-card').classList.toggle('empty', !now);
  $('#now-singer').textContent = now ? now.singerName : 'Nobody yet';
  $('#now-title').textContent = now ? cleanTitle(now.title) : 'Add a song to get things going';
  if (now) $('#now-thumb').src = now.thumbnail;
}

function renderPlayPause() {
  const btn = $('#playpause');
  btn.textContent = playing ? '❚❚' : '▶';
  btn.title = playing ? 'Pause' : 'Play';
  btn.setAttribute('aria-label', btn.title);
}

function renderQueue() {
  const list = state.upcoming;
  $('#queue').innerHTML = list
    .map((e, i) => {
      const mine = e.singerId === clientId;
      const canEdit = mine || isAdmin;
      const open = openActions === e.id;
      const actions = !open ? '' : `
        <div class="actions">
          ${isAdmin ? `
            <button data-act="up" ${i === 0 ? 'disabled' : ''}>▲ Up</button>
            <button data-act="down" ${i === list.length - 1 ? 'disabled' : ''}>▼ Down</button>
            <button data-act="top" ${i === 0 ? 'disabled' : ''}>Play next</button>` : ''}
          <button data-act="preview">Preview</button>
          <button data-act="replace">Change version</button>
          <button data-act="remove" class="danger">Remove</button>
        </div>`;
      return `
        <li class="${mine ? 'mine' : ''}" data-id="${esc(e.id)}">
          <span class="n">${i + 1}</span>
          <img class="thumb" src="${esc(e.thumbnail)}" alt="Preview" data-act="preview" loading="lazy">
          <div><div class="who">${esc(mine ? `${e.singerName} (you)` : e.singerName)}</div><div class="what clamp">${esc(cleanTitle(e.title))}</div></div>
          ${canEdit ? `<button class="more" data-act="more" aria-label="Song options" aria-expanded="${open}">⋯</button>` : '<span></span>'}
          ${actions}
        </li>`;
    })
    .join('');
  $('#queue-empty').classList.toggle('hidden', list.length > 0);
  $('#queue-badge').textContent = list.length;
  $('#queue-badge').classList.toggle('hidden', list.length === 0);

  const banner = $('#order-banner');
  banner.classList.toggle('hidden', !isAdmin || state.mode !== 'custom');
  banner.innerHTML = '<div>Custom order: new songs go to the end.</div><button class="btn ghost small" data-act="fair">Use fair rotation</button>';

  const myNext = list.findIndex((e) => e.singerId === clientId);
  const singingNow = state.nowPlaying?.singerId === clientId;
  const turn = $('#my-turn');
  turn.classList.toggle('hidden', !singingNow && myNext === -1);
  if (singingNow) turn.innerHTML = "🎤 <strong>You're up!</strong> Grab the mic.";
  else if (myNext === 0) turn.innerHTML = "You're <strong>next</strong> — get ready!";
  else if (myNext > 0) turn.innerHTML = `Your next song is <strong>#${myNext + 1}</strong> in line.`;
}

function renderForSinger() {
  $('#for-row').classList.toggle('hidden', !isAdmin || Boolean(replacing));
  if (!isAdmin) return;
  const sel = $('#for-singer');
  const current = sel.value || 'me';
  const others = state.singers.filter((s) => s.id !== clientId).sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = [
    '<option value="me">Me</option>',
    ...others.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.guest ? ' (no phone)' : ''}</option>`),
    '<option value="new">Someone new…</option>',
  ].join('');
  sel.value = [...sel.options].some((o) => o.value === current) ? current : 'me';
}

function renderHostTab() {
  $('#tv-sidebar').checked = state.display?.sidebar !== false;
  $('#tv-music').checked = state.display?.music !== false;
  const custom = state.mode === 'custom';
  $('#order-desc').textContent = custom
    ? 'Custom order you set. New songs go to the end.'
    : 'Fair rotation: everyone gets one song per round.';
  $('#fair-btn').classList.toggle('hidden', !custom);

  const singers = [...state.singers].sort((a, b) => b.sung + b.queued - (a.sung + a.queued) || a.name.localeCompare(b.name));
  const max = Math.max(1, ...singers.map((s) => s.sung + s.queued));
  $('#singers').innerHTML = singers.length
    ? singers
        .map((s) => `
          <li>
            <strong>${esc(s.name)}${s.guest ? ' <span class="faint">(no phone)</span>' : ''}</strong>
            <span class="counts">${s.sung} sung · ${s.queued} queued</span>
            <span class="bar"><i style="width:${Math.round(((s.sung + s.queued) / max) * 100)}%"></i></span>
          </li>`)
        .join('')
    : '<li class="faint">Nobody has joined yet.</li>';

  const url = `${location.origin}/a/${code}`;
  $('#audience-link').href = url;
  $('#audience-link').textContent = url.replace(/^https?:\/\//, '');
}

function renderResults() {
  const label = replacing ? 'Use this' : 'Add';
  $('#results').innerHTML = lastResults
    .map((v, i) => {
      const added = !replacing && addedIds.has(v.videoId);
      const meta = [v.channel, fmtDuration(v.duration)].filter(Boolean).join(' · ');
      return `
        <li>
          <img class="thumb" src="${esc(v.thumbnail)}" alt="Preview" loading="lazy" data-preview="${i}">
          <div><div class="r-title clamp" data-preview="${i}">${esc(v.title)}</div><div class="r-meta">${esc(meta)} · <span class="dim">tap to preview</span></div></div>
          <button class="btn small add${added ? ' added' : ''}" data-add="${i}">${added ? 'Added' : label}</button>
        </li>`;
    })
    .join('');
}

// ---- tabs -----------------------------------------------------------------------

function showTab(name) {
  $$('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name);
  });
  for (const t of ['search', 'queue', 'host']) $(`#tab-${t}`).classList.toggle('hidden', t !== name);
}
$$('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

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

async function runSearch(q) {
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
}

$('#search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').blur();
  runSearch(q);
});

/** Works out who a new song is for. Returns undefined for "me", or null if the host cancelled. */
function chosenSinger() {
  if (!isAdmin) return undefined;
  const v = $('#for-singer').value;
  if (v === 'me') return undefined;
  if (v === 'new') {
    const name = prompt('Who is this song for?')?.trim();
    return name ? { name } : null;
  }
  return { id: v };
}

async function addVideo(video) {
  if (replacing) return replaceWith(video);
  const forSinger = chosenSinger();
  if (forSinger === null) return false;
  if (!forSinger && addedIds.has(video.videoId) && !confirm('You already added this one. Add it again?')) return false;
  try {
    const { position, singerName } = await call(socket, 'song:add', { video, forSinger });
    if (!forSinger) addedIds.add(video.videoId);
    const who = forSinger ? `${singerName} is` : "you're";
    toast(position === 0 ? `Playing now for ${singerName} 🎤` : `Added — ${who} #${position} in line`);
    if ($('#for-singer').value === 'new') renderForSinger();
    renderResults();
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  }
}

$('#results').addEventListener('click', async (ev) => {
  const prev = ev.target.closest('[data-preview]');
  if (prev) return openPreview(lastResults[Number(prev.dataset.preview)], replacing ? 'Use this version' : 'Add to queue');
  const btn = ev.target.closest('[data-add]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  if (!(await addVideo(lastResults[Number(btn.dataset.add)]))) btn.disabled = false;
});

// ---- replacing a queued song's version ---------------------------------------------

function startReplacing(entry) {
  replacing = entry;
  openActions = null;
  $('#replace-what').textContent = `${cleanTitle(entry.title)} (${entry.singerName})`;
  $('#replace-banner').classList.remove('hidden');
  renderForSinger();
  showTab('search');
  $('#q').value = cleanTitle(entry.title);
  runSearch($('#q').value);
}

function stopReplacing() {
  replacing = null;
  $('#replace-banner').classList.add('hidden');
  if (state) renderForSinger();
  renderResults();
}

async function replaceWith(video) {
  try {
    await call(socket, 'song:replace', { entryId: replacing.id, video });
    toast(`Swapped in the new version for ${replacing.singerName}`);
    stopReplacing();
    showTab('queue');
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  }
}

$('#replace-cancel').addEventListener('click', stopReplacing);

// ---- preview (this phone only) --------------------------------------------------------

function openPreview(video, actionLabel) {
  previewing = { video, actionLabel };
  const src = `https://www.youtube.com/embed/${encodeURIComponent(video.videoId)}?autoplay=1&playsinline=1&rel=0`;
  $('#preview-frame').innerHTML = `<iframe src="${src}" title="Preview" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  $('#preview-title').textContent = video.title;
  $('#preview-meta').textContent = [video.channel, fmtDuration(video.duration)].filter(Boolean).join(' · ');
  $('#preview-action').textContent = actionLabel ?? '';
  $('#preview-action').classList.toggle('hidden', !actionLabel);
  $('#preview').classList.remove('hidden');
}

function closePreview() {
  previewing = null;
  $('#preview-frame').innerHTML = ''; // stops playback
  $('#preview').classList.add('hidden');
}

$('#preview-close').addEventListener('click', closePreview);
$('#preview').addEventListener('click', (ev) => ev.target.id === 'preview' && closePreview());
document.addEventListener('keydown', (ev) => ev.key === 'Escape' && previewing && closePreview());
$('#preview-action').addEventListener('click', async () => {
  const { video } = previewing;
  if (await addVideo(video)) closePreview();
});

// ---- queue actions --------------------------------------------------------------------

$('#tab-queue').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  if (act === 'fair') return call(socket, 'admin:fair').catch((e) => toast(e.message, { error: true }));

  const id = btn.closest('li')?.dataset.id;
  const idx = state.upcoming.findIndex((e) => e.id === id);
  const entry = state.upcoming[idx];
  if (!entry) return;
  const fail = (e) => toast(e.message, { error: true });

  if (act === 'more') {
    openActions = openActions === id ? null : id;
    renderQueue();
  } else if (act === 'preview') {
    openPreview(entry, null);
  } else if (act === 'replace') {
    startReplacing(entry);
  } else if (act === 'remove') {
    const whose = entry.singerId === clientId ? 'your song' : `${entry.singerName}'s song`;
    if (confirm(`Remove ${whose} “${cleanTitle(entry.title)}”?`)) call(socket, 'song:remove', { entryId: id }).catch(fail);
  } else if (act === 'up' || act === 'down' || act === 'top') {
    const toIndex = act === 'top' ? 0 : idx + (act === 'up' ? -1 : 1);
    call(socket, 'admin:move', { entryId: id, toIndex }).catch(fail);
  }
});

// ---- host tab -------------------------------------------------------------------------

$('#tv-sidebar').addEventListener('change', (ev) =>
  call(socket, 'admin:display', { sidebar: ev.target.checked }).catch((e) => toast(e.message, { error: true })),
);
$('#tv-music').addEventListener('change', (ev) =>
  call(socket, 'admin:display', { music: ev.target.checked }).catch((e) => toast(e.message, { error: true })),
);
$('#fair-btn').addEventListener('click', () => call(socket, 'admin:fair').catch((e) => toast(e.message, { error: true })));

// ---- playback controls ------------------------------------------------------------------

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
