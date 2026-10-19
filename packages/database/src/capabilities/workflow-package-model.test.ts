import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EmployeeRuntimeContentSchema,
  WorkflowDefinitionSchema,
  WorkflowPackageManifestSchema,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  readWorkflowPackageObject,
  validateWorkflowPackageDefinition,
  validateWorkflowPackageSource,
  workflowPackageBytesChecksum,
  workflowPackageMethodSync,
  workflowPackageSelectedReferences,
} from './workflow-package-model.ts';

const digest = `sha256:${'b'.repeat(64)}`;
const pin = (sourceKind: 'procedure' | 'workflow' = 'procedure') => ({
  sourceKind,
  contentId: randomUUID(),
  revisionId: randomUUID(),
  digest,
});

function fixture() {
  const definition = WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    steps: [{ key: 'plan', name: '选题', kind: 'model' }],
  });
  const body = '先读品牌资料，再给出有依据的候选。\n';
  const files = [
    { path: 'workflow.json', bytes: Buffer.from(JSON.stringify(definition)) },
    { path: 'method.md', bytes: Buffer.from(body) },
    {
      path: 'scripts/check.mjs',
      bytes: Buffer.from('export const validate = x => x;\n'),
    },
  ].map(({ path, bytes }) => ({
    path,
    contentBase64: bytes.toString('base64'),
    checksum: workflowPackageBytesChecksum(bytes),
  }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  const manifest = WorkflowPackageManifestSchema.parse({
    schemaVersion: 1,
    templateKey: 'brand-content-operations.topics',
    method: pin(),
    definitionChecksum: runtimePolicyDigest(definition),
    source: {
      objectId: randomUUID(),
      checksum: workflowPackageBytesChecksum(bytes),
    },
    files: files.map(({ path, checksum }) => ({ path, checksum })),
  });
  return { definition, body, files, bytes, manifest };
}

function snapshot() {
  const common = pin('workflow');
  const first = {
    id: randomUUID(),
    name: '选题',
    appliesWhen: '策划选题',
    references: [pin('workflow')],
  };
  const second = {
    id: randomUUID(),
    name: '成稿',
    appliesWhen: '写稿',
    references: [pin('workflow')],
  };
  const content = EmployeeRuntimeContentSchema.parse({
    schemaVersion: 1,
    instanceId: randomUUID(),
    employeeId: randomUUID(),
    employeeVersionId: randomUUID(),
    platform: { revisionId: null, digest },
    checksum: digest,
    layers: [
      {
        setId: randomUUID(),
        revisionId: randomUUID(),
        digest,
        ownership: {
          scope: 'personal',
          organizationId: randomUUID(),
          ownerId: randomUUID(),
        },
        common: [common],
        scenes: [first, second],
      },
    ],
  });
  return { common, first, second, content };
}

describe('Workflow package exact source and scene boundaries', () => {
  it('verifies real source bytes, each file, the DAG, and the exact method', () => {
    const f = fixture();
    expect(
      validateWorkflowPackageSource(f.bytes, f.manifest, f.definition, f.body)
        .files,
    ).toHaveLength(3);
    expect(
      validateWorkflowPackageDefinition(f.definition, f.manifest).definition,
    ).toEqual(f.definition);
  });

  it('refuses changed stored bytes and an altered definition', () => {
    const f = fixture();
    expect(() =>
      validateWorkflowPackageSource(
        Buffer.concat([f.bytes, Buffer.from(' ')]),
        f.manifest,
        f.definition,
        f.body,
      ),
    ).toThrow('source_changed');
    expect(() =>
      validateWorkflowPackageDefinition(
        {
          ...f.definition,
          steps: [{ ...f.definition.steps[0], name: '偷偷换步骤' }],
        },
        f.manifest,
      ),
    ).toThrow('source_changed');
  });

  it('refuses a valid archive checksum containing tampered individual files', () => {
    const f = fixture();
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        files: f.files.map((file, i) =>
          i === 2
            ? {
                ...file,
                contentBase64: Buffer.from('changed').toString('base64'),
              }
            : file,
        ),
      }),
    );
    const manifest = {
      ...f.manifest,
      source: {
        ...f.manifest.source!,
        checksum: workflowPackageBytesChecksum(bytes),
      },
    };
    expect(() =>
      validateWorkflowPackageSource(bytes, manifest, f.definition, f.body),
    ).toThrow('source_changed');
  });

  it('does not substitute a newer method or silently omit a declared file', () => {
    const f = fixture();
    expect(() =>
      validateWorkflowPackageSource(
        f.bytes,
        f.manifest,
        f.definition,
        `${f.body}新增意见`,
      ),
    ).toThrow('source_changed');
    expect(() =>
      validateWorkflowPackageSource(
        f.bytes,
        { ...f.manifest, files: f.manifest.files.slice(0, 2) },
        f.definition,
        f.body,
      ),
    ).toThrow('source_changed');
  });

  it('does not advertise scene-only workflows to an ordinary common conversation', () => {
    const f = snapshot();
    expect(workflowPackageSelectedReferences(f.content, null)).toEqual([
      f.common,
    ]);
    expect(workflowPackageSelectedReferences(f.content, f.first.id)).toEqual([
      f.common,
      ...f.first.references,
    ]);
    expect(() =>
      workflowPackageSelectedReferences(f.content, randomUUID()),
    ).toThrow('not_found');
  });

  it('rejects ambiguous pins instead of quietly choosing a method version', () => {
    const f = snapshot();
    f.content.layers[0]!.common.push({ ...f.common, revisionId: randomUUID() });
    expect(() => workflowPackageSelectedReferences(f.content, null)).toThrow(
      'source_changed',
    );
  });

  it('reports a method edit separately while retaining the original executable manifest', () => {
    const f = fixture();
    expect(
      workflowPackageMethodSync(f.manifest, [f.manifest.method], true),
    ).toBe('in_sync');
    expect(
      workflowPackageMethodSync(
        f.manifest,
        [{ ...f.manifest.method, revisionId: randomUUID() }],
        true,
      ),
    ).toBe('method_changed');
    expect(
      workflowPackageMethodSync(f.manifest, [f.manifest.method], false),
    ).toBe('source_unavailable');
  });

  it('checks actual object length/hash instead of trusting storage metadata', async () => {
    const f = fixture();
    const object = {
      id: f.manifest.source!.objectId,
      checksum: f.manifest.source!.checksum,
      sizeBytes: f.bytes.length,
    } as StorageObject;
    const storage = (bytes: Uint8Array): StoragePort => ({
      get: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      put: async () => undefined,
      delete: async () => undefined,
      exists: async () => true,
    });
    expect(
      await readWorkflowPackageObject(storage(f.bytes), object, 512_000),
    ).toEqual(f.bytes);
    await expect(
      readWorkflowPackageObject(storage(Buffer.from('wrong')), object, 512_000),
    ).rejects.toThrow('source_changed');
    await expect(
      readWorkflowPackageObject(storage(f.bytes), object, 1),
    ).rejects.toThrow('invalid_package');
  });
});
