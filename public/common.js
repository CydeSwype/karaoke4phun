// Small helpers shared by the TV and phone pages.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Strips the usual karaoke-channel noise so titles fit on a TV. */
function cleanTitle(title) {
  return String(title ?? '')
    .replace(/\s*[\[(](?:[^\])]*?(?:karaoke|instrumental|lyrics?|version|official|hd|4k)[^\])]*)[\])]/gi, '')
    .replace(/\s*[|–-]\s*(?:karaoke|sing king|lyrics).*$/i, '')
    .replace(/\bkaraoke\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || title;
}

function toast(message, { error = false, ms = 3500 } = {}) {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.textContent = message;
  box.append(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 250); }, ms);
}

/** socket.emit that resolves with the server's reply, or rejects with its error. */
function call(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('The party server is not responding'));
      if (!res?.ok) return reject(new Error(res?.error || 'Something went wrong'));
      resolve(res);
    });
  });
}

const store = {
  get(key) {
    try { return localStorage.getItem(`k4p:${key}`); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(`k4p:${key}`, value); } catch { /* private mode */ }
  },
};
