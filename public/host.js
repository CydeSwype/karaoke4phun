// The TV screen: plays the queue through the YouTube player and shows who's up.

const INTERMISSION_SECONDS = 6;
const YT_ERRORS = {
  2: 'bad video id',
  5: 'player error',
  100: 'video removed or private',
  101: 'owner blocks embedding',
  150: 'owner blocks embedding',
  153: 'player blocked by browser settings',
};

const socket = io();
let state = null;
let started = false;
let player = null;
let playerReady = false;
let loadedEntryId = null; // the entry the player is (or is about to be) playing
let intermissionTimer = null;

// ---- room ------------------------------------------------------------------

async function openRoom() {
  try {
    const { code } = await call(socket, 'host:open', { code: store.get('hostCode') });
    store.set('hostCode', code);
    const { baseUrl } = await fetch('/api/config').then((r) => r.json());
    const joinUrl = `${baseUrl}/r/${code}`;
    $('#room-code').textContent = code;
    $$('.join-url').forEach((n) => (n.textContent = joinUrl.replace(/^https?:\/\//, '')));
    $$('.qr').forEach((img) => (img.src = `/api/qr?url=${encodeURIComponent(joinUrl)}`));
  } catch (err) {
    toast(err.message, { error: true });
  }
}

socket.on('connect', openRoom);
socket.on('disconnect', () => toast('Lost connection to the party server — reconnecting…', { error: true }));
socket.on('room:notice', ({ message }) => toast(message));
socket.on('room:state', (s) => {
  state = s;
  renderSidebar();
  syncPlayback();
});
socket.on('player:command', ({ action }) => {
  if (!playerReady || !state?.nowPlaying) return;
  if (action === 'pause') player.pauseVideo();
  if (action === 'play') player.playVideo();
  if (action === 'restart') {
    player.seekTo(0, true);
    player.playVideo();
  }
});

// ---- rendering ----------------------------------------------------------------

function renderSidebar() {
  const now = state.nowPlaying;
  $('#now-singer').textContent = now ? now.singerName : '—';
  $('#now-title').textContent = now ? cleanTitle(now.title) : 'Nobody yet';

  $('#up-next').innerHTML = state.upcoming
    .map((e, i) => `
      <li>
        <span class="n">${i + 1}</span>
        <div><div class="who">${esc(e.singerName)}</div><div class="what clamp">${esc(cleanTitle(e.title))}</div></div>
        <button class="x" data-remove="${esc(e.id)}" title="Remove">✕</button>
      </li>`)
    .join('');
  $('#next-count').textContent = state.upcoming.length ? `· ${state.upcoming.length}` : '';
  $('#empty-next').classList.toggle('hidden', state.upcoming.length > 0);
  $('#idle').classList.toggle('hidden', Boolean(now));
  $('.join').classList.toggle('hidden', !now); // the idle screen already shows a big QR code
}

$('#up-next').addEventListener('click', (ev) => {
  const id = ev.target.closest('[data-remove]')?.dataset.remove;
  if (id) call(socket, 'song:remove', { entryId: id }).catch((e) => toast(e.message, { error: true }));
});

// ---- playback -------------------------------------------------------------------

function syncPlayback() {
  if (!started || !playerReady) return;
  const now = state?.nowPlaying;
  if (!now) {
    clearIntermission();
    loadedEntryId = null;
    player.stopVideo();
    return;
  }
  if (now.id === loadedEntryId) return;
  loadedEntryId = now.id;
  player.stopVideo();
  showIntermission(now, () => player.loadVideoById(now.videoId));
}

function showIntermission(entry, then) {
  clearIntermission();
  $('#im-singer').textContent = entry.singerName;
  $('#im-title').textContent = cleanTitle(entry.title);
  $('#intermission').classList.remove('hidden');
  let left = INTERMISSION_SECONDS;
  $('#im-count').textContent = left;
  intermissionTimer = setInterval(() => {
    left -= 1;
    $('#im-count').textContent = left;
    if (left <= 0) {
      clearIntermission();
      then();
    }
  }, 1000);
}

function clearIntermission() {
  clearInterval(intermissionTimer);
  intermissionTimer = null;
  $('#intermission').classList.add('hidden');
}

function songFinished(error) {
  if (!loadedEntryId) return;
  call(socket, 'player:ended', { entryId: loadedEntryId, error }).catch(() => {});
}

// Called by the YouTube IFrame API script once it loads.
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        syncPlayback();
      },
      onStateChange: ({ data }) => {
        if (data === YT.PlayerState.ENDED) songFinished();
        if (data === YT.PlayerState.PLAYING || data === YT.PlayerState.PAUSED) {
          socket.emit('player:status', { playing: data === YT.PlayerState.PLAYING });
        }
      },
      onError: ({ data }) => songFinished(YT_ERRORS[data] ?? `error ${data}`),
    },
  });
};

$('#start-btn').addEventListener('click', () => {
  started = true;
  $('#start').classList.add('hidden');
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
});

// ---- keyboard ---------------------------------------------------------------------

document.addEventListener('keydown', (ev) => {
  if (!started || ev.target.closest('input')) return;
  const key = ev.key.toLowerCase();
  if (key === ' ' && playerReady) {
    ev.preventDefault();
    player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
  } else if ((key === 'n' || key === 'arrowright') && state?.nowPlaying) {
    call(socket, 'song:skip', { entryId: state.nowPlaying.id }).catch(() => {});
  } else if (key === 'f') {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  }
});
