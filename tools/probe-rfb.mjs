#!/usr/bin/env node
/**
 * Standalone probe of the Proxmox console: ssh → `qm vncproxy` → RFB → PNG.
 * Needs no harness — only node and ssh access to the node.
 *
 * Examples:
 *   node tools/probe-rfb.mjs --vmid 100 --ssh-config ~/.ssh/config --out /tmp/shot.png
 *   node tools/probe-rfb.mjs --vmid 100 --click 20,1050 --after /tmp/after.png
 *   node tools/probe-rfb.mjs --vmid 100 --text "hello"
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { RfbClient } from '../lib/rfb.js';
import { encodePng } from '../lib/png.js';
import { encodeText, parseCombo } from '../lib/keys.js';
import { shellQuote, sshArgv, vncPassword, vncProxyCommand } from '../lib/ssh.js';

function parseArgs(argv) {
  const options = {
    vmid: undefined,
    host: 'proxmox',
    user: 'root',
    port: undefined,
    keyPath: undefined,
    sshConfig: undefined,
    out: 'shot.png',
    after: undefined,
    click: undefined,
    move: undefined,
    text: undefined,
    key: undefined,
    timeout: 20000,
    wait: 900,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--vmid') options.vmid = Number(next());
    else if (token === '--host') options.host = next();
    else if (token === '--user') options.user = next();
    else if (token === '--port') options.port = Number(next());
    else if (token === '--key') options.keyPath = next();
    else if (token === '--ssh-config') options.sshConfig = next();
    else if (token === '--out') options.out = next();
    else if (token === '--after') options.after = next();
    else if (token === '--click') options.click = next();
    else if (token === '--move') options.move = next();
    else if (token === '--text') options.text = next();
    else if (token === '--key-combo') options.key = next();
    else if (token === '--timeout') options.timeout = Number(next());
    else if (token === '--wait') options.wait = Number(next());
    else if (token === '--verbose') options.verbose = true;
    else if (token === '--wake') options.wake = true;
    else throw new Error(`unknown argument ${token}`);
  }
  if (!Number.isInteger(options.vmid) || options.vmid <= 0) throw new Error('pass --vmid <VM id>');
  return options;
}

function point(value) {
  const [x, y] = String(value).split(',').map((part) => Number(part.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`cannot parse coordinates "${value}"`);
  return { x, y };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const password = vncPassword();
  const argv = sshArgv({
    host: options.host,
    user: options.user,
    port: options.port,
    keyPath: options.keyPath,
    sshConfig: options.sshConfig,
    extraOptions: ['SendEnv=LC_PVE_TICKET', 'LogLevel=ERROR'],
    command: vncProxyCommand(options.vmid),
  });
  const child = spawn(argv[0], argv.slice(1), {
    env: { ...process.env, LC_PVE_TICKET: password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // stdin stays open: an EOF on it makes the `qm vncproxy` bridge exit.
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const started = Date.now();
  const client = new RfbClient({ input: child.stdout, output: child.stdin, timeoutMs: options.timeout });
  if (options.verbose) {
    let chunks = 0;
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      chunks += 1;
      bytes += chunk.length;
      if (chunks <= 12) process.stderr.write(`chunk#${chunks} t+${Date.now() - started}ms size=${chunk.length} total=${bytes}\n`);
    });
    client.on('rect', (rect) => process.stderr.write(`rect t+${Date.now() - started}ms ${JSON.stringify(rect)}\n`));
    const timer = setInterval(() => {
      process.stderr.write(`progress t+${Date.now() - started}ms chunks=${chunks} bytes=${bytes} pending=${client.reader.length}\n`);
    }, 2000);
    timer.unref();
  }
  try {
    await client.connect({ password });
    if (options.wake) {
      // The guest OS blanks the display when idle and the frame stays black:
      // any input event wakes the session, after which the frame has content again.
      client.keyEvent(0xffe1, true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      client.keyEvent(0xffe1, false);
      client.pointerEvent(Math.max(0, client.pointer.x - 2), Math.max(0, client.pointer.y - 2), 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      client.pointerEvent(client.pointer.x + 2, client.pointer.y + 2, 0);
      await new Promise((resolve) => setTimeout(resolve, options.wait));
    }
    client.requestUpdate({ incremental: false });
    const update = await client.waitForUpdate({ timeoutMs: options.timeout });
    const elapsedMs = Date.now() - started;
    const shot = client.snapshot();
    fs.writeFileSync(options.out, encodePng(shot));
    const result = {
      vmid: options.vmid,
      fbName: client.name,
      width: shot.width,
      height: shot.height,
      rectangles: update.rectangles,
      cursor: client.cursor ? { width: client.cursor.width, height: client.cursor.height, hotspotX: client.cursor.hotspotX, hotspotY: client.cursor.hotspotY } : null,
      elapsedMs,
      out: options.out,
      bytes: fs.statSync(options.out).size,
    };

    if (options.move) {
      const to = point(options.move);
      client.pointerEvent(to.x, to.y, 0);
      result.moved = to;
    }
    if (options.click) {
      const at = point(options.click);
      client.pointerEvent(at.x, at.y, 0);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await client.click({ button: 'left' });
      await new Promise((resolve) => setTimeout(resolve, options.wait));
      client.requestUpdate({ incremental: false });
      await client.waitForUpdate({ timeoutMs: options.timeout });
      const after = client.snapshot();
      if (options.after) fs.writeFileSync(options.after, encodePng(after));
      result.clicked = at;
      result.after = options.after ?? null;
    }
    if (options.text) {
      await client.typeSteps(encodeText(options.text));
      await new Promise((resolve) => setTimeout(resolve, options.wait));
      client.requestUpdate({ incremental: false });
      await client.waitForUpdate({ timeoutMs: options.timeout });
      if (options.after) fs.writeFileSync(options.after, encodePng(client.snapshot()));
      result.typed = options.text;
    }
    if (options.key) {
      await client.pressCombo(parseCombo(options.key));
      await new Promise((resolve) => setTimeout(resolve, options.wait));
      client.requestUpdate({ incremental: false });
      await client.waitForUpdate({ timeoutMs: options.timeout });
      if (options.after) fs.writeFileSync(options.after, encodePng(client.snapshot()));
      result.pressed = options.key;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    try {
      child.stdin.end();
    } catch {}
    child.kill('SIGTERM');
  }
  if (stderr.trim().length > 0) process.stderr.write(`ssh stderr: ${stderr.trim().slice(0, 800)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
