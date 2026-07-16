export function workCenterRequestKey(request) {
  if (!request?.runId || !request?.id) return '';
  return `${request.runId}:${request.id}`;
}

export function workCenterRequestLoopKey(request, loop) {
  const requestKey = workCenterRequestKey(request);
  if (!requestKey) return '';
  return `${requestKey}:${loop?.id || loop?.loopNumber || ''}`;
}
