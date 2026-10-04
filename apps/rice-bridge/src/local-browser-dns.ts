// Reuse the same DNS boundary as project dependency preparation.
import { resolvePublicAddress } from '@allrice/project-runtime';
export async function resolveLocalBrowserPublicAddress(
  hostname: string,
  publicAddress: (address: string) => boolean,
) {
  try {
    return await resolvePublicAddress(hostname, publicAddress);
  } catch {
    throw Error('LOCAL_BROWSER_POLICY_DENIED');
  }
}
