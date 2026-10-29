import { prepareDeliveryAuthorityFixture } from './final-delivery-reference-authority.fixture.ts';
/** Real publisher -> current transaction reader -> deterministic final policy.
 * All identities/leases belong to the fixture's private UUID PostgreSQL schema.
 * No real account, renderer, native SDK, model, cloud tool or Dev is invoked. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  officeMediaTypes,
  type OfficeDeliveryReceipt,
} from '@allrice/contracts';
import * as client from '../../../packages/database/src/core/client.ts';
import {
  runtimeFixtureStorage,
  createRuntimeFixtureDatabase,
} from '../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import {
  getWorkbenchArtifact,
  publishWorkbenchArtifact,
  readArtifactBytes,
} from '../../../packages/database/src/artifact-review.ts';
import { checkOfficeExport } from '../src/office/quality.js';
import { officeDeliveryReceipt } from '../src/office/delivery-receipt.js';
import { createDeliveryMarkup } from '../src/final-delivery/markup.js';
import {
  checkFinalDelivery,
  type DeliverySnapshot,
} from '../src/final-delivery/policy.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const digest = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const evidence = process.env.ALLRICE_OFFICE_FIRST_PG_EVIDENCE;
const save = (name: string, value: unknown) => {
  if (evidence)
    writeFileSync(
      join(evidence, `${name}.json`),
      JSON.stringify(value, null, 2) + '\n',
    );
};
const facts: { name: string; detail: unknown }[] = [];
const record = (name: string, detail: unknown) => {
  facts.push({ name, detail });
  save('case-facts', facts);
};

async function workbook(kind: 'missing' | 'cached' | 'constant') {
  const zip = new JSZip();
  const s = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const r =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${s}" xmlns:r="${r}"><sheets><sheet name="Totals" sheetId="1" r:id="s1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="${r}/worksheet" Target="worksheets/sheet.xml"/></Relationships>`,
  );
  const value =
    kind === 'constant'
      ? '<v>2</v>'
      : `<f>1+1</f>${kind === 'cached' ? '<v>2</v>' : ''}`;
  zip.file(
    'xl/worksheets/sheet.xml',
    `<worksheet xmlns="${s}"><sheetData><row r="1"><c r="A1">${value}</c></row></sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
const db = () => database.db;
const storage = () => runtimeFixtureStorage(db());
async function fixture(covered = true) {
  const f = await createRunAuthorityFixture(db(), {
    memberRole: 'member',
    allowedTools: ['workspace.export.create', 'workspace.document.read'],
    snapshot: (snapshot) =>
      covered
        ? {
            ...snapshot,
            officeFirstDeliveryPolicy: 'xlsx_formula_cache_v1',
            finalDeliveryPolicy: {
              version: 1,
              mode: 'checked_native_v1',
              artifactId: 'sha256:' + 'a'.repeat(64),
            },
          }
        : snapshot,
  });
  const [policy] =
    await db()`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
  assert.ok(policy);
  const context = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: f.rootRunId,
    jobId: f.worker.jobId,
    worker: { type: 'worker', id: f.worker.workerId },
    delegatedBy: { type: 'user', id: f.user },
    organizationId: f.org,
    workspaceId: f.workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: f.policy,
      organizationId: f.org,
      subjectId: f.user,
      version: 1,
      issuedAt: policy.issued_at.toISOString(),
      expiresAt: policy.expires_at.toISOString(),
      ...policy.payload,
    },
  });
  const { port } = await prepareDeliveryAuthorityFixture(f);
  const [frozen] =
    await db()`select execution_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`;
  expect(frozen!.execution_snapshot.officeFirstDeliveryPolicy).toBe(
    covered ? 'xlsx_formula_cache_v1' : undefined,
  );
  expect(frozen!.execution_snapshot.finalDeliveryPolicy).toEqual(
    covered
      ? {
          version: 1,
          mode: 'checked_native_v1',
          artifactId: 'sha256:' + 'a'.repeat(64),
        }
      : undefined,
  );
  return {
    ...f,
    context,
    read: () => port.readSnapshot(),
    principal: {
      actor: { type: 'user' as const, id: f.user },
      organizationId: f.org,
      workspaceId: f.workspace,
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Artifact = Awaited<ReturnType<typeof publishWorkbenchArtifact>>;
const published: { f: Fixture; artifact: Artifact; bytes: Buffer }[] = [];
async function localReceipt(bytes: Buffer) {
  const checked = await checkOfficeExport(bytes, 'xlsx', {
    cloudQualityAllowed: false,
  });
  expect(checked.bytes).toEqual(bytes);
  return officeDeliveryReceipt(checked.bytes, checked);
}
async function publish(
  f: Fixture,
  bytes: Buffer,
  options: {
    receipt?: OfficeDeliveryReceipt;
    noReceipt?: boolean;
    legacyProducer?: boolean;
    parent?: Artifact;
    callId?: string;
  } = {},
) {
  const artifact = await publishWorkbenchArtifact(
    {
      context: f.context,
      sessionId: f.session,
      callId: options.callId ?? randomUUID(),
      kind: 'document',
      fileName: 'same-name.xlsx',
      format: 'xlsx',
      bytes,
      mediaType: officeMediaTypes.xlsx,
      ...(options.legacyProducer ? {} : { trustedOfficeExport: true as const }),
      ...(options.noReceipt
        ? {}
        : { officeReceipt: options.receipt ?? (await localReceipt(bytes)) }),
      ...(options.parent ? { parentObjectId: options.parent.object.id } : {}),
    },
    storage(),
    db(),
  );
  published.push({ f, artifact, bytes });
  return artifact;
}
const identity = (artifact: Artifact) => ({
  objectId: artifact.object.id,
  versionId: artifact.id,
  checksum: artifact.object.checksum,
});
const link = (artifact: Artifact) =>
  `[same-name.xlsx](/api/v1/files/${artifact.object.id}/download)`;
const markup = createDeliveryMarkup();
function decide(
  f: Fixture,
  snapshot: DeliverySnapshot,
  ...artifacts: Artifact[]
) {
  return checkFinalDelivery({
    candidate: artifacts.map(link).join('\n'),
    snapshot,
    markup,
    managedOrigins: ['https://fixture.invalid'],
    expectedScope: {
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.session,
      runId: f.rootRunId,
    },
  });
}
function checks(snapshot: DeliverySnapshot, artifact: Artifact) {
  return snapshot.checks
    .filter((check) => check.versionId === artifact.id)
    .map(({ checkId, status }) => ({ checkId, status }));
}
async function audits(artifact: Artifact) {
  return db()`select id,action,metadata from allrice_audit_events where resource_type='deliverable_version' and resource_id=${artifact.id} order by occurred_at,id`;
}
async function insertReceipt(
  f: Fixture,
  artifact: Artifact,
  metadata: unknown,
  resourceId = artifact.id,
) {
  await db()`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
    values(${f.org},${f.workspace},${f.user},'artifact.office-quality','deliverable_version',${resourceId},'recorded','actual_exporter_receipt',${db().json(metadata as Parameters<ReturnType<typeof db>['json']>[0])})`;
}
async function assertBytes(f: Fixture, artifact: Artifact, bytes: Buffer) {
  const stored = await getWorkbenchArtifact(
    f.principal,
    f.session,
    artifact.id,
    db(),
  );
  const actual = await readArtifactBytes(storage(), stored.object);
  expect(actual).toEqual(bytes);
  expect(digest(actual)).toBe(artifact.object.checksum);
  return { ...identity(artifact), readable: true, bytes: actual.byteLength };
}

suite(
  'Office first delivery: real publication and frozen cache obligations (isolated PostgreSQL)',
  () => {
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
      try {
        database = await createRuntimeFixtureDatabase();
        const [location] =
          await db()`select current_database() database,current_schema() schema`;
        assert.ok(location);
        expect(location.database).toBe(
          new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
        );
        expect(location.schema).toMatch(/^p25_[a-f0-9]{32}$/);
        const tables =
          await db()`select table_name from information_schema.tables where table_schema=current_schema()
        and table_name=any(${['allrice_users', 'allrice_runs', 'allrice_employee_runs', 'allrice_deliverable_versions', 'allrice_storage_objects', 'allrice_workbench_artifacts', 'allrice_audit_events']}::text[])`;
        expect(tables).toHaveLength(7);
        vi.spyOn(client, 'getDatabase').mockReturnValue(db());
        save('fixture', {
          database: location.database,
          schema: location.schema,
          storageRoot: database.storageRoot,
          actualPublisher: 'publishWorkbenchArtifact',
          actualAuthority: 'assertAssistantAuthority',
          actualReader: 'readDeliverySnapshot',
          actualPolicy: 'checkFinalDelivery',
          actualReferences: 'readFinalDeliveryReferences',
          modelCalls: 0,
          cloudCalls: 0,
          realAccounts: 0,
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'cleanup' in error)
          save('initialization-cleanup', error.cleanup);
        throw error;
      }
    }, 120_000);
    afterAll(async () => {
      const failures: unknown[] = [];
      try {
        if (database) {
          const versions = new Map(
            published.map((item) => [item.artifact.id, item]),
          );
          const bytes = [];
          for (const item of versions.values())
            bytes.push(await assertBytes(item.f, item.artifact, item.bytes));
          save('all-version-byte-readback', bytes);
          const [usage] =
            await db()`select (select count(*)::int from allrice_model_usage_ledger) models,
            (select count(*)::int from allrice_cloud_execution_attempts) clouds`;
          expect(usage).toEqual({ models: 0, clouds: 0 });
          save('usage', usage);
          const states =
            await db()`select j.status as job_status,r.state as run_state,count(*)::int as count
            from allrice_jobs j join allrice_runs r on r.id=j.run_id group by j.status,r.state order by j.status,r.state`;
          expect(
            states.every(
              (row) =>
                row.job_status === 'running' && row.run_state === 'running',
            ),
          ).toBe(true);
          save('publication-only-run-states', states);
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        if (database) save('cleanup', await database.close());
      } catch (error) {
        if (error && typeof error === 'object' && 'cleanup' in error)
          save('cleanup', error.cleanup);
        failures.push(error);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'office_first_quality_readback_or_cleanup_failed',
        );
    }, 30_000);

    it('retains an original formula version without caches as a real incomplete obligation', async () => {
      const f = await fixture(),
        bytes = await workbook('missing');
      const v1 = await publish(f, bytes),
        snapshot = await f.read();
      expect(snapshot.artifacts.map((artifact) => artifact.versionId)).toEqual([
        v1.id,
      ]);
      expect(snapshot.requirements).toMatchObject([
        {
          expected: identity(v1),
          requireLink: true,
          requiredChecks: ['office.saved_values', 'office.formula_errors'],
        },
      ]);
      expect(checks(snapshot, v1)).toEqual(
        expect.arrayContaining([
          { checkId: 'office.saved_values', status: 'failed' },
          { checkId: 'office.formula_errors', status: 'unavailable' },
        ]),
      );
      const decision = decide(f, snapshot, v1);
      expect(decision.status).toBe('invalid_response');
      expect(decision.issues.map((issue) => issue.code)).toContain(
        'required_check_incomplete',
      );
      expect(snapshot.qualityReceipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            producer: expect.objectContaining({
              tool: 'workspace.export.create',
            }),
          }),
        ]),
      );
      record('missing-cache-v1', {
        identity: identity(v1),
        checks: checks(snapshot, v1),
        decision,
      });
    });

    it('accepts the repaired same-series v2 alone and rejects adding a link to failed historical v1', async () => {
      const f = await fixture(),
        oldBytes = await workbook('missing'),
        newBytes = await workbook('cached');
      const v1 = await publish(f, oldBytes),
        originalAudit = await audits(v1);
      const v2 = await publish(f, newBytes, { parent: v1 }),
        snapshot = await f.read();
      expect(v2.version).toMatchObject({
        seriesId: v1.version.seriesId,
        parentVersionId: v1.id,
        version: 2,
      });
      expect(snapshot.requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            expected: identity(v2),
            requireLink: true,
          }),
          expect.objectContaining({
            expected: identity(v1),
            whenLinked: true,
            requireLink: false,
          }),
        ]),
      );
      expect(decide(f, snapshot, v2).status).toBe('valid');
      const oldLinked = decide(f, snapshot, v2, v1);
      expect(oldLinked.status).toBe('invalid_response');
      expect(oldLinked.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'required_check_incomplete',
            requirementId: expect.stringContaining(v1.id),
          }),
        ]),
      );
      expect(checks(snapshot, v1)).toContainEqual({
        checkId: 'office.saved_values',
        status: 'failed',
      });
      expect(checks(snapshot, v2)).toContainEqual({
        checkId: 'office.saved_values',
        status: 'passed',
      });
      expect(checks(snapshot, v2)).toContainEqual({
        checkId: 'office.visual',
        status: 'unavailable',
      });
      expect(await audits(v1)).toEqual(originalAudit);
      await assertBytes(f, v1, oldBytes);
      await assertBytes(f, v2, newBytes);
      record('same-series-repair', {
        v1: identity(v1),
        v2: identity(v2),
        newOnly: decide(f, snapshot, v2),
        oldLinked,
      });
    });

    it('does not let a cached, identically named other series erase the first series obligation', async () => {
      const f = await fixture(),
        v1 = await publish(f, await workbook('missing'));
      const other = await publish(f, await workbook('cached')),
        snapshot = await f.read();
      expect(other.version.fileName).toBe(v1.version.fileName);
      expect(other.version.seriesId).not.toBe(v1.version.seriesId);
      expect(
        snapshot.requirements.filter((required) => required.requireLink),
      ).toHaveLength(2);
      expect(decide(f, snapshot, other).status).toBe('invalid_response');
      expect(
        decide(f, snapshot, other, v1).issues.map((issue) => issue.code),
      ).toContain('required_check_incomplete');
      record('different-series-not-repair', {
        first: identity(v1),
        other: identity(other),
        requirements: snapshot.requirements,
      });
    });

    it('retains an existing formula obligation through a constant-only head until another formula version repairs it', async () => {
      const f = await fixture(),
        v1 = await publish(f, await workbook('missing'));
      const constants = await publish(f, await workbook('constant'), {
        parent: v1,
      });
      const incomplete = await f.read();
      expect(incomplete.requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            expected: identity(constants),
            requireLink: true,
          }),
        ]),
      );
      expect(decide(f, incomplete, constants).status).toBe('invalid_response');
      expect(checks(incomplete, constants)).toContainEqual({
        checkId: 'office.saved_values',
        status: 'not_checked',
      });
      const repaired = await publish(f, await workbook('cached'), {
        parent: constants,
      });
      const complete = await f.read();
      expect(repaired.version).toMatchObject({
        version: 3,
        seriesId: v1.version.seriesId,
        parentVersionId: constants.id,
      });
      expect(decide(f, complete, repaired).status).toBe('valid');
      expect(decide(f, complete, repaired, constants).status).toBe(
        'invalid_response',
      );
      record('constants-do-not-clear-formulas', {
        constants: identity(constants),
        repaired: identity(repaired),
        incompleteChecks: checks(incomplete, constants),
      });
    });

    it('treats an initial zero-formula file as not applicable, without recording a passed formula check', async () => {
      const f = await fixture(),
        artifact = await publish(f, await workbook('constant')),
        snapshot = await f.read();
      expect(snapshot.requirements).toEqual([]);
      expect(checks(snapshot, artifact)).toEqual(
        expect.arrayContaining([
          { checkId: 'office.saved_values', status: 'not_checked' },
          { checkId: 'office.formula_errors', status: 'not_checked' },
        ]),
      );
      expect(decide(f, snapshot, artifact).status).toBe('valid');
      record('initial-zero-formula-not-business-pass', {
        identity: identity(artifact),
        checks: checks(snapshot, artifact),
      });
    });

    it('does not omit a canonical producer when its quality receipt is absent', async () => {
      const f = await fixture(),
        artifact = await publish(f, await workbook('cached'), {
          noReceipt: true,
        });
      const snapshot = await f.read();
      expect(snapshot.requirements).toMatchObject([
        { expected: identity(artifact), requireLink: true },
      ]);
      expect(snapshot.qualityReceipts).toEqual([
        expect.objectContaining({
          receipt: null,
          producer: expect.objectContaining({
            tool: 'workspace.export.create',
          }),
        }),
      ]);
      expect(decide(f, snapshot, artifact).status).toBe('invalid_response');
      record('producer-without-quality', {
        identity: identity(artifact),
        requirements: snapshot.requirements,
        checks: checks(snapshot, artifact),
      });
    });

    it.each([
      'objectId',
      'checksum',
      'runId',
      'resourceVersion',
      'savedChecksum',
      'format',
      'malformed',
    ] as const)(
      'does not accept a quality receipt with a forged %s binding',
      async (field) => {
        const f = await fixture(),
          bytes = await workbook('cached');
        const artifact = await publish(f, bytes, { noReceipt: true });
        const receipt = await localReceipt(bytes);
        const metadata: Record<string, unknown> = {
          objectId: artifact.object.id,
          checksum: artifact.object.checksum,
          runId: f.rootRunId,
          receipt,
        };
        if (field === 'objectId' || field === 'runId')
          metadata[field] = randomUUID();
        if (field === 'checksum')
          metadata.checksum = 'sha256:' + 'f'.repeat(64);
        if (field === 'savedChecksum')
          metadata.receipt = {
            ...receipt,
            savedValues: {
              ...receipt.savedValues!,
              checksum: 'sha256:' + 'e'.repeat(64),
            },
          };
        if (field === 'format')
          metadata.receipt = {
            ...receipt,
            quality: {
              status: 'checked',
              format: 'docx',
              pageCount: 1,
              formulaCount: 1,
              formulaErrorCount: 0,
              layout: 'rendered_not_visually_reviewed',
            },
          };
        if (field === 'malformed') metadata.receipt = 'not-a-receipt';
        await insertReceipt(
          f,
          artifact,
          metadata,
          field === 'resourceVersion' ? randomUUID() : artifact.id,
        );
        const snapshot = await f.read();
        expect(snapshot.requirements).toMatchObject([
          { expected: identity(artifact) },
        ]);
        expect(
          checks(snapshot, artifact).some((check) => check.status === 'passed'),
        ).toBe(false);
        expect(decide(f, snapshot, artifact).status).toBe('invalid_response');
        record('forged-quality-' + field, {
          identity: identity(artifact),
          checks: checks(snapshot, artifact),
        });
      },
    );

    it.each(['callId', 'objectId', 'checksum', 'runId', 'sessionId'] as const)(
      'rejects a malformed canonical producer %s instead of dropping the output',
      async (field) => {
        const f = await fixture(),
          artifact = await publish(f, await workbook('cached'));
        const publishedAudit = (await audits(artifact)).find(
          (audit) => audit.action === 'artifact.published',
        )!;
        const metadata = structuredClone(publishedAudit.metadata);
        if (field === 'callId' || field === 'objectId')
          metadata.officeExport[field] = randomUUID();
        else
          metadata[field] =
            field === 'checksum' ? 'sha256:' + 'f'.repeat(64) : randomUUID();
        await db()`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${f.org},${f.workspace},${f.user},'artifact.published','deliverable_version',${artifact.id},'recorded','immutable_version',${db().json(metadata)})`;
        await expect(f.read()).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
        record('malformed-producer-' + field, {
          identity: identity(artifact),
          readerRejected: true,
        });
      },
    );

    it('rejects an exact receipt checksum mismatch before any object, version or audit insertion', async () => {
      const f = await fixture(),
        bytes = await workbook('missing'),
        other = await workbook('cached');
      const count = async () =>
        (
          await db()`select (select count(*)::int from allrice_storage_objects) objects,
      (select count(*)::int from allrice_deliverable_versions) versions,(select count(*)::int from allrice_audit_events) audits`
        )[0];
      const before = await count();
      await expect(
        publish(f, bytes, { receipt: await localReceipt(other) }),
      ).rejects.toThrow('office_receipt_checksum_mismatch');
      expect(await count()).toEqual(before);
      record('prewrite-receipt-checksum-binding', { before, unchanged: true });
    });

    it('keeps the original unavailable receipt on replay even when a retry obtains cache facts', async () => {
      const f = await fixture(),
        bytes = await workbook('cached'),
        callId = randomUUID();
      const original: OfficeDeliveryReceipt = {
        quality: {
          status: 'unavailable',
          reason: 'Original unavailable receipt',
        },
        warnings: ['No saved-byte inspection was recorded'],
      };
      const first = await publish(f, bytes, { callId, receipt: original }),
        before = await audits(first);
      const replay = await publish(f, bytes, { callId });
      expect(replay).toMatchObject({
        id: first.id,
        officeReceiptReplayed: true,
        officeReceipt: original,
      });
      expect(await audits(first)).toEqual(before);
      const snapshot = await f.read();
      expect(decide(f, snapshot, first).status).toBe('invalid_response');
      record('unavailable-replay-no-upgrade', {
        identity: identity(first),
        auditRowsUnchanged: true,
        checks: checks(snapshot, first),
      });
    });

    it('does not backfill a missing original receipt on a canonical producer replay', async () => {
      const f = await fixture(),
        bytes = await workbook('cached'),
        callId = randomUUID();
      const first = await publish(f, bytes, { callId, noReceipt: true }),
        before = await audits(first);
      const replay = await publish(f, bytes, { callId });
      expect(replay).toMatchObject({
        id: first.id,
        officeReceiptReplayed: true,
        officeReceipt: null,
      });
      expect(await audits(first)).toEqual(before);
      const snapshot = await f.read();
      expect(decide(f, snapshot, first).status).toBe('invalid_response');
      record('missing-receipt-replay-no-backfill', {
        identity: identity(first),
        auditRowsUnchanged: true,
        requirements: snapshot.requirements,
      });
    });

    it.each([false, true])(
      'does not add a producer stamp or quality receipt to a legacy replay (covered=%s)',
      async (covered) => {
        const f = await fixture(covered),
          bytes = await workbook('cached'),
          callId = randomUUID();
        const first = await publish(f, bytes, {
            callId,
            legacyProducer: true,
            noReceipt: true,
          }),
          before = await audits(first);
        const replay = await publish(f, bytes, { callId });
        expect(replay).toMatchObject({
          id: first.id,
          officeReceiptReplayed: true,
          officeReceipt: null,
        });
        expect(await audits(first)).toEqual(before);
        expect(
          before.every(
            (audit) => !Object.hasOwn(audit.metadata, 'officeExport'),
          ),
        ).toBe(true);
        if (covered)
          await expect(f.read()).rejects.toThrow(
            'final_delivery_evidence_unavailable',
          );
        else {
          const snapshot = await f.read();
          expect(snapshot.requirements).toEqual([]);
          expect(
            checks(snapshot, first).every((check) => check.status !== 'passed'),
          ).toBe(true);
          expect(decide(f, snapshot, first).status).toBe('valid');
        }
        record('legacy-replay-' + covered, {
          identity: identity(first),
          covered,
          auditRowsUnchanged: true,
        });
      },
    );

    it.runIf(
      Boolean(
        process.env.ALLRICE_OFFICE_FIRST_ORIGINAL_V1 &&
        process.env.ALLRICE_OFFICE_FIRST_ORIGINAL_V2,
      ),
    )(
      'reads retained finance bytes through an isolated synthetic version chain (data-only, no original model-success claim)',
      async () => {
        const oldBytes = readFileSync(
          process.env.ALLRICE_OFFICE_FIRST_ORIGINAL_V1!,
        );
        const newBytes = readFileSync(
          process.env.ALLRICE_OFFICE_FIRST_ORIGINAL_V2!,
        );
        expect(digest(oldBytes)).toBe(
          'sha256:d3231d33dbe14d3d06144d7950b1c3fd1e287fcf1ce8b6d08964ff532dc28a53',
        );
        expect(digest(newBytes)).toBe(
          'sha256:660c750df620972051072c2f30b91e87c2dcd5171450c9d455ea9893194f84dc',
        );
        const f = await fixture(),
          original = await localReceipt(oldBytes),
          good = await localReceipt(newBytes);
        expect(original.savedValues).toMatchObject({
          inspection: 'complete',
          counts: { formulaCount: 372, missingCacheCount: 372 },
        });
        expect(good.savedValues).toMatchObject({
          inspection: 'complete',
          counts: {
            formulaCount: 372,
            missingCacheCount: 0,
            numericCacheCount: 313,
            stringCacheCount: 59,
          },
        });
        const v1 = await publish(f, oldBytes, { receipt: original }),
          first = await f.read();
        expect(decide(f, first, v1).status).toBe('invalid_response');
        const v2 = await publish(f, newBytes, { parent: v1, receipt: good }),
          second = await f.read();
        expect(decide(f, second, v2).status).toBe('valid');
        expect(decide(f, second, v2, v1).status).toBe('invalid_response');
        await assertBytes(f, v1, oldBytes);
        await assertBytes(f, v2, newBytes);
        expect(
          digest(readFileSync(process.env.ALLRICE_OFFICE_FIRST_ORIGINAL_V1!)),
        ).toBe(digest(oldBytes));
        expect(
          digest(readFileSync(process.env.ALLRICE_OFFICE_FIRST_ORIGINAL_V2!)),
        ).toBe(digest(newBytes));
        record('retained-finance-data-only', {
          v1: identity(v1),
          v2: identity(v2),
          originalCounts: original.savedValues,
          positiveCounts: good.savedValues,
          originalFilesUnchanged: true,
          originalRunModified: false,
          changedInputV2IsNotOriginalModelSuccess: true,
        });
      },
    );
  },
);
