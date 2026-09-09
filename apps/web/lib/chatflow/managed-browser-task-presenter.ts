import type { ChatFlowEventEnvelope } from '@allrice/contracts';

export function hasBrowserWorkspaceEvents(events: ChatFlowEventEnvelope[]) {
  const tools = ['browser.workspace', 'local.browser.workspace'];
  return events.some((event) =>
    event.type.startsWith('tool.')
      ? tools.includes(String(event.payload.name))
      : event.type === 'harness.native' &&
        [
          event.payload.label,
          event.sourceEvent?.payload.name,
          event.sourceEvent?.payload.toolName,
        ].some((name) => tools.includes(String(name))),
  );
}

export function hasManagedBrowserEvents(events: ChatFlowEventEnvelope[]) {
  return events.some((event) => {
    if (event.type.startsWith('tool.')) {
      return event.payload.name === 'browser.run';
    }
    if (event.type !== 'harness.native') return false;
    const source = event.sourceEvent?.payload ?? {};
    return (
      source.name === 'browser.run' ||
      source.toolName === 'browser.run' ||
      event.payload.label === 'browser.run'
    );
  });
}

/**
 * Browser task URLs may contain private query values. The tenant timeline only
 * needs the public destination identity, so never project path/query/fragment.
 */
export function safeBrowserHost(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
