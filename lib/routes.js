/**
 * HTTP routes of the observation panel: `/pve-vm/console/*`.
 *
 * Why HTTP and not a harness RPC. The panel is an ordinary page of the same origin,
 * and frames are easy to pull with `fetch`; the browser-skill overview is built the
 * same way (`/bsk-observation/*`). The routes register on the `webServer` service; a
 * composition without a web server (a headless profile) simply never registers them,
 * while the agent tools keep working as usual.
 *
 * Security. A VM screen is sensitive: passwords, chats, a working desktop. So these
 * routes carry their own fence: we answer only when Host is a loopback authority
 * (localhost / 127.0.0.0/8 / [::1]), a present Origin matches Host, and
 * `sec-fetch-site: cross-site` is refused outright; POST must be `application/json`,
 * so a cross-site simple request never reaches the handler. DSH itself applies the
 * same order of checks to `/api` (`@deepseek-ai/dsh-client-connection`), and so does
 * browser-skill; it is repeated here so that the published plugin depends on no
 * internal package.
 */
import { VmError } from './session.js';

/** Base path of the panel routes. */
export const VIEW_BASE = '/pve-vm/console';

/** Error codes to HTTP statuses. */
const STATUS_BY_CODE = {
  BAD_VMID: 400,
  NOT_ALLOWED: 403,
  CHANNEL_DISABLED: 403,
  CONSOLE_CLOSED: 409,
  CONSOLE_FAILED: 502,
  SSH_FAILED: 502,
  EOF: 502,
  TIMEOUT: 504,
};

/** Answer with JSON. */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Turn a panel request failure into a response. */
function fail(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const code = error instanceof VmError ? error.code : undefined;
  const status = STATUS_BY_CODE[code] ?? 500;
  sendJson(res, status, { error: error?.message ?? String(error), ...(code ? { code } : {}) });
}

/**
 * The fence's verdict: the reason for refusal, or undefined.
 * @param {import('node:http').IncomingMessage} req the request.
 * @returns {string|undefined} the reason for refusal.
 */
function fenceViolation(req) {
  const host = req.headers.host ?? '';
  const hostname = /^\[.*\](?::\d+)?$/.test(host) ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!loopback) return 'host is not a loopback authority';
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'unparseable Origin header';
    }
    if (originHost !== host) return 'Origin does not match Host';
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'sec-fetch-site: cross-site';
  if (req.method === 'POST') {
    const contentType = req.headers['content-type'] ?? '';
    if (!/^\s*application\/json\s*(;|$)/.test(contentType)) return 'POST requires an application/json body';
  }
  return undefined;
}

/** Run the fence; true means the request was already refused and answered. */
function fenceRejected(req, res) {
  const violation = fenceViolation(req);
  if (violation === undefined) return false;
  sendJson(res, 403, { error: `forbidden: ${violation}` });
  return true;
}

/** Read the JSON body of a small request. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new VmError('request body is too large', 'BAD_BODY');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new VmError('request body is not JSON', 'BAD_BODY');
  }
}

/**
 * Register the panel routes on the web server.
 * @param {object} webServer the `webServer` service.
 * @param {{view: object}} deps the observation panel.
 * @returns {() => void} disposer removing the routes.
 */
export function registerViewRoutes(webServer, deps) {
  const view = deps.view;
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${VIEW_BASE}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        if (fenceRejected(req, res)) return;
        try {
          sendJson(res, 200, view.state());
        } catch (error) {
          fail(res, error);
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${VIEW_BASE}/frame`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        if (fenceRejected(req, res)) return;
        const url = new URL(req.url ?? '/', 'http://localhost');
        const rawScale = url.searchParams.get('scale');
        try {
          const { png, meta } = await view.frame(Number(url.searchParams.get('vmid')), {
            scale: rawScale === null ? undefined : Number(rawScale),
            cursor: url.searchParams.get('cursor') !== '0',
          });
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(png.length),
            'cache-control': 'no-store, max-age=0',
            'x-pve-vm-vmid': String(meta.vmid),
            'x-pve-vm-resolution': `${meta.width}x${meta.height}`,
            'x-pve-vm-capture': `${meta.captureWidth}x${meta.captureHeight}`,
            'x-pve-vm-scale': String(meta.scale),
            'x-pve-vm-pointer': `${meta.pointerX},${meta.pointerY}`,
            'x-pve-vm-cursor': meta.cursorDrawn ? '1' : '0',
            'x-pve-vm-blank': meta.blank ? '1' : '0',
            'x-pve-vm-session': meta.sessionAlive ? 'alive' : 'closed',
          });
          res.end(png);
        } catch (error) {
          fail(res, error);
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${VIEW_BASE}/release`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        if (fenceRejected(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const closed = view.release(Number(body.vmid));
          sendJson(res, 200, { closed });
        } catch (error) {
          fail(res, error);
        }
      },
    }),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
