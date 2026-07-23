export function normalizeRouteForwardDisplay(input) {
  const to = input && typeof input.to === 'string' && input.to.trim() ? input.to.trim() : '?';
  const target = to === 'all' ? '@all' : `@${to}`;
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  return { to, target, text, reason };
}

export function formatRouteForwardToolLine(input, truncate = (value) => value) {
  const route = normalizeRouteForwardDisplay(input);
  if (route.text) return `Route ${route.target}: ${truncate(route.text, 70)}`;
  return `Route ${route.target}`;
}
