/**
 * Auth-aware fetch interceptor.
 *
 * The server uses bearer JWTs for protected `/api/*` routes and returns
 * `X-New-Token` when a session token is close to expiring. Patch
 * `window.fetch` once at app boot so same-origin protected API calls get the
 * current token even when a component forgets to pass auth headers, and so
 * refreshed tokens immediately replace the old in-memory/localStorage value.
 */

let installed = false;

const PUBLIC_AUTH_PATHS = new Set([
  '/api/auth/mode',
  '/api/auth/login',
  '/api/auth/aad',
  '/api/auth/verify',
  '/api/auth/verify-totp',
  '/api/auth/setup-totp',
  '/api/auth/register',
  '/api/auth/password-reset/request',
  '/api/auth/password-reset/verify',
]);

function getAuthStore() {
  try {
    if (window.Pinia && typeof window.Pinia.useAuthStore === 'function') {
      return window.Pinia.useAuthStore();
    }
  } catch {
    /* store not ready yet */
  }
  return null;
}

function getStoredToken() {
  try {
    return localStorage.getItem('authToken') || null;
  } catch {
    return null;
  }
}

function getActiveToken() {
  const store = getAuthStore();
  if (store) {
    try {
      return store.getActiveToken?.() || store.token || getStoredToken();
    } catch {
      return store.token || getStoredToken();
    }
  }
  return getStoredToken();
}

function applyFreshToken(token, requestToken) {
  if (!token) return false;
  const activeToken = getActiveToken();
  if (activeToken && activeToken !== requestToken) return false;
  try { localStorage.setItem('authToken', token); } catch {}
  const store = getAuthStore();
  if (store) store.token = token;
  return true;
}

function toUrl(input) {
  try {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw || typeof window === 'undefined' || !window.location) return null;
    return new URL(raw, window.location.href);
  } catch {
    return null;
  }
}

function isSameOriginApi(url) {
  if (!url || typeof window === 'undefined' || !window.location) return false;
  return url.origin === window.location.origin && url.pathname.startsWith('/api/');
}

function isPublicAuthEndpoint(url) {
  if (!url) return false;
  const path = url.pathname;
  if (PUBLIC_AUTH_PATHS.has(path)) return true;
  if (path.startsWith('/api/auth/sso/poll/')) return true;
  if (/^\/api\/auth\/sso\/[^/]+\/start(?:-qr)?$/.test(path)) return true;
  return false;
}

function headersFrom(input, init) {
  if (init?.headers) return new Headers(init.headers);
  if (input && typeof input === 'object' && input.headers) return new Headers(input.headers);
  return new Headers();
}

function bearerTokenFrom(headers) {
  const value = headers.get('Authorization');
  if (!value || !value.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length);
}

function withHeaders(init, headers) {
  return { ...(init || {}), headers };
}

function handleUnauthorized(response, requestToken, requestGeneration, requestWasAuthenticated) {
  const store = getAuthStore();
  if (store && typeof store.handleAuthResponse === 'function') {
    store.handleAuthResponse(response, requestToken, requestGeneration, requestWasAuthenticated);
  } else if (store && typeof store.handleAuthFailure === 'function' && requestWasAuthenticated) {
    store.handleAuthFailure(undefined, requestToken, requestGeneration);
  }
}

export function installAuthFetch() {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    const url = toUrl(input);
    const shouldAuth = isSameOriginApi(url) && !isPublicAuthEndpoint(url);
    let nextInit = isSameOriginApi(url) ? { ...(init || {}), credentials: 'same-origin' } : init;
    let requestToken = null;
    const authStore = shouldAuth ? getAuthStore() : null;
    const requestGeneration = authStore?.authGeneration;
    const requestWasAuthenticated = !!authStore?.isAuthenticated;

    if (shouldAuth) {
      const headers = headersFrom(input, init);
      requestToken = bearerTokenFrom(headers);
      if (!requestToken) {
        requestToken = getActiveToken();
        if (requestToken) {
          headers.set('Authorization', `Bearer ${requestToken}`);
          nextInit = withHeaders(nextInit, headers);
        }
      }
    }

    const response = await originalFetch(input, nextInit);
    try {
      const fresh = response.headers && response.headers.get && response.headers.get('X-New-Token');
      if (fresh) applyFreshToken(fresh, requestToken);

      if (shouldAuth && response.status === 401) {
        handleUnauthorized(response, requestToken, requestGeneration, requestWasAuthenticated);
      }
    } catch {
      /* never let auth bookkeeping break fetch semantics */
    }
    return response;
  };
}
