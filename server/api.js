import { randomUUID } from 'crypto';
import multer from 'multer';
import { CONFIG, isEmailConfigured, isTotpEnabled } from './config.js';
import { loginStep1, loginStep2, verifyToken, logout, verifyTotpStep, completeTotpSetup, register, hashPassword } from './auth.js';
import { sessionDb, messageDb, userDb, invitationDb } from './database.js';
import { pendingFiles, previewFiles } from './context.js';

// 登录速率限制: IP -> { attempts, resetAt }
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 分钟窗口

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { attempts: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  record.attempts++;
  return record.attempts <= LOGIN_MAX_ATTEMPTS;
}

// 定期清理过期的速率限制记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

// 文件上传配置 (存储在内存中)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.maxFileSize }
});

// 定期清理超过 10 分钟的文件
setInterval(() => {
  const now = Date.now();
  for (const [fileId, file] of pendingFiles) {
    if (now - file.uploadedAt > CONFIG.fileCleanupInterval) {
      pendingFiles.delete(fileId);
    }
  }
}, 60 * 1000);

/**
 * Middleware to verify JWT token for protected API routes
 */
function requireAuth(req, res, next) {
  if (CONFIG.skipAuth) {
    req.user = { username: 'dev-user', role: 'admin' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.replace('Bearer ', '');
  const result = verifyToken(token);

  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = { username: result.username, role: result.role || 'user' };
  next();
}

/**
 * Middleware to require admin role
 */
function requireAdmin(req, res, next) {
  if (CONFIG.skipAuth) return next();
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

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

export function registerApiRoutes(app) {
  // =====================
  // Authentication API
  // =====================

  app.get('/api/auth/mode', (req, res) => {
    res.json({
      skipAuth: CONFIG.skipAuth,
      emailVerification: isEmailConfigured(),
      totpEnabled: isTotpEnabled(),
      registrationEnabled: !CONFIG.skipAuth
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many login attempts, please try again later' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    try {
      const result = await loginStep1(username, password);
      res.json(result);
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  app.post('/api/auth/verify', (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ success: false, error: 'Token and code are required' });
    }
    const result = loginStep2(tempToken, code);
    res.json(result);
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      logout(token);
    }
    res.json({ success: true });
  });

  app.post('/api/auth/verify-totp', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { tempToken, totpCode } = req.body;
    if (!tempToken || !totpCode) {
      return res.status(400).json({ success: false, error: 'Token and TOTP code are required' });
    }
    try {
      const result = await verifyTotpStep(tempToken, totpCode);
      res.json(result);
    } catch (err) {
      console.error('TOTP verification error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  app.post('/api/auth/setup-totp', async (req, res) => {
    const { setupToken, totpCode } = req.body;
    if (!setupToken || !totpCode) {
      return res.status(400).json({ success: false, error: 'Setup token and TOTP code are required' });
    }
    try {
      const result = await completeTotpSetup(setupToken, totpCode);
      res.json(result);
    } catch (err) {
      console.error('TOTP setup error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Registration (public - requires invitation code)
  app.post('/api/auth/register', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { username, password, email, invitationCode } = req.body;
    try {
      const result = await register(username, password, email, invitationCode);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error('Registration error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // =====================
  // Invitation API (admin only)
  // =====================

  // Create invitation code
  app.post('/api/invitations', requireAuth, requireAdmin, (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }
      const role = req.body.role || 'user';
      if (!['user', 'pro'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be "user" or "pro"' });
      }
      const expiresInDays = parseInt(req.body.expiresInDays, 10) || 7;
      const expiresInMs = expiresInDays * 24 * 60 * 60 * 1000;
      const invitation = invitationDb.create(user.id, role, expiresInMs);
      res.json(invitation);
    } catch (err) {
      console.error('Create invitation error:', err);
      res.status(500).json({ error: 'Failed to create invitation' });
    }
  });

  // List my invitations
  app.get('/api/invitations', requireAuth, requireAdmin, (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }
      const invitations = invitationDb.getByUser(user.id);
      res.json({ invitations });
    } catch (err) {
      console.error('List invitations error:', err);
      res.status(500).json({ error: 'Failed to list invitations' });
    }
  });

  // Delete unused invitation
  app.delete('/api/invitations/:code', requireAuth, requireAdmin, (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }
      const deleted = invitationDb.delete(req.params.code, user.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Invitation not found or already used' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('Delete invitation error:', err);
      res.status(500).json({ error: 'Failed to delete invitation' });
    }
  });

  // =====================
  // User Profile & Agent Secret API
  // =====================

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
        role: user.role || 'user',
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

      // Require current password for any profile change
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

  // =====================
  // File Upload
  // =====================

  app.post('/api/upload', requireAuth, upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const user = userDb.getOrCreate(req.user.username);
    const userId = user?.id;

    const uploaded = req.files.map(file => {
      const fileId = randomUUID();
      pendingFiles.set(fileId, {
        name: file.originalname,
        mimeType: file.mimetype,
        buffer: file.buffer,
        uploadedAt: Date.now(),
        userId
      });
      return {
        fileId,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size
      };
    });

    res.json({ files: uploaded });
  });

  // =====================
  // Session History API
  // =====================

  app.get('/api/sessions', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    const agentId = req.query.agentId;

    try {
      // 非 admin 用户只能查看自己的 sessions
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

  // =====================
  // Users API
  // =====================

  app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = userDb.getAll().map(sanitizeUser);
      res.json({ users });
    } catch (e) {
      console.error('Failed to get users:', e.message);
      res.status(500).json({ error: 'Failed to get users' });
    }
  });

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

  // =====================
  // File Preview (binary file preview for Office/PDF/Image)
  // =====================

  // Cleanup expired preview files every 60s (10 min TTL)
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, f] of previewFiles) {
      if (f.createdAt < cutoff) previewFiles.delete(id);
    }
  }, 60 * 1000);

  app.get('/api/preview/:fileId', (req, res) => {
    const file = previewFiles.get(req.params.fileId);
    if (!file) return res.status(404).send('File not found or expired');
    if (file.token && req.query.token !== file.token) {
      return res.status(403).send('Forbidden');
    }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.buffer);
  });
}
