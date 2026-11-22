/** Existing 271/273 consumer fixture, not a VM/Host/model or Dev acceptance. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(
  !process.env.WORKDAY_FIXTURE_SOURCE || !process.env.WORKDAY_FIXTURE_RECEIPT,
)(
  'drives the existing native entry fixture through real HTTP and joins its close',
  async () => {
    const source = process.env.WORKDAY_FIXTURE_SOURCE;
    const receipt = process.env.WORKDAY_FIXTURE_RECEIPT;
    if (!source || !receipt)
      throw new Error('Explicit fixture source/receipt required');
    const { nativeEntryServer } = await import(
      pathToFileURL(
        resolve(source, 'apps/worker/src/d-entry/native-entry.fixture.ts'),
      ).href
    );
    const fixture = await nativeEntryServer();
    const steps: { id: string; title: string; reason: string }[] = [];
    let closed = false;
    try {
      const discovery = await fixture.request();
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        identity: fixture.identity,
        controlReady: true,
      });
      steps.push({
        id: 'IDENTITY.fixture',
        title: '已存在的consumer身份/员工选择HTTP入口',
        reason:
          '真实HTTP到nativeEntryFixture的注入身份；不证明登录/真实Host/editorReady/canSend',
      });
      const resource = await fixture.request('native-resource', {
        ...fixture.body,
        nativeSessionId: 'dsh-child',
      });
      expect(resource.status).toBe(200);
      expect(await resource.json()).toMatchObject({
        nativeSessionId: 'dsh-child',
        rootNativeSessionId: 'dsh-root',
        parentNativeSessionId: 'dsh-root',
        threadId: fixture.identity.threadId,
      });
      const prompt = (sessionId: string) => ({
        ...fixture.body,
        endpoint: 'session/prompt',
        payload: {
          args: {
            request: {
              requestId: 'workday-isolated-fixture-only',
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: 'synthetic fixture, no model' }],
            },
          },
        },
      });
      const child = await fixture.request('native-rpc', prompt('dsh-child'));
      expect(child.status).toBe(404);
      expect(fixture.rpcDispatch).not.toHaveBeenCalled();
      steps.push({
        id: 'SUBAGENT.fixture',
        title: '子会话资源读与HTTP写拒绝',
        reason:
          '实际consumer handler读catalog替身且在dispatch前拒子写；不是实际DSH子会话/UI验收',
      });
      const root = await fixture.request('native-rpc', prompt('dsh-root'));
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual({ ok: true });
      expect(root.headers.get('set-cookie')).toBeNull();
      expect(fixture.rpcDispatch).toHaveBeenCalledOnce();
      expect(fixture.rpcClose).toHaveBeenCalledTimes(2);
      const dispatched = fixture.rpcDispatch.mock.calls.length;
      fixture.deps.data.mockReturnValueOnce(undefined);
      expect(
        (await fixture.request('native-rpc', prompt('dsh-root'))).status,
      ).toBe(503);
      expect(fixture.rpcDispatch.mock.calls.length).toBe(dispatched);
      steps.push({
        id: 'CHAT.fixture',
        title: '原生HTTP协议替身与缺provider拒绝',
        reason:
          '真实handler只调用合成rpc consumer一次并close；缺DataPort拒绝，不调用模型/VM/3.x Run',
      });
    } finally {
      try {
        await fixture.close();
        closed = true;
        steps.push({
          id: 'CLEANUP.fixture',
          title: 'fixture HTTP/mux实际close与join',
          reason:
            'await既有nativeEntryServer.close完成，只关闭本次loopback fixture',
        });
      } finally {
        await writeFile(
          receipt,
          JSON.stringify({ kind: 'consumer-fixture', closed, steps }) + '\n',
        );
      }
    }
  },
);
