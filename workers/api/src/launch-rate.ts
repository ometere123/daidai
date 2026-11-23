import type { D1Like } from './d1-schema.ts';

export const createLaunchRate = 'CREATE TABLE IF NOT EXISTS launch_rate (scope TEXT PRIMARY KEY, window INTEGER NOT NULL, uses INTEGER NOT NULL)';

export async function takeLaunchRate(db: D1Like, scope: 'service' | 'invitation', now: number) {
  const limit = scope === 'invitation' ? 20 : 180;
  const window = Math.floor(now / 60_000);
  const row = await db.prepare(`INSERT INTO launch_rate VALUES (?, ?, 1)
    ON CONFLICT(scope) DO UPDATE SET window=excluded.window,
      uses=CASE WHEN launch_rate.window<excluded.window THEN 1 ELSE launch_rate.uses+1 END
    WHERE launch_rate.window<excluded.window OR (launch_rate.window=excluded.window AND launch_rate.uses<?)
    RETURNING uses`).bind(scope, window, limit).first<{ uses: number }>();
  if (!row) return false;
  if (!Number.isSafeInteger(row.uses) || row.uses < 1 || row.uses > limit) throw Error('rate state unavailable');
  return true;
}
