import { createHash } from 'node:crypto';
import { createPublicClient, encodeFunctionData, formatEther, http, toHex } from 'viem';
import { celo } from 'viem/chains';
import { CeloReader, estimateCeloFees } from '../src/celo.ts';
import { check, registry, tag } from '../src/invoice.ts';
import { registrationSession } from '../src/registration-host.ts';
import { code, identityAbi, sender, uri } from '../src/registration.ts';

const funding = '0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99';
const fundingBlock = 83444273n;
const fundingBlockHash = '0x9dbcfa7eb50eb27fb14555794cff39f0129a948c5bc96cda2e42e3100980fd9e';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ceilings = {
  gas: 244764n, maxFeePerGas: 240100000000n, maxPriorityFeePerGas: 1000000n,
  rollupReserveWei: 100000000000000n,
};
ceilings.totalWei = ceilings.gas * ceilings.maxFeePerGas + ceilings.rollupReserveWei;
const file = new URL('../.daidai-registration.sqlite', import.meta.url);
const call = {
  from: sender, to: registry, value: '0x0', data: tag(encodeFunctionData({
    abi: identityAbi, functionName: 'register', args: [uri],
  }), code),
};
let gate = 'arguments and private RPC configuration';
try {
  const [mode = '--review', fingerprint, extra] = process.argv.slice(2);
  check((mode === '--review' && !fingerprint) ||
    (mode === '--arm' && /^[a-f0-9]{64}$/.test(fingerprint ?? '') && !extra), 'invalid arguments');
  const endpoint = new URL(process.env.DAIDAI_CELO_RPC_URL ?? '');
  check(endpoint.protocol === 'https:' && endpoint.hostname === 'celo-mainnet.g.alchemy.com' &&
    /^\/v2\/[^/]+$/.test(endpoint.pathname) && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash, 'invalid endpoint');
  const client = createPublicClient({ chain: celo, transport: http(endpoint.href, {
    timeout: 10_000, retryCount: 0, fetchOptions: { redirect: 'error' },
  }) });
  const reader = new CeloReader((method, params) => client.request({ method, params }),
    (request, gas) => estimateCeloFees(client, request, gas));

  async function refresh() {
    check(await client.getChainId() === 42220, 'wrong RPC chain');
    const [latest, final, receipt, payment, canonical, nonce, pending, finalizedNonce] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' }),
      client.getTransactionReceipt({ hash: funding }), client.getTransaction({ hash: funding }),
      client.getBlock({ blockNumber: fundingBlock }), client.getTransactionCount({ address: sender, blockTag: 'latest' }),
      client.getTransactionCount({ address: sender, blockTag: 'pending' }),
      client.getTransactionCount({ address: sender, blockTag: 'finalized' }),
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    check(latest.timestamp <= now + 10n && latest.timestamp >= now - 60n &&
      final.timestamp <= latest.timestamp && final.timestamp >= now - 3600n &&
      latest.number >= final.number && final.number >= fundingBlock, 'stale or inconsistent chain head');
    check(receipt.status === 'success' && receipt.transactionHash === funding && receipt.blockNumber === fundingBlock &&
      receipt.blockHash === fundingBlockHash && canonical.hash === fundingBlockHash && payment.hash === funding &&
      payment.blockHash === fundingBlockHash && payment.from.toLowerCase() === '0xfd69a5d0b8330dc86e266304b3d1abe3f57b9d09' &&
      receipt.from.toLowerCase() === payment.from.toLowerCase() && receipt.to?.toLowerCase() === sender &&
      payment.to?.toLowerCase() === sender && payment.value === 32720588235294117647n, 'funding evidence changed');
    check(nonce === pending && nonce === finalizedNonce, 'outstanding transaction or nonce disagreement');
    const balances = [];
    for (const block of [latest, final]) {
      const [owned, balance] = await Promise.all([
        client.readContract({ address: registry, abi: identityAbi, functionName: 'balanceOf', args: [sender], blockNumber: block.number }),
        client.getBalance({ address: sender, blockNumber: block.number }),
      ]);
      check(owned === 0n && balance >= ceilings.totalWei, 'identity exists or native gas balance insufficient');
      balances.push(formatEther(balance));
    }
    const fields = await reader.preflight(call, ceilings);
    check(fields.nonce === toHex(nonce), 'nonce changed during preflight');
    const sim = await client.call({ account: sender, to: registry, data: call.data, value: 0n, nonce,
      gas: ceilings.gas, maxFeePerGas: ceilings.maxFeePerGas, maxPriorityFeePerGas: ceilings.maxPriorityFeePerGas });
    check(/^0x[0-9a-f]{64}$/i.test(sim.data ?? ''), 'unexpected register simulation result');
    return { nonce, latestBlock: latest.number.toString(), finalizedBlock: final.number.toString(),
      latestBalanceCELO: balances[0], finalizedBalanceCELO: balances[1], funding,
      checkedAtUTC: new Date().toISOString() };
  }

  gate = 'independent pinned metadata check';
  const metadata = await fetch('https://ipfs.filebase.io/ipfs/' + uri.slice(7), {
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  check(metadata.ok, 'metadata unavailable');
  const bytes = Buffer.from(await metadata.arrayBuffer());
  check(bytes.length === 516 && sha256(bytes) === '157bf72f79324331a1d676d8b9c69aa2468101845379acf7b44520fe9d5398a2',
    'unexpected registration metadata');
  gate = 'Celo identity, nonce, funding, simulation and fee checks';
  const snapshot = await refresh();
  const { fileURLToPath } = await import('node:url');
  const approval = review => sha256(JSON.stringify({ ...review, expiresUTC: undefined }));
  gate = 'local ledger or approval fingerprint';
  const session = await registrationSession({ file: fileURLToPath(file), reader, ceilings, nonce: snapshot.nonce,
    expires: Date.now() + 5 * 60_000, refresh: async () => (await refresh()).nonce, port: 51529,
    approved: mode === '--arm' ? review => approval(review) === fingerprint : undefined,
  });
  console.log(JSON.stringify({ ...session.review, snapshot, fingerprint: approval(session.review),
    gasBudgetCELO: formatEther(ceilings.gas * ceilings.maxFeePerGas), existingAttempt: session.existing }, null, 2));
  if (session.existing) process.exitCode = 2;
  if (session.host) {
    console.log('Open this one-use localhost URL manually. Keep it private. Ctrl+C closes the session.');
    console.log(session.host.bootstrapUrl);
    let timer;
    let interrupted;
    try {
      const result = await Promise.race([session.result, new Promise(resolve => {
        interrupted = () => resolve({ status: 'session_cancelled_or_interrupted' });
        process.once('SIGINT', interrupted);
        timer = setTimeout(interrupted, 5 * 60_000);
      })]);
      console.log(JSON.stringify(result));
      if (result.status !== 'hash_returned') process.exitCode = 2;
    } finally {
      clearTimeout(timer);
      if (interrupted) process.removeListener('SIGINT', interrupted);
      await session.close();
    }
  }
} catch {
  // RPC errors can contain the endpoint credential.
  console.error('Registration readiness blocked at ' + gate + '.');
  process.exitCode = 2;
}
