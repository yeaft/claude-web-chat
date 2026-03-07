import { userDb, invitationDb } from '../database.js';

/**
 * Register invitation-related API routes.
 */
export function registerInvitationRoutes(app, { requireAuth, requireAdmin }) {
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
}
