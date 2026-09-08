interface BridgeRefreshRequest {
  scope: string;
  controller: AbortController;
  interactive: boolean;
}

/** Latest request wins within a tenant/workspace; polling cannot preempt a click. */
export class BridgeRefreshCoordinator {
  private scope: string | null = null;
  private active: BridgeRefreshRequest | null = null;
  private generation = 0;

  reset(scope: string | null) {
    this.active?.controller.abort();
    this.active = null;
    this.scope = scope;
    this.generation++;
  }

  capture(scope: string) {
    if (scope !== this.scope) return null;
    const generation = this.generation;
    return () => this.scope === scope && this.generation === generation;
  }

  start(scope: string, interactive: boolean) {
    if (scope !== this.scope || (!interactive && this.active)) return null;
    this.active?.controller.abort();
    const request = {
      scope,
      interactive,
      controller: new AbortController(),
    };
    this.active = request;
    return request;
  }

  isCurrent(request: BridgeRefreshRequest) {
    return this.active === request && this.scope === request.scope;
  }

  finish(request: BridgeRefreshRequest) {
    if (this.isCurrent(request)) this.active = null;
  }
}
