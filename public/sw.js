// Deliberately minimal: the app is live (sockets, search), so there's nothing useful to cache offline.
// A service worker is still what lets browsers treat the site as installable.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
