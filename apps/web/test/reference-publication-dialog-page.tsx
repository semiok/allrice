// Isolated parent seam; all data and writes still use real HTTP routes.
import '../app/styles/base.css';
import { createRoot } from 'react-dom/client';
import { useEffect, useState, type ComponentProps } from 'react';
import type {
  ReferenceRevision,
  WorkbenchDeliverable,
} from '@allrice/contracts';
import {
  ReferencePublicationDialog,
  type ReferencePublicationTarget,
} from '../app/chatflow/reference-publication-dialog';

const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspaceId')!;
const headers = { 'x-workspace-id': workspaceId };
type Selection = {
  kind: ReferencePublicationTarget['kind'];
  objectId?: string;
  sourceId?: string;
};
type Directory = {
  viewerId: string;
  references: ReferenceRevision[];
  options: NonNullable<
    ComponentProps<typeof ReferencePublicationDialog>['options']
  >;
};
// Exercise late replies even if a transport cannot honor cancellation; no response is mocked.
if (params.get('ignoreAbort') === '1') {
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) =>
    fetch(
      input,
      init?.method === 'POST' ? { ...init, signal: undefined } : init,
    );
}

function Fixture() {
  const [model, setModel] = useState<
    (Directory & { target: ReferencePublicationTarget }) | null
  >(null);
  const [saved, setSaved] = useState<unknown[]>([]);
  const [closed, setClosed] = useState(0);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const open = async (selection: Selection) => {
      const query = new URLSearchParams({ workspaceId });
      if (selection.sourceId) query.set('sourceId', selection.sourceId);
      const response = await fetch('/api/v1/references/publications?' + query, {
        headers,
      });
      if (!response.ok) throw Error('Fixture directory: ' + response.status);
      const directory = (await response.json()) as Directory;
      let target: ReferencePublicationTarget;
      if (selection.kind === 'upload') target = { kind: 'upload' };
      else if (selection.kind === 'file') {
        const files = await fetch(
          `/api/v1/workbench/files?view=deliverables&workspaceId=${workspaceId}&objectId=${selection.objectId}`,
          { headers },
        );
        if (!files.ok) throw Error('Fixture file: ' + files.status);
        const catalog = (await files.json()) as {
          files: WorkbenchDeliverable[];
        };
        target = { kind: 'file', file: catalog.files[0]! };
      } else {
        const reference = directory.references[0];
        if (!reference) throw Error('Fixture publication not readable');
        target = { kind: selection.kind, reference };
      }
      setModel({ ...directory, target });
    };
    const change = (event: Event) => {
      void open((event as CustomEvent<Selection>).detail).catch((e: Error) =>
        setFailure(e.message),
      );
    };
    window.addEventListener('publication-fixture-target', change);
    change(new CustomEvent('initial', { detail: Object.fromEntries(params) }));
    return () =>
      window.removeEventListener('publication-fixture-target', change);
  }, []);
  return (
    <>
      <output aria-label="当前查看者">{model?.viewerId}</output>
      <output aria-label="保存回执">{JSON.stringify(saved)}</output>
      <output aria-label="取消次数">{closed}</output>
      <output aria-label="夹具错误">{failure}</output>
      {model && (
        <ReferencePublicationDialog
          {...model}
          options={
            params.get('omitOptions') === '1' ? undefined : model.options
          }
          workspaceId={workspaceId}
          headers={headers}
          onClose={() => {
            setClosed((n) => n + 1);
            setModel(null);
          }}
          onSaved={(result) => {
            setSaved((events) => [
              ...events,
              { viewerId: model.viewerId, ...result },
            ]);
            setModel(null);
          }}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
