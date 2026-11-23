// Public, credentialless non-reserving probe. Sends only a fixed synthetic exact output amount and the token pair.
import { preparePreview } from '../src/product-quote.ts';
import { textilePreviewSource } from '../src/textile-preview-source.ts';

const sample = { state: 'committed', digest: 'e'.repeat(64), target: '1500000000', cap: '1100000', expiry: Date.now() + 30_000 };
const preview = await preparePreview(sample, textilePreviewSource(), Date.now);
console.log(JSON.stringify({ outcome: preview.kind, evidence: 'non-reserving indicative preview only' }));
process.exitCode = preview.kind === 'indicative' || preview.kind === 'over-cap' ? 0 : 1;
