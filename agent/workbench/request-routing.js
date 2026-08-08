export function workbenchRequestRouting(source) {
  return {
    ...(source?._requestUserId ? { _requestUserId: source._requestUserId } : {}),
    ...(source?._requestClientId ? { _requestClientId: source._requestClientId } : {}),
    ...(source?.workbenchRouteKey ? { workbenchRouteKey: source.workbenchRouteKey } : {}),
  };
}

export function sendWorkbenchResult(ctx, request, result) {
  ctx.sendToServer({
    ...result,
    ...workbenchRequestRouting(request),
  });
}
