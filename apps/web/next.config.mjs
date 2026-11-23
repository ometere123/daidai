import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  // Repo root, so server code can import the shared, Worker-safe contract in ../../src (P10.4).
  turbopack: { root: dirname(dirname(dirname(fileURLToPath(import.meta.url)))) },
  devIndicators: false,
  async headers() {
    const headers = [
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      // Preserve the Origin header on same-origin native form POSTs. URL fragments are never sent.
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ];
    return ['/merchant/:path*', '/invoices/:path*', '/activity', '/pay'].map(source => ({ source, headers }));
  },
};
