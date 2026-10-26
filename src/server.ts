import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createServices } from './container.js';
import { createLogger } from './logger.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Problems list names variables only, never values.
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const services = createServices(config, logger);
  const app = buildApp({
    logLevel: config.logLevel,
    logger,
    webhookSecret: config.fireflies.webhookSecret!,
    ...services,
  });

  logger.info(
    {
      event: 'service.starting',
      appMode: config.appMode,
      dryRun: config.dryRun,
      storeBackend: config.storeBackend,
      queueBackend: config.queueBackend,
      tokenStoreBackend: config.tokenStoreBackend,
      approvedRules: config.meetingRules.map((r) => r.name),
      oauthEnabled: Boolean(services.oauth),
    },
    config.meetingRules.length === 0 ? 'no meeting rules configured: nothing will be posted' : 'starting',
  );

  const shutdown = async (signal: string) => {
    logger.info({ event: 'service.stopping', signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
