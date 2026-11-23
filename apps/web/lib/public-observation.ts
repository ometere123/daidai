import { unstable_cache } from 'next/cache';
import { observePublicRegistration } from '../../../src/public-registration.ts';

export const publicObservation = unstable_cache(async () => observePublicRegistration(), ['p13-public-registration-v1'], { revalidate: 60 });
