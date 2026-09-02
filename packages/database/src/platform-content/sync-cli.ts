import { closeDatabase } from '../core/client.js';
import { loadPlatformContentCatalog } from './catalog.js';
import { synchronizePlatformContent } from './sync.js';

try {
  const catalog = await loadPlatformContentCatalog();
  const result = await synchronizePlatformContent(catalog);
  console.info(
    `[content] platform Skills synchronized: ${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged, ${result.unmanaged} unmanaged`,
  );
  console.info(`[content] catalog ${result.catalogChecksum}`);
} finally {
  await closeDatabase();
}
