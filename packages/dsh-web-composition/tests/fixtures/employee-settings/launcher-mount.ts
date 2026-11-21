import { act, type ReactNode } from 'react';
import { vi } from 'vitest';

/** Real ReactDOM effects, with null presentation only; no DOM/layout claims. */
export async function createLauncherMount() {
  const view = {
    HTMLElement: class {},
    HTMLIFrameElement: class {},
    document: null as unknown,
  };
  const document = {
    nodeType: 9,
    defaultView: view,
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  view.document = document;
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document,
    textContent: '',
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal('window', view);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };
  return {
    render: async (node: ReactNode) => {
      await act(async () => root.render(node));
    },
    unmount,
    dispose: async () => {
      try {
        await unmount();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  };
}
