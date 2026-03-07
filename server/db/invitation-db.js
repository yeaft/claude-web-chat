import { randomBytes } from 'crypto';
import { stmts } from './connection.js';

// 定期清理过期邀请码（每小时）
setInterval(() => {
  try { stmts.cleanupExpiredInvitations.run(Date.now()); } catch (e) { /* ignore */ }
}, 60 * 60 * 1000);

export const invitationDb = {
  create(createdBy, role = 'user', expiresInMs = 7 * 24 * 60 * 60 * 1000) {
    const code = randomBytes(6).toString('hex'); // 12 字符
    const now = Date.now();
    const expiresAt = now + expiresInMs;
    stmts.insertInvitation.run(code, createdBy, now, expiresAt, role);
    return { code, createdBy, createdAt: now, expiresAt, role };
  },

  get(code) {
    return stmts.getInvitation.get(code) || null;
  },

  use(code, usedBy) {
    stmts.useInvitation.run(usedBy, Date.now(), code);
  },

  getByUser(userId) {
    return stmts.getInvitationsByUser.all(userId);
  },

  delete(code, userId) {
    const result = stmts.deleteInvitation.run(code, userId);
    return result.changes > 0;
  },

  cleanup() {
    stmts.cleanupExpiredInvitations.run(Date.now());
  }
};
