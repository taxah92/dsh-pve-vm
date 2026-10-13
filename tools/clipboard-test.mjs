#!/usr/bin/env node
/**
 * Clipboard probe over VNC: we put text into the guest clipboard (RFB
 * ClientCutText) and paste it into Notepad with Ctrl+V.
 *
 * It works only if the VM has `vga: std,clipboard=vnc` enabled (QEMU brings up
 * the `qemu-vdagent` chardev and the `com.redhat.spice.0` port) and a SPICE
 * agent (the `spice-agent` service) is running in the guest.
 *
 *   node tools/clipboard-test.mjs --vmid 100 --ssh-config ~/.ssh/config \
 *        --text "Hello from the clipboard!" --out /tmp/clipboard.png
 *
 * The default --text value stays Cyrillic: it proves that non-ASCII survives
 * the clipboard path.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { RfbClient } from '../lib/rfb.js';
import { encodePng } from '../lib/png.js';
import { sshArgv, vncPassword, vncProxyCommand } from '../lib/ssh.js';

const CTRL = 0xffe3;

function parseArgs(argv) {
  const options = {
    vmid: undefined,
    sshConfig: '',
    out: 'clipboard.png',
    text: 'Привет из буфера обмена! Кириллица через VNC clipboard',
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
  const client = new RfbClient({ input: child.stdout, output: child.stdin, timeoutMs: 20000 });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const report = {};

  const tap = async (keysym, holdMs = 45, gapMs = 45) => client.tap(keysym, { holdMs, gapMs });

  try {
    await client.connect({ password });
    await client.wake({ settleMs: 300 });

    // Open Notepad: Win → search → notepad → Enter.
    await tap(0xffeb, 60, 900);
    for (const char of 'notepad') await tap(char.codePointAt(0), 30, 40);
    await wait(400);
    await tap(0xff0d, 40, 2600);

    // Put the text into the guest clipboard and paste it.
    client.clientCutText(options.text);
    report.sent = options.text;
    await wait(1200);
    client.keyEvent(CTRL, true);
    await wait(60);
    await tap(0x76, 40, 60); // v
    client.keyEvent(CTRL, false);
    await wait(1200);

    client.requestUpdate({ incremental: false });
    await client.waitForUpdate({});
    fs.writeFileSync(options.out, encodePng(client.snapshot()));
    report.out = options.out;
    report.bytes = fs.statSync(options.out).size;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    try {
      child.stdin.end();
    } catch {}
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  process.stderr.write(`clipboard-test failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
