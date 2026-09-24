'use client';
import { useCallback, useEffect, useState } from 'react';

type Preferences = {
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  panelWidth: number | null;
};
const defaults: Preferences = {
  sidebarCollapsed: false,
  panelOpen: true,
  panelWidth: null,
};
export function layoutPreferenceKey(
  viewerId?: string | null,
  organizationId?: string,
  workspaceId?: string,
) {
  return viewerId && organizationId && workspaceId
    ? `allrice:workbench-layout:v1:${[viewerId, organizationId, workspaceId].map(encodeURIComponent).join(':')}`
    : null;
}
export function parseLayoutPreferences(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    return {
      sidebarCollapsed:
        typeof value?.sidebarCollapsed === 'boolean'
          ? value.sidebarCollapsed
          : false,
      panelOpen: typeof value?.panelOpen === 'boolean' ? value.panelOpen : true,
      panelWidth:
        typeof value?.panelWidth === 'number' &&
        Number.isFinite(value.panelWidth) &&
        value.panelWidth >= 360
          ? value.panelWidth
          : null,
    };
  } catch {
    return { ...defaults };
  }
}
function readPreferences(key: string | null) {
  try {
    return parseLayoutPreferences(key ? localStorage.getItem(key) : null);
  } catch {
    return { ...defaults };
  }
}

export function useWorkbenchLayout({
  viewerId,
  organizationId,
  workspaceId,
}: {
  viewerId?: string | null;
  organizationId?: string;
  workspaceId?: string;
}) {
  const key = layoutPreferenceKey(viewerId, organizationId, workspaceId);
  const scope = JSON.stringify([viewerId ?? null, organizationId, workspaceId]);
  const [viewport, setViewport] = useState({ narrow: true, compact: false });
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [state, setState] = useState({
    scope: '',
    ...defaults,
    widePanelOpen: true,
  });
  useEffect(() => {
    setMobileSidebar(false);
    const preferences = readPreferences(key);
    setState({
      scope,
      ...preferences,
      widePanelOpen: preferences.panelOpen,
      panelOpen:
        !window.matchMedia('(max-width: 1100px)').matches &&
        preferences.panelOpen,
    });
  }, [key, scope]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1100px)');
    const compact = window.matchMedia('(max-width: 760px)');
    const sync = () => {
      setViewport({ narrow: narrow.matches, compact: compact.matches });
      if (!narrow.matches)
        setState((s) => ({ ...s, panelOpen: s.panelOpen || s.widePanelOpen }));
    };
    sync();
    narrow.addEventListener('change', sync);
    compact.addEventListener('change', sync);
    return () => {
      narrow.removeEventListener('change', sync);
      compact.removeEventListener('change', sync);
    };
  }, []);
  const current =
    state.scope === scope
      ? state
      : { ...defaults, panelOpen: false, widePanelOpen: true };
  const update = useCallback(
    (change: Partial<Preferences>) => {
      setState((s) => {
        const previous =
          s.scope === scope ? s : { scope, ...defaults, widePanelOpen: true };
        const next = { ...previous, ...change };
        if (!viewport.narrow && change.panelOpen !== undefined)
          next.widePanelOpen = change.panelOpen;
        try {
          if (key)
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarCollapsed: next.sidebarCollapsed,
                panelOpen: next.widePanelOpen,
                panelWidth: next.panelWidth,
              }),
            );
        } catch {
          /* Private mode / quota: retain in-memory preference. */
        }
        return next;
      });
    },
    [key, scope, viewport.narrow],
  );
  const show = useCallback(() => update({ panelOpen: true }), [update]);
  const close = useCallback(() => update({ panelOpen: false }), [update]);
  const setPanelWidth = useCallback(
    (panelWidth: number | null) => update({ panelWidth }),
    [update],
  );
  return {
    narrow: viewport.narrow,
    compact: viewport.compact,
    sidebarCollapsed: viewport.compact
      ? !mobileSidebar
      : current.sidebarCollapsed,
    open: current.panelOpen,
    panelWidth: current.panelWidth,
    setPanelWidth,
    show,
    close,
    setSidebarCollapsed: (sidebarCollapsed: boolean) =>
      viewport.compact
        ? setMobileSidebar(!sidebarCollapsed)
        : update({ sidebarCollapsed }),
  };
}
