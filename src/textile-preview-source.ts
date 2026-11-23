import { textilePreviewPath, type PreviewSource } from './product-quote.ts';

const endpoint = 'https://api.textilecredit.com' + textilePreviewPath;
const maxBytes = 32_768;

/** Non-reserving preview transport. The application demo uses its deterministic adapter by default. */
export function textilePreviewSource(fetcher: typeof fetch = globalThis.fetch): PreviewSource {
  return async request => {
    const response = await fetcher(endpoint, {
      method: 'POST', body: JSON.stringify(request), cache: 'no-store', credentials: 'omit',
      redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    const reader = response.body?.getReader();
    if (!response.ok || !reader) {
      await reader?.cancel().catch(() => {});
      throw Error('Textile preview unavailable');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0, text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw Error('Textile preview response too large');
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch {
      await reader.cancel().catch(() => {});
      throw Error('Textile preview response invalid');
    }
  };
}
