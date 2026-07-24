import { describe, expect, it } from 'vitest';
import { resolveWindowsClaudeCommand } from '../../agent/sdk/utils.js';

const shimPath = 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\claude.cmd';

function existingOnly(...paths) {
  const normalized = new Set(paths.map(path => path.toLowerCase()));
  return path => normalized.has(path.toLowerCase());
}

describe('Claude Code Windows command resolution', () => {
  it('runs the legacy JavaScript CLI with Node instead of the npm shim', () => {
    const cliPath = 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const command = resolveWindowsClaudeCommand(shimPath, {
      readFile: () => String.raw`@ECHO off
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
)
"%_prog%" "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`,
      fileExists: existingOnly(cliPath),
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    });

    expect(command).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: [cliPath],
      spawnOpts: {},
    });
  });

  it('runs the current native Claude executable directly instead of PowerShell', () => {
    const nativePath = 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const command = resolveWindowsClaudeCommand(shimPath, {
      readFile: () => String.raw`@ECHO off
GOTO start
:start
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`,
      fileExists: existingOnly(nativePath),
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    });

    expect(command).toEqual({
      command: nativePath,
      prefixArgs: [],
      spawnOpts: {},
    });
  });

  it('fails explicitly when the npm shim target cannot be resolved', () => {
    expect(() => resolveWindowsClaudeCommand(shimPath, {
      readFile: () => '@ECHO off\r\necho unsupported shim\r\n',
      fileExists: () => false,
      nodeExecutable: 'node.exe',
    })).toThrow(/could not resolve the executable target/i);
  });
});
