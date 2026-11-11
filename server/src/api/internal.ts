/**
 * POST /internal/mediamtx-auth: the MediaMTX HTTP auth hook (127.0.0.1 only).
 * 200 allows the action: with an empty body for the internal user, with {"expireAt": ISO time} for a
 * live viewer (MediaMTX closes that session then). 401 denies it. Rules: server/src/media/auth-hook.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../contracts.ts';
import { isDirectLoopback, mediamtxAuthDecision } from '../media/auth-hook.ts';

export function registerInternalRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, auth, secrets } = deps;
  const cameraStmt = db.prepare('SELECT location_id FROM cameras WHERE id = ?');

  app.post('/internal/mediamtx-auth', async (req: FastifyRequest, reply: FastifyReply) => {
    const decision = mediamtxAuthDecision(isDirectLoopback(req.socket?.remoteAddress, req.headers), req.body, {
      internalUser: secrets.mediamtxUser,
      internalPassword: secrets.mediamtxPassword,
      streamTokenKey: secrets.streamTokenKey,
      cameraLocationId(cameraId) {
        const row = cameraStmt.get(cameraId) as { location_id: number } | undefined;
        return row ? row.location_id : null;
      },
      userCanStillView: (userId, locationId) => auth.userCanStillView(userId, locationId),
      now: Date.now,
    });
    reply.header('cache-control', 'no-store');
    if (!decision.allow) return reply.code(401).send();
    if (decision.expireAt === null) return reply.code(200).send();
    return reply.code(200).type('application/json').send(JSON.stringify({ expireAt: new Date(decision.expireAt).toISOString() }));
  });
}
