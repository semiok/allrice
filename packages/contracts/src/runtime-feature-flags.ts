/** Implemented employee capabilities default on in development. Explicit 0 is
 * reserved for an operational shutdown; UI and executors share this decision. */
export const employeeRuntimeFeatureFlags = [
  'ALLRICE_WORKBENCH_ENABLED',
  'ALLRICE_ASSISTANTS_ENABLED',
  'ALLRICE_CHANGESET_ENABLED',
  'ALLRICE_LOCAL_COMMAND_ENABLED',
  'ALLRICE_LOCAL_SERVICE_ENABLED',
  'ALLRICE_LOCAL_MCP_ENABLED',
  'ALLRICE_LOCAL_BROWSER_ENABLED',
  'ALLRICE_LOCAL_PREVIEW_ENABLED',
  'ALLRICE_BROWSER_CONTROL_ENABLED',
  'ALLRICE_CLOUD_RUNNER_ENABLED',
  'ALLRICE_CLOUD_MCP_ENABLED',
  'ALLRICE_RUNTIME_POLICY_ENABLED',
  'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
  'ALLRICE_BRIDGE_WSS_ENABLED',
] as const;
export function runtimeFeatureEnabled(
  name: (typeof employeeRuntimeFeatureFlags)[number],
  environment: Record<string, string | undefined> = process.env,
) {
  return (
    environment[name] === '1' ||
    (environment[name] === undefined &&
      environment.ALLRICE_ENV === 'development')
  );
}

export function rapidEmployeeIterationEnabled() {
  return process.env.ALLRICE_ENV === 'development';
}
