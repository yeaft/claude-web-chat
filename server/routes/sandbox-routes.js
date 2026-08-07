import { userDb } from '../database.js';
import { containerAgentService } from '../container-agent-service.js';

function loadUser(req, sandboxUserDb = userDb) {
  let user = sandboxUserDb.getByUsername(req.user.username);
  if (!user && req.user.username === 'dev-user') user = sandboxUserDb.getOrCreate('dev-user', 'dev-user');
  return user;
}

function sendError(res, error) {
  const code = error.code || error.message || 'SANDBOX_INTERNAL_ERROR';
  const known = code.startsWith('SANDBOX_') || code.startsWith('CONTAINER_AGENT_');
  if (!known) console.error('Container Agent API error:', error);
  return res.status(known ? 409 : 500).json({ code: known ? code : 'SANDBOX_INTERNAL_ERROR' });
}

/**
 * Register user-owned Sandbox lifecycle routes.
 *
 * @param {object} app Express-compatible route registrar
 * @param {{ requireAuth: Function, sandboxService?: object, sandboxUserDb?: object }} dependencies
 */
export function registerSandboxRoutes(app, {
  requireAuth,
  sandboxService = containerAgentService,
  sandboxUserDb = userDb,
}) {
  app.get('/api/sandbox/capability', requireAuth, async (_req, res) => {
    res.json(await sandboxService.capability());
  });

  app.get('/api/sandbox', requireAuth, async (req, res) => {
    const user = loadUser(req, sandboxUserDb);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    try {
      // Older browsers request capability and snapshot concurrently. Keep their
      // snapshot response successful when the Docker runtime is unavailable so
      // the capability reason remains visible instead of a generic load error.
      const capability = await sandboxService.capability();
      if (!capability.available) return res.json({ sandbox: null });
      return res.json({ sandbox: await sandboxService.snapshot(user.id) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/sandbox', requireAuth, async (req, res) => {
    const user = loadUser(req, sandboxUserDb);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    try {
      const agentSecret = sandboxUserDb.getAgentSecret(user.id) || sandboxUserDb.resetAgentSecret(user.id);
      const result = await sandboxService.create({ ...user, agent_secret: agentSecret }, {
        agentName: req.body?.agentName,
      });
      return res.status(201).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  for (const action of ['start', 'stop', 'retry', 'remove']) {
    app.post(`/api/sandbox/${action}`, requireAuth, async (req, res) => {
      const user = loadUser(req, sandboxUserDb);
      if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
      try {
        return res.json(await sandboxService.action(user.id, action));
      } catch (error) {
        return sendError(res, error);
      }
    });
  }
}
