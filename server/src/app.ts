import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MAX_PLAYERS, ROOM_NAME } from '@wobble/shared';
import { RaceRoom } from './RaceRoom';
import { normalizeCode } from './codes';

export interface AppOptions {
  port: number;
  corsOrigins?: string[];
  staticDir?: string;
}

export async function createGameServer(opts: AppOptions) {
  const app = express();
  const origins = opts.corsOrigins?.filter(Boolean) ?? [];
  app.use(cors(origins.length ? { origin: origins } : undefined));
  app.use(express.json({ limit: '8kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // Public room browser: includes rooms that are mid-race so players can see them.
  app.get('/api/rooms', async (_req, res) => {
    try {
      const rooms = await matchMaker.query({ name: ROOM_NAME, private: false });
      res.json(
        rooms.map((r) => ({
          code: r.roomId,
          clients: r.clients,
          maxClients: r.maxClients ?? MAX_PLAYERS,
          locked: r.locked,
          metadata: r.metadata ?? {},
        })),
      );
    } catch {
      res.status(500).json({ error: 'Could not list rooms' });
    }
  });

  // Resolve a join code (works for private rooms too) and say whether it can be joined.
  app.get('/api/rooms/:code', async (req, res) => {
    const code = normalizeCode(req.params.code);
    const [room] = await matchMaker.query({ roomId: code });
    if (!room) return res.status(404).json({ error: 'Room not found. Check the code and try again.' });
    res.json({ code: room.roomId, clients: room.clients, maxClients: room.maxClients, locked: room.locked, metadata: room.metadata });
  });

  if (opts.staticDir) app.use(express.static(opts.staticDir));

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, pingInterval: 3000, pingMaxRetries: 3 }),
  });
  gameServer.define(ROOM_NAME, RaceRoom);
  await gameServer.listen(opts.port);
  return { gameServer, httpServer, app };
}
