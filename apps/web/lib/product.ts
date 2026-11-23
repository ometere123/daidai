import { appEnabled } from './app-gate';

export function localProduct() {
  const base = process.env.DAIDAI_API_BASE_URL;
  return appEnabled() && process.env.DAIDAI_LOCAL_PRODUCT === '1' && !process.env.VERCEL_ENV &&
    typeof base === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(base);
}
export const productCookie = '__Host-daidai_review';
