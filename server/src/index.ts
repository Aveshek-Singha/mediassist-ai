import { app } from './app.js';
import { env } from './config/env.js';
import { closeMongo } from './db/mongo.js';
import { closeStore } from './db/store.js';
import { logger } from './lib/logger.js';
import { bootstrap } from './bootstrap.js';
import { startDeliveryWorker, stopDeliveryWorker } from './modules/webhooks/worker.js';

let server: ReturnType<typeof app.listen> | undefined;
let shutdownWork: Promise<void> | undefined;

async function start(): Promise<void> {
  try {
    await bootstrap();
    server = app.listen(env.PORT, '0.0.0.0', () => {
      logger.info({ port: env.PORT, storage: env.DATABASE_URL ? 'postgres' : 'file' }, 'MediAssist API ready');
      startDeliveryWorker();
    });
    server.on('error', (error) => {
      logger.fatal({ errorType: error.name, code: (error as NodeJS.ErrnoException).code }, 'API listener failed');
      process.exitCode = 1;
      void shutdown('listener-error');
    });
  } catch (error) {
    logger.fatal({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Backend startup failed');
    await Promise.allSettled([closeMongo(), closeStore()]);
    process.exitCode = 1;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shutdownWork) return shutdownWork;
  shutdownWork = (async () => {
    logger.info({ signal }, 'shutting down');
    const forcedExit = setTimeout(() => {
      logger.fatal('Graceful shutdown timed out; closing remaining connections.');
      server?.closeAllConnections();
      process.exit(1);
    }, 30_000);
    forcedExit.unref();
    const closeServer = server
      ? new Promise<void>((resolve) => server!.close(() => resolve()))
      : Promise.resolve();
    await Promise.allSettled([stopDeliveryWorker(), closeServer]);
    await Promise.allSettled([closeMongo(), closeStore()]);
    clearTimeout(forcedExit);
  })();
  return shutdownWork;
}

await start();
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('unhandledRejection', () => {
  logger.fatal('Unhandled promise rejection; starting graceful shutdown.');
  void shutdown('unhandled-rejection');
});
