#!/usr/bin/env node
/**
 * Probe that reads the guest clipboard.
 *
 * Scenario: open Notepad, type Cyrillic into it with a task in the session
 * (the vm_type_text path), select all and copy (Ctrl+A, Ctrl+C over RFB),
 * then fetch the guest clipboard through the extended clipboard (the
 * console_clipboard path).
 *
 * Requires `vga: <type>,clipboard=vnc` on the VM and a live SPICE agent in
 * the guest.
 *
 *   node tools/clipboard-read-test.mjs --vmid 100 --ssh-config ~/.ssh/config
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { VmController } from '../lib/session.js';
import { resolveSettings } from '../lib/config.js';
import { powershellArgv, windowsTypeScript } from '../lib/guest.js';
import { RfbClient } from '../lib/rfb.js';
import { encodePng } from '../lib/png.js';
import { sshArgv, vncPassword, vncProxyCommand } from '../lib/ssh.js';

const CTRL = 0xffe3;

function parseArgs(argv) {
  const options = {
    vmid: undefined,
    sshConfig: '',
    out: 'clipboard-read.png',
    text: 'текст из гостя: строка 42',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--vmid') options.vmid = Number(argv[++i]);
    else if (argv[i] === '--ssh-config') options.sshConfig = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
    else if (argv[i] === '--text') options.text = argv[++i];
  }
  if (!Number.isInteger(options.vmid) || options.vmid <= 0) throw new Error('pass --vmid <VM id>');
  return options;
}

/** Adapter for ctx.subprocess on top of node:child_process. */
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
      collected[stream] = { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const settings = () => ({
    ...resolveSettings({
      sshHost: 'proxmox',
      sshConfigFile: options.sshConfig,
      allowVmids: [options.vmid],
      inputChannel: 'auto',
      sendkeyDelayMs: 80,
    }),
    guestTypeCommand: '',
  });
  const controller = new VmController({ settings, spawn: adapter, cwd: process.cwd() });

  const password = vncPassword();
  const argv = sshArgv({
    host: 'proxmox',
    user: 'root',
    sshConfig: options.sshConfig,
    extraOptions: ['SendEnv=LC_PVE_TICKET', 'LogLevel=ERROR'],
    command: vncProxyCommand(options.vmid),
  });
  const child = spawn(argv[0], argv.slice(1), {
    env: { ...process.env, LC_PVE_TICKET: password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new RfbClient({ input: child.stdout, output: child.stdin, timeoutMs: 20000, extendedClipboard: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const report = { expected: options.text };

  try {
    await client.connect({ password });
    await client.wake({ settleMs: 300 });

    // Open Notepad: the Start menu with the Win key (RFB), while the program
    // name is typed through SendKeys — it sends characters, not keys, so the
    // guest layout (often Russian after login) does not get in its way.
    await client.tap(0xffeb, { holdMs: 60, gapMs: 900 });
    const opened = await controller.guestExec(options.vmid, powershellArgv(windowsTypeScript('notepad')), {
      timeoutMs: 60000,
    });
    report.opened = `${opened.stdout}`.trim();
    await wait(500);
    await client.tap(0xff0d, { holdMs: 40, gapMs: 2600 });

    // We type the text inside the user session: layout and modifiers do not matter.
    const typed = await controller.guestExec(options.vmid, powershellArgv(windowsTypeScript(options.text)), {
      timeoutMs: 60000,
    });
    report.typed = `${typed.stdout}`.trim();
    await wait(800);

    // Select and copy — now the clipboard belongs to the guest, not to us.
    client.keyEvent(CTRL, true);
    await wait(60);
    await client.tap(0x61, { holdMs: 40, gapMs: 120 }); // a
    await client.tap(0x63, { holdMs: 40, gapMs: 400 }); // c
    client.keyEvent(CTRL, false);
    await wait(500);

    report.read = await client.readClipboard({ timeoutMs: 8000 });
    report.match = report.read === options.text;

    client.requestUpdate({ incremental: false });
    await client.waitForUpdate({});
    fs.writeFileSync(options.out, encodePng(client.snapshot()));
    report.out = options.out;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    controller.closeAll();
    try {
      child.stdin.end();
    } catch {}
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  process.stderr.write(`clipboard-read-test failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
