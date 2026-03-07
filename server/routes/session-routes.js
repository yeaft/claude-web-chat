import { CONFIG } from '../config.js';
import { sessionDb, messageDb, userDb } from '../database.js';

// 转换数据库会话记录为前端期望的格式
function transformSession(session) {
  return {
    id: session.id,
    agentId: session.agent_id,
    agentName: session.agent_name,
    claudeSessionId: session.claude_session_id,
    workDir: session.work_dir,
    title: session.title,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    isActive: !!session.is_active,
    userId: session.user_id
  };
}

/**
 * Register session history API routes.
 */
export function registerSessionRoutes(app, { requireAuth }) {
  app.get('/api/sessions', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    const agentId = req.query.agentId;

    try {
      let effectiveUserId;
      if (CONFIG.skipAuth) {
        effectiveUserId = req.query.userId;
      } else if (req.user.role === 'admin' && req.query.userId) {
        effectiveUserId = req.query.userId;
      } else {
        const user = userDb.getByUsername(req.user.username);
        effectiveUserId = user?.id;
      }

      let sessions;
      if (effectiveUserId && agentId) {
        sessions = sessionDb.getByUserAndAgent(effectiveUserId, agentId, limit);
      } else if (effectiveUserId) {
        sessions = sessionDb.getByUser(effectiveUserId, limit);
      } else if (agentId) {
        sessions = sessionDb.getByAgent(agentId, limit);
      } else {
        sessions = sessionDb.getAll(limit);
      }
      res.json({ sessions: sessions.map(transformSession) });
    } catch (e) {
      console.error('Failed to get sessions:', e.message);
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  });

  app.get('/api/sessions/:id', requireAuth, (req, res) => {
    try {
      const session = sessionDb.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!CONFIG.skipAuth) {
        const user = userDb.getByUsername(req.user.username);
        if (session.user_id && session.user_id !== user?.id) {
          return res.status(403).json({ error: 'Permission denied' });
        }
      }
      res.json({ session: transformSession(session) });
    } catch (e) {
      console.error('Failed to get session:', e.message);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  app.get('/api/sessions/:id/messages', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    try {
      if (!CONFIG.skipAuth) {
        const session = sessionDb.get(req.params.id);
        const user = userDb.getByUsername(req.user.username);
        if (session && session.user_id && session.user_id !== user?.id) {
          return res.status(403).json({ error: 'Permission denied' });
        }
      }
      const messages = limit
        ? messageDb.getRecent(req.params.id, limit)
        : messageDb.getBySession(req.params.id);
      res.json({ messages });
    } catch (e) {
      console.error('Failed to get messages:', e.message);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });

  app.delete('/api/sessions/:id', requireAuth, (req, res) => {
    try {
      if (!CONFIG.skipAuth) {
        const session = sessionDb.get(req.params.id);
        const user = userDb.getByUsername(req.user.username);
        if (session && session.user_id && session.user_id !== user?.id) {
          return res.status(403).json({ error: 'Permission denied' });
        }
      }
      messageDb.deleteBySession(req.params.id);
      sessionDb.delete(req.params.id);
      res.json({ success: true });
    } catch (e) {
      console.error('Failed to delete session:', e.message);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });
}
