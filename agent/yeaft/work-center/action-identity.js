function generation(value) {
  return Math.max(1, Number(value) || 1);
}

export function eventMatchesActionGeneration(event, action) {
  if (!event || !action) return false;
  return generation(event.actionGeneration) === generation(action.generation);
}

export function currentActionInputEventIds(events, action) {
  const actionEvents = (Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id);
  const inputEvents = new Map(actionEvents
    .filter(event => event.type === 'action.input_added')
    .map(event => [String(event.id), event]));
  const valid = new Set();
  const superseded = new Set();
  for (const event of inputEvents.values()) {
    if (eventMatchesActionGeneration(event, action)) valid.add(String(event.id));
  }
  for (const event of actionEvents) {
    const sourceEventIds = [
      event.data?.sourceEventId,
      ...(Array.isArray(event.data?.sourceEventIds) ? event.data.sourceEventIds : []),
    ].filter(value => value != null).map(String);
    if (event.type === 'action.input_superseded') {
      for (const eventId of sourceEventIds) {
        superseded.add(eventId);
        valid.delete(eventId);
      }
      continue;
    }
    if (event.type !== 'action.input_rebound' || !eventMatchesActionGeneration(event, action)) continue;
    for (const eventId of sourceEventIds) {
      if (inputEvents.has(eventId) && !superseded.has(eventId)) valid.add(eventId);
    }
  }
  return valid;
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
