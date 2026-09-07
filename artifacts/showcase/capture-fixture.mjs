// Staged inspection only: no provider calls, patch, regression run or release.
import { projectWorkItemDetail, projectWorkItemSummary } from '../../agent/yeaft/work-center/projection.js';
export const sessionId = 'showcase-demo';
export const demoWorkDir = '/demo/yeaft';
export const session = {
  id: sessionId, name: 'STAGED INSPECTION · session.js', title: 'STAGED INSPECTION · session.js',
  roster: ['linus', 'martin'], defaultVpId: 'linus', workDir: demoWorkDir,
  announcement: 'STAGED INSPECTION DEMO · Read agent/yeaft/session.js. Run syntax check only. No patch or production success.',
};
const timestamp = Date.UTC(2026, 8, 7, 9);
const message = (id, type, content, vpId) => ({
  id, messageId: id, turnId: id, type, content, sessionId,
  timestamp, isStreaming: false, ...(vpId ? { vpId, speakerVpId: vpId } : {}),
});
export const conversation = [
  message('demo-goal', 'user', '**STAGED INSPECTION DEMO**\n\nLinus, inspect `agent/yeaft/session.js` and run `node --check agent/yeaft/session.js`. Do not edit code. Martin, review what this evidence does—and does not—prove.'),
  message('demo-answer', 'assistant', '**Inspection · Linus**\n\n`loadSession()` separates `workDir` from the Agent data root. Lines 146–160 document and resolve that boundary.\n\nOpen the source in **Files**, then inspect the real syntax-check replay in **Terminal**. This is read-only inspection, not a patch or release.', 'linus'),
];
export const teamConversation = [
  conversation[0],
  message('demo-linus', 'assistant', '**Inspection · Linus**\n\n`session.js:146–160`: `workDir` is project context; `configDir` owns Session data. The Terminal replays the actual syntax-check result. No code changed.', 'linus'),
  message('demo-martin', 'assistant', '**Evidence review · Martin**\n\nA syntax check proves parsing only—not runtime correctness, regression coverage, or production readiness. No patch or approval is claimed in this staged demo.', 'martin'),
];
export const vps = [
  { vpId: 'linus', displayName: 'Linus', role: 'Source inspection', description: 'Read source. Preserve exact evidence.' },
  { vpId: 'martin', displayName: 'Martin', role: 'Evidence review', description: 'Separate syntax from runtime behavior.' },
];
const specs = [
  ['inspect', 'completed', 'linus', 'Inspect session.js', 'STAGED: read loadSession(), lines 146–160. No edit.'],
  ['syntax', 'completed', 'linus', 'Run node --check', 'Actual command replay is in Terminal; syntax only.'],
  ['review', 'ready', 'martin', 'Review evidence limits', 'STAGED: syntax is not runtime or regression coverage.'],
];
const actions = specs.map(([type, status, vpId, objective, summary], i) => ({
  id: `demo-${type}`, stageId: type, generation: 1, sequence: i + 1, type, status,
  requiredRole: '', assignmentPolicy: { mode: 'auto', capability: type, fixedVpId: null },
  dependsOnStageIds: i ? [specs[i - 1][0]] : [], workspaceMode: 'read',
  brief: { objective, approach: summary, expectedOutcome: summary },
  canonicalResult: status === 'completed' ? { status, summary, evidence: [{ kind: 'summary', label: summary }] } : null,
  progressRevision: i + 1,
}));
const runs = specs.flatMap(([type, status, vpId, objective, response], i) => status === 'ready' ? [] : [{
  id: `demo-run-${type}`, actionId: `demo-${type}`, actionGeneration: 1, actionAttempt: 1, status,
  vpSnapshot: { id: vpId, name: vpId === 'linus' ? 'Linus' : 'Martin' }, response,
  startedAt: timestamp + i * 60000, endedAt: timestamp + (i + 1) * 60000, summary: response,
  evidence: [{ kind: 'summary', label: response }],
}]);
const rawWorkItem = {
  id: 'demo-inspection', revision: 1, planRevision: 1, ledgerRevision: 1, coordinatorRevision: 1,
  executionSchemaVersion: 2, title: 'STAGED INSPECTION · session.js',
  goal: 'STAGED INSPECTION DEMO · Read agent/yeaft/session.js, run node --check, review evidence limits. No patch or production success.',
  status: 'running', lifecycle: 'active', attentionState: 'none', workItemType: 'software-change', workDir: demoWorkDir,
  workflowTemplate: 'ai-planned', planningMode: 'ai', executionMode: 'graph',
  acceptanceCriteria: ['Read source without edits', 'Keep actual command exit evidence', 'Do not infer runtime or release success'],
  activeActionIds: [], attentionActionIds: [], currentActionId: 'demo-review', actions, runs, events: [],
  messages: [{ id: 'demo-work-goal', role: 'user', status: 'completed', text: 'STAGED INSPECTION DEMO: inspect agent/yeaft/session.js; run node --check agent/yeaft/session.js. No patch or release.', createdAt: timestamp, updatedAt: timestamp }],
  createdAt: timestamp, updatedAt: timestamp,
};
export const workItem = projectWorkItemSummary(rawWorkItem);
export const workItemDetail = projectWorkItemDetail(rawWorkItem);
