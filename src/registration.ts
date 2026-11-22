import { decodeFunctionData, formatEther, parseAbi, toHex } from 'viem';
import { fromDataSuffix } from '@celo/attribution-tags';
import { check, registry, verifyTag } from './invoice.ts';
import type { FeeCeilings } from './celo.ts';
import type { WalletAdapter } from './wallet.ts';

export const sender = '0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e';
export const uri = 'ipfs://bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui';
export const code = 'celo_597f1146c487';
export const identityAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

export function registrationIntent(adapter: WalletAdapter, expires: number, nonce: number, ceilings: FeeCeilings) {
  const prepared = adapter.prepareRegistration(uri, expires);
  const { request } = prepared;
  const { functionName, args } = decodeFunctionData({ abi: identityAbi, data: request.data });
  const suffix = fromDataSuffix(request.data);
  verifyTag(request.data, code);
  check(functionName === 'register' && args[0] === uri && suffix?.codes.length === 1 &&
    suffix.codes[0] === code && request.from === sender && request.to === registry,
  'unexpected registration intent');
  check(Number.isSafeInteger(nonce) && nonce >= 0, 'invalid reviewed nonce');
  const transaction = Object.freeze({ ...request, gas: toHex(ceilings.gas), nonce: toHex(nonce),
    maxFeePerGas: toHex(ceilings.maxFeePerGas), maxPriorityFeePerGas: toHex(ceilings.maxPriorityFeePerGas) });
  const review = Object.freeze({ chain: 'Celo Mainnet (42220)', method: 'register(string)',
    metadataURI: uri, attribution: code, nativeValueCELO: '0',
    reviewedBudgetCELO: formatEther(ceilings.totalWei), rollupReserveCELO: formatEther(ceilings.rollupReserveWei),
    expiresUTC: new Date(expires).toISOString(), transaction });
  return { prepared, review };
}

export type RegistrationReview = ReturnType<typeof registrationIntent>['review'];
