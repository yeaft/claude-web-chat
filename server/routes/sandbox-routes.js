import { userDb } from '../database.js';
import { containerAgentService } from '../container-agent-service.js';

function loadUser(req) {
  let user = userDb.getByUsername(req.user.username);
  if (!user && req.user.username === 'dev-user') user = userDb.getOrCreate('dev-user', 'dev-user');
  return user;
}

function sendError(res, error) {
  const code = error.code || error.message || 'SANDBOX_INTERNAL_ERROR';
  const known = code.startsWith('SANDBOX_') || code.startsWith('CONTAINER_AGENT_');
  if (!known) console.error('Container Agent API error:', error);
  return res.status(known ? 409 : 500).json({ code: known ? code : 'SANDBOX_INTERNAL_ERROR' });
}

export function registerSandboxRoutes(app, { requireAuth }) {
  app.get('/api/sandbox/capability', requireAuth, (_req, res) => {
    res.json(containerAgentService.capability());
  });

  app.get('/api/sandbox', requireAuth, async (req, res) => {
    const user = loadUser(req);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    try {
      return res.json({ sandbox: await containerAgentService.snapshot(user.id) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/sandbox', requireAuth, async (req, res) => {
    const user = loadUser(req);
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
    try {
      const agentSecret = userDb.getAgentSecret(user.id) || userDb.resetAgentSecret(user.id);
      const result = await containerAgentService.create({ ...user, agent_secret: agentSecret }, {
        agentName: req.body?.agentName,
      });
      return res.status(201).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  for (const action of ['start', 'stop', 'retry', 'remove']) {
    app.post(`/api/sandbox/${action}`, requireAuth, async (req, res) => {
      const user = loadUser(req);
      if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND' });
      try {
        return res.json(await containerAgentService.action(user.id, action));
      } catch (error) {
        return sendError(res, error);
      }
    });
  }
}
