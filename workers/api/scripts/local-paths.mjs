// Gitignored local state for the demo. Never committed (see workers/api/.gitignore).
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const persistDir = root + '.wrangler/local-d1';
export const identitiesFile = root + '.wrangler/demo-identities.json';
export const devVarsFile = root + '.dev.vars';
export const PORT = 8787;
