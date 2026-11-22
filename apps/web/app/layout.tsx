import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './plumb.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Daidai · Invoices', description: 'Daidai invoice settlement demo' };
export default function Layout({children}: {children: ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
