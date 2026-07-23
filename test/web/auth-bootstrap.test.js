import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('web authentication bootstrap contract', () => {
  it('does not render the login page before persisted authentication is resolved', () => {
    const app = read('web/app.js');

    expect(app).toContain('v-if="!authStore.initialized"');
    expect(app).toContain('v-else-if="!authStore.isAuthenticated"');
    expect(app).toContain('authStore.initialize()');
    expect(app).toContain('authStore.initialized && authStore.isAuthenticated');
    expect(app).not.toContain('await authStore.checkAuthMode()');
    expect(app).not.toContain('await authStore.restoreSession()');
  });

  it('keeps protected API authentication decisions out of individual components', () => {
    const input = read('web/components/ChatInput.js');
    const workCenter = read('web/components/WorkCenterPage.js');
    const settings = read('web/components/SettingsPanel.js');

    expect(input).not.toContain('handleAuthFailure');
    expect(input).not.toContain('handleAuthResponse');
    expect(workCenter).not.toContain('handleAuthFailure');
    expect(workCenter).not.toContain('handleAuthResponse');
    expect(settings).not.toContain('profileRes.status === 401 || profileRes.status === 403');
  });
});
