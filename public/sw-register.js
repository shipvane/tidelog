/**
 * Service worker registration, gated on the kill switch (see public/sw.js).
 *
 * The page asks `/sw-kill` BEFORE registering. Without this, a killed SW
 * unregisters itself on one navigation and the page re-registers it on the next
 * unmanaged load, so the switch flaps between on and off instead of staying off.
 * With it, `{ kill: true }` means the page never registers, and it also removes
 * any registration still hanging around.
 *
 * Fails OPEN: if the sentinel cannot be reached (offline, or a server that
 * predates the route), register as normal. Going offline must never switch
 * offline support off.
 *
 * Its own file rather than a block in app.js so tests can load it alone; app.js
 * starts the whole app at load time.
 */
(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  fetch('/sw-kill', { cache: 'no-store' })
    .then((res) => (res && res.ok ? res.json() : { kill: false }))
    .catch(() => ({ kill: false }))
    .then((body) => {
      if (body && body.kill === true) {
        return navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((reg) => reg.unregister())));
      }
      return navigator.serviceWorker.register('/sw.js', { scope: '/' });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('SW registration failed:', err);
    });
})();
