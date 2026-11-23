import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  // Repo root, so server code can import the shared, Worker-safe contract in ../../src (P10.4).
  turbopack: { root: dirname(dirname(dirname(fileURLToPath(import.meta.url)))) },
  devIndicators: false,
};
