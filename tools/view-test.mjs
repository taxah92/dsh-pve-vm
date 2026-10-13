#!/usr/bin/env node
/**
 * Live probe of the observation panel without the harness: a real HTTP server is
 * started, the plugin's routes (`registerViewRoutes`) are registered on it, and
 * they are called the way a browser would: state -> frame -> frame -> release.
 *
 * It checks exactly what static analysis cannot: a frame arrives as a real PNG
 * from a live VM, an incremental frame does not tear the stream, the fence refuses
 * a foreign Host, and release closes the console session.
 *
 *   node tools/view-test.mjs --vmid 100 --ssh-config ~/.ssh/config
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import { resolveSettings } from '../lib/config.js';
import { registerViewRoutes, VIEW_BASE } from '../lib/routes.js';
import { VmController } from '../lib/session.js';
import { ConsoleView } from '../lib/view.js';

function parseArgs(argv) {
  const options = { vmid: undefined, sshConfig: '', out: 'probe-out/view', scale: 2, fps: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--vmid') options.vmid = Number(argv[++i]);
    else if (argv[i] === '--ssh-config') options.sshConfig = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
    else if (argv[i] === '--scale') options.scale = Number(argv[++i]);
    else if (argv[i] === '--fps') options.fps = Number(argv[++i]);
  }
  if (!Number.isInteger(options.vmid) || options.vmid <= 0) throw new Error('pass --vmid <VM id>');
  return options;
}

/** Adapter for ctx.subprocess on top of node:child_process (as in live-test.mjs). */
function adapter(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const collected = {};
  for (const stream of ['stdout', 'stderr']) {
    const mode = spec.stdio?.[stream];
    if (mode && typeof mode === 'object') {
      let text = '';
      child[stream].on('data', (chunk) => {
        text += chunk.toString('utf8');
      });
      collected[stream] = {
        readFrom: () => {
          const limit = mode.maxBytes ?? text.length;
          return { text: text.slice(0, limit), nextOffset: text.length, lossy: text.length > limit };
        },
      };
    }
  }
  const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected,
    done,
    terminate: () => child.kill('SIGTERM'),
    waitForExit: async () => true,
  };
}

const options = parseArgs(process.argv.slice(2));
fs.mkdirSync(options.out, { recursive: true });

const values = {
  sshHost: 'proxmox',
  sshUser: 'root',
  sshPort: 22,
  sshKeyPath: '',
  sshConfigFile: options.sshConfig,
  sshExtraOptions: [],
  allowVmids: [options.vmid],
  enableConsole: true,
  enableGuest: true,
  inputChannel: 'auto',
  sendkeyDelayMs: 80,
  consoleTimeoutMs: 20000,
  sessionIdleMs: 300000,
  guestTimeoutMs: 60000,
  guestTypeCommand: '',
  viewAutoOpen: false,
  viewFollowAgent: true,
  viewFps: options.fps,
  viewScale: options.scale,
};
const settings = () => resolveSettings(values);

const controller = new VmController({ settings, spawn: adapter, cwd: process.cwd() });
const view = new ConsoleView({ controller, settings });

const routes = [];
const registered = [];
const webServer = {
  register(route) {
    routes.push(route);
    return () => {
      const index = registered.indexOf(route);
      if (index >= 0) registered.splice(index, 1);
    };
  },
};
const disposeRoutes = registerViewRoutes(webServer, { view });

const problems = [];
const note = (message) => problems.push(message);

// A real http server serves the routes: that way both the headers and the fence
// (which reads Host/Origin/sec-fetch-site of the real request) are exercised.
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const route = routes.find((entry) => entry.kind === 'exact' && entry.path === path);
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  Promise.resolve(route.handler(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}${VIEW_BASE}`;

/** A request with an arbitrary Host header (fetch refuses to override it). */
function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

const report = { vmid: options.vmid, state: null, frames: [], fence: null, release: null };

try {
  const stateResponse = await fetch(`${base}/state`, { headers: { accept: 'application/json' } });
  const state = await stateResponse.json();
  report.state = { status: stateResponse.status, allowed: state.allowed, consoleEnabled: state.consoleEnabled };
  if (stateResponse.status !== 200) note(`state: статус ${stateResponse.status}`);
  if (!Array.isArray(state.allowed) || state.allowed[0] !== options.vmid) note('state: allowVmids не совпал');
  if (state.view?.scale !== options.scale || state.view?.fps !== options.fps) note('state: настройки панели не совпали');

  for (const pass of [1, 2]) {
    const started = Date.now();
    const response = await fetch(`${base}/frame?vmid=${options.vmid}&scale=${options.scale}&cursor=1`);
    const body = Buffer.from(await response.arrayBuffer());
    const elapsedMs = Date.now() - started;
    const png = body.subarray(0, 8).toString('latin1') === '\u0089PNG\r\n\u001a\n';
    const meta = {
      pass,
      status: response.status,
      bytes: body.length,
      png,
      resolution: response.headers.get('x-pve-vm-resolution'),
      capture: response.headers.get('x-pve-vm-capture'),
      scale: response.headers.get('x-pve-vm-scale'),
      blank: response.headers.get('x-pve-vm-blank'),
      pointer: response.headers.get('x-pve-vm-pointer'),
      session: response.headers.get('x-pve-vm-session'),
      elapsedMs,
    };
    report.frames.push(meta);
    if (response.status !== 200) note(`кадр ${pass}: статус ${response.status}: ${body.toString('utf8').slice(0, 200)}`);
    else if (!png) note(`кадр ${pass}: это не PNG`);
    else fs.writeFileSync(`${options.out}/frame-${pass}.png`, body);
  }
  // The second frame goes through the incremental path: it must not be more than
  // twice as slow as the first, or the panel holds the session queue for nothing.
  const [first, second] = report.frames;
  if (first && second && second.elapsedMs > Math.max(1500, first.elapsedMs * 2)) {
    note(`инкрементальный кадр неожиданно медленный: ${second.elapsedMs} мс против ${first.elapsedMs} мс`);
  }

  const foreign = await rawGet(`${VIEW_BASE}/state`, { host: 'pve.example.net' });
  report.fence = { status: foreign.status, body: foreign.body.toString('utf8').slice(0, 120) };
  if (foreign.status !== 403) note(`a foreign Host was not refused (status ${foreign.status})`);

  // Watching must not look like agent work: otherwise the panel moves the "whom to
  // follow" mark itself and jumps between VMs in follow mode.
  report.mark = { afterFrames: controller.lastConsoleUse(), afterTool: null };
  if (controller.lastConsoleUse() !== null) {
    note(`panel frames marked agent work: last = ${JSON.stringify(controller.lastConsoleUse())}`);
  }
  await controller.withConsole(options.vmid, async () => 'agent-op');
  report.mark.afterTool = controller.lastConsoleUse();
  if (controller.lastConsoleUse()?.vmid !== options.vmid) note('an agent tool did not mark the VM in lastConsole');

  const releaseResponse = await fetch(`${base}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vmid: options.vmid }),
  });
  report.release = { status: releaseResponse.status, body: await releaseResponse.json() };
  if (releaseResponse.status !== 200 || report.release.body.closed !== true) {
    note(`release: ${releaseResponse.status} ${JSON.stringify(report.release.body)}`);
  }
  const after = await (await fetch(`${base}/state`)).json();
  if ((after.sessions ?? []).length !== 0) note('после release сессия консоли осталась жива');
} catch (error) {
  note(`проба упала: ${error?.stack ?? error}`);
} finally {
  disposeRoutes();
  controller.closeAll();
  await new Promise((resolve) => server.close(resolve));
}

report.problems = problems;
report.out = options.out;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(problems.length === 0 ? 0 : 1);
