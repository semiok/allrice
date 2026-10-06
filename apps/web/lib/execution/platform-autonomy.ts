/** MET167 currently delivers diagnosis and reports only. Re-enabling source,
 * review or repository writes requires a separately authorized change. */
export function platformAutonomyPaused(): boolean {
  return true;
}

export function deferredPlatformActionResponse() {
  return Response.json(
    { error: 'platform_autonomous_actions_deferred' },
    { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
