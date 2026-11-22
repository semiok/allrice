import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmployeePanelDataClient,
  EmployeePanelDataUnavailableError,
  unboundEmployeePanelDataClient,
  type EmployeePanelDataMethod,
} from '../../../apps/web/lib/chatflow/employee-panel-data';
import { legacyEmployeePanelDataClient } from '../../../apps/web/lib/chatflow/employee-panel-data-legacy';
import { ReferenceSelectionUnavailableError } from '../../../apps/web/lib/chatflow/reference-selection';
import { createEmployeePanelsDataPort } from '../src/employee-panels-data';
import { bindEmployeePanelsData } from '../src/employee-panels';
import { EmployeePanelsUnavailableError } from '../src/employee-panels-model';
import { syntheticPanelsOwner } from './fixtures/employee-panels/owner';
import {
  createSyntheticPanelsData,
  panelsViewer,
  panelsWorkspace,
  uid,
} from './fixtures/employee-panels/data';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe('explicit browser panel client, without BFF identity or business writes', () => {
  it('rejects all sixteen missing methods without making a legacy request or returning empty success', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const names = Object.keys(
      unboundEmployeePanelDataClient,
    ) as EmployeePanelDataMethod[];
    expect(names).toHaveLength(16);
    for (const name of names) {
      const call = unboundEmployeePanelDataClient[name] as (
        input: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>;
      await expect(call({}, signal())).rejects.toMatchObject({
        name: 'EmployeePanelDataUnavailableError',
        method: name,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps search excerpts, incomplete coverage, scope labels and exact selection from the bound projection', async () => {
    const data = createSyntheticPanelsData();
    const queryMaterials = vi.fn<
      (input: unknown, signal: AbortSignal) => Promise<unknown>
    >(async () => ({
      ...data.catalog,
      viewerId: panelsViewer,
      options: data.options,
      fullTextCoverage: { ready: 3, unavailable: 2 },
    }));
    const client = createEmployeePanelDataClient({
      queryMaterials,
      selectMaterial: async (input) => data.selection(input.revisionId),
    });
    const query = {
      query: '销售',
      category: 'departments' as const,
      limit: 20,
    };
    const catalog = await client.queryMaterials(
      { workspaceId: panelsWorkspace, query },
      signal(),
    );
    expect(queryMaterials.mock.calls[0]?.[0]).toEqual({
      workspaceId: panelsWorkspace,
      query,
    });
    expect(catalog.fullTextCoverage.unavailable).toBe(2);
    expect(catalog.references[1]?.publication?.audience.departmentIds).toEqual([
      uid(6),
    ]);
    const exact = await client.selectMaterial(
      { workspaceId: panelsWorkspace, revisionId: uid(200) },
      signal(),
    );
    expect(exact.selection).toMatchObject({
      revisionId: uid(200),
      checksum: data.references[0]!.checksum,
    });
  });

  it('uses the existing web action projection: absent quotable IDs fail closed, malformed output fails parsing', async () => {
    const data = createSyntheticPanelsData();
    const withoutActions: Partial<typeof data.files> = { ...data.files };
    delete withoutActions.quotableFileIds;
    const client = createEmployeePanelDataClient({
      listDeliverables: async () => withoutActions,
      queryMaterials: async () => ({ references: data.references }),
    });
    expect(
      (
        await client.listDeliverables(
          { workspaceId: panelsWorkspace },
          signal(),
        )
      ).quotableFileIds,
    ).toEqual([]);
    await expect(
      client.queryMaterials(
        { workspaceId: panelsWorkspace, query: {} },
        signal(),
      ),
    ).rejects.toThrow();
  });

  it('keeps file copy, upload and publication CAS separate; retries carry the caller retained request ID', async () => {
    const copy = vi.fn<
      (input: unknown, signal: AbortSignal) => Promise<unknown>
    >(async () => ({
      sourceId: uid(800),
      revisionId: uid(801),
    }));
    const change = vi.fn<
      (input: unknown, signal: AbortSignal) => Promise<unknown>
    >(async () => ({
      sourceId: uid(800),
    }));
    const client = createEmployeePanelDataClient({
      publishFile: copy,
      changePublication: change,
    });
    const body = {
      workspaceId: panelsWorkspace,
      requestId: uid(77),
      origin: 'file' as const,
      objectId: uid(300),
      audience: { scope: 'personal' as const, departmentIds: [] },
      purpose: '固定副本',
    };
    await client.publishFile(body, signal());
    await client.publishFile(body, signal());
    expect(copy.mock.calls.map((call) => call[0])).toEqual([body, body]);
    const command = {
      sourceId: uid(800),
      body: {
        workspaceId: panelsWorkspace,
        requestId: uid(78),
        expectedRevision: 3,
        action: 'revoke' as const,
      },
    };
    await client.changePublication(command, signal());
    expect(change.mock.calls[0]?.[0]).toEqual(command);
    await expect(
      client.publishUpload(
        {
          ...body,
          origin: 'upload',
          fileName: 'a.txt',
          mediaType: 'text/plain',
          contentBase64: 'YQ==',
        } as never,
        signal(),
      ),
    ).rejects.toBeInstanceOf(EmployeePanelDataUnavailableError);
  });

  it('passes source-page positions and immutable resource identity to the bound reader, accepting only Blob downloads', async () => {
    const preview = vi.fn<
      (input: unknown, signal: AbortSignal) => Promise<unknown>
    >(async () => ({
      kind: 'text',
      text: '第二页',
      mediaType: 'text/plain',
      offset: 3,
      lines: 2,
      eof: true,
    }));
    const bytes = new Blob(['fixed bytes']);
    const client = createEmployeePanelDataClient({
      previewDeliverable: preview,
      downloadDeliverable: async () => bytes,
      downloadMaterial: async () => 'https://example.test/private',
    });
    const page = {
      workspaceId: panelsWorkspace,
      objectId: uid(300),
      fileName: 'a.txt',
      source: true,
      offset: 3,
    };
    expect(await client.previewDeliverable(page, signal())).toMatchObject({
      offset: 3,
      text: '第二页',
    });
    expect(preview.mock.calls[0]?.[0]).toEqual(page);
    expect(
      await client.downloadDeliverable(
        { workspaceId: panelsWorkspace, objectId: uid(300) },
        signal(),
      ),
    ).toBe(bytes);
    await expect(
      client.downloadMaterial(
        { workspaceId: panelsWorkspace, revisionId: uid(200) },
        signal(),
      ),
    ).rejects.toThrow('文件下载失败');
  });

  it('propagates abort and rejects a late result even if the supplied transport ignored its signal', async () => {
    let release!: (value: unknown) => void;
    const controller = new AbortController();
    const favorite = vi.fn((_input, supplied: AbortSignal) => {
      expect(supplied).toBe(controller.signal);
      return new Promise((done) => {
        release = done;
      });
    });
    const client = createEmployeePanelDataClient({ favorite });
    const pending = client.favorite(
      {
        workspaceId: panelsWorkspace,
        objectId: uid(300),
        body: { favorite: true },
      },
      controller.signal,
    );
    controller.abort();
    release({ viewerId: panelsViewer, objectId: uid(300), favorite: true });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      client.favorite({} as never, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(favorite).toHaveBeenCalledTimes(1);
  });

  it('only the explicit 3.x compatibility adapter uses the old route and preserves the structured lost-access error', async () => {
    const data = createSyntheticPanelsData();
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () =>
        Response.json({
          ...data.catalog,
          viewerId: panelsViewer,
          options: data.options,
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const legacy = legacyEmployeePanelDataClient(
      { 'x-fixture': 'legacy-only' },
      panelsViewer,
    );
    await legacy.queryMaterials(
      { workspaceId: panelsWorkspace, query: { query: '销售' } },
      signal(),
    );
    const url = new URL(
      fetch.mock.calls[0]![0] as string,
      'https://example.test',
    );
    expect(url.pathname).toBe('/api/v1/references/publications');
    expect(url.searchParams.get('query')).toBe('销售');
    fetch.mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: 'REFERENCE_SELECTION_UNAVAILABLE',
            message: 'unavailable',
            requestId: uid(88),
            retryable: false,
            referenceRevisionIds: [uid(200)],
          },
        },
        { status: 409 },
      ),
    );
    await expect(
      legacy.selectMaterial(
        { workspaceId: panelsWorkspace, revisionId: uid(200) },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ReferenceSelectionUnavailableError);
  });
});

describe('data owner bound to existing public sidebar props', () => {
  it('publishes explicit unbound clients and keeps snapshot identity stable without changing header props', async () => {
    const owner = syntheticPanelsOwner();
    const port = createEmployeePanelsDataPort(
      owner.port,
      () => null,
      owner.lifetime.signal,
    );
    const snapshot = port.getSnapshot(owner.sessionId)!;
    expect(port.getSnapshot(owner.sessionId)).toBe(snapshot);
    expect(snapshot.filesUnread).toBe(owner.snapshot().filesUnread);
    expect(snapshot.files.onOpen).toBe(owner.snapshot().files.onOpen);
    expect(snapshot.materials.dataClient).toBe(snapshot.files.dataClient);
    await expect(
      snapshot.files.dataClient!.listDeliverables(
        { workspaceId: panelsWorkspace },
        signal(),
      ),
    ).rejects.toBeInstanceOf(EmployeePanelDataUnavailableError);
  });

  it('aborts in-flight reads on owner change, refuses stale preview/dialog clients and preserves the native reference bridge', async () => {
    const owner = syntheticPanelsOwner();
    let release!: (value: unknown) => void;
    let supplied!: AbortSignal;
    const raw = createEmployeePanelDataClient({
      listDeliverables: async (_input, signal) => {
        supplied = signal;
        return new Promise((done) => {
          release = done;
        });
      },
    });
    const port = createEmployeePanelsDataPort(
      owner.port,
      () => raw,
      owner.lifetime.signal,
    );
    const stale = port.dataClient(owner.sessionId);
    const stop = port.subscribe(owner.sessionId, () => {});
    const read = stale.listDeliverables(
      { workspaceId: panelsWorkspace },
      signal(),
    );
    owner.publish({ ...owner.snapshot(), scopeKey: 'new-person-scope' });
    expect(supplied.aborted).toBe(true);
    release(createSyntheticPanelsData().files);
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      stale.listDeliverables({ workspaceId: panelsWorkspace }, signal()),
    ).rejects.toBeInstanceOf(EmployeePanelsUnavailableError);
    expect(port.dataClient(owner.sessionId)).not.toBe(stale);
    const insertion = {
      sessionId: owner.sessionId,
      scopeKey: 'new-person-scope',
      reference: createSyntheticPanelsData().references[0]!,
      signal: signal(),
    };
    expect(port.useReference?.(insertion)).toBe(true);
    expect(owner.port.useReference).toHaveBeenCalledWith(insertion);
    stop();
    expect(owner.listeners.size).toBe(0);
  });

  it('installs the explicit data owner in the Cordis lifetime and removes it on disposal', async () => {
    const ctx = new Context();
    try {
      const owner = syntheticPanelsOwner();
      const fork = bindEmployeePanelsData(ctx, owner.port);
      await fork;
      const binding = ctx.allriceEmployeePanels;
      expect(
        binding.port.getSnapshot(owner.sessionId)?.files.dataClient,
      ).toBeDefined();
      await fork.dispose();
      expect(binding.signal.aborted).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
