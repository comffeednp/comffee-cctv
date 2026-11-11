/**
 * Hub entry point.
 *   node server/src/main.ts              runs the hub
 *   node server/src/main.ts <command>    runs a command line tool (see cli.ts) and exits
 *
 * Start order: config -> database -> secrets -> box -> audit -> auth -> connectors -> media ->
 * Fastify app -> routes -> listen -> connectors.start() -> media.start(). Stop runs in reverse.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { AppDeps, HubConfig, RegisterRoutes } from './contracts.ts';
import { createAuditWriter } from './audit.ts';
import { pruneChallenges } from './auth/challenges.ts';
import { createAuth } from './auth/service.ts';
import { pruneSessions } from './auth/sessions.ts';
import { pruneSetupCodes } from './auth/setup-codes.ts';
import { pruneIpFailures } from './auth/throttle.ts';
import { runCli } from './cli.ts';
import { loadConfig } from './config.ts';
import { createBox } from './crypto/box.ts';
import { dbFile, openDatabase } from './db.ts';
import { createHttpApp } from './http.ts';
import { loadOrCreateSecrets } from './secrets.ts';
import { registerAuditRoutes } from './api/audit.ts';
import { registerAuthRoutes } from './api/auth.ts';
import { registerCameraRoutes } from './api/cameras.ts';
import { registerInternalRoutes } from './api/internal.ts';
import { registerKeyRoutes } from './api/keys.ts';
import { registerLiveRoutes } from './api/live.ts';
import { registerLocationRoutes } from './api/locations.ts';
import { registerMeRoutes } from './api/me.ts';
import { registerRecordingRoutes } from './api/recordings.ts';
import { registerSetupRoutes } from './api/setup.ts';
import { registerStorageRoutes } from './api/storage.ts';
import { registerUserRoutes } from './api/users.ts';
import { createMediaManager } from './media/manager.ts';
import { registerBridgeSocket } from './sites/bridge-hub.ts';
import { createConnectorService } from './sites/connectors.ts';

/** Every route module, in registration order. */
export const ROUTE_MODULES: RegisterRoutes[] = [
  registerSetupRoutes,
  registerAuthRoutes,
  registerMeRoutes,
  registerUserRoutes,
  registerAuditRoutes,
  registerKeyRoutes,
  registerLocationRoutes,
  registerCameraRoutes,
  registerLiveRoutes,
  registerRecordingRoutes,
  registerStorageRoutes,
  registerInternalRoutes,
  registerBridgeSocket,
];

const HOUSEKEEPING_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 15_000;

export interface RunningHub {
  app: FastifyInstance;
  deps: AppDeps;
  stop(): Promise<void>;
}

/** Deletes expired sessions, challenges, failure rows and used setup codes. */
export function housekeeping(db: DatabaseSync, now: number = Date.now()): void {
  pruneSessions(db, now);
  pruneChallenges(db, now);
  pruneIpFailures(db, now);
  pruneSetupCodes(db, now);
}

export interface StartOptions {
  config?: HubConfig;
  logger?: FastifyServerOptions['logger'];
}

export async function startHub(opts: StartOptions = {}): Promise<RunningHub> {
  const config = opts.config ?? loadConfig();
  const db = openDatabase(dbFile(config.dataDir));
  const cleanups: (() => Promise<void> | void)[] = [() => db.close()];
  const runCleanups = async (): Promise<void> => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      try {
        await fn();
      } catch (err) {
        console.error('shutdown step failed:', (err as Error).message);
      }
    }
  };

  try {
    const secrets = loadOrCreateSecrets(config.dataDir);
    const box = createBox(secrets.masterKey);
    const audit = createAuditWriter(db);
    const auth = createAuth({ db, config, box });
    const connectors = createConnectorService({ db, config, secrets, box, audit });
    const media = createMediaManager({ db, config, secrets, box, auth, audit, connectors });
    const deps: AppDeps = { db, config, secrets, box, auth, audit, media, connectors };

    housekeeping(db);
    const timer = setInterval(() => {
      try {
        housekeeping(db);
      } catch (err) {
        console.error('housekeeping failed:', (err as Error).message);
      }
    }, HOUSEKEEPING_MS);
    timer.unref();
    cleanups.push(() => clearInterval(timer));

    const app = await createHttpApp(config, {
      logger: opts.logger ?? { level: process.env.CCTV_LOG_LEVEL || 'info' },
    });
    cleanups.push(() => app.close());
    for (const register of ROUTE_MODULES) await register(app, deps);

    await app.listen({ host: config.listenHost, port: config.listenPort });

    cleanups.push(() => connectors.stop());
    await connectors.start();
    cleanups.push(() => media.stop());
    await media.start();

    let stopping: Promise<void> | null = null;
    return {
      app,
      deps,
      stop() {
        stopping ??= runCleanups();
        return stopping;
      },
    };
  } catch (err) {
    await runCleanups();
    throw err;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    process.exitCode = await runCli(args);
    return;
  }

  const hub = await startHub();
  let signals = 0;
  const shutdown = (signal: string): void => {
    signals += 1;
    if (signals > 1) {
      console.error(`Second ${signal}: exiting at once`);
      process.exit(1);
    }
    hub.app.log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => {
      console.error('Shutdown took too long, exiting');
      process.exit(1);
    }, STOP_TIMEOUT_MS);
    force.unref();
    hub
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('Shutdown failed:', (err as Error).message);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error((err as Error).message ?? err);
    process.exit(1);
  });
}
