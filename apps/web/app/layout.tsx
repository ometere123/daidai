import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './daidai.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'Invoices — Daidai (demo)', template: '%s — Daidai (demo)' },
  description: 'Daidai invoice settlement demo. Nothing here happened onchain.',
  applicationName: 'Daidai',
};
export const viewport: Viewport = { themeColor: '#0F1B26', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en-NG"><body>{children}</body></html>;
}
