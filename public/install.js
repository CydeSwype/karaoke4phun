// "Add to home screen" prompt for the phone pages. Call Install.offer() once the person is in the party.
//  - Android/Chrome: uses the browser's own install prompt when it offers one.
//  - iOS (and Android without a prompt, e.g. plain-http on a home network): shows the manual steps.
//  - Hidden once installed, on desktop, and for 30 days after it's dismissed.

const Install = (() => {
  const DISMISS_DAYS = 30;
  const ua = navigator.userAgent;
  const isAndroid = /Android/.test(ua);
  // iPadOS in desktop mode reports itself as a Mac, so a touchscreen Mac counts as iOS.
  const isIOS = !isAndroid && (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  let deferred = null; // the browser's install prompt, when it offers one
  let offered = false;
  let showingSteps = false;

  const dismissed = () => {
    const at = Number(store.get('installDismissed'));
    return at && Date.now() - at < DISMISS_DAYS * 86400000;
  };

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferred = ev;
    render();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    store.set('installDismissed', String(Date.now()));
    render();
  });

  function steps() {
    return isIOS
      ? 'Tap the Share button in your browser, then “Add to Home Screen”.'
      : 'Open your browser menu (⋮), then tap “Install app” or “Add to Home screen”.';
  }

  function render() {
    const box = $('#install');
    if (!box) return;
    const show = offered && (isIOS || isAndroid) && !standalone() && !dismissed();
    box.classList.toggle('hidden', !show);
    if (!show) return;
    $('#install-text').textContent = showingSteps ? steps() : 'Add karaoke4phun to your home screen to jump back in next time.';
    const btn = $('#install-go');
    btn.textContent = deferred ? 'Install' : 'Show me how';
    btn.classList.toggle('hidden', showingSteps);
  }

  document.addEventListener('click', async (ev) => {
    if (ev.target.closest('#install-dismiss')) {
      store.set('installDismissed', String(Date.now()));
      render();
    } else if (ev.target.closest('#install-go')) {
      if (deferred) {
        const prompt = deferred;
        deferred = null;
        prompt.prompt();
        await prompt.userChoice.catch(() => {});
      } else {
        showingSteps = true;
      }
      render();
    }
  });

  return {
    offer() {
      offered = true;
      render();
    },
  };
})();
