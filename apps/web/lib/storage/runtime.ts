import { LocalStorageAdapter, SignedAccessService } from '@allrice/storage';

let adapter: LocalStorageAdapter | undefined;
let signer: SignedAccessService | undefined;

export function getStorageAdapter() {
  adapter ??= new LocalStorageAdapter(
    process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
  );
  return adapter;
}

export function getSignedAccessService() {
  const secret =
    process.env.ALLRICE_STORAGE_SIGNING_SECRET ??
    (process.env.NODE_ENV === 'production'
      ? undefined
      : 'allrice-development-signing-secret-change-me');
  if (!secret) {
    throw new Error('ALLRICE_STORAGE_SIGNING_SECRET is required in production');
  }
  signer ??= new SignedAccessService(secret);
  return signer;
}
