// The audience screen: a second display that mirrors the main TV's video (muted by default,
// since the main TV has the sound) with a ticker of who's singing now and the next three up.

const code = location.pathname.split('/').filter(Boolean).pop()?.toUpperCase() ?? '';
const MAX_DRIFT_SECONDS = 1.2;
const MARQUEE_PX_PER_SECOND = 90;

const socket = io();
let state = null;
let playback = null; // latest report from the main TV
let playbackReceivedAt = 0;
let player = null;
let playerReady = false;
let loadedVideoId = null;
let wantPlaying = false;
let muted = true;

$('#code').textContent = code;

socket.on('connect', async () => {
  try {
    await call(socket, 'audience:join', { code });
  } catch (err) {
    toast(`${err.message}. Check the address on the main TV (press H there).`, { error: true, ms: 10000 });
  }
});
socket.on('room:state', (s) => {
  state = s;
  renderTicker();
  sync();
});
socket.on('player:status', (s) => {
  playback = s;
  playbackReceivedAt = Date.now() - (s.age ?? 0) * 1000;
  sync();
});

fetch('/api/config')
  .then((r) => r.json())
  .then(({ baseUrl }) => {
    const joinUrl = `${baseUrl}/r/${code}`;
    $$('.qr').forEach((img) => (img.src = `/api/qr?url=${encodeURIComponent(joinUrl)}`));
    $('.join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  });

// ---- what's on screen ---------------------------------------------------------------

function sync() {
  if (!state) return;
  const now = state.nowPlaying;
  const onScreen = now && playback?.entryId === now.id; // the main TV is showing this song
  $('#idle').classList.toggle('hidden', Boolean(now));
  document.body.classList.toggle('idle-shown', !now);
  $('#intermission').classList.toggle('hidden', !now || onScreen);
  if (now && !onScreen) {
    $('#im-singer').textContent = now.singerName;
    $('#im-title').textContent = cleanTitle(now.title);
  }

  if (!playerReady) return;
  if (!onScreen) {
    wantPlaying = false;
    if (loadedVideoId) player.pauseVideo();
    return;
  }

  wantPlaying = playback.playing;
  const target = playback.time + (playback.playing ? (Date.now() - playbackReceivedAt) / 1000 : 0);
  if (loadedVideoId !== playback.videoId) {
    loadedVideoId = playback.videoId;
    player.loadVideoById({ videoId: playback.videoId, startSeconds: target });
    return;
  }
  if (Math.abs(player.getCurrentTime() - target) > MAX_DRIFT_SECONDS) player.seekTo(target, true);
  const isPlaying = player.getPlayerState() === YT.PlayerState.PLAYING;
  if (wantPlaying && !isPlaying) player.playVideo();
  if (!wantPlaying && isPlaying) player.pauseVideo();
}

function renderTicker() {
  const now = state.nowPlaying;
  $('#now-singer').textContent = now ? now.singerName : '—';
  $('#now-title').textContent = now ? cleanTitle(now.title) : 'Nobody singing yet';

  const next = state.upcoming.slice(0, 3);
  const track = $('#marquee-track');
  const group = next.length
    ? `<span class="label">Up next</span>${next
        .map((e, i) => `<span><span class="n">${i + 1}</span><span class="who">${esc(e.singerName)}</span> <span class="what">· ${esc(cleanTitle(e.title))}</span></span>`)
        .join('<span class="sep">✦</span>')}`
    : `<span class="label">Up next</span><span class="what">Nobody yet. Scan the code and pick a song!</span>`;
  // Two copies side by side so the scroll loops seamlessly.
  track.innerHTML = `<div class="marquee-group">${group}</div><div class="marquee-group" aria-hidden="true">${group}</div>`;
  const width = track.firstElementChild.offsetWidth;
  track.style.setProperty('--marquee-duration', `${Math.max(12, width / MARQUEE_PX_PER_SECOND)}s`);
  track.classList.remove('scrolling');
  void track.offsetWidth; // restart the animation from the start
  track.classList.add('scrolling');
}

// ---- player ---------------------------------------------------------------------------

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    // Muted so the browser lets it autoplay, and so it doesn't echo the main TV.
    playerVars: { autoplay: 1, mute: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        player.mute();
        sync();
      },
      onStateChange: ({ data }) => {
        if (data === YT.PlayerState.PLAYING && !wantPlaying) player.pauseVideo();
      },
    },
  });
};
const yt = document.createElement('script');
yt.src = 'https://www.youtube.com/iframe_api';
document.head.append(yt);

// Re-check sync now and then, in case a status report was missed.
setInterval(sync, 3000);

// ---- sound toggle (shown when the mouse moves) --------------------------------------------

const soundBtn = $('#sound');
let quietTimer = null;
function showSoundButton() {
  soundBtn.classList.remove('quiet');
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => soundBtn.classList.add('quiet'), 3000);
}
document.addEventListener('mousemove', showSoundButton);
showSoundButton();
soundBtn.addEventListener('click', () => {
  if (!playerReady) return;
  muted = !muted;
  muted ? player.mute() : player.unMute();
  soundBtn.textContent = muted ? '🔇 Sound off' : '🔊 Sound on';
});

document.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});
