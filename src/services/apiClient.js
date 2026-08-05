/**
 * HTTP client for the VegDrop API.
 *
 * Design notes that matter for security:
 *
 *  - The access token lives in a module-scoped variable, never in localStorage
 *    or sessionStorage. Anything in web storage is readable by any script that
 *    achieves XSS; a variable in a module closure is not, and the token dies
 *    with the tab.
 *  - The refresh token is an httpOnly cookie the browser attaches automatically.
 *    JavaScript cannot read it, so it is never exposed here at all.
 *  - A 401 triggers exactly one refresh attempt, then a single retry. Concurrent
 *    401s share one in-flight refresh rather than stampeding the endpoint.
 *  - A failed request is a failed request. There is no local fallback path: the
 *    previous client treated a network error as permission to authenticate
 *    itself, which made the entire login flow bypassable by going offline.
 */

const API_BASE = '/api';

let accessToken = null;
let refreshPromise = null;
const listeners = new Set();

/** Subscribe to session changes (sign-in, sign-out, silent refresh). */
export function onSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(user) {
  for (const listener of listeners) {
    try {
      listener(user);
    } catch (err) {
      console.error('session listener failed', err);
    }
  }
}

export function setAccessToken(token) {
  accessToken = token || null;
}

export function getAccessToken() {
  return accessToken;
}

export function clearSession() {
  accessToken = null;
  emit(null);
}

/** Error carrying the server's structured error envelope. */
export class ApiRequestError extends Error {
  constructor(status, body) {
    const detail = body?.error?.message || `Request failed with status ${status}`;
    super(detail);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.details = body?.error?.details;
    this.requestId = body?.error?.requestId;
  }
}

/** Distinguishes "the server never answered" from "the server said no". */
export class NetworkError extends Error {
  constructor(cause) {
    super('Unable to reach the server. Check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

async function parseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body from an API that only speaks JSON means a proxy or error
    // page intercepted the request; surface it rather than guessing.
    return { error: { code: 'BAD_RESPONSE', message: 'Unexpected response from server.' } };
  }
}

/**
 * Exchange the httpOnly refresh cookie for a new access token.
 * Concurrent callers share a single in-flight request.
 */
export function refreshSession() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      const body = await parseBody(response);
      if (!response.ok) {
        accessToken = null;
        return null;
      }

      accessToken = body.accessToken;
      emit(body.user);
      return body.user;
    } catch {
      accessToken = null;
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Perform an API request.
 *
 * @param {string} path         path below /api, e.g. "/orders"
 * @param {object} [options]
 * @param {boolean} [options.auth=true]  attach the access token and retry once on 401
 * @throws {ApiRequestError} when the server returns a non-2xx response
 * @throws {NetworkError}    when the request never reached the server
 */
export async function apiFetch(path, { method = 'GET', body, auth = true, signal } = {}) {
  const send = async () => {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

    return fetch(`${API_BASE}${path}`, {
      method,
      headers,
      // Required for the refresh cookie to travel with auth requests.
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  };

  let response;
  try {
    response = await send();
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }

  // One silent refresh, then one retry. Never more: a refresh loop against an
  // expired session would hammer the endpoint.
  if (response.status === 401 && auth) {
    const user = await refreshSession();
    if (user) {
      try {
        response = await send();
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new NetworkError(err);
      }
    } else {
      clearSession();
    }
  }

  const parsed = await parseBody(response);

  if (!response.ok) {
    throw new ApiRequestError(response.status, parsed);
  }

  return parsed;
}

export const api = {
  get: (path, options) => apiFetch(path, { ...options, method: 'GET' }),
  post: (path, body, options) => apiFetch(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => apiFetch(path, { ...options, method: 'PATCH', body }),
  // Used where a call replaces a whole collection rather than editing fields —
  // a market's price sheet, a stall's declared stock.
  put: (path, body, options) => apiFetch(path, { ...options, method: 'PUT', body }),
  delete: (path, options) => apiFetch(path, { ...options, method: 'DELETE' }),
};
