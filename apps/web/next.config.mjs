import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  // Repo root, so server code can import the shared, Worker-safe contract in ../../src (P10.4).
  turbopack: { root: dirname(dirname(dirname(fileURLToPath(import.meta.url)))) },
  devIndicators: false,
  async headers() {
    const headers = [
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ];
    return ['/merchant/:path*', '/pay'].map(source => ({ source, headers }));
  },
};
