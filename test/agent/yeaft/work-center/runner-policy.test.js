import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { resolvePlanningWorkflowSnapshot } from '../../../../agent/yeaft/work-center/workflow.js';
import {
  createProposeWorkItemActionsTool,
  createRequestWorkItemReplanTool,
  createSubmitWorkItemPlanTool,
  createSubmitWorkItemReplanTool,
  createWorkItemToolRegistry,
  parseStructuredResult,
  renderPendingActionInput,
  workItemToolPolicySnapshot,
  resolveWorkItemWorkDir,
  WorkItemRunner,
} from '../../../../agent/yeaft/work-center/runner.js';

describe('Work Center tool policy', () => {
  let workDir;
  let outsideDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-policy-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-outside-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });





  it('removes Bash from both registry and policy when attachments are present', async () => {
    const attachmentDir = join(outsideDir, 'attachments');
    mkdirSync(attachmentDir);
    const attachmentPath = join(attachmentDir, 'evidence.txt');
    writeFileSync(attachmentPath, 'evidence');
    const ref = 'work-item-attachment://attachment-1/evidence.txt';
    const registry = createWorkItemToolRegistry({
      workDir,
      attachmentFiles: [{ ref, path: attachmentPath, root: attachmentDir }],
      isRunActive: () => true,
    });
    expect(registry.getAllTools().map(tool => tool.name)).not.toContain('Bash');
    await expect(registry.execute('Bash', {
      command: `find ${JSON.stringify(attachmentDir)} -type f -delete`,
      cwd: workDir,
      background: false,
    }, {})).rejects.toThrow(/Unknown tool: Bash/);
    expect(readFileSync(attachmentPath, 'utf8')).toBe('evidence');
    expect(workItemToolPolicySnapshot(workDir, [ref])).toMatchObject({
      allowedToolNames: expect.not.arrayContaining(['Bash']),
      shell: { enabled: false },
    });
    expect(workItemToolPolicySnapshot(workDir, [])).toMatchObject({
      allowedToolNames: expect.arrayContaining(['Bash']),
      shell: { enabled: true },
    });
  });

  it('persists external side effects and excludes Run-local control tools', async () => {
    const transitions = [];
    const recordLifecycle = (name, input) => {
      transitions.push({ phase: 'start', name, input });
      return { complete: (effectStatus, result) => transitions.push({ phase: 'complete', name, effectStatus, result }) };
    };
    const controlTools = [
      createSubmitWorkItemPlanTool({
        vps: [{ id: 'omni', role: 'developer' }],
        workItem: { title: 'Plan', goal: 'Plan safely', acceptanceCriteria: ['Safe'] },
        collector: { value: null }, isRunActive: () => true,
      }),
      createProposeWorkItemActionsTool({
        vps: [{ id: 'omni', role: 'developer' }],
        workItem: { planRevision: 1 }, actions: [], collector: { value: null }, isRunActive: () => true,
      }),
      createRequestWorkItemReplanTool({
        workItem: { planRevision: 1 }, collector: { value: null }, isRunActive: () => true,
      }),
      createSubmitWorkItemReplanTool({
        vps: [{ id: 'omni', role: 'developer' }],
        workItem: { planRevision: 1 },
        action: { context: [{ type: 'replan-barrier', candidateActionIds: [] }] },
        actions: [], collector: { value: null }, isRunActive: () => true,
      }),
      {
        name: 'FailingWrite', errorOutput: null, sideEffectScope: 'external',
        isReadOnly: () => false, isConcurrencySafe: () => false,
        async execute() { throw new Error('write outcome uncertain'); },
      },
      {
        name: 'ReturnedUnknownWrite', errorOutput: 'json-error-envelope', sideEffectScope: 'external',
        isReadOnly: () => false, isConcurrencySafe: () => false,
        async execute() { return JSON.stringify({ error: 'write may have happened' }); },
      },
    ];
    const mcpTools = [{
      name: 'mcp__test__mutate', errorOutput: null,
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() { return 'mutated'; },
    }];
    const aliasedTool = {
      name: 'AliasedWrite', aliases: ['LegacyWrite'], errorOutput: null, sideEffectScope: 'external',
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() { return 'aliased'; },
    };
    const registry = createWorkItemToolRegistry({
      workDir, isRunActive: () => true, runTools: [...controlTools, aliasedTool],
      mcpTools, operationLifecycle: recordLifecycle,
    });

    await registry.execute('FileWrite', { file_path: 'tracked.txt', content: 'tracked' }, {});
    await registry.execute('FileEdit', {
      file_path: 'tracked.txt', old_string: 'tracked', new_string: 'edited', replace_all: false,
    }, {});
    await registry.execute('FileRead', { file_path: 'tracked.txt' }, {});
    expect(readFileSync(join(workDir, 'tracked.txt'), 'utf8')).toBe('edited');
    const missingEdit = await registry.execute('FileEdit', {
      file_path: 'missing.txt', old_string: 'old', new_string: 'new', replace_all: false,
    }, {});
    expect(JSON.parse(missingEdit)).toMatchObject({ errorEffect: 'none', error: expect.stringMatching(/File not found/) });
    await registry.execute('mcp__test__mutate', {}, {});
    await registry.execute('LegacyWrite', {}, {});
    await expect(registry.execute('FailingWrite', {}, {})).rejects.toThrow(/uncertain/);
    await registry.execute('ReturnedUnknownWrite', {}, {});

    expect(transitions.filter(entry => entry.phase === 'start').map(entry => entry.name)).toEqual([
      'FileWrite', 'FileEdit', 'FileEdit', 'mcp__test__mutate', 'AliasedWrite',
      'FailingWrite', 'ReturnedUnknownWrite',
    ]);
    expect(transitions.filter(entry => entry.phase === 'complete').map(entry => ({
      name: entry.name, effectStatus: entry.effectStatus,
    }))).toEqual([
      { name: 'FileWrite', effectStatus: 'applied' },
      { name: 'FileEdit', effectStatus: 'applied' },
      { name: 'FileEdit', effectStatus: 'failed_no_effect' },
      { name: 'mcp__test__mutate', effectStatus: 'applied' },
      { name: 'AliasedWrite', effectStatus: 'applied' },
      { name: 'FailingWrite', effectStatus: 'unknown' },
      { name: 'ReturnedUnknownWrite', effectStatus: 'unknown' },
    ]);
    expect(controlTools.slice(0, 4).map(tool => tool.sideEffectScope)).toEqual(['run', 'run', 'run', 'run']);

    const adapter = {
      responses: [
        [
          { type: 'tool_call', id: 'missing-edit', name: 'FileEdit', input: {
            file_path: 'engine-missing.txt', old_string: 'old', new_string: 'new', replace_all: false,
          } },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: 'Handled.' }, { type: 'stop', stopReason: 'end_turn' }],
      ],
      async *stream() {
        for (const event of this.responses.shift()) yield event;
      },
    };
    const engine = new Engine({
      adapter, trace: new NullTrace(), config: { model: 'provider/model', maxOutputTokens: 1_024 },
      toolRegistry: registry,
    });
    const events = [];
    for await (const event of engine.query({ prompt: 'Edit a missing file', workDir })) events.push(event);
    expect(events.find(event => event.type === 'tool_end' && event.id === 'missing-edit'))
      .toMatchObject({ isError: true });

    const store = new WorkItemStore(join(workDir, 'work-center.db'));
    const controller = new WorkflowController(store, { listAvailableVpIds: () => ['omni'] });
    const workItem = controller.create({
      id: 'plan-self-correction',
      title: 'Correct an invalid plan',
      goal: 'Let the planner correct its graph in one Run',
      acceptanceCriteria: ['The corrected plan can execute'],
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
      workDir,
      start: true,
    });
    const claim = store.claimReadyAction('planner-boot', 5_000);
    const planAction = (id, type, dependsOnActionIds) => ({
      id, name: id, type,
      objective: `Complete ${id}`,
      approach: `Use repository evidence to complete ${id}`,
      expectedOutcome: `${id} is complete`,
      candidateVpIds: ['omni'], assignmentReason: 'Use the available planner',
      dependsOnActionIds, workspaceMode: type === 'deliver' ? 'shared' : 'read',
    });
    const planInput = {
      summary: 'A corrected plan is ready.',
      evidence: ['The complete graph was validated.'],
      acceptanceChecks: [{
        criterion: 'The corrected plan can execute', status: 'passed', evidence: 'Validated graph',
      }],
      contractPatch: {
        title: 'Correct an invalid plan',
        goal: 'Let the planner correct its graph in one Run',
        acceptanceCriteria: ['The corrected plan can execute'],
      },
      workItemType: 'plan-correction',
      actions: [
        planAction('implement', 'implement', []),
        planAction('deliver', 'deliver', ['implement']),
      ],
    };
    const plannerAdapter = {
      responses: [
        [
          { type: 'tool_call', id: 'invalid-plan', name: 'SubmitWorkItemPlan', input: {
            ...planInput,
            actions: [
              planAction('implement', 'implement', ['missing-dependency']),
              planAction('deliver', 'deliver', ['implement']),
            ],
          } },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'valid-plan', name: 'SubmitWorkItemPlan', input: planInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
      ],
      async *stream(params) {
        params.onRequestStart?.();
        for (const event of this.responses.shift()) yield event;
      },
    };
    const runner = new WorkItemRunner({
      store,
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter: plannerAdapter,
      }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'planner', traits: ['triage', 'implement'] }],
        getVp: id => id === 'omni'
          ? { id: 'omni', name: 'Omni', role: 'planner', traits: ['triage', 'implement'] }
          : null,
      },
    });
    const planned = await runner.run({
      ...claim, ownerBootId: 'planner-boot', signal: new AbortController().signal,
    });
    const plannedDetail = controller.submit(
      claim.run.id, 'planner-boot', claim.run.leaseEpoch, planned,
    );
    expect(plannedDetail).toMatchObject({ id: workItem.id, status: 'ready' });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE work_item_id = ?')
      .get(workItem.id).count).toBe(0);
    const executionClaim = store.claimReadyAction('executor-boot', 5_000);
    expect(executionClaim)
      .toMatchObject({ workItem: { id: workItem.id }, action: { stageId: 'implement' } });
    const operationKey = `${executionClaim.run.id}:tool:1`;
    const fencedRegistry = createWorkItemToolRegistry({
      workDir,
      isRunActive: () => store.isActiveRun(
        executionClaim.run.id, 'executor-boot', executionClaim.run.leaseEpoch,
      ),
      runTools: [controlTools[4]],
      operationLifecycle: (name, input) => {
        store.createOperation({
          workItemId: workItem.id,
          actionId: executionClaim.action.id,
          runId: executionClaim.run.id,
          operationType: name,
          idempotencyKey: operationKey,
          replayPolicy: 'never_automatic',
          payload: { input },
        });
        expect(store.claimOperation(
          operationKey, 'executor-boot', executionClaim.run.leaseEpoch, false,
        )).not.toBeNull();
        return {
          complete: (effectStatus, result) => expect(store.completeOperation(
            operationKey, 'executor-boot', executionClaim.run.leaseEpoch, effectStatus, result,
          )).toBe(true),
        };
      },
    });
    await expect(fencedRegistry.execute('FailingWrite', {}, {})).rejects.toThrow(/uncertain/);
    expect(store.getOperationByKey(operationKey)).toMatchObject({
      effectStatus: 'unknown', executionStatus: 'quiescent',
    });
    const afterImplementation = controller.submit(
      executionClaim.run.id, 'executor-boot', executionClaim.run.leaseEpoch,
      {
        outcome: 'completed', response: 'Implementation complete.', summary: 'Implementation complete.',
        evidence: ['implementation evidence'],
        acceptanceChecks: [{
          criterion: 'The corrected plan can execute', status: 'deferred', evidence: 'Delivery verifies it',
        }],
      },
    );
    expect(afterImplementation.actions.find(action => action.stageId === 'deliver'))
      .toMatchObject({ status: 'ready' });
    expect(store.claimReadyAction('blocked-by-unknown-operation', 5_000)).toBeNull();

    const timeoutItem = controller.create({
      id: 'timeout-operation-fence', title: 'Fence late writes',
      goal: 'Do not dispatch a later mutator after timeout',
      acceptanceCriteria: ['Late mutators stay fenced'],
      workflowTemplate: 'software-change', workDir, start: true,
    });
    const timeoutClaim = store.claimReadyAction('timeout-owner', 5_000);
    let fastWriteCalls = 0;
    const slowPath = join(workDir, 'timeout-order.txt');
    const slowWrite = {
      name: 'SlowWrite', timeoutMs: 5, errorOutput: null, sideEffectScope: 'external',
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() {
        await new Promise(resolve => setTimeout(resolve, 60));
        writeFileSync(slowPath, 'slow-old');
        return 'slow';
      },
    };
    const fastWrite = {
      name: 'FastWrite', errorOutput: null, sideEffectScope: 'external',
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() {
        fastWriteCalls += 1;
        writeFileSync(slowPath, 'fast-new');
        return 'fast';
      },
    };
    let timeoutOrdinal = 0;
    const timeoutRegistry = createWorkItemToolRegistry({
      workDir, isRunActive: () => store.isActiveRun(
        timeoutClaim.run.id, 'timeout-owner', timeoutClaim.run.leaseEpoch,
      ),
      runTools: [slowWrite, fastWrite],
      operationLifecycle: (name, input) => {
        timeoutOrdinal += 1;
        const key = `${timeoutClaim.run.id}:tool:${timeoutOrdinal}`;
        const claimedOperation = store.createAndClaimOperation({
          workItemId: timeoutItem.id,
          actionId: timeoutClaim.action.id,
          runId: timeoutClaim.run.id,
          operationType: name,
          idempotencyKey: key,
          replayPolicy: 'never_automatic',
          payload: { input },
        }, 'timeout-owner', timeoutClaim.run.leaseEpoch, false);
        expect(claimedOperation).not.toBeNull();
        return {
          complete: (effectStatus, result) => store.completeOperation(
            key, 'timeout-owner', timeoutClaim.run.leaseEpoch, effectStatus, result,
          ),
        };
      },
    });
    const timeoutAdapter = {
      responses: [[
        { type: 'tool_call', id: 'slow', name: 'SlowWrite', input: {} },
        { type: 'tool_call', id: 'fast', name: 'FastWrite', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]],
      async *stream() {
        for (const event of this.responses.shift()) yield event;
      },
    };
    const timeoutEngine = new Engine({
      adapter: timeoutAdapter, trace: new NullTrace(),
      config: { model: 'provider/model', maxOutputTokens: 1_024 },
      toolRegistry: timeoutRegistry,
    });
    const timeoutEvents = [];
    for await (const event of timeoutEngine.query({ prompt: 'Run both writes', workDir })) {
      timeoutEvents.push(event);
    }
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'tool_end', id: 'slow', isError: true,
    }));
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'error', error: expect.objectContaining({ name: 'ToolExecutionTimeoutError' }),
    }));
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'turn_end', stopReason: 'error', terminal: true,
    }));
    expect(fastWriteCalls).toBe(0);
    expect(store.interruptRun(
      timeoutClaim.run.id, 'timeout-owner', timeoutClaim.run.leaseEpoch, 'fatal tool timeout',
    )).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(readFileSync(slowPath, 'utf8')).toBe('slow-old');
    expect(store.getOperationByKey(`${timeoutClaim.run.id}:tool:1`)).toMatchObject({
      effectStatus: 'unknown', executionStatus: 'hazardous_orphan',
      effectCutoff: { status: 'stale', closureType: 'late_completion' },
    });
    expect(store.claimReadyAction('blocked-after-timeout', 5_000)).toBeNull();

    const crashItem = controller.create({
      id: 'operation-create-crash', title: 'Recover unclaimed operation',
      goal: 'Do not deadlock after create-before-claim crash', acceptanceCriteria: [],
      workflowTemplate: 'software-change', workDir, start: true,
    });
    const crashClaim = store.claimReadyAction('crash-owner', 5_000);
    store.createOperation({
      workItemId: crashItem.id, actionId: crashClaim.action.id, runId: crashClaim.run.id,
      operationType: 'CrashBeforeClaim', idempotencyKey: 'create-before-claim-crash',
      replayPolicy: 'never_automatic',
    });
    store.close();
    const reopened = new WorkItemStore(join(workDir, 'work-center.db'));
    expect(reopened.getOperationByKey('create-before-claim-crash')).toMatchObject({
      effectStatus: 'failed_no_effect', executionStatus: 'quiescent',
      effectCutoff: { closureType: 'recovered_before_dispatch' },
    });
    expect(reopened.recoverInterruptedRuns('post-crash-owner')).toBeGreaterThanOrEqual(1);
    expect(reopened.claimReadyAction('post-crash-owner', 5_000))
      .toMatchObject({ workItem: { id: crashItem.id } });
    reopened.close();

    for (const tool of controlTools.slice(0, 4)) {
      const controlRegistry = createWorkItemToolRegistry({
        workDir, isRunActive: () => true,
        runTools: [tool], operationLifecycle: recordLifecycle,
      });
      try { await controlRegistry.execute(tool.name, {}, {}); } catch {}
    }
    expect(transitions.filter(entry => entry.phase === 'start').map(entry => entry.name))
      .not.toEqual(expect.arrayContaining(controlTools.slice(0, 4).map(tool => tool.name)));

    const policyRegistry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(policyRegistry.execute('Bash', {
      command: 'echo nope', cwd: outsideDir, background: false,
    }, {})).rejects.toThrow(/cwd is fixed/);
    await expect(policyRegistry.execute('Bash', {
      command: 'echo nope', cwd: workDir, background: true,
    }, {})).rejects.toThrow(/background Bash/);
  });

  const verifyRunningQuotedActionInput = () => {
    const store = new WorkItemStore(join(workDir, 'running-quote.db'), { now: () => 1_000 });
    const controller = new WorkflowController(store);
    try {
      const item = controller.create({
        id: 'running-quoted-input',
        title: 'Use a live correction',
        goal: 'Deliver the latest user correction to the active executor',
        acceptanceCriteria: ['The correction reaches the active executor'],
        workflowTemplate: 'software-change',
        workDir,
        start: true,
      });
      const claim = store.claimReadyAction('running-quote-owner', 60_000);
      controller.input(item.id, {
        text: 'LATEST RUNNING CORRECTION',
        actionId: claim.action.id,
        generation: claim.action.generation,
        revision: store.getWorkItem(item.id).revision,
        clientMessageId: 'running-large-quote',
        quote: { role: 'assistant', author: 'Reviewer', content: 'Q'.repeat(20_000) },
      });

      const pending = store.listPendingActionInputs(
        claim.action.id,
        claim.run.id,
        'running-quote-owner',
        claim.run.leaseEpoch,
      );
      const rendered = renderPendingActionInput(pending[0]);

      expect(pending).toHaveLength(1);
      expect(rendered).toContain('LATEST RUNNING CORRECTION');
      expect(rendered).toContain('<quoted-message untrusted-reference="true">');
      expect(rendered).toContain('[quoted message truncated to fit the execution context budget]');
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(
        Buffer.byteLength('LATEST RUNNING CORRECTION\n\n', 'utf8') + (8 * 1024),
      );
    } finally {
      store.close();
    }
  };

  it('rejects lexical, patch, and symlink escapes', async () => {
    verifyRunningQuotedActionInput();
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(registry.execute('FileRead', { file_path: '../secret' }, {}))
      .rejects.toThrow(/escapes/);
    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/file.txt\n+++ ../../secret.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }, {})).rejects.toThrow(/escapes/);

    const safe = join(workDir, 'safe');
    mkdirSync(safe);
    symlinkSync(outsideDir, join(safe, 'link'));
    await expect(registry.execute('FileWrite', {
      file_path: join(safe, 'link', 'escaped.txt'), content: 'nope',
    }, {})).rejects.toThrow(/escapes/);

    const writeTarget = join(outsideDir, 'write-target.txt');
    const patchTarget = join(outsideDir, 'patch-target.txt');
    symlinkSync(writeTarget, join(workDir, 'write-link.txt'));
    symlinkSync(patchTarget, join(workDir, 'patch-link.txt'));

    await expect(registry.execute('FileWrite', {
      file_path: 'write-link.txt', content: 'outside',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(writeTarget)).toBe(false);

    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/patch-link.txt\n+++ b/patch-link.txt\n@@ -0,0 +1 @@\n+outside\n',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(patchTarget)).toBe(false);
  });





  it('uses the creation-time workspace identity after a symlink is retargeted', () => {
    const projectA = join(workDir, 'project-a');
    const projectB = join(workDir, 'project-b');
    const alias = join(workDir, 'current');
    mkdirSync(projectA);
    mkdirSync(projectB);
    symlinkSync(projectA, alias);
    const workItem = { workDir: alias, workspaceKey: projectA };

    unlinkSync(alias);
    symlinkSync(projectB, alias);

    expect(resolveWorkItemWorkDir(workItem, outsideDir)).toBe(projectA);
    expect(() => resolveWorkItemWorkDir({ workDir: alias, workspaceKey: '' }, outsideDir))
      .toThrow(/canonical workspace identity/);
  });



  it('rejects a replaced canonical target before snapshots or adapter execution', async () => {
    const projectA = join(workDir, 'runner-canonical-a');
    const movedProjectA = join(workDir, 'runner-moved-a');
    const projectB = join(workDir, 'runner-canonical-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    renameSync(projectA, movedProjectA);
    symlinkSync(projectB, projectA);
    let adapterStarted = false;
    const setRunExecutionSnapshots = vi.fn();
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: outsideDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: {
          async *stream() {
            adapterStarted = true;
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: { isActiveRun: () => true, setRunExecutionSnapshots },
      registry: {
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });

    await expect(runner.run({
      workItem: { workDir: projectA, workspaceKey: projectA },
      action: { type: 'triage', requiredRole: 'omni', instruction: 'Inspect workspace' },
      run: { id: 'run-replaced', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-a',
    })).rejects.toThrow(/canonical workspace identity changed/);
    expect(setRunExecutionSnapshots).not.toHaveBeenCalled();
    expect(adapterStarted).toBe(false);

    const engineError = new Error('provider failed inside Work Center');
    const errorStore = {
      listCompletedRuns: () => [],
      listActionDependencies: () => [],
      getActionResumeContext: () => null,
      listPendingActionInputs: () => [],
      setRunExecutionSnapshots: () => true,
      isActiveRun: () => true,
      prepareEngineTurn: () => ({ id: 'engine-turn-error' }),
      claimEngineTurn: () => true,
      failEngineTurn: () => ({ allowRetry: true }),
      closeRunInput: () => true,
    };
    const errorRunner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter: {
          async *stream(params) {
            params.onRequestStart?.();
            throw engineError;
          },
        },
      }),
      store: errorStore,
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', traits: [] }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', traits: [] }),
      },
    });
    await expect(errorRunner.run({
      workItem: {
        id: 'work-item-engine-error', title: 'Fail visibly', goal: 'Surface the Engine error',
        acceptanceCriteria: [], workDir, workspaceKey: workDir,
      },
      action: { id: 'action-error', type: 'test', requiredRole: 'omni', instruction: 'Fail' },
      run: { id: 'run-engine-error', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-error',
    })).rejects.toBe(engineError);
  });





  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });




});
