// Тонкая обёртка над GoatCounter (self-hosted, index.html грузит его только
// на проде). Событийная аналитика: какие паки выбирают, доходят ли до конца.

declare global {
  interface Window {
    goatcounter?: { count: (opts: { path: string; event?: boolean }) => void };
  }
}

export function trackEvent(path: string): void {
  window.goatcounter?.count({ path, event: true });
}
