/** A request's returned promise and its response lifetime are both tracked.
 * Response close alone never proves that the handler stopped writing. Bridge
 * frames, preview and detached resources remain explicit unknown coverage. */
export function createDevRequestHandler(lifecycle, handle) {
  return async (request, response) => {
    const path = request.url?.split('?')[0];
    const observer =
      ['GET', 'HEAD'].includes(request.method) &&
      ['/api/health/ready', '/api/health/live'].includes(path);
    if (!lifecycle.enabled || observer) return handle(request, response);
    let resolveResponse;
    const ended = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const done = () => resolveResponse();
    response.once('finish', done);
    response.once('close', done);
    response.once('error', done);
    const terminal = () => response.destroyed || response.writableFinished;
    // Reconcile a terminal event that happened before listeners were attached.
    if (terminal()) done();
    let entered = false;
    try {
      await lifecycle.run('canonical_admission', async () => {
        entered = true;
        // Admission can await the database while the browser disconnects. No
        // business handler has started yet, so do not dispatch on a dead socket.
        if (terminal()) {
          done();
          return;
        }
        await Promise.all([
          Promise.resolve().then(() => handle(request, response)),
          ended,
        ]);
      });
    } catch {
      if (terminal()) return;
      if (!response.headersSent)
        response.writeHead(entered ? 500 : 503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
      response.end(
        JSON.stringify({
          error: entered
            ? 'internal_server_error'
            : 'dev_maintenance_unavailable',
        }),
      );
    } finally {
      response.removeListener('finish', done);
      response.removeListener('close', done);
      response.removeListener('error', done);
    }
  };
}
