import {
  resolveManagedYeaftDir,
  resolveServiceInstanceId,
  warnDeprecatedInstanceArg,
} from '../service/config.js';

/**
 * Execute an Agent-instance-scoped Browser Runtime management command.
 * Dependencies are injectable so tests never import the executable Agent CLI.
 */
export async function handleBrowserCommand(args, dependencies = {}) {
  const action = args[0];
  const options = {};
  const identityArgs = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--headful') {
      options.headless = false;
      continue;
    }
    if (arg === '--executable' || arg === '--name' || arg === '--instance' || arg === '--yeaft-dir') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--executable') options.executablePath = value;
      else identityArgs.push(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`Unexpected browser argument: ${arg}`);
  }

  const env = dependencies.env || process.env;
  const warn = dependencies.warn || console.warn;
  warnDeprecatedInstanceArg(identityArgs, warn);
  const instanceId = resolveServiceInstanceId(identityArgs, env, { management: true });
  const resolveManagementRoot = dependencies.resolveManagedYeaftDir || resolveManagedYeaftDir;
  const yeaftDir = resolveManagementRoot(identityArgs, env, instanceId, {
    loadServiceConfig: dependencies.loadServiceConfig,
    getDefaultYeaftDir: dependencies.getDefaultYeaftDir,
  });
  const browser = dependencies.browserModule || await import('./index.js');
  const configApi = dependencies.configApi || await import('../yeaft/config-api.js');
  const current = configApi.getBrowserRuntimeSettings(yeaftDir);
  if (current.error) throw new Error(current.error);
  const cacheDir = current.cacheDir || browser.defaultBrowserCacheDir(yeaftDir);
  const log = dependencies.log || console.log;

  if (action === 'install') {
    const result = await browser.installManagedBrowser({ cacheDir });
    log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  if (action === 'probe') {
    const result = await browser.probeBrowserRuntime({
      executablePath: options.executablePath || current.executablePath,
      cacheDir,
      headless: options.headless ?? current.headless,
      timeoutMs: current.startupProbeTimeoutMs,
      profileParent: `${cacheDir}-profiles`,
    });
    log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      if (dependencies.onProbeFailure) dependencies.onProbeFailure(result);
      else process.exitCode = 1;
    }
    return;
  }
  if (action === 'enable' || action === 'disable') {
    const result = configApi.updateBrowserRuntimeSettings({ enabled: action === 'enable' }, yeaftDir);
    if (result.error) throw new Error(result.error);
    log(JSON.stringify(result, null, 2));
    log('Restart the selected Agent instance to run the startup probe. Phase 0 does not advertise Browser capability.');
    return;
  }
  if (action === 'status') {
    const executablePath = await browser.findManagedBrowser(cacheDir);
    log(JSON.stringify({
      instanceId,
      yeaftDir,
      config: current,
      managedBuildId: browser.BROWSER_RUNTIME_CHROME_BUILD,
      managedExecutablePath: executablePath,
      installed: !!executablePath,
    }, null, 2));
    return;
  }
  throw new Error('Usage: yeaft-agent browser install|probe|enable|disable|status [--name <id>] [--yeaft-dir <path>] [--executable <path>] [--headful]');
}
