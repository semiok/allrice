import { act, createElement, useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createEmployeePanelDataClient,
  type EmployeePanelDataClient,
} from '../../../apps/web/lib/chatflow/employee-panel-data';
import { useWorkbenchFileFavorite } from '../../../apps/web/app/chatflow/use-workbench-file-favorite';
import { createLauncherMount } from './fixtures/employee-settings/launcher-mount';
import {
  panelsViewer,
  panelsWorkspace,
  uid,
} from './fixtures/employee-panels/data';

afterEach(() => vi.unstubAllGlobals());

it.each(['resolve', 'reject'] as const)(
  'replaces the client in the same mounted favorite hook, clearing busy and ignoring late %s',
  async (outcome) => {
    const mount = await createLauncherMount();
    const changed = vi.fn();
    Object.assign(window, { dispatchEvent: changed });
    let value!: ReturnType<typeof useWorkbenchFileFavorite>;
    let mounts = 0;
    let releaseOld!: (value: unknown) => void,
      rejectOld!: (error: Error) => void;
    let releaseNew!: (value: unknown) => void;
    let oldSignal!: AbortSignal;
    const oldClient = createEmployeePanelDataClient({
      favorite: (_input, signal) => {
        oldSignal = signal;
        return new Promise((resolve, reject) => {
          releaseOld = resolve;
          rejectOld = reject;
        });
      },
    });
    const nextClient = createEmployeePanelDataClient({
      favorite: () =>
        new Promise((resolve) => {
          releaseNew = resolve;
        }),
    });
    function Probe({ dataClient }: { dataClient: EmployeePanelDataClient }) {
      value = useWorkbenchFileFavorite({
        ownerKey: 'same-owner',
        viewerId: panelsViewer,
        workspaceId: panelsWorkspace,
        headers: {},
        active: true,
        dataClient,
      });
      useEffect(() => {
        mounts++;
      }, []);
      return null;
    }
    try {
      await mount.render(createElement(Probe, { dataClient: oldClient }));
      let pendingOld!: Promise<void>;
      await act(async () => {
        pendingOld = value.setFavorite(uid(300), true);
      });
      expect(value.using).toBe(uid(300));
      await mount.render(createElement(Probe, { dataClient: nextClient }));
      expect(mounts).toBe(1);
      expect(oldSignal.aborted).toBe(true);
      expect(value.using).toBe('');
      expect(value.error).toBe('');
      let pendingNew!: Promise<void>;
      await act(async () => {
        pendingNew = value.setFavorite(uid(301), true);
      });
      await act(async () => {
        if (outcome === 'resolve')
          releaseOld({
            viewerId: panelsViewer,
            objectId: uid(300),
            favorite: true,
          });
        else rejectOld(Error('obsolete transport error'));
        await pendingOld;
      });
      expect(value.using).toBe(uid(301));
      expect(value.error).toBe('');
      expect(changed).not.toHaveBeenCalled();
      await act(async () => {
        releaseNew({
          viewerId: panelsViewer,
          objectId: uid(301),
          favorite: true,
        });
        await pendingNew;
      });
      expect(value.using).toBe('');
      expect(value.error).toBe('');
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      await mount.dispose();
    }
  },
);

it('clears an old client error without remounting or changing identity', async () => {
  const mount = await createLauncherMount();
  Object.assign(window, { dispatchEvent: vi.fn() });
  let value!: ReturnType<typeof useWorkbenchFileFavorite>;
  const oldClient = createEmployeePanelDataClient({
    favorite: async () => {
      throw Error('old failure');
    },
  });
  const nextClient = createEmployeePanelDataClient({});
  function Probe({ dataClient }: { dataClient: EmployeePanelDataClient }) {
    value = useWorkbenchFileFavorite({
      ownerKey: 'same-owner',
      viewerId: panelsViewer,
      workspaceId: panelsWorkspace,
      headers: {},
      active: true,
      dataClient,
    });
    return null;
  }
  try {
    await mount.render(createElement(Probe, { dataClient: oldClient }));
    await act(async () => {
      await value.setFavorite(uid(300), true);
    });
    expect(value.error).toBe('old failure');
    await mount.render(createElement(Probe, { dataClient: nextClient }));
    expect(value.error).toBe('');
    expect(value.using).toBe('');
  } finally {
    await mount.dispose();
  }
});
