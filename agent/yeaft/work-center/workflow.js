const SOFTWARE_CHANGE_STEPS = Object.freeze([
  { type: 'triage', requiredRole: 'omni' },
  { type: 'implement', requiredRole: 'linus' },
  { type: 'review', requiredRole: 'martin' },
  { type: 'deliver', requiredRole: 'linus' },
]);

export const WORKFLOW_TEMPLATES = Object.freeze({
  'software-change': SOFTWARE_CHANGE_STEPS,
});

export const RUN_OUTCOMES = Object.freeze([
  'completed',
  'waiting',
  'retryable',
  'failed',
]);

export function getWorkflowSteps(template = 'software-change') {
  const steps = WORKFLOW_TEMPLATES[template];
  if (!steps) throw new Error(`Unsupported Work Center workflow: ${template}`);
  return steps;
}

export function getStep(template, type) {
  return getWorkflowSteps(template).find(step => step.type === type) || null;
}

export function getNextStep(template, type, result = {}) {
  const steps = getWorkflowSteps(template);
  const index = steps.findIndex(step => step.type === type);
  if (index === -1) throw new Error(`Action type ${type} is not in workflow ${template}`);
  if (type === 'review') {
    if (result.reviewDecision === 'changes_requested') {
      return steps.find(step => step.type === 'implement') || null;
    }
    if (result.reviewDecision !== 'approved') {
      throw new Error('Completed review requires approved or changes_requested');
    }
  }
  return steps[index + 1] || null;
}

function renderContext(context = []) {
  if (!Array.isArray(context) || context.length === 0) return '';
  const blocks = context.map(entry => {
    const evidence = Array.isArray(entry.evidence) && entry.evidence.length > 0
      ? `\nEvidence:\n${entry.evidence.map(item => {
          const status = item.status ? ` [${item.status}]` : '';
          const ref = item.ref ? ` (${item.ref})` : '';
          return `- ${item.kind}: ${item.label}${status}${ref}`;
        }).join('\n')}`
      : '';
    const decision = entry.reviewDecision ? `\nReview decision: ${entry.reviewDecision}` : '';
    const waitingReason = entry.waitingReason ? `\nWaiting reason: ${entry.waitingReason}` : '';
    const answer = entry.answer ? `\nUser answer: ${entry.answer}` : '';
    return `### ${entry.type} (${entry.role || 'unknown role'})\n${entry.summary || '(no summary)'}${decision}${waitingReason}${answer}${evidence}`;
  });
  return `\n\nPrior Action results:\n${blocks.join('\n\n')}`;
}

export function actionInstruction(step, workItem, context = []) {
  const criteria = (workItem.acceptanceCriteria || []).map(item => `- ${item}`).join('\n') || '- No explicit criteria';
  const common = `WorkItem: ${workItem.title}\nGoal: ${workItem.goal}\nAcceptance criteria:\n${criteria}${renderContext(context)}`;
  switch (step.type) {
    case 'triage':
      return `${common}\n\nAnalyze the request, verify scope and risks, and make the contract executable. Do not implement yet. If the goal or acceptance criteria need refinement, submit a contractPatch.`;
    case 'implement':
      return `${common}\n\nImplement the smallest correct change in the supplied work directory. Add and run relevant tests. Use the prior triage/review findings. Do not approve your own work.`;
    case 'review':
      return `${common}\n\nReview the implementation and evidence independently. Return approved or changes_requested with concrete findings.`;
    case 'deliver':
      return `${common}\n\nDeliver the approved change using the repository release policy. Verify the final remote state and provide evidence.`;
    default:
      return common;
  }
}

export function initialActionFor(workItem) {
  const step = getWorkflowSteps(workItem.workflowTemplate)[0];
  return {
    ...step,
    context: [],
    instruction: actionInstruction(step, workItem, []),
    maxAttempts: 2,
  };
}

export function actionContextFromRuns(runs = []) {
  return runs
    .filter(run => run && run.summary)
    .map(run => ({
      type: run.actionType || 'action',
      role: run.roleSnapshot?.id || run.vpSnapshot?.id || null,
      summary: run.summary,
      evidence: Array.isArray(run.evidence) ? run.evidence : [],
      reviewDecision: run.reviewDecision || null,
    }));
}
