import { existsSync, writeFileSync } from 'node:fs';
import {
  updateBrowserRuntimeSettings,
  updatePluginConfig,
  updateTelemetrySettings,
} from '../../agent/yeaft/config-api.js';
import { mutateAgentConfig } from '../../agent/yeaft/config-store.js';

const [root, readyPath, startPath, operation] = process.argv.slice(2);
if (!root || !readyPath || !startPath || !operation) throw new Error('missing child arguments');

writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
while (!existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

let result;
if (operation === 'browser') result = updateBrowserRuntimeSettings({ enabled: true }, root);
else if (operation === 'plugins') result = updatePluginConfig({ tools: ['FileRead'] }, root);
else if (operation === 'telemetry') result = updateTelemetrySettings({ enabled: false }, root);
else if (operation === 'hold-browser') {
  result = mutateAgentConfig(root, config => {
    config.browserRuntime = { enabled: true };
    writeFileSync(`${readyPath}.locked`, String(process.pid), { flag: 'wx' });
    while (!existsSync(`${startPath}.release`)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  });
} else throw new Error(`unknown operation: ${operation}`);

if (result?.error) throw new Error(result.error);
