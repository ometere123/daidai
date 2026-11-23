import { connection } from 'next/server';
import Prototype from '../prototype';
import { readFixtureWorkspace } from '../invoice-workspace';
import { SiteNav } from '../site-nav';

export default async function DemoPage() {
  await connection();
  return <><SiteNav /><Prototype workspace={readFixtureWorkspace(Date.now())} /></>;
}
