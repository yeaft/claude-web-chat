import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPGRADE_REGISTRY,
  buildUpgradeInstallCommand,
  buildUpgradeVersionCommand,
} from '../../agent/upgrade-command.js';

describe('yeaft-agent upgrade npm commands', () => {
  it('uses the Yeaft registry for version lookup', () => {
    expect(DEFAULT_UPGRADE_REGISTRY).toBe('https://pkg.yeaft.com/');
    expect(buildUpgradeVersionCommand('@yeaft/webchat-agent')).toBe(
      'npm view @yeaft/webchat-agent version --registry=https://pkg.yeaft.com/',
    );
  });

  it('uses the Yeaft registry for Unix installation', () => {
    expect(buildUpgradeInstallCommand('@yeaft/webchat-agent@latest')).toBe(
      'npm install -g @yeaft/webchat-agent@latest --registry=https://pkg.yeaft.com/',
    );
  });

  it('keeps Windows environment expansion intact', () => {
    expect(buildUpgradeInstallCommand('%PKG%')).toBe(
      'npm install -g %PKG% --registry=https://pkg.yeaft.com/',
    );
  });
});
