import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import type { BrowserContext } from 'playwright-core';
import { localBrowserUrlAllowed } from './local-browser-network.js';
import {
  LocalBrowserProfileBindingSchema,
  platformFileMaximumBytes,
  BrowserProfileSchema,
  runtimeContractEqual,
  type BrowserProfile,
  type LocalBrowserProfileBinding,
  type LocalBrowserRevocation,
} from '@allrice/contracts';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';

export type LocalBrowserStorageState = Awaited<
  ReturnType<BrowserContext['storageState']>
>;
type StoredProfile = {
  version: 1;
  serverUrl: string;
  binding: LocalBrowserProfileBinding;
  origins: string[];
  network?: BrowserProfile['network'];
  revoked: boolean;
  state: LocalBrowserStorageState | null;
};
type ProfileIndex = {
  version: 1;
  serverUrl: string;
  deviceId: string;
  revoked: boolean;
  entries: Array<{
    binding: LocalBrowserProfileBinding;
    origins: string[];
    network?: BrowserProfile['network'];
  }>;
};
const limit = { maxBytes: platformFileMaximumBytes };
const publicProfile = BrowserProfileSchema.parse({
  version: 1,
  network: 'public_https',
  origins: [],
});
const unsafe = () => Error('LOCAL_BROWSER_PROFILE_UNSAFE');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw unsafe();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw unsafe();
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw unsafe();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw unsafe();
  return value;
}

/** Validate native Playwright storageState. Login data stays in the owned profile;
 * the network policy still controls every request made after restoration. */
export function validateLocalBrowserStorageState(
  value: unknown,
  origins: string[],
  network?: BrowserProfile['network'],
): LocalBrowserStorageState {
  const state = record(value);
  keys(state, ['cookies', 'origins']);
  const hosts = origins.map((origin) => new URL(origin).hostname);
  const allowsOrigin = (origin: string) =>
    network === 'public_https'
      ? localBrowserUrlAllowed(origin, publicProfile) &&
        new URL(origin).origin === origin
      : origins.includes(origin);
  for (const item of array(state.cookies, 1000)) {
    const cookie = record(item);
    keys(cookie, [
      'name',
      'value',
      'domain',
      'path',
      'expires',
      'httpOnly',
      'secure',
      'sameSite',
      'partitionKey',
    ]);
    string(cookie.name, 1024);
    string(cookie.value, 16384);
    const domain = string(cookie.domain, 253).replace(/^\./, '').toLowerCase();
    if (
      !domain ||
      !(network === 'public_https'
        ? localBrowserUrlAllowed(`https://${domain}`, publicProfile)
        : hosts.some((host) => host === domain || host.endsWith(`.${domain}`)))
    )
      throw unsafe();
    if (!string(cookie.path, 2048).startsWith('/')) throw unsafe();
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))
      throw unsafe();
    if (
      typeof cookie.httpOnly !== 'boolean' ||
      typeof cookie.secure !== 'boolean'
    )
      throw unsafe();
    if (!['Strict', 'Lax', 'None'].includes(String(cookie.sameSite)))
      throw unsafe();
    if (
      cookie.partitionKey !== undefined &&
      !allowsOrigin(string(cookie.partitionKey, 2048))
    )
      throw unsafe();
  }
  const seen = new Set<string>();
  for (const item of array(state.origins, network ? 1000 : 8)) {
    const origin = record(item);
    keys(origin, ['origin', 'localStorage', 'indexedDB']);
    const name = string(origin.origin, 2048);
    if (!allowsOrigin(name) || seen.has(name)) throw unsafe();
    seen.add(name);
    for (const pair of array(origin.localStorage, 2000)) {
      const entry = record(pair);
      keys(entry, ['name', 'value']);
      string(entry.name, 2048);
      string(entry.value, platformFileMaximumBytes);
    }
  }
  if (Buffer.byteLength(JSON.stringify(state)) > platformFileMaximumBytes)
    throw unsafe();
  return structuredClone(state) as LocalBrowserStorageState;
}

/** Protected, unencrypted, device-owned storage. It is never a personal Chrome
 * profile and never uploaded. Grant revocation leaves only a secret-free tombstone. */
export class LocalBrowserProfiles {
  readonly directory: string;
  private readonly busy = new Set<string>();
  private readonly deviceBusy = new Set<string>();
  constructor(
    configPath: string,
    private readonly serverUrl: string,
  ) {
    this.directory = join(
      dirname(configPath),
      `${basename(configPath)}.browser-profiles`,
    );
  }
  deviceDirectory(deviceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw unsafe();
    return (
      this.directory +
      '-' +
      createHash('sha256')
        .update(JSON.stringify([this.serverUrl, deviceId]))
        .digest('hex')
        .slice(0, 32)
    );
  }
  private async index(deviceId: string): Promise<ProfileIndex> {
    const directory = this.deviceDirectory(deviceId);
    const text = await readCredentialRecordFile(directory, 'index.json', limit);
    if (text === null) {
      const stat = await lstat(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw unsafe();
        },
      );
      // A missing index is safe only when this exact device directory has never
      // held any profile. Never infer deletion from a missing/corrupt index.
      if (stat && (await readdir(directory)).length) throw unsafe();
      return {
        version: 1,
        serverUrl: this.serverUrl,
        deviceId,
        revoked: false,
        entries: [],
      };
    }
    try {
      const value = record(JSON.parse(text));
      keys(value, ['version', 'serverUrl', 'deviceId', 'revoked', 'entries']);
      if (
        value.version !== 1 ||
        value.serverUrl !== this.serverUrl ||
        value.deviceId !== deviceId ||
        typeof value.revoked !== 'boolean'
      )
        throw unsafe();
      const seen = new Set<string>();
      const entries = array(value.entries, 128).map((entry) => {
        const item = record(entry);
        keys(item, ['binding', 'origins', 'network']);
        if (
          item.network !== undefined &&
          !['public_https', 'local_sites'].includes(String(item.network))
        )
          throw unsafe();
        const binding = LocalBrowserProfileBindingSchema.parse(item.binding);
        if (binding.deviceId !== deviceId || seen.has(binding.logicalProfileId))
          throw unsafe();
        seen.add(binding.logicalProfileId);
        const origins = array(item.origins, 8).map((origin) =>
          string(origin, 2048),
        );
        return {
          binding,
          origins,
          ...(item.network
            ? { network: item.network as BrowserProfile['network'] }
            : {}),
        };
      });
      const names = await readdir(directory);
      if (
        names.length > 129 ||
        names.some(
          (name) =>
            name !== 'index.json' &&
            !entries.some((entry) => this.filename(entry.binding) === name),
        )
      )
        throw unsafe();
      return {
        version: 1,
        serverUrl: this.serverUrl,
        deviceId,
        revoked: value.revoked,
        entries,
      };
    } catch {
      throw unsafe();
    }
  }
  private async indexBeforeState(
    binding: LocalBrowserProfileBinding,
    origins: string[],
    network?: BrowserProfile['network'],
  ) {
    if (this.deviceBusy.has(binding.deviceId)) throw unsafe();
    this.deviceBusy.add(binding.deviceId);
    const entry = { binding, origins, ...(network ? { network } : {}) };
    try {
      const index = await this.index(binding.deviceId);
      if (index.revoked) throw Error('LOCAL_BROWSER_POLICY_DENIED');
      const prior = index.entries.find(
        (entry) => entry.binding.logicalProfileId === binding.logicalProfileId,
      );
      if (prior) {
        if (!runtimeContractEqual(prior, entry)) throw unsafe();
        return;
      }
      if (index.entries.length >= 128) throw unsafe();
      index.entries.push(entry);
      await writeCredentialRecordFile(
        this.deviceDirectory(binding.deviceId),
        'index.json',
        JSON.stringify(index),
        limit,
      );
    } finally {
      this.deviceBusy.delete(binding.deviceId);
    }
  }
  private filename(
    binding: LocalBrowserProfileBinding | LocalBrowserRevocation,
  ) {
    return `${binding.logicalProfileId}.json`;
  }
  private async read(
    binding: LocalBrowserProfileBinding | LocalBrowserRevocation,
  ) {
    try {
      const index = await this.index(binding.deviceId);
      const text = await readCredentialRecordFile(
        this.deviceDirectory(binding.deviceId),
        this.filename(binding),
        limit,
      );
      if (text === null) return null;
      const value = record(JSON.parse(text));
      keys(value, [
        'version',
        'serverUrl',
        'binding',
        'origins',
        'network',
        'revoked',
        'state',
      ]);
      if (
        value.version !== 1 ||
        value.serverUrl !== this.serverUrl ||
        (value.network !== undefined &&
          !['public_https', 'local_sites'].includes(String(value.network))) ||
        typeof value.revoked !== 'boolean'
      )
        throw unsafe();
      const saved = LocalBrowserProfileBindingSchema.parse(value.binding);
      const expected =
        'persistLogin' in binding
          ? binding
          : { ...binding, persistLogin: saved.persistLogin };
      if (!runtimeContractEqual(saved, expected)) throw unsafe();
      const origins = array(value.origins, 8).map((v) => string(v, 2048));
      const entry = index.entries.find(
        (entry) => entry.binding.logicalProfileId === binding.logicalProfileId,
      );
      if (
        !entry ||
        !runtimeContractEqual(entry, {
          binding: saved,
          origins,
          ...(value.network ? { network: value.network } : {}),
        })
      )
        throw unsafe();
      if (value.revoked) {
        if (value.state !== null) throw unsafe();
      } else if (value.state !== null)
        validateLocalBrowserStorageState(
          value.state,
          origins,
          value.network as BrowserProfile['network'],
        );
      return { ...value, binding: saved, origins } as StoredProfile;
    } catch {
      throw unsafe();
    }
  }
  async load(
    bindingInput: LocalBrowserProfileBinding,
    profile: BrowserProfile,
  ) {
    const binding = LocalBrowserProfileBindingSchema.parse(bindingInput);
    if ((await this.index(binding.deviceId)).revoked)
      throw Error('LOCAL_BROWSER_POLICY_DENIED');
    const stored = await this.read(binding);
    if (stored?.revoked) throw Error('LOCAL_BROWSER_POLICY_DENIED');
    if (
      stored &&
      (stored.network !== profile.network ||
        !runtimeContractEqual(stored.origins, profile.origins))
    )
      throw unsafe();
    if (!binding.persistLogin) {
      if (stored?.state !== null && stored !== null) throw unsafe();
      return undefined;
    }
    return stored?.state
      ? validateLocalBrowserStorageState(
          stored.state,
          profile.origins,
          profile.network,
        )
      : undefined;
  }
  async save(
    bindingInput: LocalBrowserProfileBinding,
    profile: BrowserProfile,
    state: LocalBrowserStorageState,
  ) {
    const binding = LocalBrowserProfileBindingSchema.parse(bindingInput);
    if (!binding.persistLogin) return;
    if (this.busy.has(binding.logicalProfileId)) throw unsafe();
    this.busy.add(binding.logicalProfileId);
    try {
      const prior = await this.read(binding);
      if (prior?.revoked) throw Error('LOCAL_BROWSER_POLICY_DENIED');
      if (
        prior &&
        (prior.network !== profile.network ||
          !runtimeContractEqual(prior.origins, profile.origins))
      )
        throw unsafe();
      const value: StoredProfile = {
        version: 1,
        serverUrl: this.serverUrl,
        binding,
        origins: profile.origins,
        ...(profile.network ? { network: profile.network } : {}),
        revoked: false,
        state: validateLocalBrowserStorageState(
          state,
          profile.origins,
          profile.network,
        ),
      };
      await this.indexBeforeState(binding, profile.origins, profile.network);
      await writeCredentialRecordFile(
        this.deviceDirectory(binding.deviceId),
        this.filename(binding),
        JSON.stringify(value),
        limit,
      );
    } finally {
      this.busy.delete(binding.logicalProfileId);
    }
  }
  async revoke(binding: LocalBrowserRevocation) {
    if (this.busy.has(binding.logicalProfileId)) throw unsafe();
    this.busy.add(binding.logicalProfileId);
    try {
      const prior = await this.read(binding);
      // Persist a tombstone even for an unused grant so an old local session can
      // never recreate credentials after the cloud has revoked this generation.
      const value: StoredProfile = {
        version: 1,
        serverUrl: this.serverUrl,
        binding: prior?.binding ?? { ...binding, persistLogin: false },
        origins: prior?.origins ?? [],
        ...(prior?.network ? { network: prior.network } : {}),
        revoked: true,
        state: null,
      };
      await this.indexBeforeState(value.binding, value.origins, value.network);
      await writeCredentialRecordFile(
        this.deviceDirectory(binding.deviceId),
        this.filename(binding),
        JSON.stringify(value),
        limit,
      );
    } finally {
      this.busy.delete(binding.logicalProfileId);
    }
  }
  /** Called only after this device's active browser is really stopped. There is
   * no server ACK here: an invalid token cannot certify cloud-side cleanup. */
  async revokeDevice(deviceId: string): Promise<void> {
    if (this.deviceBusy.has(deviceId)) throw unsafe();
    this.deviceBusy.add(deviceId);
    try {
      const index = await this.index(deviceId);
      if (
        index.entries.some((entry) =>
          this.busy.has(entry.binding.logicalProfileId),
        )
      )
        throw unsafe();
      index.revoked = true;
      await writeCredentialRecordFile(
        this.deviceDirectory(deviceId),
        'index.json',
        JSON.stringify(index),
        limit,
      );
      for (const entry of index.entries) {
        const prior = await this.read(entry.binding);
        // An index-first interrupted write may legitimately have no state file.
        if (prior && !runtimeContractEqual(prior.origins, entry.origins))
          throw unsafe();
        if (this.busy.has(entry.binding.logicalProfileId)) throw unsafe();
        this.busy.add(entry.binding.logicalProfileId);
        try {
          await writeCredentialRecordFile(
            this.deviceDirectory(deviceId),
            this.filename(entry.binding),
            JSON.stringify({
              version: 1,
              serverUrl: this.serverUrl,
              binding: entry.binding,
              origins: entry.origins,
              ...(entry.network ? { network: entry.network } : {}),
              revoked: true,
              state: null,
            }),
            limit,
          );
        } finally {
          this.busy.delete(entry.binding.logicalProfileId);
        }
      }
    } finally {
      this.deviceBusy.delete(deviceId);
    }
  }
}
