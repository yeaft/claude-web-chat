function generation(value) {
  return Math.max(1, Number(value) || 1);
}

export function eventMatchesActionGeneration(event, action) {
  if (!event || !action) return false;
  return generation(event.actionGeneration) === generation(action.generation);
}

export function runMatchesActionIdentity(run, action) {
  if (!run || !action) return false;
  const actionGeneration = generation(action.generation);
  const manifest = run.executionManifest;
  const runGeneration = generation(run.actionGeneration ?? manifest?.actionGeneration);
  if (runGeneration !== actionGeneration) return false;

  const actionSpecHash = typeof action.specHash === 'string' ? action.specHash : '';
  const runSpecHash = typeof run.actionSpecHash === 'string' && run.actionSpecHash
    ? run.actionSpecHash
    : typeof manifest?.actionSpecHash === 'string' ? manifest.actionSpecHash : '';
  if (!actionSpecHash || !runSpecHash) {
    return actionGeneration === 1 && !actionSpecHash && !runSpecHash;
  }
  return runSpecHash === actionSpecHash;
}
