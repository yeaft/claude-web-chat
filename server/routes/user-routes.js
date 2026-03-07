import { CONFIG } from '../config.js';
import { hashPassword } from '../auth.js';
import { userDb, sessionDb } from '../database.js';

// 过滤用户敏感字段
function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    last_login_at: user.last_login_at
  };
}

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
 * Register user profile, agent secret, and admin user management routes.
 */
export function registerUserRoutes(app, { requireAuth, requireAdmin }) {
  // Get my profile
  app.get('/api/user/profile', requireAuth, (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        role: user.role === 'admin' ? 'admin' : 'pro',
        createdAt: user.created_at
      });
    } catch (err) {
      console.error('Get profile error:', err);
      res.status(500).json({ error: 'Failed to get profile' });
    }
  });

  // Update my profile (password and/or email)
  app.put('/api/user/profile', requireAuth, async (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { currentPassword, newPassword, email } = req.body;

      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' });
      }

      const bcryptModule = await import('bcrypt');
      const passwordValid = await bcryptModule.default.compare(currentPassword, user.password_hash);
      if (!passwordValid) {
        return res.status(403).json({ error: 'Current password is incorrect' });
      }

      if (newPassword) {
        if (newPassword.length < 6) {
          return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }
        const newHash = await hashPassword(newPassword);
        userDb.updatePassword(user.id, newHash);
      }

      if (email !== undefined) {
        userDb.updateEmail(user.id, email || null);
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  // Get my agent secret
  app.get('/api/user/agent-secret', requireAuth, (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ agentSecret: user.agent_secret || null });
    } catch (err) {
      console.error('Get agent secret error:', err);
      res.status(500).json({ error: 'Failed to get agent secret' });
    }
  });

  // Reset my agent secret
  app.post('/api/user/agent-secret/reset', requireAuth, (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const newSecret = userDb.resetAgentSecret(user.id);
      res.json({ agentSecret: newSecret });
    } catch (err) {
      console.error('Reset agent secret error:', err);
      res.status(500).json({ error: 'Failed to reset agent secret' });
    }
  });

  // Admin: list all users
  app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = userDb.getAll().map(sanitizeUser);
      res.json({ users });
    } catch (e) {
      console.error('Failed to get users:', e.message);
      res.status(500).json({ error: 'Failed to get users' });
    }
  });

  // Admin: get user by id
  app.get('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    try {
      const user = userDb.get(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user: sanitizeUser(user) });
    } catch (e) {
      console.error('Failed to get user:', e.message);
      res.status(500).json({ error: 'Failed to get user' });
    }
  });

  // Admin: get user's sessions
  app.get('/api/users/:id/sessions', requireAuth, requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const agentId = req.query.agentId;
    try {
      const sessions = agentId
        ? sessionDb.getByUserAndAgent(req.params.id, agentId, limit)
        : sessionDb.getByUser(req.params.id, limit);
      res.json({ sessions: sessions.map(transformSession) });
    } catch (e) {
      console.error('Failed to get user sessions:', e.message);
      res.status(500).json({ error: 'Failed to get user sessions' });
    }
  });
}
