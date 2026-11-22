/**
 * Installable app with offline support (phase 30). The worker file is public/sw.js. It is registered only in a
 * production build (the dev server must not be cached), and a new version waits until the user agrees.
 */

export type UpdateHandle = { apply: () => void };

let asked = false;

export function registerServiceWorker(onUpdate: (h: UpdateHandle) => void): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const offer = (w: ServiceWorker) => onUpdate({ apply: () => ((asked = true), w.postMessage("SKIP_WAITING")) });
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const w = reg.installing;
          w?.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
          });
        });
      })
      .catch(() => {
        /* offline support is optional */
      });
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded || !asked) return; // the first install also changes the controller: no reload for that
      reloaded = true;
      location.reload();
    });
  });
}
