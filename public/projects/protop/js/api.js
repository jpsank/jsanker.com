// The only place the ProTop pages talk to the network. Everything is relative to the site, never a third party:
// the Flask service behind /projects/protop/api fetches RCSB, UniProt, AlphaKnot and KnotProt itself.
// See protop-app/API.md for the contract.

export const BASE = '/projects/protop/api';

export class ApiError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.status = status; // 0 = no answer at all (offline, timeout)
    this.retryAfter = retryAfter; // seconds
  }
}

const FRIENDLY = {
  404: 'Not found.',
  413: 'That is too large.',
  429: 'Too many requests just now. Give it a minute and try again.',
  502: 'An upstream database did not answer properly.',
  503: 'The service is busy. Try again in a little while.',
  504: 'An upstream database took too long to answer.',
};

/** method + path (relative to BASE) -> parsed JSON, or text with {text: true}. Throws ApiError. */
export async function request(method, path, { body, timeout = 20000, signal, text = false } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError' && !timedOut) throw e; // the caller cancelled: let it know
    throw new ApiError(0, timedOut ? 'The server took too long to answer.' : 'Could not reach the server.');
  }
  try {
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch { /* not JSON (a proxy error page, say) */ }
      throw new ApiError(res.status, msg || FRIENDLY[res.status] || 'Something went wrong (' + res.status + ').', +res.headers.get('Retry-After') || 0);
    }
    if (res.status === 204) return null;
    return text ? await res.text() : await res.json();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError' && !timedOut) throw e;
    throw new ApiError(0, timedOut ? 'The server took too long to answer.' : 'The answer was cut off.');
  } finally {
    clearTimeout(timer);
  }
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, body, opts) => request('POST', path, { ...opts, body });

export const isAbort = (e) => e && e.name === 'AbortError';
export const msgOf = (e) => (e instanceof ApiError ? e.message : 'Something went wrong.');

/** Room URLs. ids are validated so a pasted hash can never reach out of the /rooms/ path. */
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
export const roomPath = (id) => '/rooms/' + encodeURIComponent(id);
export const WORKSPACE_URL = '/projects/protop/workspace/';
