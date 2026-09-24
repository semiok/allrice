'use client';

import { useState, useSyncExternalStore } from 'react';
import type {
  DockIntents,
  DockLabels,
  PaneId,
  TabId,
} from '@deepseek-ai/dsh-client-ui-dockkit';
import {
  canCloseTab,
  createSidebarRightStore,
} from './dsh-upstream/dock/stores';
import { GUIDE_KIND, pageAddress } from './dsh-upstream/dock/contract/seed';

export const dockLabels: DockLabels = {
  emptyPane: '选择交付成果或文件',
  splitPane: '并排查看',
  splitPaneDisabled: '已分为两栏',
  splitPaneNarrow: '请拉宽工作台或全屏后分栏',
  closeTab: '关闭标签',
  addTab: '打开成果或文件',
  dockFloat: '放回工作台',
  closeFloat: '关闭浮动窗口',
  dropZone: {
    center: '移至此栏',
    left: '在左侧查看',
    right: '在右侧查看',
    top: '在上方查看',
    bottom: '在下方查看',
  },
};
const nativeStore = createSidebarRightStore(() => ({
  kind: GUIDE_KIND,
  title: '交付成果',
}));

/** Native state and validated persistence. Allrice only scopes it and supplies content. */
export function useNativeDock(
  scope: string,
  canClose: (id: TabId) => boolean,
  onClose: () => void,
) {
  const [store] = useState(() => {
    const instance = nativeStore.create(scope);
    instance.actions.open(scope);
    instance.actions.setExpanded(scope, true);
    return instance;
  });
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const surface = snapshot.bySession[scope]!;
  const actions = store.actions;
  const open = (
    kind: string,
    contentId: string,
    title: string,
    paneId?: PaneId,
  ) => {
    actions.openContent(
      scope,
      { kind, contentId, title, ...(paneId ? { paneId } : {}) },
      () => {},
    );
  };
  const intents: DockIntents = {
    focusTab: (id) => actions.focusTab(scope, id),
    focusPane: (id) => actions.focusPane(scope, id),
    splitPane: (id) => actions.splitPane(scope, id),
    addTab: (paneId) =>
      open(GUIDE_KIND, pageAddress(GUIDE_KIND), '交付成果', paneId),
    closeTab: (id) => {
      if (!canClose(id)) return;
      actions.closeTab(scope, id);
      if (!store.getSnapshot().bySession[scope]!.layout.expanded) onClose();
    },
    duplicateTab: (id) => actions.duplicateTab(scope, id),
    floatTab: (id, rect) => actions.floatTab(scope, id, rect),
    unfloatPane: (id) => actions.unfloatPane(scope, id),
    placeTab: (id, pane, index) => actions.placeTab(scope, id, pane, index),
    dropTab: (id, pane, zone) => actions.dropTab(scope, id, pane, zone),
    moveFloat: (id, x, y) => actions.moveFloat(scope, id, x, y),
    resizeFloat: (id, rect) => actions.resizeFloat(scope, id, rect),
    resizeSplit: (id, sizes) => actions.resizeSplit(scope, id, sizes),
  };
  return {
    surface,
    open,
    intents,
    canCloseTab: (id: TabId) => canCloseTab(surface, id),
    setFullscreen: (value: boolean) =>
      actions.setMode(scope, value ? 'fullscreen' : 'push'),
  };
}
