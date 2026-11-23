/** Future server-side identity entry point. No browser input, invitation or wallet address supplies an operator grant. */
type Claims = { issuer: string; subject: string; audience: string; expiresAt: number; confirmedAt: number; mfa: boolean };
type Grant = { tenant: string; active: boolean; operatorReview: boolean };
export type IdentityPorts = {
  verify: (assertion: string) => Promise<Claims | null>;
  findGrant: (issuer: string, subject: string, tenant: string) => Promise<Grant | null>;
};

export async function launchIdentity(input: { assertion: string; tenant: string; purpose: 'view' | 'operator-review' },
  policy: { issuer: string; audience: string; now: number }, ports?: IdentityPorts) {
  if (!ports) return { kind: 'unconfigured' } as const;
  if (!input.assertion || input.assertion.length > 8192 || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.tenant)) return { kind: 'denied' } as const;
  try {
    const claims = await ports.verify(input.assertion);
    if (!claims || claims.issuer !== policy.issuer || claims.audience !== policy.audience || !claims.subject ||
        !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= policy.now) return { kind: 'denied' } as const;
    const grant = await ports.findGrant(claims.issuer, claims.subject, input.tenant);
    if (!grant || !grant.active || grant.tenant !== input.tenant) return { kind: 'denied' } as const;
    if (input.purpose === 'operator-review' && (grant.operatorReview !== true || claims.mfa !== true ||
        !Number.isSafeInteger(claims.confirmedAt) || claims.confirmedAt > policy.now || claims.confirmedAt <= policy.now - 300_000)) return { kind: 'denied' } as const;
    return { kind: 'permitted', tenant: grant.tenant, purpose: input.purpose } as const;
  } catch { return { kind: 'unavailable' } as const; }
}
