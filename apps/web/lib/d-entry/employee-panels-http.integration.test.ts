import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { DataAccessError, type BuiltinModuleId } from '@allrice/database';
import * as database from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import { employeeManifest } from '../../../../packages/database/src/employees/employee-config.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../../../../packages/database/src/reference-processing.ts';
import { referenceLibraryOptions } from '../../../../packages/database/src/reference-library.ts';
import { createEmployeePanelsHandlers } from './employee-panels-http';
import { employeePanelsDependencies } from './employee-panels-context';
import {
  createEmployeePanelsHttpClient,
  readEmployeePanelsWriteReceipt,
  EmployeePanelsWriteUnknownError,
} from '../chatflow/employee-panel-data-http';
import { ReferenceSelectionUnavailableError } from '../chatflow/reference-selection';

// Next's request-local Cookie carrier is replaced, not authentication. The
// real production session adapter, opaque token and current DB readers run.
const cookieBridge = vi.hoisted(() => ({ read: (): string => '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get(name: string) {
      const part = cookieBridge
        .read()
        .split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(name + '='));
      return part ? { value: part.slice(name.length + 1) } : undefined;
    },
  }),
}));
const cookieScope = new AsyncLocalStorage<string>();
cookieBridge.read = () => cookieScope.getStore() ?? '';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'Cookie authenticated n4 panel HTTP with real PostgreSQL and immutable storage',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let server: ReturnType<typeof createServer>, base: string;
    let handlers: ReturnType<typeof createEmployeePanelsHandlers>;
    const running = new Set<Promise<void>>();
    const routeNames: Record<
      string,
      keyof ReturnType<typeof createEmployeePanelsHandlers>
    > = {
      'GET materials': 'queryMaterials',
      'GET materials/options': 'publicationOptions',
      'GET materials/revisions/:revisionId/selection': 'selectMaterial',
      'GET materials/revisions/:revisionId/preview': 'previewMaterial',
      'GET materials/revisions/:revisionId/download': 'downloadMaterial',
      'POST materials/publications': 'publish',
      'POST materials/publications/:sourceId': 'changePublication',
      'POST materials/sources/:sourceId': 'changeSource',
      'GET deliverables': 'listDeliverables',
      'POST deliverables': 'uploadDeliverable',
      'POST deliverables/:objectId/reference': 'captureReference',
      'GET materials/revisions/:revisionId': 'readPreparedReference',
      'PUT deliverables/:objectId/favorite': 'favorite',
      'GET deliverables/:objectId/preview': 'previewDeliverable',
      'GET deliverables/:objectId/download': 'downloadDeliverable',
      'GET write-receipts/:requestId': 'readWriteReceipt',
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_LOCAL_PORTAL', 'unified');
      f = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
      handlers = createEmployeePanelsHandlers({
        ...employeePanelsDependencies,
        storage: () => runtimeFixtureStorage(f.db),
      });
      server = createServer((incoming, outgoing) => {
        const work = cookieScope.run(
          incoming.headers.cookie ?? '',
          async () => {
            const stop = new AbortController();
            incoming.once('aborted', () =>
              stop.abort(Error('client disconnected')),
            );
            outgoing.once('close', () => {
              if (!outgoing.writableFinished)
                stop.abort(Error('client disconnected'));
            });
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers))
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(',') : value,
                );
            const request = new Request(base + incoming.url, {
              method: incoming.method,
              headers,
              ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
              signal: stop.signal,
            });
            const pieces = new URL(request.url).pathname.split('/').slice(5);
            const panelEmployeeInstanceId = pieces.shift()!;
            const parts = pieces.map((part, index) =>
              index === 2 &&
              pieces[0] === 'materials' &&
              pieces[1] === 'revisions'
                ? ':revisionId'
                : index === 2 &&
                    pieces[0] === 'materials' &&
                    ['publications', 'sources'].includes(pieces[1]!)
                  ? ':sourceId'
                  : index === 1 && pieces[0] === 'deliverables'
                    ? ':objectId'
                    : index === 1 && pieces[0] === 'write-receipts'
                      ? ':requestId'
                      : part,
            );
            const name = routeNames[`${incoming.method} ${parts.join('/')}`];
            if (!name) {
              outgoing.writeHead(404).end();
              return;
            }
            const params: {
              panelEmployeeInstanceId: string;
              revisionId?: string;
              sourceId?: string;
              objectId?: string;
              requestId?: string;
            } = { panelEmployeeInstanceId };
            parts.forEach((part, index) => {
              if (part === ':revisionId') params.revisionId = pieces[index];
              if (part === ':sourceId') params.sourceId = pieces[index];
              if (part === ':objectId') params.objectId = pieces[index];
              if (part === ':requestId') params.requestId = pieces[index];
            });
            const response = await handlers[name](request, {
              params: Promise.resolve(params),
            });
            outgoing.writeHead(
              response.status,
              Object.fromEntries(response.headers),
            );
            if (response.body) {
              const reader = response.body.getReader();
              try {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  if (!outgoing.write(chunk.value))
                    await once(outgoing, 'drain');
                }
              } finally {
                await reader.cancel();
                reader.releaseLock();
              }
            }
            outgoing.end();
          },
        );
        running.add(work);
        void work
          .catch((error: unknown) =>
            outgoing.destroy(
              error instanceof Error ? error : Error('response failed'),
            ),
          )
          .finally(() => running.delete(work));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('test listener missing');
      base = `http://127.0.0.1:${address.port}`;
    }, 120000);
    afterAll(async () => {
      await Promise.allSettled([...running]);
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (f) await f.close();
    }, 30000);
    async function person(role: 'admin' | 'viewer' = 'admin') {
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'panel-' + randomUUID(),
          organizationName: 'Panel company',
          workspaceSlug: 'default',
          workspaceName: 'Panel workspace',
          email: randomUUID() + '@example.test',
          displayName: 'Panel owner',
          role,
        },
        f.db,
      );
      const login = await createSession(p.user.id),
        context = await authenticateSession(login.token, {
          organizationId: p.organizationId,
          workspaceId: p.workspaceId,
        });
      if (!context) throw Error('test login failed');
      const employeeId = randomUUID(),
        versionId = randomUUID(),
        assignmentId = randomUUID();
      const manifest = employeeManifest({
        key: 'panels',
        name: 'Panels',
        description: 'Ordinary file management; no execution',
        toolNames: [],
      });
      await f.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
      values(${employeeId},${p.organizationId},${p.workspaceId},'panels','Panels')`;
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      values(${versionId},${p.organizationId},${p.workspaceId},${employeeId},1,'Panels',${manifest.provider.model},${manifest.systemPrompt},${f.db.json(manifest.capabilities)},${'sha256:' + 'a'.repeat(64)},${f.db.json(manifest)},${f.db.json(manifest.provider)})`;
      await f.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
      values(${assignmentId},${p.organizationId},${p.workspaceId},${employeeId},${versionId},${p.user.id})`;
      await ensureGeneralEmployeeInstance(f.db, assignmentId);
      const selection = {
        workspaceId: p.workspaceId,
        employeeInstanceId: assignmentId,
      };
      const fetcher: typeof fetch = (path, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('Cookie', 'allrice_session=' + login.token);
        if (!headers.has('Origin')) headers.set('Origin', base);
        headers.set('Connection', 'close');
        return fetch(new URL(String(path), base), { ...init, headers });
      };
      const options = { fetch: fetcher, expectedViewerId: p.user.id };
      return {
        context,
        login,
        selection,
        options,
        client: createEmployeePanelsHttpClient(selection, options),
        employeeId,
        versionId,
      };
    }
    async function release(...people: Awaited<ReturnType<typeof person>>[]) {
      const policy = {
        revision: randomUUID(),
        defaultGeneration: '3.x',
        selections: people.map((p) => ({
          organizationId: p.context.organizationId,
          personId: p.context.actor.id,
          employeeInstanceId: p.selection.employeeInstanceId,
          generation: '4.0',
        })),
      };
      await f.db`insert into allrice_settings(scope_type,key,value) values('system','d_entry_rollout_policy',${f.db.json(policy)})
      on conflict(scope_type,scope_id,key) do update set value=excluded.value`;
    }
    const signal = () => new AbortController().signal;
    function uploadInput(
      p: Awaited<ReturnType<typeof person>>,
      name = '同名.txt',
      text = '收款口径。\n中文第二行。',
    ) {
      return {
        workspaceId: p.selection.workspaceId,
        requestId: randomUUID(),
        fileName: name,
        mediaType: 'text/plain',
        contentBase64: Buffer.from(text).toString('base64'),
      };
    }
    async function processed(revisionId: string, text: string) {
      await f.db`update allrice_knowledge_processing set updated_at='2000-01-01' where revision_id=${revisionId}`;
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(revisionId);
      if (!claim) throw Error('claim missing');
      await finishReferenceProcessing(
        claim,
        [{ content: text, start: 0, end: text.length }],
        {
          text,
          kind: 'text',
          warnings: [],
          units: [{ label: '正文', start: 0, end: text.length }],
        },
      );
    }
    async function raw(
      p: Awaited<ReturnType<typeof person>>,
      path: string,
      init: RequestInit = {},
    ) {
      return p.options.fetch(
        `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}${path}?workspaceId=${p.selection.workspaceId}`,
        init,
      );
    }
    it('uploads independent same-name files, favorites all employees, publishes a fixed copy and rejects its exact selection after revoke without B/MCP/VM', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        first = await p.client.uploadDeliverable(input, signal());
      const replay = await p.client.uploadDeliverable(input, signal());
      expect(replay).toEqual(first);
      const second = await p.client.uploadDeliverable(
        { ...input, requestId: randomUUID() },
        signal(),
      );
      expect(second.objectId).not.toBe(first.objectId);
      const list = await p.client.listDeliverables(
        { workspaceId: p.selection.workspaceId, category: 'upload' },
        signal(),
      );
      expect(list.viewerId).toBe(p.context.actor.id);
      expect(list.files.map((file) => file.fileName).sort()).toEqual([
        '同名 (2).txt',
        '同名.txt',
      ]);
      expect(list.quotableFileIds.sort()).toEqual(
        [first.objectId, second.objectId].sort(),
      );
      expect(
        await p.client.favorite(
          {
            workspaceId: p.selection.workspaceId,
            objectId: first.objectId,
            body: { favorite: true },
          },
          signal(),
        ),
      ).toEqual({
        viewerId: p.context.actor.id,
        objectId: first.objectId,
        favorite: true,
      });
      expect(
        (
          await p.client.listDeliverables(
            { workspaceId: p.selection.workspaceId, category: 'favorite' },
            signal(),
          )
        ).files.map((file) => file.objectId),
      ).toEqual([first.objectId]);
      const requestId = randomUUID(),
        published = await p.client.publishFile(
          {
            origin: 'file',
            workspaceId: p.selection.workspaceId,
            objectId: first.objectId,
            requestId,
            purpose: '固定资料',
            audience: { scope: 'personal', departmentIds: [] },
          },
          signal(),
        );
      const text = Buffer.from(input.contentBase64, 'base64').toString();
      await processed(published.revisionId, text);
      const selected = await p.client.selectMaterial(
        {
          workspaceId: p.selection.workspaceId,
          revisionId: published.revisionId,
        },
        signal(),
      );
      expect(selected.selection.revisionId).toBe(published.revisionId);
      const downloaded = await p.client.downloadMaterial(
        {
          workspaceId: p.selection.workspaceId,
          revisionId: published.revisionId,
        },
        signal(),
      );
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(
        Buffer.from(input.contentBase64, 'base64'),
      );
      const fixed = await p.client.queryMaterials(
        { workspaceId: p.selection.workspaceId, query: { query: '收款' } },
        signal(),
      );
      expect(fixed.references.map((value) => value.revisionId)).toContain(
        published.revisionId,
      );
      expect(fixed.fullTextCoverage.ready).toBeGreaterThan(0);
      const current = fixed.references.find(
        (reference) => reference.revisionId === published.revisionId,
      )!;
      await p.client.changePublication(
        {
          sourceId: published.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            expectedRevision: current.publication!.audienceRevision,
            action: 'revoke',
          },
        },
        signal(),
      );
      await expect(
        p.client.selectMaterial(
          {
            workspaceId: p.selection.workspaceId,
            revisionId: published.revisionId,
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(ReferenceSelectionUnavailableError);
      expect(
        (
          await p.client.listDeliverables(
            { workspaceId: p.selection.workspaceId },
            signal(),
          )
        ).files,
      ).toHaveLength(2);
      expect(
        await f.db`select id from allrice_runs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_jobs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
    });
    it('captures a personal exact reference before processing and returns its exact pending/prepared identity', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        file = await p.client.uploadDeliverable(input, signal());
      const captured = await p.client.captureReference(
        {
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          requestId: randomUUID(),
        },
        signal(),
      );
      expect(captured.reference.processing).toBe('saved');
      expect(captured.reference.checksum).toBe(
        'sha256:' +
          createHash('sha256')
            .update(Buffer.from(input.contentBase64, 'base64'))
            .digest('hex'),
      );
      expect(
        await p.client.readPreparedReference(
          {
            workspaceId: p.selection.workspaceId,
            sourceId: captured.reference.sourceId,
            revisionId: captured.reference.revisionId,
          },
          signal(),
        ),
      ).toEqual(captured.reference);
      await expect(
        p.client.readPreparedReference(
          {
            workspaceId: p.selection.workspaceId,
            sourceId: randomUUID(),
            revisionId: captured.reference.revisionId,
          },
          signal(),
        ),
      ).rejects.toThrow();
    });
    it('exposes real original-key receipts and leaves missing receipts unknown without writing', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        object = await p.client.uploadDeliverable(input, signal());
      const receipt = await readEmployeePanelsWriteReceipt(
        p.selection,
        {
          workspaceId: p.selection.workspaceId,
          requestId: input.requestId,
          operation: 'upload',
        },
        signal(),
        p.options,
      );
      expect(receipt).toMatchObject({
        status: 'recorded',
        ready: true,
        result: object,
      });
      const before =
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`;
      const unknown = await readEmployeePanelsWriteReceipt(
        p.selection,
        {
          workspaceId: p.selection.workspaceId,
          requestId: randomUUID(),
          operation: 'upload',
        },
        signal(),
        p.options,
      );
      expect(unknown).toMatchObject({
        status: 'unknown',
        result: null,
        ready: null,
        inputDigest: null,
      });
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`,
      ).toEqual(before);
    });
    it('reads fixed previews, source pages and complete file downloads from owner names and bytes', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        file = await p.client.uploadDeliverable(input, signal());
      const preview = await p.client.previewDeliverable(
        {
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          fileName: 'forged.pdf',
        },
        signal(),
      );
      expect(preview).toMatchObject({
        kind: 'text',
        text: '收款口径。\n中文第二行。',
        offset: 1,
      });
      const page = await p.client.previewDeliverable(
        {
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          fileName: 'ignored',
          source: true,
          offset: 2,
        },
        signal(),
      );
      expect(page).toMatchObject({
        kind: 'text',
        text: '中文第二行。',
        offset: 2,
        eof: true,
      });
      const bytes = await p.client.downloadDeliverable(
        { workspaceId: p.selection.workspaceId, objectId: file.objectId },
        signal(),
      );
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(
        Buffer.from(input.contentBase64, 'base64'),
      );
    });
    it('offers every active company department for personal and department publishers without widening maintenance options', async () => {
      for (const level of ['personal', 'department'] as const) {
        const p = await person();
        await release(p);
        const a = randomUUID(),
          b = randomUUID(),
          archived = randomUUID();
        for (const [id, name] of [
          [a, 'A'],
          [b, 'B'],
          [archived, 'Old'],
        ])
          await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name,archived_at)
            values(${id!},${p.context.organizationId},${name!},${randomUUID()},${name!},${id === archived ? new Date() : null})`;
        await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,department_id,content_maintenance_level)
          values(${p.context.organizationId},${p.context.actor.id},'Publisher',${a},${level})
          on conflict(organization_id,user_id) do update set department_id=excluded.department_id,content_maintenance_level=excluded.content_maintenance_level`;
        const maintenance = await referenceLibraryOptions(
          p.context,
          p.selection.workspaceId,
        );
        expect(
          maintenance.departments.map((department) => department.id),
        ).toEqual([a]);
        const options = await p.client.publicationOptions(
          { workspaceId: p.selection.workspaceId },
          signal(),
        );
        expect(options.viewerId).toBe(p.context.actor.id);
        expect(options.options).toMatchObject({
          writable: true,
          maintenanceLevel: level,
          departmentId: a,
        });
        expect(
          options.options.departments.map((department) => department.id),
        ).toEqual([a, b]);
        const published = await p.client.publishUpload(
          {
            ...uploadInput(p, '跨部门.txt'),
            origin: 'upload',
            purpose: '发布到B',
            audience: { scope: 'departments', departmentIds: [b] },
          },
          signal(),
        );
        const query = await p.client.queryMaterials(
          {
            workspaceId: p.selection.workspaceId,
            query: { sourceId: published.sourceId },
          },
          signal(),
        );
        expect(query.options.departments).toEqual(options.options.departments);
        expect(query.references[0]?.publication?.audience).toEqual({
          scope: 'departments',
          departmentIds: [b],
        });
        expect(
          await f.db`select id from allrice_runs where organization_id=${p.context.organizationId}`,
        ).toHaveLength(0);
      }
    });
    it('publishes an upload, returns true options/current viewer and preserves metadata CAS and retry', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p, '资料.txt');
      const value = {
        origin: 'upload' as const,
        ...input,
        purpose: '原用途',
        audience: { scope: 'personal' as const, departmentIds: [] },
      };
      const saved = await p.client.publishUpload(value, signal());
      const options = await p.client.publicationOptions(
        { workspaceId: p.selection.workspaceId },
        signal(),
      );
      expect(options.viewerId).toBe(p.context.actor.id);
      expect(options.options.workspaceId).toBe(p.selection.workspaceId);
      const query = await p.client.queryMaterials(
        {
          workspaceId: p.selection.workspaceId,
          query: { sourceId: saved.sourceId },
        },
        signal(),
      );
      const revision = query.references[0]!;
      await p.client.changePublication(
        {
          sourceId: saved.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            action: 'edit',
            expectedRevision: revision.publication!.audienceRevision,
            purpose: '新用途',
            audience: value.audience,
          },
        },
        signal(),
      );
      expect(
        (
          await p.client.queryMaterials(
            {
              workspaceId: p.selection.workspaceId,
              query: { sourceId: saved.sourceId },
            },
            signal(),
          )
        ).references[0]!.purpose,
      ).toBe('新用途');
      await expect(
        p.client.changePublication(
          {
            sourceId: saved.sourceId,
            body: {
              workspaceId: p.selection.workspaceId,
              requestId: randomUUID(),
              action: 'edit',
              expectedRevision: revision.publication!.audienceRevision,
              purpose: '过期用途',
              audience: value.audience,
            },
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
      await f.db`update allrice_knowledge_processing set state='failed',failure='synthetic failure' where revision_id=${saved.revisionId}`;
      await p.client.changeSource(
        {
          sourceId: saved.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            expectedRevision: revision.revision,
            action: 'retry',
          },
        },
        signal(),
      );
      expect(
        (
          await p.client.readPreparedReference(
            { workspaceId: p.selection.workspaceId, ...saved },
            signal(),
          )
        ).processing,
      ).toBe('saved');
      const preview = await p.client.previewMaterial(
        { workspaceId: p.selection.workspaceId, revisionId: saved.revisionId },
        signal(),
      );
      expect(preview).toMatchObject({ kind: 'text' });
    });
    it('uses the application all-enabled policy without B, Run, VM or old module binding and ignores browser release claims', async () => {
      const p = await person();
      await release(p);
      expect(
        await f.db`select module_id from allrice_employee_module_bindings where instance_id=${p.selection.employeeInstanceId}`,
      ).toEqual([]);
      const headers = {
        'x-allrice-release-sha': 'f'.repeat(40),
        'x-allrice-builtin-modules': 'none',
        'x-allrice-module-enabled': 'false',
      };
      const listing = await raw(p, '/deliverables', { headers });
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({
        viewerId: p.context.actor.id,
        files: [],
      });
      const object = await p.client.uploadDeliverable(uploadInput(p), signal());
      // Adversarial old carrier rows are not the newly approved builtin policy.
      for (const moduleId of ['deliverables', 'enterprise-materials'])
        await f.db`insert into allrice_employee_module_bindings
          (organization_id,workspace_id,owner_id,instance_id,module_id,contract_version,content_version,digest,enabled_at,revoked_at)
          values(${p.context.organizationId},${p.selection.workspaceId},${p.context.actor.id},${p.selection.employeeInstanceId},${moduleId},1,'0.0.0',${'sha256:' + '0'.repeat(64)},'2000-01-01','2000-01-02')`;
      const published = await p.client.publishFile(
        {
          origin: 'file',
          workspaceId: p.selection.workspaceId,
          objectId: object.objectId,
          requestId: randomUUID(),
          purpose: '',
          audience: { scope: 'personal', departmentIds: [] },
        },
        signal(),
      );
      expect(
        (
          await p.client.queryMaterials(
            {
              workspaceId: p.selection.workspaceId,
              query: { sourceId: published.sourceId },
            },
            signal(),
          )
        ).references[0]?.sourceId,
      ).toBe(published.sourceId);
      const before =
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id} order by id`;
      const forged = await raw(p, '/deliverables', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...uploadInput(p),
          applicationBuild: { sourceSha: 'a'.repeat(40) },
          builtinModules: { deliverables: true },
        }),
      });
      expect(forged.status).toBe(400);
      await forged.text();
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id} order by id`,
      ).toEqual(before);
      expect(
        await f.db`select id from allrice_runs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_jobs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
      await f.db`update allrice_memberships set active=false where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
      const denied = await raw(p, '/deliverables', {
        headers: { ...headers, 'x-allrice-builtin-modules': 'all-enabled' },
      });
      expect([401, 403]).toContain(denied.status);
      await denied.text();
    });
    it('checks each Port named authority independently and both modules for a file-origin publication', async () => {
      const p = await person();
      await release(p);
      const platform = employeePanelsDependencies.builtinModules;
      let blocked: BuiltinModuleId | null = 'enterprise-materials';
      const checked: BuiltinModuleId[] = [];
      handlers = createEmployeePanelsHandlers({
        ...employeePanelsDependencies,
        storage: () => runtimeFixtureStorage(f.db),
        builtinModules: {
          async require(input, currentSignal) {
            checked.push(input.moduleId);
            expect(input.context.actor.id).toBe(p.context.actor.id);
            expect(input.identity).toMatchObject({
              personId: p.context.actor.id,
              organizationId: p.context.organizationId,
              employeeInstanceId: p.selection.employeeInstanceId,
            });
            await platform.require(input, currentSignal);
            if (input.moduleId === blocked)
              throw new DataAccessError('authorization_denied');
          },
        },
      });
      try {
        const file = await p.client.uploadDeliverable(uploadInput(p), signal());
        expect(new Set(checked)).toEqual(new Set(['deliverables']));
        const denied = await raw(p, '/materials/options');
        expect(denied.status).toBe(403);
        await denied.text();
        blocked = null;
        checked.length = 0;
        const publication = {
          origin: 'file' as const,
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          requestId: randomUUID(),
          purpose: '',
          audience: { scope: 'personal' as const, departmentIds: [] },
        };
        await p.client.publishFile(publication, signal());
        expect(new Set(checked)).toEqual(
          new Set(['deliverables', 'enterprise-materials']),
        );
        const before =
          await f.db`select * from allrice_knowledge_save_requests where actor_id=${p.context.actor.id} order by request_id`;
        for (const moduleId of [
          'deliverables',
          'enterprise-materials',
        ] as const) {
          blocked = moduleId;
          await expect(
            p.client.publishFile(
              { ...publication, requestId: randomUUID() },
              signal(),
            ),
          ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
        }
        expect(
          await f.db`select * from allrice_knowledge_save_requests where actor_id=${p.context.actor.id} order by request_id`,
        ).toEqual(before);
      } finally {
        handlers = createEmployeePanelsHandlers({
          ...employeePanelsDependencies,
          storage: () => runtimeFixtureStorage(f.db),
        });
      }
    });
    it.each(['membership', 'resource'] as const)(
      'rejects %s withdrawal during real byte acquisition despite static builtin availability',
      async (kind) => {
        const p = await person();
        await release(p);
        const saved = await p.client.publishUpload(
          {
            ...uploadInput(p),
            origin: 'upload',
            purpose: '',
            audience: { scope: 'personal', departmentIds: [] },
          },
          signal(),
        );
        const revision = (
          await p.client.queryMaterials(
            {
              workspaceId: p.selection.workspaceId,
              query: { sourceId: saved.sourceId },
            },
            signal(),
          )
        ).references[0]!;
        const storage = runtimeFixtureStorage(f.db),
          get = storage.get.bind(storage);
        const reading = vi
          .spyOn(storage, 'get')
          .mockImplementationOnce(async (object) => {
            const bytes = await get(object);
            if (kind === 'membership')
              await f.db`update allrice_memberships set active=false where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
            else
              await p.client.changePublication(
                {
                  sourceId: saved.sourceId,
                  body: {
                    workspaceId: p.selection.workspaceId,
                    requestId: randomUUID(),
                    expectedRevision: revision.publication!.audienceRevision,
                    action: 'revoke',
                  },
                },
                signal(),
              );
            return bytes;
          });
        try {
          const response = await raw(
            p,
            `/materials/revisions/${saved.revisionId}/download`,
          );
          expect([401, 403, 404]).toContain(response.status);
          expect(response.headers.get('content-disposition')).toBeNull();
          await response.text();
          expect(reading).toHaveBeenCalledTimes(1);
        } finally {
          reading.mockRestore();
        }
      },
    );
    it('enforces server default-off without creating a thread or generation pin', async () => {
      const p = await person();
      await f.db`delete from allrice_settings where scope_type='system' and key='d_entry_rollout_policy'`;
      const response = await raw(p, '/deliverables');
      expect(response.status).toBe(403);
      await response.text();
      expect(
        await f.db`select id from allrice_chat_sessions where owner_id=${p.context.actor.id}`,
      ).toHaveLength(0);
    });
    it('requires real Cookie, same-origin writes and matching viewer without changing stored files', async () => {
      const p = await person();
      await release(p);
      const missing = await fetch(
        `${base}/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/deliverables?workspaceId=${p.selection.workspaceId}`,
        { headers: { Connection: 'close' } },
      );
      expect(missing.status).toBe(401);
      await missing.text();
      const invalidHeaders: Record<string, string>[] = [
        { Origin: 'https://evil.example' },
        { 'x-allrice-expected-viewer-id': randomUUID() },
      ];
      for (const headers of invalidHeaders) {
        const response = await raw(p, '/deliverables', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(uploadInput(p)),
        });
        expect([403, 409]).toContain(response.status);
        await response.text();
      }
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`,
      ).toHaveLength(0);
    });
    it('cannot exchange tenant, panel employee, viewer or directory filter for authority', async () => {
      const p = await person(),
        foreign = await person();
      await release(p, foreign);
      const secret = await foreign.client.uploadDeliverable(
        uploadInput(foreign),
        signal(),
      );
      for (const path of [
        `/api/v1/d-entry/panels/${foreign.selection.employeeInstanceId}/deliverables?workspaceId=${p.selection.workspaceId}`,
        `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/deliverables?workspaceId=${foreign.selection.workspaceId}`,
        `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/deliverables/${secret.objectId}/download?workspaceId=${p.selection.workspaceId}`,
      ]) {
        const response = await p.options.fetch(path);
        expect(response.ok).toBe(false);
        await response.text();
      }
      const list = await p.client.listDeliverables(
        {
          workspaceId: p.selection.workspaceId,
          employeeInstanceId: foreign.selection.employeeInstanceId,
        },
        signal(),
      );
      expect(list.files).toEqual([]);
      expect(list.viewerId).toBe(p.context.actor.id);
    });
    it('rejects retained Cookie after actual session or membership revocation', async () => {
      for (const kind of ['session', 'membership'] as const) {
        const p = await person();
        await release(p);
        const input = uploadInput(p),
          file = await p.client.uploadDeliverable(input, signal());
        if (kind === 'session')
          await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${p.context.sessionId}`;
        else
          await f.db`update allrice_memberships set active=false where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
        await expect(
          p.client.downloadDeliverable(
            { workspaceId: p.selection.workspaceId, objectId: file.objectId },
            signal(),
          ),
        ).rejects.toThrow();
        await expect(
          p.client.favorite(
            {
              workspaceId: p.selection.workspaceId,
              objectId: file.objectId,
              body: { favorite: true },
            },
            signal(),
          ),
        ).rejects.toThrow();
      }
    });
    it('permits a current read-only member to manage views without granting execute or file writes', async () => {
      const p = await person('viewer');
      await release(p);
      expect(
        (
          await p.client.listDeliverables(
            { workspaceId: p.selection.workspaceId },
            signal(),
          )
        ).files,
      ).toEqual([]);
      const options = await p.client.publicationOptions(
        { workspaceId: p.selection.workspaceId },
        signal(),
      );
      expect(options.options.writable).toBe(false);
      await expect(
        p.client.uploadDeliverable(uploadInput(p), signal()),
      ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`,
      ).toHaveLength(0);
    });
    it('does not turn a legacy persisted thread into a 4.0 management scope', async () => {
      const p = await person();
      await release(p);
      const threadId = randomUUID();
      await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_instance_id,employee_version_id)
      values(${threadId},${p.context.organizationId},${p.selection.workspaceId},${p.context.actor.id},'Legacy fixed writer',${p.selection.employeeInstanceId},${p.selection.employeeInstanceId},${p.versionId})`;
      const client = createEmployeePanelsHttpClient(
        { ...p.selection, threadId },
        p.options,
      );
      await expect(
        client.listDeliverables(
          { workspaceId: p.selection.workspaceId },
          signal(),
        ),
      ).rejects.toThrow();
      expect(
        await f.db`select execution_generation from allrice_chat_sessions where id=${threadId}`,
      ).toEqual([{ execution_generation: '3.x' }]);
    });
    it('retains pending storage acknowledgement as a reservation and only reads it by its original key', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p, 'pending.txt');
      const storage = runtimeFixtureStorage(f.db),
        put = storage.put.bind(storage);
      const failure = vi
        .spyOn(storage, 'put')
        .mockImplementationOnce(async (object, bytes) => {
          await put(object, bytes);
          throw Error('synthetic put ACK lost');
        });
      try {
        await expect(
          p.client.publishUpload(
            {
              ...input,
              origin: 'upload',
              purpose: '',
              audience: { scope: 'personal', departmentIds: [] },
            },
            signal(),
          ),
        ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
        const receipt = await readEmployeePanelsWriteReceipt(
          p.selection,
          {
            workspaceId: p.selection.workspaceId,
            requestId: input.requestId,
            operation: 'publish-upload',
          },
          signal(),
          p.options,
        );
        expect(receipt).toMatchObject({ status: 'recorded', ready: false });
        if (!receipt.result || !('revisionId' in receipt.result))
          throw Error('original reservation missing');
        const prepared = await p.client.readPreparedReference(
          {
            workspaceId: p.selection.workspaceId,
            sourceId: receipt.result.sourceId,
            revisionId: receipt.result.revisionId,
          },
          signal(),
        );
        expect(prepared.processing).toBe('uploading');
        expect(failure).toHaveBeenCalledTimes(1);
      } finally {
        failure.mockRestore();
      }
    });
    it('rechecks a real release withdrawal after byte acquisition and returns no successful body', async () => {
      const p = await person();
      await release(p);
      const saved = await p.client.uploadDeliverable(uploadInput(p), signal());
      const storage = runtimeFixtureStorage(f.db),
        get = storage.get.bind(storage);
      const read = vi
        .spyOn(storage, 'get')
        .mockImplementationOnce(async (object) => {
          const bytes = await get(object);
          await release();
          return bytes;
        });
      try {
        const response = await raw(
          p,
          `/deliverables/${saved.objectId}/download`,
        );
        expect(response.status).toBe(403);
        expect(response.headers.get('content-disposition')).toBeNull();
        await response.text();
      } finally {
        read.mockRestore();
      }
    });
  },
);
