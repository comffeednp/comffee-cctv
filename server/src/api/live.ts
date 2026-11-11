/**
 * POST /api/live/:cameraId/token: a 60-second token for the WHEP request of one camera.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LiveTokenResponse } from '../../../shared/api-types.ts';
import { cameraPathName } from '../contracts.ts';
import type { AppDeps } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { iso, notFound, parseIdParam } from '../media/params.ts';
import { issueLiveToken } from '../streamtoken.ts';

export function registerLiveRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, auth, secrets, audit } = deps;
  const cameraStmt = db.prepare('SELECT id, location_id FROM cameras WHERE id = ?');

  app.post('/api/live/:cameraId/token', async (req: FastifyRequest): Promise<LiveTokenResponse> => {
    const user = auth.requireUser(req);
    const cameraId = parseIdParam((req.params as Record<string, unknown>).cameraId);
    const camera = cameraStmt.get(cameraId) as { id: number; location_id: number } | undefined;
    if (!camera) throw notFound('Camera not found');
    auth.assertLocationAccess(user, camera.location_id);
    const pathName = cameraPathName(camera.id);
    const { token, expiresMs } = issueLiveToken(secrets.streamTokenKey, pathName, user.id);
    audit({ userId: user.id, username: user.username, action: 'live.start', target: `camera:${camera.id}`, ...requestMeta(req) });
    return { whepUrl: `/live/${pathName}/whep`, token, expiresAt: iso(expiresMs) };
  });
}
