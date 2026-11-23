import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  bindEmployeePanelsHttp,
  EmployeePanelsWriteUnknownError,
  readEmployeePanelsWriteReceipt,
  type EmployeePanelsHttpOwnerResolver,
} from '../src/employee-panels';
import { EmployeePanelsUnavailableError } from '../src/employee-panels-model';
import { syntheticPanelsOwner } from './fixtures/employee-panels/owner';
import {
  createSyntheticPanelsData,
  panelsEmployee,
  panelsViewer,
  panelsWorkspace,
  uid,
} from './fixtures/employee-panels/data';

// Explicit HTTP response/owner substitutes exercise the actual formal resolver
// and Cordis binder. They establish neither Cookie/DB nor production owner facts.
async function fixture(resolve?: EmployeePanelsHttpOwnerResolver | null) {
  const ctx = new Context();
  const owner = syntheticPanelsOwner();
  const data = createSyntheticPanelsData();
  const selection = {
    workspaceId: panelsWorkspace,
    employeeInstanceId: panelsEmployee,
    threadId: uid(707),
  };
  const root = `/api/v1/d-entry/panels/${selection.employeeInstanceId}`;
  const reference = data.references[0]!;
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const path = new URL(String(input), 'https://contract.example').pathname;
    if (path.endsWith('/download')) return new Response('fixed bytes');
    if (path.endsWith('/preview'))
      return Response.json({
        kind: 'text',
        text: '固定页',
        mediaType: 'text/plain',
        offset: 3,
        lines: 1,
        eof: true,
      });
    if (path === root + '/materials')
      return Response.json({
        ...data.catalog,
        viewerId: panelsViewer,
        options: data.options,
      });
    if (path.endsWith('/materials/options'))
      return Response.json({ viewerId: panelsViewer, options: data.options });
    if (path.endsWith('/selection'))
      return Response.json(data.selection(reference.revisionId));
    if (path.endsWith('/reference')) return Response.json({ reference });
    if (path === root + `/materials/revisions/${reference.revisionId}`)
      return Response.json(reference);
    if (path.endsWith('/favorite'))
      return Response.json({
        viewerId: panelsViewer,
        objectId: uid(300),
        favorite: true,
      });
    if (path === root + '/deliverables')
      return Response.json(
        init.method === 'POST' ? { objectId: uid(300) } : data.files,
      );
    if (path.endsWith('/materials/publications'))
      return Response.json({
        sourceId: reference.sourceId,
        revisionId: reference.revisionId,
      });
    return Response.json({ sourceId: reference.sourceId });
  });
  const current: EmployeePanelsHttpOwnerResolver = (id, snapshot) => {
    expect(id).toBe(owner.sessionId);
    expect(snapshot).toBe(owner.snapshot());
    return { selection, viewerId: panelsViewer };
  };
  const fork = bindEmployeePanelsHttp(
    ctx,
    owner.port,
    resolve === null ? undefined : (resolve ?? current),
    { fetch: fetcher },
  );
  await fork;
  const binding = ctx.allriceEmployeePanels;
  const snapshot = binding.port.getSnapshot(owner.sessionId)!;
  return {
    ctx,
    owner,
    selection,
    fetcher,
    binding,
    reference,
    data,
    client: snapshot.files.dataClient!,
    fork,
    dispose: () => ctx.fiber.dispose(),
  };
}
const signal = () => new AbortController().signal;

describe('formal HTTP resolver through the public employee panel binder', () => {
  it('uses the owner catalog selection for all sixteen methods, preserving the existing panel props', async () => {
    const f = await fixture();
    try {
      const snapshot = f.binding.port.getSnapshot(f.owner.sessionId)!;
      expect(snapshot.materials.dataClient).toBe(f.client);
      expect(snapshot.files.onOpen).toBe(f.owner.snapshot().files.onOpen);
      expect(f.owner.sessionId).not.toBe(f.selection.threadId);
      const workspace = { workspaceId: panelsWorkspace };
      const material = { ...workspace, revisionId: f.reference.revisionId };
      const file = { ...workspace, objectId: uid(300) };
      const upload = {
        ...workspace,
        requestId: uid(77),
        fileName: '成果.txt',
        mediaType: 'text/plain',
        contentBase64: 'YWJj',
      };
      const audience = { scope: 'personal' as const, departmentIds: [] };
      await f.client.queryMaterials({ ...workspace, query: {} }, signal());
      await f.client.publicationOptions(workspace, signal());
      await f.client.selectMaterial(material, signal());
      await f.client.previewMaterial(
        { ...material, source: true, offset: 3 },
        signal(),
      );
      await f.client.downloadMaterial(material, signal());
      await f.client.publishFile(
        {
          ...file,
          requestId: uid(78),
          origin: 'file',
          purpose: '固定副本',
          audience,
        },
        signal(),
      );
      await f.client.publishUpload(
        { ...upload, origin: 'upload', purpose: '', audience },
        signal(),
      );
      await f.client.changePublication(
        {
          sourceId: f.reference.sourceId,
          body: {
            ...workspace,
            requestId: uid(79),
            expectedRevision: 1,
            action: 'revoke',
          },
        },
        signal(),
      );
      await f.client.changeSource(
        {
          sourceId: f.reference.sourceId,
          body: {
            ...workspace,
            requestId: uid(80),
            expectedRevision: 1,
            action: 'retry',
          },
        },
        signal(),
      );
      await f.client.listDeliverables(
        { ...workspace, category: 'favorite' },
        signal(),
      );
      await f.client.captureReference(
        { ...file, requestId: uid(81) },
        signal(),
      );
      await f.client.readPreparedReference(
        { ...material, sourceId: f.reference.sourceId },
        signal(),
      );
      await f.client.favorite({ ...file, body: { favorite: true } }, signal());
      await f.client.previewDeliverable(
        { ...file, fileName: 'not-authority.txt', source: true, offset: 3 },
        signal(),
      );
      expect(
        await (await f.client.downloadDeliverable(file, signal())).text(),
      ).toBe('fixed bytes');
      expect(await f.client.uploadDeliverable(upload, signal())).toEqual({
        objectId: uid(300),
      });
      expect(f.fetcher).toHaveBeenCalledTimes(16);
      for (const [input, init] of f.fetcher.mock.calls) {
        const url = new URL(String(input), 'https://contract.example');
        expect(url.pathname).toMatch(
          new RegExp(`^/api/v1/d-entry/panels/${panelsEmployee}/`),
        );
        expect(String(input)).not.toContain(f.owner.sessionId);
        expect(url.searchParams.get('workspaceId')).toBe(panelsWorkspace);
        expect(url.searchParams.get('threadId')).toBe(f.selection.threadId);
        expect(init?.credentials).toBe('same-origin');
        expect(init?.cache).toBe('no-store');
        expect(
          new Headers(init?.headers).get('x-allrice-expected-viewer-id'),
        ).toBe(panelsViewer);
        expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      }
    } finally {
      await f.dispose();
    }
  });

  it.each(['absent', 'null'] as const)(
    'rejects both panels with a %s authenticated selection and makes no HTTP request',
    async (mode) => {
      const f = await fixture(mode === 'absent' ? null : () => null);
      try {
        await expect(
          f.client.queryMaterials(
            { workspaceId: panelsWorkspace, query: {} },
            signal(),
          ),
        ).rejects.toMatchObject({ name: 'EmployeePanelDataUnavailableError' });
        await expect(
          f.client.listDeliverables({ workspaceId: panelsWorkspace }, signal()),
        ).rejects.toMatchObject({ name: 'EmployeePanelDataUnavailableError' });
        expect(f.fetcher).not.toHaveBeenCalled();
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(['revoke', 'dispose'] as const)(
    'aborts an independent HTTP read on %s, rejects ignored-abort results and releases subscriptions',
    async (mode) => {
      const f = await fixture();
      try {
        let release!: (value: Response) => void;
        let active!: AbortSignal;
        f.fetcher.mockImplementationOnce(async (_input, init) => {
          active = init!.signal!;
          return new Promise((done) => {
            release = done;
          });
        });
        const pending = f.client.listDeliverables(
          { workspaceId: panelsWorkspace },
          signal(),
        );
        if (mode === 'revoke') f.owner.publish(null);
        else await f.fork.dispose();
        expect(active.aborted).toBe(true);
        release(Response.json(f.data.files));
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.owner.listeners.size).toBe(0);
        await expect(
          f.client.listDeliverables({ workspaceId: panelsWorkspace }, signal()),
        ).rejects.toBeInstanceOf(EmployeePanelsUnavailableError);
        expect(f.fetcher).toHaveBeenCalledTimes(1);
      } finally {
        await f.dispose();
      }
    },
  );

  it('preserves the unknown write error and uses the formal original-key GET for reconciliation without replay', async () => {
    const f = await fixture();
    try {
      const input = {
        workspaceId: panelsWorkspace,
        requestId: uid(90),
        fileName: '独立成果.txt',
        mediaType: 'text/plain',
        contentBase64: 'YWJj',
      };
      f.fetcher.mockRejectedValueOnce(Error('reply lost'));
      const error: unknown = await f.client
        .uploadDeliverable(input, signal())
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(EmployeePanelsWriteUnknownError);
      expect(error).toMatchObject({
        operation: 'upload',
        requestId: input.requestId,
        originalInput: input,
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      f.fetcher.mockResolvedValueOnce(
        Response.json({
          requestId: input.requestId,
          operation: 'upload',
          status: 'unknown',
          inputDigest: null,
          result: null,
          ready: null,
        }),
      );
      const receipt = await readEmployeePanelsWriteReceipt(
        f.selection,
        {
          workspaceId: panelsWorkspace,
          requestId: input.requestId,
          operation: 'upload',
        },
        signal(),
        {
          fetch: f.fetcher,
          expectedViewerId: panelsViewer,
          lifetimeSignal: f.binding.signal,
        },
      );
      expect(receipt.status).toBe('unknown');
      const [url, init] = f.fetcher.mock.calls[1]!;
      expect(String(url)).toContain(`/write-receipts/${input.requestId}?`);
      expect(init?.method).toBeUndefined();
      expect(init?.body).toBeUndefined();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await f.dispose();
    }
  });
});
