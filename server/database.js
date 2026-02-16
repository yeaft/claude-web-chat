import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 数据库文件位置
const DATA_DIR = process.env.TEST_DB_DIR || join(__dirname, '../data');
const DB_PATH = process.env.TEST_DB_PATH || join(DATA_DIR, 'webchat.db');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 创建数据库连接
const db = new Database(DB_PATH);

// 启用 WAL 模式提高性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 初始化表结构（不包含索引，索引在迁移后创建）
db.exec(`
  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  -- 会话表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent_name TEXT,
    claude_session_id TEXT,
    work_dir TEXT,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
  );

  -- 消息表
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT,
    tool_name TEXT,
    tool_input TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 邀请码表
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_by TEXT,
    used_at INTEGER,
    expires_at INTEGER NOT NULL,
    role TEXT DEFAULT 'user',
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
  );

  -- 基本索引（不依赖迁移列）
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

// 数据库迁移 - 添加缺失的列
const migrations = [
  // 添加 user_id 到 sessions
  `ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)`,
  // 添加 TOTP 字段到 users
  `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
  `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0`,
  // 多用户 + Agent 绑定改造
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN email TEXT`,
  `ALTER TABLE users ADD COLUMN agent_secret TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`
];

for (const migration of migrations) {
  try {
    db.exec(migration);
  } catch (e) {
    // 列已存在，忽略错误
  }
}

// 创建依赖迁移列的索引（在迁移后）
const postMigrationIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_agent_secret ON users(agent_secret)`
];
for (const idx of postMigrationIndexes) {
  try { db.exec(idx); } catch (e) { /* 索引已存在 */ }
}

// 生成用户级 Agent 密钥
function generateAgentSecret() {
  return randomBytes(32).toString('hex');
}

// 生成用户 ID
function generateUserId() {
  return `user_${randomUUID()}`;
}

// 准备常用语句
const stmts = {
  // User 操作
  insertUser: db.prepare(`
    INSERT INTO users (id, username, display_name, created_at)
    VALUES (?, ?, ?, ?)
  `),

  insertUserFull: db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, email, agent_secret, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateUserLogin: db.prepare(`
    UPDATE users SET last_login_at = ? WHERE id = ?
  `),

  updateUserPassword: db.prepare(`
    UPDATE users SET password_hash = ? WHERE id = ?
  `),

  updateUserEmail: db.prepare(`
    UPDATE users SET email = ? WHERE id = ?
  `),

  updateUserAgentSecret: db.prepare(`
    UPDATE users SET agent_secret = ? WHERE id = ?
  `),

  updateUserRole: db.prepare(`
    UPDATE users SET role = ? WHERE id = ?
  `),

  updateUserMigrate: db.prepare(`
    UPDATE users SET password_hash = ?, email = ?, role = ?, agent_secret = COALESCE(agent_secret, ?) WHERE id = ?
  `),

  getUserById: db.prepare(`
    SELECT * FROM users WHERE id = ?
  `),

  getUserByUsername: db.prepare(`
    SELECT * FROM users WHERE username = ?
  `),

  getUserByAgentSecret: db.prepare(`
    SELECT * FROM users WHERE agent_secret = ?
  `),

  getAllUsers: db.prepare(`
    SELECT * FROM users ORDER BY created_at DESC
  `),

  updateUserTotp: db.prepare(`
    UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE username = ?
  `),

  getUserTotp: db.prepare(`
    SELECT totp_secret, totp_enabled FROM users WHERE username = ?
  `),

  // Invitation 操作
  insertInvitation: db.prepare(`
    INSERT INTO invitations (id, created_by, created_at, expires_at, role)
    VALUES (?, ?, ?, ?, ?)
  `),

  getInvitation: db.prepare(`
    SELECT * FROM invitations WHERE id = ?
  `),

  useInvitation: db.prepare(`
    UPDATE invitations SET used_by = ?, used_at = ? WHERE id = ?
  `),

  getInvitationsByUser: db.prepare(`
    SELECT i.*, u.username AS used_by_username
    FROM invitations i
    LEFT JOIN users u ON i.used_by = u.id
    WHERE i.created_by = ?
    ORDER BY i.created_at DESC
  `),

  deleteInvitation: db.prepare(`
    DELETE FROM invitations WHERE id = ? AND created_by = ? AND used_by IS NULL
  `),

  cleanupExpiredInvitations: db.prepare(`
    DELETE FROM invitations WHERE expires_at < ? AND used_by IS NULL
  `),

  // Session 操作
  insertSession: db.prepare(`
    INSERT INTO sessions (id, user_id, agent_id, agent_name, claude_session_id, work_dir, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateSession: db.prepare(`
    UPDATE sessions SET
      claude_session_id = COALESCE(?, claude_session_id),
      title = COALESCE(?, title),
      updated_at = ?
    WHERE id = ?
  `),

  updateSessionActive: db.prepare(`
    UPDATE sessions SET is_active = ?, updated_at = ? WHERE id = ?
  `),

  getSession: db.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `),

  getSessionsByAgent: db.prepare(`
    SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getSessionsByUser: db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getSessionsByUserAndAgent: db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getAllSessions: db.prepare(`
    SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?
  `),

  getActiveSessions: db.prepare(`
    SELECT * FROM sessions WHERE is_active = 1 ORDER BY updated_at DESC
  `),

  deleteSession: db.prepare(`
    DELETE FROM sessions WHERE id = ?
  `),

  // Message 操作
  insertMessage: db.prepare(`
    INSERT INTO messages (session_id, role, content, message_type, tool_name, tool_input, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  getMessagesBySession: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC
  `),

  getRecentMessages: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `),

  getMessagesAfterId: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY created_at ASC
  `),

  getMessagesBeforeId: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND id < ?
    ORDER BY id DESC LIMIT ?
  `),

  getMessageCount: db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE session_id = ?
  `),

  deleteMessagesBySession: db.prepare(`
    DELETE FROM messages WHERE session_id = ?
  `)
};

// 定期清理过期邀请码（每小时）
setInterval(() => {
  try { stmts.cleanupExpiredInvitations.run(Date.now()); } catch (e) { /* ignore */ }
}, 60 * 60 * 1000);

// 导出数据库操作函数
export const userDb = {
  // 创建或获取用户（自动创建如果不存在）— 保持向后兼容
  getOrCreate(username, displayName = null) {
    let user = stmts.getUserByUsername.get(username);
    if (!user) {
      const id = generateUserId();
      const now = Date.now();
      stmts.insertUser.run(id, username, displayName || username, now);
      user = { id, username, display_name: displayName || username, created_at: now };
    }
    return user;
  },

  // 创建完整用户（含密码、邮箱、角色、agent_secret）
  createFull(username, passwordHash, email = null, role = 'user') {
    const id = generateUserId();
    const now = Date.now();
    const agentSecret = generateAgentSecret();
    stmts.insertUserFull.run(id, username, username, passwordHash, email, agentSecret, role, now);
    return { id, username, display_name: username, password_hash: passwordHash, email, agent_secret: agentSecret, role, created_at: now };
  },

  // 迁移用户：从 AUTH_USERS/users.json 同步到数据库
  migrateUser(username, passwordHash, email, role = 'admin') {
    const existing = stmts.getUserByUsername.get(username);
    if (existing) {
      if (existing.password_hash) {
        // 已迁移，跳过
        return existing;
      }
      // 存在但无密码（之前通过 getOrCreate 自动创建的），更新字段
      const newSecret = generateAgentSecret();
      stmts.updateUserMigrate.run(passwordHash, email, role, newSecret, existing.id);
      return { ...existing, password_hash: passwordHash, email, role, agent_secret: existing.agent_secret || newSecret };
    }
    // 不存在，创建
    return this.createFull(username, passwordHash, email, role);
  },

  // 获取用户（通过 ID）
  get(id) {
    return stmts.getUserById.get(id);
  },

  // 获取用户（通过用户名）
  getByUsername(username) {
    return stmts.getUserByUsername.get(username);
  },

  // 根据 agent_secret 查找用户（Agent 认证用）
  getUserByAgentSecret(secret) {
    if (!secret) return null;
    return stmts.getUserByAgentSecret.get(secret) || null;
  },

  // 获取所有用户
  getAll() {
    return stmts.getAllUsers.all();
  },

  // 更新最后登录时间
  updateLogin(id) {
    stmts.updateUserLogin.run(Date.now(), id);
  },

  // 更新密码
  updatePassword(userId, passwordHash) {
    stmts.updateUserPassword.run(passwordHash, userId);
  },

  // 更新邮箱
  updateEmail(userId, email) {
    stmts.updateUserEmail.run(email, userId);
  },

  // 获取用户的 Agent 密钥
  getAgentSecret(userId) {
    const user = stmts.getUserById.get(userId);
    return user?.agent_secret || null;
  },

  // 重置 Agent 密钥
  resetAgentSecret(userId) {
    const newSecret = generateAgentSecret();
    stmts.updateUserAgentSecret.run(newSecret, userId);
    return newSecret;
  },

  // 更新角色
  updateRole(userId, role) {
    stmts.updateUserRole.run(role, userId);
  },

  // 获取用户 TOTP 设置
  getTotp(username) {
    const result = stmts.getUserTotp.get(username);
    if (result) {
      return {
        totpSecret: result.totp_secret,
        totpEnabled: !!result.totp_enabled
      };
    }
    return null;
  },

  // 更新用户 TOTP 设置
  updateTotp(username, totpSecret, totpEnabled) {
    // 确保用户存在
    let user = stmts.getUserByUsername.get(username);
    if (!user) {
      const id = generateUserId();
      const now = Date.now();
      stmts.insertUser.run(id, username, username, now);
    }
    stmts.updateUserTotp.run(totpSecret, totpEnabled ? 1 : 0, username);
    return true;
  }
};

// 邀请码数据库操作
export const invitationDb = {
  // 创建邀请码
  create(createdBy, role = 'user', expiresInMs = 7 * 24 * 60 * 60 * 1000) {
    const code = randomBytes(6).toString('hex'); // 12 字符
    const now = Date.now();
    const expiresAt = now + expiresInMs;
    stmts.insertInvitation.run(code, createdBy, now, expiresAt, role);
    return { code, createdBy, createdAt: now, expiresAt, role };
  },

  // 查询邀请码
  get(code) {
    return stmts.getInvitation.get(code) || null;
  },

  // 标记已使用
  use(code, usedBy) {
    stmts.useInvitation.run(usedBy, Date.now(), code);
  },

  // 查询用户创建的邀请码
  getByUser(userId) {
    return stmts.getInvitationsByUser.all(userId);
  },

  // 删除未使用的邀请码（只能删自己创建的）
  delete(code, userId) {
    const result = stmts.deleteInvitation.run(code, userId);
    return result.changes > 0;
  },

  // 清理过期邀请码
  cleanup() {
    stmts.cleanupExpiredInvitations.run(Date.now());
  }
};

export const sessionDb = {
  // 创建新会话
  create(id, agentId, agentName, workDir, claudeSessionId = null, title = null, userId = null) {
    const now = Date.now();
    stmts.insertSession.run(id, userId, agentId, agentName, claudeSessionId, workDir, title, now, now);
    return { id, userId, agentId, agentName, workDir, claudeSessionId, title, createdAt: now, updatedAt: now };
  },

  // 更新会话
  update(id, updates = {}) {
    const now = Date.now();
    stmts.updateSession.run(
      updates.claudeSessionId ?? null,
      updates.title ?? null,
      now,
      id
    );
  },

  // 设置会话活跃状态
  setActive(id, active) {
    stmts.updateSessionActive.run(active ? 1 : 0, Date.now(), id);
  },

  // 获取单个会话
  get(id) {
    return stmts.getSession.get(id);
  },

  // 获取指定 agent 的会话列表
  getByAgent(agentId, limit = 50) {
    return stmts.getSessionsByAgent.all(agentId, limit);
  },

  // 获取指定用户的会话列表
  getByUser(userId, limit = 50) {
    return stmts.getSessionsByUser.all(userId, limit);
  },

  // 获取指定用户和 agent 的会话列表
  getByUserAndAgent(userId, agentId, limit = 50) {
    return stmts.getSessionsByUserAndAgent.all(userId, agentId, limit);
  },

  // 获取所有会话
  getAll(limit = 100) {
    return stmts.getAllSessions.all(limit);
  },

  // 获取活跃会话
  getActive() {
    return stmts.getActiveSessions.all();
  },

  // 删除会话
  delete(id) {
    stmts.deleteSession.run(id);
  },

  // 检查会话是否存在
  exists(id) {
    return !!stmts.getSession.get(id);
  }
};

export const messageDb = {
  // 添加消息
  add(sessionId, role, content, messageType = null, toolName = null, toolInput = null) {
    const now = Date.now();
    const result = stmts.insertMessage.run(sessionId, role, content, messageType, toolName, toolInput, now);
    // 更新会话的 updated_at
    stmts.updateSession.run(null, null, now, sessionId);
    return result.lastInsertRowid;
  },

  // 获取会话的所有消息
  getBySession(sessionId) {
    return stmts.getMessagesBySession.all(sessionId);
  },

  // 获取会话的最近 N 条消息
  getRecent(sessionId, limit = 50) {
    return stmts.getRecentMessages.all(sessionId, limit).reverse();
  },

  // 获取指定 ID 之后的消息（用于重连同步）
  getAfterId(sessionId, afterId) {
    return stmts.getMessagesAfterId.all(sessionId, afterId || 0);
  },

  // 获取指定 ID 之前的消息（向上分页）
  getBeforeId(sessionId, beforeId, limit = 50) {
    return stmts.getMessagesBeforeId.all(sessionId, beforeId, limit).reverse();
  },

  // 获取消息总数
  getCount(sessionId) {
    return stmts.getMessageCount.get(sessionId)?.count || 0;
  },

  // 删除会话的所有消息
  deleteBySession(sessionId) {
    stmts.deleteMessagesBySession.run(sessionId);
  }
};

// 关闭数据库连接（用于优雅退出）
export function closeDb() {
  db.close();
}

// 进程退出时关闭数据库
process.on('exit', closeDb);
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

export default db;
