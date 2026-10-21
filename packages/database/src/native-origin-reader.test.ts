import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configuredNativeOriginReaders,
  nativeOriginReaderForBinding,
  nativeOriginReaderForOrigin,
  type NativeOriginReaderScope,
} from './conversation/native-origin-reader.ts';
import {
  nativeRootDigest,
  newNativeGeneration,
  type NativeRootOrigin,
} from './conversation/native-root-origin.ts';

const invalid = 'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID';
const environment = {
  path: 'ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH',
  hash: 'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
  storage: 'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT',
  primary: 'ALLRICE_DSH_NATIVE_ARTIFACT_ID',
  newBirth: 'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
} as const;
const secondEnvironment = {
  path: 'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH',
  hash: 'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256',
  storage: 'ALLRICE_DSH_ORIGIN_READER_2_STORAGE_ROOT',
} as const;
const checksum = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sourceArtifactId = checksum('synthetic-original-artifact');
const targetArtifactId = checksum('synthetic-current-artifact');

// Real files and the production parser only. These synthetic operator inputs
// do not stand in for DB admission or existing-writer migration evidence.
describe('exact unbound-chat origin reader configuration', () => {
  let directory: string;
  let approvalPath: string;
  let storageRoot: string;
  let secondApprovalPath: string;
  let secondStorageRoot: string;
  let scope: NativeOriginReaderScope;
  let origin: NativeRootOrigin;

  beforeEach(() => {
    for (const name of new Set([
      ...Object.values(environment),
      ...Object.values(secondEnvironment),
      ...Object.keys(process.env).filter((key) =>
        key.startsWith('ALLRICE_DSH_ORIGIN_READER_'),
      ),
    ]))
      vi.stubEnv(name, undefined);
    // macOS /var and some CI temp roots are aliases; the approved path itself
    // must be canonical, so resolve the parent before creating this fixture.
    directory = mkdtempSync(
      join(realpathSync(tmpdir()), 'allrice-origin-reader-'),
    );
    approvalPath = join(directory, 'approval.json');
    storageRoot = join(directory, 'storage');
    mkdirSync(storageRoot);
    secondApprovalPath = join(directory, 'approval-2.json');
    secondStorageRoot = join(directory, 'storage-2');
    mkdirSync(secondStorageRoot);
    scope = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
    };
    const contextId = randomUUID();
    origin = {
      schemaVersion: 1,
      contextKind: 'chat',
      contextId,
      rootSeed: contextId,
      distributionGeneration: newNativeGeneration,
      profileId: 'restricted',
      artifactId: sourceArtifactId,
      frozenIdentity: {
        kind: 'employee_package',
        checksum: checksum('synthetic-frozen-employee-package'),
        sourceId: randomUUID(),
      },
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function policy() {
    return {
      schemaVersion: 1,
      mode: 'unbound_chat_first_writer',
      sourceArtifactId,
      targetArtifactId,
      generation: newNativeGeneration,
      profileId: 'restricted',
      sessionFormat: 4,
      prerequisites: {
        nodeMajor: Number(process.versions.node.split('.')[0]),
        platform: process.platform,
        arch: process.arch,
        modules: process.versions.modules,
      },
      evidenceDigest: checksum('synthetic-reviewed-evidence'),
      contexts: [{ ...scope, origin }],
    };
  }
  type Policy = ReturnType<typeof policy>;
  type Binding = Parameters<typeof nativeOriginReaderForBinding>[0];

  function installBytes(bytes: Buffer) {
    writeFileSync(approvalPath, bytes, { mode: 0o600 });
    vi.stubEnv(environment.path, approvalPath);
    vi.stubEnv(environment.hash, checksum(bytes));
    vi.stubEnv(environment.storage, storageRoot);
    vi.stubEnv(environment.primary, targetArtifactId);
    vi.stubEnv(environment.newBirth, targetArtifactId);
  }
  function install(value: unknown = policy()) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    installBytes(bytes);
    return bytes;
  }
  function secondPolicy(): Policy {
    const value = policy();
    const contextId = randomUUID();
    value.sourceArtifactId = checksum('synthetic-second-original-artifact');
    value.targetArtifactId = checksum('synthetic-second-reader-target');
    value.evidenceDigest = checksum('synthetic-second-reviewed-evidence');
    value.contexts = [
      {
        ...scope,
        origin: {
          ...origin,
          contextId,
          rootSeed: contextId,
          artifactId: value.sourceArtifactId,
        },
      },
    ];
    return value;
  }
  function installSecondBytes(bytes: Buffer) {
    writeFileSync(secondApprovalPath, bytes, { mode: 0o600 });
    vi.stubEnv(secondEnvironment.path, secondApprovalPath);
    vi.stubEnv(secondEnvironment.hash, checksum(bytes));
    vi.stubEnv(secondEnvironment.storage, secondStorageRoot);
    vi.stubEnv(environment.primary, targetArtifactId);
    vi.stubEnv(environment.newBirth, targetArtifactId);
  }
  function installSecond(value: unknown = secondPolicy()) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    installSecondBytes(bytes);
    return bytes;
  }
  function groupEnvironment(group: number) {
    if (group === 1) return environment;
    const prefix = `ALLRICE_DSH_ORIGIN_READER_${group}_`;
    return {
      path: `${prefix}APPROVAL_PATH`,
      hash: `${prefix}APPROVAL_SHA256`,
      storage: `${prefix}STORAGE_ROOT`,
    };
  }
  function groupPolicy(group: number): Policy {
    if (group === 1) return policy();
    if (group === 2) return secondPolicy();
    const value = secondPolicy();
    value.sourceArtifactId = checksum(`synthetic-source-${group}`);
    value.targetArtifactId = checksum(`synthetic-target-${group}`);
    value.contexts[0]!.origin.artifactId = value.sourceArtifactId;
    return value;
  }
  function installGroup(group: number, value: Policy, bytes?: Buffer) {
    const body = bytes ?? Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if (group === 1) installBytes(body);
    else if (group === 2) installSecondBytes(body);
    else {
      const names = groupEnvironment(group);
      const path = join(directory, `approval-${group}.json`);
      const storage = join(directory, `storage-${group}`);
      mkdirSync(storage, { recursive: true });
      writeFileSync(path, body, { mode: 0o600 });
      vi.stubEnv(names.path, path);
      vi.stubEnv(names.hash, checksum(body));
      vi.stubEnv(names.storage, storage);
    }
    return body;
  }
  function installGroups(count: number) {
    return Array.from({ length: count }, (_, index) => {
      const value = groupPolicy(index + 1);
      installGroup(index + 1, value);
      return value;
    });
  }
  function withContexts(value: Policy, count: number): Policy {
    const base = value.contexts[0]!;
    return {
      ...value,
      contexts: Array.from({ length: count }, (_, i) => {
        const contextId = i ? randomUUID() : base.origin.contextId;
        return {
          ...base,
          origin: { ...base.origin, contextId, rootSeed: contextId },
        };
      }),
    };
  }
  function paddedPolicy(value: Policy, bytes: number) {
    const json = Buffer.from(JSON.stringify(value));
    if (json.byteLength > bytes) throw Error('padded_fixture_too_large');
    return Buffer.concat([json, Buffer.alloc(bytes - json.byteLength, ' ')]);
  }
  function binding(): Binding {
    const [approved] = configuredNativeOriginReaders();
    if (!approved) throw Error('approved_fixture_required');
    return {
      ...scope,
      originReaderApprovalDigest: approved.approvalDigest,
      artifactId: targetArtifactId,
      contextKind: 'chat',
      contextId: origin.contextId,
      profileId: 'restricted',
      storageNamespace: approved.storageNamespace,
    };
  }

  it('returns no approvals or origin redirect when configuration is absent', () => {
    expect(configuredNativeOriginReaders()).toEqual([]);
    expect(nativeOriginReaderForOrigin(origin, scope)).toBeUndefined();
  });

  it('approves the exact file hash, origin, tenant and old storage namespace', () => {
    const bytes = install();
    expect(process.env[environment.hash]).toBe(
      checksum(readFileSync(approvalPath)),
    );
    expect(readFileSync(approvalPath)).toEqual(bytes);
    const approvals = configuredNativeOriginReaders();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      ...scope,
      sourceArtifactId,
      targetArtifactId,
      generation: newNativeGeneration,
      profileId: 'restricted',
      contextId: origin.contextId,
      evidenceDigest: policy().evidenceDigest,
      storageNamespace: join(
        storageRoot,
        scope.organizationId,
        scope.workspaceId,
        scope.ownerId,
        origin.contextId,
        'sessions',
      ),
    });
    expect(approvals[0]?.approvalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(approvals[0]?.originDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(nativeOriginReaderForOrigin(origin, scope)).toEqual(approvals[0]);
    expect(nativeOriginReaderForBinding(binding())).toEqual(approvals[0]);
  });

  it('re-hashes changed bytes even when file size and timestamps are preserved', () => {
    const bytes = install();
    configuredNativeOriginReaders();
    const before = statSync(approvalPath);
    const changed = Buffer.from(
      bytes
        .toString()
        .replace(policy().evidenceDigest, checksum('different-evidence')),
    );
    expect(changed.byteLength).toBe(bytes.byteLength);
    writeFileSync(approvalPath, changed);
    utimesSync(approvalPath, before.atime, before.mtime);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('does not approve semantically equal JSON with different unapproved bytes', () => {
    install();
    writeFileSync(approvalPath, JSON.stringify(policy()));
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each([
    ['path', ['hash', 'storage']],
    ['hash', ['path', 'storage']],
    ['storage', ['path', 'hash']],
    ['path+hash', ['storage']],
    ['path+storage', ['hash']],
    ['hash+storage', ['path']],
  ] as const)(
    'rejects partial approval configuration: %s',
    (_label, missing) => {
      install();
      for (const key of missing) vi.stubEnv(environment[key], undefined);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each([
    ['malformed hash', 'not-a-sha256'],
    ['wrong hash', checksum('other-file')],
    ['missing hash prefix', 'a'.repeat(64)],
  ])('rejects %s', (_label, hash) => {
    install();
    vi.stubEnv(environment.hash, hash);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each(['primary', 'newBirth'] as const)(
    'requires the current primary and new-birth artifact to agree: %s',
    (key) => {
      install();
      vi.stubEnv(environment[key], checksum('different-current-target'));
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
      vi.stubEnv(environment[key], undefined);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it('keeps the exact approved reader when a later primary is promoted, without rewriting its proof', () => {
    install();
    const before = configuredNativeOriginReaders();
    const later = checksum('later-primary');
    vi.stubEnv(environment.primary, later);
    vi.stubEnv(environment.newBirth, later);
    expect(configuredNativeOriginReaders()).toEqual(before);
    expect(configuredNativeOriginReaders()[0]!.targetArtifactId).toBe(
      targetArtifactId,
    );
    // Launch/coverage separately require this exact target to remain installed
    // and verified. A new primary is not a version-wide replacement reader.
  });

  const invalidPolicies: [string, (value: Policy) => unknown][] = [
    [
      'same source and target',
      (p) => ({ ...p, sourceArtifactId: p.targetArtifactId }),
    ],
    [
      'another policy mode',
      (p) => ({ ...p, mode: 'existing_writer_migration' }),
    ],
    [
      'another distribution generation',
      (p) => ({ ...p, generation: 'dsh-other' }),
    ],
    ['technical profile', (p) => ({ ...p, profileId: 'technical' })],
    ['another session format', (p) => ({ ...p, sessionFormat: 5 })],
    [
      'another Node ABI',
      (p) => ({
        ...p,
        prerequisites: { ...p.prerequisites, modules: 'different' },
      }),
    ],
    [
      'another Node major',
      (p) => ({
        ...p,
        prerequisites: {
          ...p.prerequisites,
          nodeMajor: p.prerequisites.nodeMajor + 1,
        },
      }),
    ],
    [
      'another platform',
      (p) => ({
        ...p,
        prerequisites: { ...p.prerequisites, platform: 'different' },
      }),
    ],
    [
      'another architecture',
      (p) => ({
        ...p,
        prerequisites: { ...p.prerequisites, arch: 'different' },
      }),
    ],
    ['unknown policy field', (p) => ({ ...p, allowSameGeneration: true })],
    ['no exact contexts', (p) => ({ ...p, contexts: [] })],
    [
      'origin from another source',
      (p) => ({
        ...p,
        contexts: [
          {
            ...scope,
            origin: { ...origin, artifactId: checksum('other-source') },
          },
        ],
      }),
    ],
    [
      'origin with another profile',
      (p) => ({
        ...p,
        contexts: [{ ...scope, origin: { ...origin, profileId: 'technical' } }],
      }),
    ],
    [
      'origin with another root seed',
      (p) => ({
        ...p,
        contexts: [{ ...scope, origin: { ...origin, rootSeed: randomUUID() } }],
      }),
    ],
    [
      'non-chat origin',
      (p) => ({
        ...p,
        contexts: [
          {
            ...scope,
            origin: { ...origin, contextKind: 'platform_employee_test' },
          },
        ],
      }),
    ],
    [
      'missing published employee version',
      (p) => ({
        ...p,
        contexts: [
          {
            ...scope,
            origin: {
              ...origin,
              frozenIdentity: {
                kind: 'employee_package',
                checksum: origin.frozenIdentity.checksum,
              },
            },
          },
        ],
      }),
    ],
    [
      'extra context field',
      (p) => ({ ...p, contexts: [{ ...p.contexts[0], allOwners: true }] }),
    ],
  ];
  it.each(invalidPolicies)(
    'rejects a hash-approved policy with %s',
    (_label, change) => {
      install(change(policy()));
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it('rejects duplicate context IDs even with a different tenant scope', () => {
    const value = policy();
    value.contexts.push({ ...scope, ownerId: randomUUID(), origin });
    install(value);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each(['organizationId', 'workspaceId', 'ownerId'] as const)(
    'rejects an origin lookup in another %s',
    (key) => {
      install();
      expect(() =>
        nativeOriginReaderForOrigin(origin, { ...scope, [key]: randomUUID() }),
      ).toThrow(invalid);
    },
  );

  const changedOrigins: [
    string,
    (value: NativeRootOrigin) => NativeRootOrigin,
  ][] = [
    [
      'source artifact',
      (o) => ({ ...o, artifactId: checksum('another-source') }),
    ],
    ['root seed', (o) => ({ ...o, rootSeed: randomUUID() })],
    ['context kind', (o) => ({ ...o, contextKind: 'platform_employee_test' })],
    ['profile', (o) => ({ ...o, profileId: 'technical' })],
    [
      'frozen package checksum',
      (o) => ({
        ...o,
        frozenIdentity: {
          ...o.frozenIdentity,
          checksum: checksum('other-package'),
        },
      }),
    ],
    [
      'published version',
      (o) => ({
        ...o,
        frozenIdentity: { ...o.frozenIdentity, sourceId: randomUUID() },
      }),
    ],
    [
      'frozen identity kind',
      (o) => ({
        ...o,
        frozenIdentity: { ...o.frozenIdentity, kind: 'internal_recipe' },
      }),
    ],
  ];
  it.each(changedOrigins)(
    'rejects a reviewed context with a changed %s',
    (_label, change) => {
      install();
      expect(() => nativeOriginReaderForOrigin(change(origin), scope)).toThrow(
        invalid,
      );
    },
  );

  it('rejects an extra origin of the retired source and never grants a generation-wide redirect', () => {
    install();
    const contextId = randomUUID();
    const extra = { ...origin, contextId, rootSeed: contextId };
    expect(() => nativeOriginReaderForOrigin(extra, scope)).toThrow(invalid);
    expect(
      nativeOriginReaderForOrigin(
        {
          ...extra,
          artifactId: checksum('unrelated-same-generation-artifact'),
        },
        scope,
      ),
    ).toBeUndefined();
  });

  it('keeps the first approval digest stable when another exact context is approved', () => {
    const value = policy();
    install(value);
    const first = nativeOriginReaderForOrigin(origin, scope)!;
    const contextId = randomUUID();
    const secondOrigin = { ...origin, contextId, rootSeed: contextId };
    value.contexts.push({ ...scope, origin: secondOrigin });
    install(value);
    expect(nativeOriginReaderForOrigin(origin, scope)).toEqual(first);
    const second = nativeOriginReaderForOrigin(secondOrigin, scope)!;
    expect(second.approvalDigest).not.toBe(first.approvalDigest);
    value.contexts.reverse();
    install(value);
    expect(nativeOriginReaderForOrigin(origin, scope)?.approvalDigest).toBe(
      first.approvalDigest,
    );
  });

  it('invalidates a former binding approval when the reviewed evidence changes', () => {
    install();
    const previous = binding();
    install({ ...policy(), evidenceDigest: checksum('new-reviewed-evidence') });
    expect(() => nativeOriginReaderForBinding(previous)).toThrow(invalid);
  });

  const changedBindings: [string, (value: Binding) => Binding][] = [
    [
      'approval digest',
      (b) => ({ ...b, originReaderApprovalDigest: checksum('other-approval') }),
    ],
    ['old writer artifact', (b) => ({ ...b, artifactId: sourceArtifactId })],
    [
      'unapproved target',
      (b) => ({ ...b, artifactId: checksum('other-target') }),
    ],
    ['organization', (b) => ({ ...b, organizationId: randomUUID() })],
    ['workspace', (b) => ({ ...b, workspaceId: randomUUID() })],
    ['owner', (b) => ({ ...b, ownerId: randomUUID() })],
    ['context kind', (b) => ({ ...b, contextKind: 'platform_employee_test' })],
    ['context ID', (b) => ({ ...b, contextId: randomUUID() })],
    ['profile', (b) => ({ ...b, profileId: 'technical' })],
    [
      'storage namespace',
      (b) => ({
        ...b,
        storageNamespace: join(directory, 'other-storage', 'sessions'),
      }),
    ],
    [
      'noncanonical namespace',
      (b) => ({ ...b, storageNamespace: b.storageNamespace + '/' }),
    ],
  ];
  it.each(changedBindings)(
    'rejects binding with a changed %s',
    (_label, change) => {
      install();
      expect(() => nativeOriginReaderForBinding(change(binding()))).toThrow(
        invalid,
      );
    },
  );

  it('rejects a symlink approval file', () => {
    install();
    const alias = join(directory, 'approval-link.json');
    symlinkSync(approvalPath, alias);
    vi.stubEnv(environment.path, alias);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('rejects approval files beneath a symlink directory', () => {
    install();
    const alias = join(directory, 'directory-link');
    symlinkSync(directory, alias, 'dir');
    vi.stubEnv(environment.path, join(alias, 'approval.json'));
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each(['relative', 'noncanonical', 'missing', 'directory'] as const)(
    'rejects a %s approval file path',
    (kind) => {
      install();
      const path = {
        relative: 'approval.json',
        noncanonical:
          directory + '/../' + directory.split('/').at(-1) + '/approval.json',
        missing: join(directory, 'missing.json'),
        directory,
      }[kind];
      vi.stubEnv(environment.path, path);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each(['relative', 'noncanonical', 'missing', 'file', 'symlink'] as const)(
    'rejects a %s storage root',
    (kind) => {
      install();
      const alias = join(directory, 'storage-link');
      if (kind === 'symlink') symlinkSync(storageRoot, alias, 'dir');
      const path = {
        relative: 'storage',
        noncanonical: storageRoot + '/../storage',
        missing: join(directory, 'missing-storage'),
        file: approvalPath,
        symlink: alias,
      }[kind];
      vi.stubEnv(environment.storage, path);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it('rejects malformed JSON with a correct byte hash', () => {
    installBytes(Buffer.from('{"schemaVersion":1,'));
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('keeps the exact original per-policy proof and raw file when a second reader is added', () => {
    const value = policy();
    const bytes = install(value);
    const { contexts, ...proof } = value;
    const storageNamespace = join(
      storageRoot,
      scope.organizationId,
      scope.workspaceId,
      scope.ownerId,
      origin.contextId,
      'sessions',
    );
    const original = configuredNativeOriginReaders()[0]!;
    // Independent reference to the original digest contract: no combined proof,
    // slot, policy order or second-file fields may enter an existing approval.
    expect(original.approvalDigest).toBe(
      nativeRootDigest({ proof, entry: contexts[0]!, storageNamespace }),
    );
    const second = secondPolicy();
    installSecond(second);
    const approvals = configuredNativeOriginReaders();
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toEqual(original);
    expect(readFileSync(approvalPath)).toEqual(bytes);
    expect(process.env[environment.hash]).toBe(checksum(bytes));
    expect(nativeOriginReaderForOrigin(origin, scope)).toEqual(original);
    expect(
      nativeOriginReaderForOrigin(second.contexts[0]!.origin, scope),
    ).toEqual(approvals[1]);
    const later = checksum('later-primary-with-two-exact-readers');
    vi.stubEnv(environment.primary, later);
    vi.stubEnv(environment.newBirth, later);
    expect(configuredNativeOriginReaders()).toEqual(approvals);
  });

  it('re-hashes the second file after same-size edits with unchanged timestamps', () => {
    install();
    const value = secondPolicy();
    const bytes = installSecond(value);
    expect(configuredNativeOriginReaders()).toHaveLength(2);
    const before = statSync(secondApprovalPath);
    const changed = Buffer.from(
      bytes
        .toString()
        .replace(
          value.evidenceDigest,
          checksum('changed-second-review-evidence'),
        ),
    );
    expect(changed.byteLength).toBe(bytes.byteLength);
    writeFileSync(secondApprovalPath, changed);
    utimesSync(secondApprovalPath, before.atime, before.mtime);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    expect(() => nativeOriginReaderForOrigin(origin, scope)).toThrow(invalid);
  });

  it('selects the second exact target, scope and namespace without adopting its old writer', () => {
    install();
    const second = secondPolicy();
    installSecond(second);
    const [first, approved] = configuredNativeOriginReaders();
    expect(approved!.targetArtifactId).not.toBe(first!.targetArtifactId);
    const input: Binding = {
      ...scope,
      originReaderApprovalDigest: approved!.approvalDigest,
      artifactId: approved!.targetArtifactId,
      contextKind: 'chat',
      contextId: approved!.contextId,
      profileId: 'restricted',
      storageNamespace: approved!.storageNamespace,
    };
    expect(nativeOriginReaderForBinding(input)).toEqual(approved);
    for (const change of [
      { originReaderApprovalDigest: first!.approvalDigest },
      { artifactId: second.sourceArtifactId },
      { artifactId: first!.targetArtifactId },
      { storageNamespace: first!.storageNamespace },
      { organizationId: randomUUID() },
      { workspaceId: randomUUID() },
      { ownerId: randomUUID() },
    ])
      expect(() =>
        nativeOriginReaderForBinding({ ...input, ...change }),
      ).toThrow(invalid);
    const contextId = randomUUID();
    expect(() =>
      nativeOriginReaderForOrigin(
        { ...second.contexts[0]!.origin, contextId, rootSeed: contextId },
        scope,
      ),
    ).toThrow(invalid);
  });

  it('preserves the old all-blank configuration behavior with no second group', () => {
    for (const key of ['path', 'hash', 'storage'] as const)
      vi.stubEnv(environment[key], '  ');
    expect(configuredNativeOriginReaders()).toEqual([]);
  });

  it('rejects a second group without the complete original three inputs', () => {
    installSecond();
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each([
    ['path', ['hash', 'storage']],
    ['hash', ['path', 'storage']],
    ['storage', ['path', 'hash']],
    ['path+hash', ['storage']],
    ['path+storage', ['hash']],
    ['hash+storage', ['path']],
  ] as const)('rejects partial second configuration: %s', (_label, missing) => {
    install();
    installSecond();
    for (const key of missing) vi.stubEnv(secondEnvironment[key], undefined);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('rejects an explicitly empty second group instead of ignoring it', () => {
    install();
    for (const name of Object.values(secondEnvironment)) vi.stubEnv(name, '  ');
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each(['0', '1', '01', '02', '9', '100'])(
    'rejects indexed reader alias %s even with no original policy',
    (slot) => {
      vi.stubEnv(
        `ALLRICE_DSH_ORIGIN_READER_${slot}_APPROVAL_PATH`,
        approvalPath,
      );
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );
  it('rejects an unknown second-group field', () => {
    install();
    installSecond();
    vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_2_ALLOW_EXISTING_WRITER', '1');
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each(
    [
      'ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH_2',
      'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256_2',
      'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT_2',
      'ALLRICE_DSH_ORIGIN_READER_2APPROVAL_PATH',
      'ALLRICE_DSH_ORIGIN_READER_ALLOW_EXISTING_WRITER',
      'ALLRICE_DSH_ORIGIN_READER_',
      'ALLRICE_DSH_ORIGIN_READER_2_ALLOW_EXISTING_WRITER',
      'ALLRICE_DSH_ORIGIN_READER_9_APPROVAL_PATH',
    ].flatMap((name) =>
      ['', 'synthetic-unsupported-reader-input'].flatMap((value) =>
        (['absent', 'original', 'both'] as const).map((configuration) => ({
          name,
          value,
          configuration,
        })),
      ),
    ),
  )(
    'rejects unsupported reader key $name with value "$value" and $configuration valid configuration',
    ({ name, value, configuration }) => {
      if (configuration !== 'absent') install();
      if (configuration === 'both') installSecond();
      expect(configuredNativeOriginReaders()).toHaveLength(
        configuration === 'absent' ? 0 : configuration === 'original' ? 1 : 2,
      );
      vi.stubEnv(name, value);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
      expect(() => nativeOriginReaderForOrigin(origin, scope)).toThrow(invalid);
    },
  );

  it('allows a combined 64 contexts and rejects 65 without increasing either file limit', () => {
    install(withContexts(policy(), 32));
    const second = withContexts(secondPolicy(), 32);
    installSecond(second);
    expect(configuredNativeOriginReaders()).toHaveLength(64);
    installSecond(withContexts(second, 33));
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('applies the 256KiB limit to the actual sum of both approved files', () => {
    installBytes(paddedPolicy(policy(), 128 * 1024));
    const second = secondPolicy();
    installSecondBytes(paddedPolicy(second, 128 * 1024));
    expect(configuredNativeOriginReaders()).toHaveLength(2);
    installSecondBytes(paddedPolicy(second, 128 * 1024 + 1));
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('rejects one source split between two policies', () => {
    install();
    const second = secondPolicy();
    second.sourceArtifactId = sourceArtifactId;
    second.contexts[0]!.origin.artifactId = sourceArtifactId;
    installSecond(second);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('rejects a duplicate context across sources even with a different owner', () => {
    install();
    const second = secondPolicy();
    second.contexts[0] = {
      ...scope,
      ownerId: randomUUID(),
      origin: {
        ...second.contexts[0]!.origin,
        contextId: origin.contextId,
        rootSeed: origin.contextId,
      },
    };
    installSecond(second);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it('rejects a repeated policy/namespace/proof rather than returning duplicate approvals', () => {
    const bytes = install();
    installSecondBytes(bytes);
    vi.stubEnv(secondEnvironment.storage, storageRoot);
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each(['forward', 'reverse', 'cycle'] as const)(
    'rejects a source-target %s across the two policies',
    (kind) => {
      install();
      const second = secondPolicy();
      if (kind !== 'reverse') {
        second.sourceArtifactId = targetArtifactId;
        second.contexts[0]!.origin.artifactId = targetArtifactId;
      }
      if (kind !== 'forward') second.targetArtifactId = sourceArtifactId;
      installSecond(second);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each([
    'hash',
    'abi',
    'scope',
    'mode',
    'symlink',
    'storage-symlink',
  ] as const)(
    'does not fall back to the original reader when the second has invalid %s',
    (kind) => {
      install();
      const second = secondPolicy();
      if (kind === 'abi') second.prerequisites.modules = 'different';
      if (kind === 'scope') second.contexts[0]!.ownerId = 'not-a-uuid';
      installSecond(
        kind === 'mode'
          ? { ...second, mode: 'existing_writer_migration' }
          : second,
      );
      if (kind === 'hash')
        vi.stubEnv(secondEnvironment.hash, checksum('other-second-file'));
      if (kind === 'symlink') {
        const alias = join(directory, 'second-approval-link.json');
        symlinkSync(secondApprovalPath, alias);
        vi.stubEnv(secondEnvironment.path, alias);
      }
      if (kind === 'storage-symlink') {
        const alias = join(directory, 'second-storage-link');
        symlinkSync(secondStorageRoot, alias, 'dir');
        vi.stubEnv(secondEnvironment.storage, alias);
      }
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
      expect(() => nativeOriginReaderForOrigin(origin, scope)).toThrow(invalid);
    },
  );

  it('rejects an oversized file even with its correct byte hash', () => {
    installBytes(Buffer.alloc(256 * 1024 + 1, ' '));
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
  });

  it.each([3, 8])(
    'supports %i groups without changing either original proof, file or target',
    (count) => {
      const values = installGroups(2);
      const original = configuredNativeOriginReaders();
      const bytes = [approvalPath, secondApprovalPath].map((path) =>
        readFileSync(path),
      );
      for (let group = 3; group <= count; group++) {
        const value = groupPolicy(group);
        installGroup(group, value);
        values.push(value);
      }
      const approvals = configuredNativeOriginReaders();
      expect(approvals).toHaveLength(count);
      expect(approvals.slice(0, 2)).toEqual(original);
      expect(
        [approvalPath, secondApprovalPath].map((path) => readFileSync(path)),
      ).toEqual(bytes);
      for (const [index, value] of values.entries()) {
        const approved = approvals[index]!;
        expect(
          nativeOriginReaderForOrigin(value.contexts[0]!.origin, scope),
        ).toEqual(approved);
        const input: Binding = {
          ...scope,
          originReaderApprovalDigest: approved.approvalDigest,
          artifactId: approved.targetArtifactId,
          contextKind: 'chat',
          contextId: approved.contextId,
          profileId: 'restricted',
          storageNamespace: approved.storageNamespace,
        };
        expect(nativeOriginReaderForBinding(input)).toEqual(approved);
        expect(() =>
          nativeOriginReaderForBinding({
            ...input,
            artifactId: value.sourceArtifactId,
          }),
        ).toThrow(invalid);
      }
    },
  );

  it('allows independent sources to share an approved target', () => {
    const values = installGroups(8);
    values.forEach((value, index) => {
      value.targetArtifactId = targetArtifactId;
      installGroup(index + 1, value);
    });
    expect(
      configuredNativeOriginReaders().map((entry) => entry.targetArtifactId),
    ).toEqual(Array(8).fill(targetArtifactId));
  });

  it.each([1, 2, 4, 7])(
    'rejects a missing group %i before a later complete group',
    (gap) => {
      installGroups(8);
      const names = groupEnvironment(gap);
      for (const key of ['path', 'hash', 'storage'] as const)
        vi.stubEnv(names[key], undefined);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each([3, 8])('rejects partial or explicitly blank group %i', (group) => {
    installGroups(group - 1);
    const names = groupEnvironment(group);
    vi.stubEnv(names.path, '');
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    for (const key of ['path', 'hash', 'storage'] as const)
      vi.stubEnv(names[key], '  ');
    expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    const value = groupPolicy(group);
    for (const key of ['path', 'hash', 'storage'] as const) {
      installGroup(group, value);
      vi.stubEnv(names[key], undefined);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    }
  });

  it.each([3, 8])(
    'shares the 64-context limit across all %i groups',
    (count) => {
      const values = installGroups(count);
      installGroup(count, withContexts(values[count - 1]!, 65 - count));
      expect(configuredNativeOriginReaders()).toHaveLength(64);
      installGroup(count, withContexts(values[count - 1]!, 66 - count));
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each([3, 8])(
    'shares the 256KiB byte limit across all %i groups',
    (count) => {
      const values = installGroups(count);
      const perFile = Math.floor((256 * 1024) / count);
      values.forEach((value, index) => {
        const size =
          index === count - 1 ? 256 * 1024 - perFile * index : perFile;
        installGroup(index + 1, value, paddedPolicy(value, size));
      });
      expect(configuredNativeOriginReaders()).toHaveLength(count);
      const last = values[count - 1]!;
      installGroup(
        count,
        last,
        paddedPolicy(last, 256 * 1024 - perFile * (count - 1) + 1),
      );
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each(['source', 'context', 'repeated-policy', 'chain', 'cycle'] as const)(
    'rejects nonadjacent cross-group %s conflicts',
    (kind) => {
      const values = installGroups(8);
      const third = values[2]!;
      const last = values[7]!;
      if (kind === 'source') {
        last.sourceArtifactId = third.sourceArtifactId;
        last.contexts[0]!.origin.artifactId = third.sourceArtifactId;
      } else if (kind === 'context') {
        last.contexts[0]!.origin.contextId =
          third.contexts[0]!.origin.contextId;
        last.contexts[0]!.origin.rootSeed = third.contexts[0]!.origin.rootSeed;
      } else if (kind === 'repeated-policy') {
        installGroup(8, third);
        vi.stubEnv(
          groupEnvironment(8).storage,
          process.env[groupEnvironment(3).storage],
        );
        expect(() => configuredNativeOriginReaders()).toThrow(invalid);
        return;
      } else {
        third.targetArtifactId = last.sourceArtifactId;
        if (kind === 'cycle') last.targetArtifactId = third.sourceArtifactId;
        installGroup(3, third);
      }
      installGroup(8, last);
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
    },
  );

  it.each(['hash', 'abi', 'symlink'] as const)(
    'fails the whole configuration on invalid final-group %s',
    (kind) => {
      const values = installGroups(8);
      const names = groupEnvironment(8);
      expect(configuredNativeOriginReaders()).toHaveLength(8);
      if (kind === 'hash') {
        const path = process.env[names.path]!;
        const before = statSync(path);
        const bytes = readFileSync(path);
        const changed = Buffer.from(
          bytes
            .toString()
            .replace(
              values[7]!.evidenceDigest,
              checksum('changed-last-review'),
            ),
        );
        expect(changed.byteLength).toBe(bytes.byteLength);
        writeFileSync(path, changed);
        utimesSync(path, before.atime, before.mtime);
      } else if (kind === 'abi') {
        values[7]!.prerequisites.modules = 'different';
        installGroup(8, values[7]!);
      } else {
        const alias = join(directory, 'last-approval-alias.json');
        symlinkSync(process.env[names.path]!, alias);
        vi.stubEnv(names.path, alias);
      }
      expect(() => configuredNativeOriginReaders()).toThrow(invalid);
      expect(() => nativeOriginReaderForOrigin(origin, scope)).toThrow(invalid);
    },
  );
});
