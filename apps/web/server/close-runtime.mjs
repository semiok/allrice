/** Keep HTTP/Next/database available while already-started Bridge loopback work
 * drains. Every gateway latches stop before we wait for any of them. */
export function createWebRuntimeClose({
  server,
  cloudPreview,
  lifecycle,
  app,
  closeDatabase,
}) {
  let closing;
  return () => {
    if (closing) return closing;
    const pending = [server.previewGateway, cloudPreview, server.bridgeGateway]
      .filter(Boolean)
      .map((gateway) => {
        try {
          return gateway.close();
        } catch (error) {
          return Promise.reject(error);
        }
      });
    closing = (async () => {
      const results = await Promise.allSettled(pending);
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await lifecycle.waitForCurrentRoots();
      if (results.some((result) => result.status === 'rejected'))
        throw Error('WEB_GATEWAY_CLEANUP_UNCONFIRMED');
      await app.close();
      await closeDatabase();
    })();
    return closing;
  };
}
