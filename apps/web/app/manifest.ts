import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Daidai (demo)', short_name: 'Daidai', description: 'Daidai invoice settlement demo. Nothing here happened onchain.',
    start_url: '/', display: 'standalone', background_color: '#F6F6F2', theme_color: '#0F1B26',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
  };
}
