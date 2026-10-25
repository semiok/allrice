import { closeDatabase, getDatabase } from './core/client.js';
import { verifyDatabase } from './verify-database.js';

try {
  console.info(await verifyDatabase(getDatabase()));
} finally {
  await closeDatabase();
}
