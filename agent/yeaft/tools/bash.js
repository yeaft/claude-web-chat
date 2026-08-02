/**
 * bash.js — Execute shell commands.
 *
 * Spawns a child process to run shell commands with timeout, output
 * truncation, working directory support, and cancellation via AbortSignal.
 *
 * The tool name remains Bash for wire compatibility. Internally it uses the
 * platform default shell: POSIX shell on Linux/macOS, PowerShell/cmd on Windows.
 */

import { defineTool } from './types.js';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildShellInvocation, getRuntimePlatformInfo } from '../runtime-platform.js';
import {
  wrapInvocationInSystemdUserScope,
  wrapInvocationInSystemdUserService,
} from '../systemd-scope.js';
import { runProcess } from './process-runner.js';

export { buildShellInvocation };

/** Max output size in bytes before truncation (256 KB). */
const MAX_OUTPUT = 256 * 1024;

/** Default timeout in ms (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Max timeout in ms (10 minutes). */
const MAX_TIMEOUT_MS = 600_000;
/**
 * ToolRegistry must not preempt Bash's own process timeout. Bash terminates
 * the process tree and waits for close before returning exit 124; the grace
 * covers TERM/KILL escalation and the bounded close-confirmation window.
 */
const REGISTRY_TIMEOUT_MS = MAX_TIMEOUT_MS + 15_000;
const LINUX_NAMESPACE_HELPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'linux-process-namespace.js',
);

/**
 * Run a command in a child process.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
function runCommand(command, { cwd, timeout, signal, runtimePlatform }) {
  const platform = runtimePlatform || getRuntimePlatformInfo();
  const env = { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' };
  const baseInvocation = buildShellInvocation(command, { runtimePlatform: platform });
  let invocation = wrapInvocationInSystemdUserScope(baseInvocation, {
    runtimePlatform: platform,
    env,
    scopeId: `foreground-${Date.now()}-${process.pid}`,
  });
  if (platform.isLinux && !invocation.systemdControl) {
    invocation = wrapInvocationInSystemdUserService(baseInvocation, {
      runtimePlatform: platform,
      env,
      cwd,
      unitId: `foreground-${Date.now()}-${process.pid}`,
    });
  }
  if (platform.isLinux && !invocation.systemdControl) {
    const unsharePath = env.YEAFT_UNSHARE_PATH || '/usr/bin/unshare';
    if (!existsSync(unsharePath)) {
      throw new Error(
        'Foreground Bash requires systemd-run or unshare on Linux so timeout can guarantee complete process-tree cleanup. Use background=true or install util-linux.',
      );
    }
    invocation = {
      command: process.execPath,
      args: [LINUX_NAMESPACE_HELPER, '--', baseInvocation.command, ...(baseInvocation.args || [])],
      family: baseInvocation.family,
      systemdControl: null,
    };
  }
  return runProcess(invocation.command, invocation.args, {
    cwd,
    env,
    signal,
    timeoutMs: timeout,
    maxBytes: MAX_OUTPUT,
    requireExitConfirmation: true,
    systemdScope: invocation.systemdControl,
    onSettled: invocation.cleanup || null,
    platform: platform.platform,
  }).then(result => ({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    timedOut: result.timedOut,
  }));
}

export default defineTool({
  name: 'Bash',
  description: {
    en: `Execute a shell command and return its output.

Use this tool to run CLI commands, scripts, and system operations. The tool name
is kept as Bash for compatibility; on Windows the command is executed through
the configured Windows shell (PowerShell by default, or cmd when configured).

Guidelines:
- Commands run in the working directory (cwd from context)
- Match command syntax to the Agent OS shown in the runtime_platform prompt
- Timeout defaults to 2 minutes (max 10 minutes)
- Large outputs are truncated at 256KB
- Use absolute paths when possible
- Avoid interactive commands (no stdin support)
- Use background=true for long-running or persistent tasks that should survive across turns
- stderr is captured separately and included in the result`,
    zh: `执行 Shell 命令并返回输出。

用于运行 CLI 命令、脚本和系统操作。

使用指南：
- 命令在工作目录中执行（上下文中的 cwd）
- 默认超时 2 分钟（最大 10 分钟）
- 大输出在 256KB 处截断
- 尽量使用绝对路径
- 避免交互式命令（不支持 stdin）
- 长时间或需要跨 turn 持续存在的任务使用 background=true
- stderr 单独捕获并包含在结果中`
  },
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: {
          en: 'The shell command to execute using the Agent OS default shell',
          zh: '要使用 Agent 操作系统默认 shell 执行的命令',
        },
      },
      cwd: {
        type: 'string',
        description: {
          en: 'Working directory for the command (default: engine cwd)',
          zh: '命令的工作目录（默认为引擎当前目录）',
        },
      },
      timeout_ms: {
        type: 'number',
        description: {
          en: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
          zh: `超时时间，单位毫秒（默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}）`,
        },
      },
      background: {
        type: 'boolean',
        description: {
          en: 'Run as a persistent Session task and return immediately with a taskId and log path',
          zh: '作为持久化 Session 后台任务运行，并立即返回 taskId 和日志路径',
        },
      },
      taskTitle: {
        type: 'string',
        description: {
          en: 'Human-readable title for the background task',
          zh: '后台任务的人类可读标题',
        },
      },
    },
    required: ['command'],
  },
  errorOutput: null,
  timeoutMs: REGISTRY_TIMEOUT_MS,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: (input) => {
    if (!input?.command) return false;
    const cmd = input.command.toLowerCase();
    return cmd.includes('rm ') || cmd.includes('rmdir') ||
           cmd.includes('remove-item') || cmd.startsWith('del ') || cmd.includes(' del ') ||
           cmd.includes('git reset --hard') || cmd.includes('git clean') ||
           cmd.includes('dd ') || cmd.includes('mkfs') || cmd.includes('format ') ||
           cmd.includes('> /dev/') || cmd.includes('chmod 000');
  },
  async execute(input, ctx) {
    const { command, cwd: inputCwd, timeout_ms, background = false, taskTitle } = input;
    if (!command) throw new Error('command is required');

    // Resolve working directory
    const cwd = inputCwd
      ? resolve(inputCwd)
      : (ctx?.cwd || process.cwd());

    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Clamp timeout
    const timeout = Math.min(Math.max(timeout_ms || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const runtimePlatform = ctx?.runtimePlatform || getRuntimePlatformInfo();

    if (background) {
      if (!ctx?.taskManager) {
        throw new Error('background tasks are unavailable in this runtime');
      }
      try {
        const task = ctx.taskManager.startShellTask({
          command,
          cwd,
          sessionId: ctx.sessionId || 'default',
          ownerVpId: ctx.currentVpId || null,
          title: taskTitle || command.slice(0, 120),
          runtimePlatform,
          source: {
            threadId: ctx.threadId || 'main',
          },
        });
        return `Started background task ${task.id}.\nStatus: ${task.status}\nLog: ${task.log?.path || ''}\nThe task is detached from this turn. Use ListTasks, ReadTaskLog, or CancelTask to inspect or control it.`;
      } catch (err) {
        throw new Error(err?.message || String(err));
      }
    }

    try {
      const result = await runCommand(command, {
        cwd,
        timeout,
        signal: ctx?.signal,
        runtimePlatform,
      });

      // Format output similar to Claude Code
      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
      if (result.timedOut) parts.push(`\n(Command timed out after ${timeout}ms)`);

      const output = parts.join('\n');
      if (result.exitCode !== 0) {
        return `Exit code: ${result.exitCode}\n${output}`;
      }
      return output || '(no output)';
    } catch (err) {
      if (err?.name === 'ProcessTerminationError') err.fatalToolTimeout = true;
      throw err;
    }
  },
});
