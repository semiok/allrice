import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import { listEmployeeToolAvailability } from '@allrice/database';
import {
  WorkerCapabilitySnapshotSchema,
  type WorkerCapabilitySnapshot,
} from '@allrice/contracts';

function installedVersion(specifier: string, anchor: string): string | null {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  try {
    let directory = dirname(createRequire(anchor).resolve(specifier));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(
          readFileSync(resolve(directory, 'package.json'), 'utf8'),
        );
        if (
          manifest.name === packageName &&
          typeof manifest.version === 'string'
        )
          return manifest.version;
      } catch {
        /* The module entry may be several directories below its package. */
      }
      directory = dirname(directory);
    }
  } catch {
    /* Missing/unresolvable packages are reported, never counted as installed. */
  }
  return null;
}

export function readWorkerCapabilities(
  workerId: string,
  options: {
    profilePath?: string;
  } = {},
): WorkerCapabilitySnapshot {
  const env = process.env;
  const profilePath = resolve(
    options.profilePath ??
      env.ALLRICE_DSH_CORDIS_CONFIG ??
      resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
  );
  const snapshot: WorkerCapabilitySnapshot = {
    schemaVersion: 1,
    workerId,
    releaseSha: env.ALLRICE_RELEASE_SHA ?? null,
    version: installedVersion(
      '@deepseek-ai/dsh-sdk-jsonrpc-server',
      profilePath,
    ),
    profileDigest: null,
    profileStatus: 'read',
    components: [],
    tools: listEmployeeToolAvailability().map((tool) => ({
      name: tool.canonicalName,
      enabled: tool.released,
    })),
  };
  // A custom executable need not use this installation or this composition.
  if (env.ALLRICE_DSH_RUNTIME_COMMAND || env.ALLRICE_DSH_RUNTIME_ARGS) {
    return WorkerCapabilitySnapshotSchema.parse({
      ...snapshot,
      version: null,
      profileStatus: 'custom-runtime',
    });
  }
  try {
    snapshot.profileDigest = createHash('sha256')
      .update(readFileSync(profilePath))
      .digest('hex');
    // Reuse upstream's entry-list YAML parser. !!js stays an inert expression
    // node: reporting must never evaluate config, boot plugins or read secrets.
    const entries = loadOverlayPatches('allrice-capabilities', profilePath);
    const visit = (
      rows: unknown[],
      parent: 'configured' | 'disabled' | 'conditional' = 'configured',
      prefix = '',
    ) => {
      for (const [index, value] of rows.entries()) {
        if (!value || typeof value !== 'object') throw Error('invalid_entry');
        const entry = value as Record<string, unknown>;
        const id = `${prefix}${typeof entry.id === 'string' ? entry.id : index}`;
        const state =
          parent === 'disabled' || entry.disabled === true
            ? 'disabled'
            : parent === 'conditional' ||
                (entry.disabled !== undefined && entry.disabled !== false) ||
                entry.filter !== undefined
              ? 'conditional'
              : 'configured';
        if (entry.group && Array.isArray(entry.config)) {
          visit(entry.config, state, `${id}/`);
          continue;
        }
        if (typeof entry.name !== 'string') throw Error('invalid_entry_name');
        // Local/embedded plugin paths and config expressions aren't public package identities.
        if (
          !/^@?[a-z0-9][a-z0-9._/-]*$/i.test(entry.name) ||
          entry.name.startsWith('.')
        )
          throw Error('unsupported_entry');
        const version = installedVersion(entry.name, profilePath);
        snapshot.components.push({
          id,
          packageName: entry.name,
          version,
          state: state === 'configured' && !version ? 'missing' : state,
        });
      }
    };
    visit(entries);
  } catch {
    snapshot.profileStatus = 'unavailable';
    snapshot.components = [];
  }
  return WorkerCapabilitySnapshotSchema.parse(snapshot);
}
