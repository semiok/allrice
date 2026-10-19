import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  officeMediaTypes,
  type OfficeDeliveryReceipt,
} from '@allrice/contracts';
import * as client from '../../../packages/database/src/core/client.ts';
import {
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../packages/database/src/assistant-authority.fixture.ts';
import {
  getWorkbenchArtifact,
  publishWorkbenchArtifact,
  readArtifactBytes,
} from '../../../packages/database/src/artifact-review.ts';
import { inspectXlsxFormulaCaches } from '../src/office/formula-cache.js';
import { officeDeliveryReceipt } from '../src/office/delivery-receipt.js';
import { checkOfficeExport } from '../src/office/quality.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

async function workbook(cached = '') {
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
  zip.file(
    'xl/worksheets/sheet.xml',
    `<worksheet xmlns="${s}"><sheetData><row r="1"><c r="A1"><f>1+1</f>${cached}</c></row></sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

suite(
  'Office final bytes and publication receipts (isolated PostgreSQL)',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let f: Awaited<ReturnType<typeof createAssistantAuthorityFixture>>;
    let context: ReturnType<typeof ExecutionContextSchema.parse>;
    const db = () => database.db;
    const storage = () => assistantFixtureStorage(db());
    const original: OfficeDeliveryReceipt = {
      quality: {
        status: 'unavailable',
        reason: 'Original renderer unavailable',
      },
      warnings: ['Original result; no later inspection recorded'],
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(db());
      f = await createAssistantAuthorityFixture(db(), {
        memberRole: 'member',
        allowedTools: [
          'assistant.delegate',
          'assistant.report',
          'workspace.export.create',
          'workspace.document.read',
        ],
      });
      const [policy] =
        await db()`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      context = ExecutionContextSchema.parse({
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
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
      });
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
    });
    async function publish(
      bytes: Buffer,
      receipt?: OfficeDeliveryReceipt,
      options: { callId?: string; parentObjectId?: string } = {},
    ) {
      return publishWorkbenchArtifact(
        {
          context,
          sessionId: f.session,
          callId: options.callId ?? randomUUID(),
          kind: 'document',
          fileName: 'same-name.xlsx',
          format: 'xlsx',
          bytes,
          mediaType: officeMediaTypes.xlsx,
          ...(receipt ? { officeReceipt: receipt } : {}),
          ...(options.parentObjectId
            ? { parentObjectId: options.parentObjectId }
            : {}),
        },
        storage(),
        db(),
      );
    }
    async function receipts(version: string) {
      return db()`select id,metadata from allrice_audit_events where resource_id=${version}
      and action='artifact.office-quality' order by occurred_at,id`;
    }
    async function localReceipt(bytes: Buffer) {
      const checked = await checkOfficeExport(bytes, 'xlsx', {
        cloudQualityAllowed: false,
      });
      expect(checked.bytes).toEqual(bytes);
      return officeDeliveryReceipt(checked.bytes, checked);
    }
    it('persists missing cached values and local-only diagnostics for the exact saved bytes', async () => {
      const bytes = await workbook(),
        receipt = await localReceipt(bytes);
      expect(receipt.savedValues).toMatchObject({
        inspection: 'complete',
        counts: { formulaCount: 1, missingCacheCount: 1 },
      });
      expect(receipt.diagnostic).toEqual({
        stage: 'local_policy',
        code: 'cloud_quality_disallowed',
      });
      const artifact = await publish(bytes, receipt);
      expect(await readArtifactBytes(storage(), artifact.object)).toEqual(
        bytes,
      );
      expect((await receipts(artifact.id))[0]!.metadata).toEqual({
        objectId: artifact.object.id,
        checksum: artifact.object.checksum,
        runId: f.rootRunId,
        receipt,
      });
      expect(
        JSON.stringify((await receipts(artifact.id))[0]!.metadata),
      ).not.toContain('1+1');
    });
    it('retains an original unavailable receipt when a retry obtains new facts for the same bytes', async () => {
      const bytes = await workbook('<v>2</v>'),
        callId = randomUUID();
      const first = await publish(bytes, original, { callId });
      const before = await receipts(first.id);
      const replay = await publish(bytes, await localReceipt(bytes), {
        callId,
      });
      expect(replay).toMatchObject({
        id: first.id,
        officeReceiptReplayed: true,
        officeReceipt: original,
      });
      expect(await receipts(first.id)).toEqual(before);
      expect(await readArtifactBytes(storage(), replay.object)).toEqual(bytes);
    });
    it('does not fabricate missing legacy receipts on a repeated publication', async () => {
      const bytes = await workbook('<v>0</v>'),
        callId = randomUUID();
      const first = await publish(bytes, undefined, { callId });
      const replay = await publish(bytes, await localReceipt(bytes), {
        callId,
      });
      expect(replay).toMatchObject({
        id: first.id,
        officeReceiptReplayed: true,
        officeReceipt: null,
      });
      expect(await receipts(first.id)).toEqual([]);
    });
    it('rejects a receipt for other bytes before inserting storage or publication rows', async () => {
      const bytes = await workbook(),
        other = await workbook('<v>2</v>');
      const count = async () =>
        (
          await db()`select (select count(*)::int from allrice_storage_objects) objects,
      (select count(*)::int from allrice_deliverable_versions) versions,
      (select count(*)::int from allrice_audit_events where action='artifact.office-quality') receipts`
        )[0];
      const before = await count();
      await expect(publish(bytes, await localReceipt(other))).rejects.toThrow(
        'office_receipt_checksum_mismatch',
      );
      expect(await count()).toEqual(before);
    });
    it('keeps old and corrected versions, their bytes and their distinct saved-value facts', async () => {
      const oldBytes = await workbook(),
        newBytes = await workbook('<v>2</v>');
      const first = await publish(oldBytes, await localReceipt(oldBytes));
      const second = await publish(newBytes, await localReceipt(newBytes), {
        parentObjectId: first.object.id,
      });
      expect(second.version).toMatchObject({
        seriesId: first.version.seriesId,
        parentVersionId: first.id,
        version: 2,
      });
      const principal = {
        actor: { type: 'user' as const, id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
      };
      const old = await getWorkbenchArtifact(
        principal,
        f.session,
        first.id,
        db(),
      );
      expect(await readArtifactBytes(storage(), old.object)).toEqual(oldBytes);
      expect(await readArtifactBytes(storage(), second.object)).toEqual(
        newBytes,
      );
      expect(
        (await receipts(first.id))[0]!.metadata.receipt.savedValues.counts
          .missingCacheCount,
      ).toBe(1);
      expect(
        (await receipts(second.id))[0]!.metadata.receipt.savedValues.counts
          .numericCacheCount,
      ).toBe(1);
      expect(await inspectXlsxFormulaCaches(newBytes)).toMatchObject({
        inspection: 'complete',
        counts: { formulaCount: 1, numericCacheCount: 1 },
      });
      const [usage] =
        await db()`select (select count(*)::int from allrice_model_usage_ledger) models,
      (select count(*)::int from allrice_cloud_execution_attempts) clouds`;
      expect(usage).toEqual({ models: 0, clouds: 0 });
    });
  },
);
