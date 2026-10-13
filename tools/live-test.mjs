#!/usr/bin/env node
/**
 * Live run of the plugin logic without the harness: we plug a `ctx.subprocess`
 * adapter on top of node:child_process, a stub for attachments and the real
 * settings, then call the tools the way an agent would.
 *
 *   node tools/live-test.mjs --vmid 100 --ssh-config ~/.ssh/config
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { VmController } from '../lib/session.js';
import { resolveSettings } from '../lib/config.js';
import { consoleTools } from '../tools/console.js';
import { guestTools } from '../tools/guest.js';

function parseArgs(argv) {
  const options = { vmid: undefined, sshConfig: '', out: 'probe-out' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--vmid') options.vmid = Number(argv[++i]);
    else if (argv[i] === '--ssh-config') options.sshConfig = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
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
      collected[stream] = {
        readFrom: () => {
          const limit = mode.maxBytes ?? text.length;
          const slice = text.slice(0, limit);
          return { text: slice, nextOffset: text.length, lossy: text.length > limit };
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
  consoleTimeoutMs: 20000,
  sessionIdleMs: 300000,
  guestTimeoutMs: 60000,
  guestTypeCommand: undefined,
};
const settings = () => {
  const resolved = resolveSettings(values);
  if (values.guestTypeCommand === undefined) delete resolved.guestTypeCommand;
  return { ...resolved, guestTypeCommand: values.guestTypeCommand ?? '' };
};

const saved = [];
const attachments = {
  saveImage: async ({ data, mediaType, name }) => {
    const index = String(saved.length + 1).padStart(2, '0');
    const file = `${options.out}/${index}-${name ?? 'image.png'}`;
    fs.writeFileSync(file, data);
    saved.push(file);
    return { attachmentId: `test-${saved.length}`, mediaType, bytes: data.length, width: 0, height: 0, name };
  },
};

const controller = new VmController({ settings, spawn: adapter, cwd: process.cwd() });
const deps = { controller, settings, attachments };
const tools = new Map([...consoleTools(deps), ...guestTools(deps)].map((tool) => [tool.name, tool]));

const results = [];
async function run(name, args, note) {
  const tool = tools.get(name);
  const started = Date.now();
  try {
    const value = await tool.execute(args, { signal: undefined });
    const text = tool.output.render(args, value).map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
    results.push({ name, note, ok: true, ms: Date.now() - started, value: summarize(value), text: text.slice(0, 400) });
    return value;
  } catch (error) {
    results.push({ name, note, ok: false, ms: Date.now() - started, error: `${error.name}: ${error.message}` });
    return null;
  }
}

const summarize = (value) => {
  const copy = { ...value };
  if (copy.attachment) copy.attachment = '<image>';
  return copy;
};

await run('vm_status', { vmid: options.vmid }, 'VM status');
await run('vm_exec', { vmid: options.vmid, argv: ['powershell.exe', '-NoProfile', '-Command', '$env:COMPUTERNAME; (Get-Date).ToString("s")'] }, 'PowerShell via the guest agent');
await run('console_shot', { vmid: options.vmid }, 'first frame');
await run('vm_type_text', { vmid: options.vmid, text: 'кириллица из dsh-pve-vm', settleMs: 900 }, 'non-ASCII in Windows: task in the session (SendKeys)');
await run('console_paste', { vmid: options.vmid, text: 'вставка из буфера: проверка', settleMs: 900 }, 'clipboard → Ctrl+V (vdagent required)');
await run('console_batch', { vmid: options.vmid, actions: [{ do: 'key', combo: 'ctrl+a' }, { do: 'key', combo: 'ctrl+c' }, { do: 'wait', ms: 400 }], observe: false }, 'select all and copy in the guest');
await run('console_clipboard', { vmid: options.vmid, timeoutMs: 8000 }, 'read the guest clipboard');
await run('vm_file_write', { vmid: options.vmid, path: 'C:\\Windows\\Temp\\dsh-pve-vm-test.txt', data: 'привет от dsh-pve-vm\n' }, 'write the file');
await run('vm_file_read', { vmid: options.vmid, path: 'C:\\Windows\\Temp\\dsh-pve-vm-test.txt' }, 'read the file back');
await run('console_click', { vmid: options.vmid, x: 437, y: 779, settleMs: 900 }, 'click the Start button');
await run('console_batch', { vmid: options.vmid, actions: [{ do: 'key', combo: 'esc' }, { do: 'wait', ms: 400 }], settleMs: 600 }, 'Escape and a frame');
await run('console_release', { vmid: options.vmid }, 'close the session');

controller.closeAll();
process.stdout.write(`${JSON.stringify({ results, saved }, null, 2)}\n`);
process.exit(results.every((item) => item.ok !== undefined) ? 0 : 1);
