import 'dotenv/config';
import { createGameServer } from './app';

const port = Number(process.env.PORT ?? 2567);
const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const staticDir = process.env.STATIC_DIR || undefined;

const { gameServer } = await createGameServer({ port, corsOrigins, staticDir });
console.log(`WOBBLE RACERS server listening on :${port}${staticDir ? ` (serving ${staticDir})` : ''}`);

const shutdown = async () => {
  console.log('Shutting down...');
  await gameServer.gracefullyShutdown(false);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
