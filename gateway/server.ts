import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from '../data/storage/database.js';
import { initCache, closeCache } from '../data/storage/cache.js';
import { initObjects } from '../data/storage/objects.js';
import { stopTelemetry } from '../observability/telemetry.js';
import { initAuth } from '../security/auth/schema.js';
let store = new Store();
try { await store.init(); }
catch (error) {
  if (config.NODE_ENV !== 'development' || !config.DATABASE_URL || config.AUTH_MODE === 'native') throw error;
  console.warn('PostgreSQL indisponível; usando SQLite local no modo de desenvolvimento.');
  await store.close();
  store = new Store('', config.DATA_DIR);
  await store.init();
}
await initAuth(store);
await initObjects(); await initCache();
const { app, ingestion, webImports } = createApp(store);
void ingestion.resumeEmbeddings().catch(() => console.warn('Não foi possível retomar a indexação vetorial. A busca textual continua disponível.'));
const server = app.listen(config.PORT, config.HOST, () => {
  console.log('LUMINA disponível em http://' + config.HOST + ':' + config.PORT);
  console.log(config.AUTH_MODE === 'local' ? 'Modo local de desenvolvimento, sem autenticação. Não exponha à rede.' : 'Autenticação ' + config.AUTH_MODE + ' ativa · ' + store.storageName);
});
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  server.close(async () => { await webImports.close(); await ingestion.idle(); await closeCache(); await stopTelemetry(); await store.close(); process.exit(0); });
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
