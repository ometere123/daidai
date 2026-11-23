import { connection } from 'next/server';
import Prototype from './prototype';
import { readFixtureWorkspace } from './invoice-workspace';

export default async function Page() {
  await connection();
  return <Prototype workspace={readFixtureWorkspace(Date.now())} />;
}
