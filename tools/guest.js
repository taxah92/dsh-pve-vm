/**
 * Guest agent tools: commands, files, state.
 * All of this is cheaper and more reliable than pixels — the console is only needed for the GUI.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { encodeText } from '../lib/keys.js';
import { textToSendkeys } from '../lib/hmp.js';
import { planTyping } from '../lib/keys.js';
import { encodePng } from '../lib/png.js';
import { VmError } from '../lib/session.js';
import {
  MAX_FILE_BYTES,
  clipboardHint,
  powershellArgv,
  windowsTypeScript,
  linuxReadFileArgv,
  linuxWriteFileArgv,
  shellArgv,
  typeTextArgv,
  unsupportedOs,
  windowsReadFileArgv,
  windowsWriteFileArgv,
} from '../lib/guest.js';

const EXEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vmid: { type: 'number', required: true, description: 'VM id.' },
    exitcode: { type: 'number', required: true, description: 'Exit code of the command in the guest.' },
    stdout: { type: 'string', required: true, description: 'Standard output.' },
    stderr: { type: 'string', required: true, description: 'Standard error output.' },
    truncated: { type: 'boolean', required: true, description: 'The output was truncated.' },
    command: { type: 'array', description: 'The argv that was actually executed.' },
  },
};

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    vmid: { type: 'number', required: true, description: 'VM id.' },
    allowed: { type: 'boolean', required: true, description: 'Whether the VM is in allowVmids.' },
    agent: { type: 'boolean', description: 'Whether qemu-guest-agent responds.' },
    os: { type: 'string', description: 'Guest OS family.' },
    config: { type: 'string', description: 'VM configuration lines (name/ostype/agent/vga).' },
    console: { type: 'json', description: 'Console session state.' },
    sessions: { type: 'array', description: 'Live console sessions.' },
    agentError: { type: 'string', description: 'Why the agent did not respond.' },
  },
};

/** Text-only response without an image. */
function textOutput(text) {
  return [{ type: 'text', text }];
}

/** Summary of a command result. */
function describeExec(value) {
  const parts = [`VM ${value.vmid}: the command finished with exit code ${value.exitcode}`];
  if (value.command) parts.push(`argv: ${value.command.join(' ')}`);
  if (value.truncated) parts.push('output truncated');
  const body = [];
  if (value.stdout) body.push(value.stdout.replace(/\s+$/, ''));
  if (value.stderr) body.push(`stderr:\n${value.stderr.replace(/\s+$/, '')}`);
  return `${parts.join('; ')}\n${body.join('\n')}`.trim();
}

/**
 * Build the guest agent tool definitions.
 * @param {{controller: object, settings: () => object}} deps
 * @returns {object[]} definitions for `ctx.tools.register`.
 */
export function guestTools(deps) {
  const { controller } = deps;

  return [
    {
      name: 'vm_exec',
      description:
        'Run a command inside the VM through qemu-guest-agent (Windows: cmd/PowerShell, Linux: shell) and return the ' +
        'output and the exit code. This is cheaper and more accurate than clicking on the screen. It runs as root/SYSTEM ' +
        'and does not see the graphical user session: GUI applications cannot be pressed this way.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        command: { type: 'string', description: 'Command for the guest shell (if argv is not set).' },
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ready-made argv without a shell — more reliable for PowerShell and paths with spaces.',
        },
        shell: {
          type: 'string',
          enum: ['auto', 'windows', 'linux'],
          description: 'Which shell to use for command (default auto — by the guest OS).',
        },
        timeoutMs: { type: 'number', description: 'Timeout, ms (default from the settings).' },
      },
      output: {
        schema: EXEC_SCHEMA,
        render: (args, value) => textOutput(describeExec(value)),
      },
      timeoutMs: 600000,
      async execute(args, exec) {
        let argv = Array.isArray(args.argv) && args.argv.length > 0 ? args.argv.map(String) : null;
        if (!argv) {
          if (typeof args.command !== 'string' || args.command.length === 0) {
            throw new VmError('either command or a non-empty argv is required', 'BAD_ARGS');
          }
          let family = args.shell ?? 'auto';
          if (family === 'auto') family = await controller.guestOs(args.vmid, { signal: exec?.signal });
          argv = shellArgv(family, args.command);
        }
        const result = await controller.guestExec(args.vmid, argv, { timeoutMs: args.timeoutMs, signal: exec?.signal });
        return {
          vmid: Number(args.vmid),
          exitcode: result.exitcode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          command: argv,
        };
      },
    },
    {
      name: 'vm_file_read',
      description:
        'Read a file inside the VM through the guest agent and return its contents. Text files are returned as text ' +
        '(up to 1 MB), binary files as a binary marker and base64.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        path: { type: 'string', required: true, description: 'Path to the file inside the guest.' },
        maxBytes: { type: 'number', description: 'How many bytes to read (default 262144, maximum 1048576).' },
        encoding: {
          type: 'string',
          enum: ['auto', 'text', 'base64'],
          description: 'auto — text if the content looks like UTF-8, otherwise base64.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vmid: { type: 'number', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true, description: 'How many bytes were read.' },
            encoding: { type: 'string', required: true, description: 'text or base64.' },
            content: { type: 'string', required: true, description: 'File contents.' },
            truncated: { type: 'boolean', required: true, description: 'The file is larger than the requested limit.' },
          },
        },
        render: (args, value) =>
          textOutput(
            `VM ${value.vmid}: ${value.path} — ${value.bytes} bytes (${value.encoding}${value.truncated ? ', truncated' : ''})\n${value.content}`,
          ),
      },
      timeoutMs: 300000,
      async execute(args, exec) {
        const maxBytes = Math.max(1, Math.min(MAX_FILE_BYTES, Number(args.maxBytes ?? 262144)));
        const family = await controller.guestOs(args.vmid, { signal: exec?.signal });
        const argv =
          family === 'windows'
            ? windowsReadFileArgv(args.path, maxBytes)
            : family === 'linux'
              ? linuxReadFileArgv(args.path, maxBytes)
              : (() => {
                  throw unsupportedOs(family, 'reading a file');
                })();
        const result = await controller.guestExec(args.vmid, argv, { timeoutMs: args.timeoutMs, signal: exec?.signal });
        if (result.exitcode !== 0) {
          throw new VmError(`failed to read ${args.path}: ${result.stderr.trim() || result.stdout.trim()}`, 'FILE_READ');
        }
        const base64 = result.stdout.replace(/\s+/g, '');
        const data = Buffer.from(base64, 'base64');
        const mode = args.encoding && args.encoding !== 'auto' ? args.encoding : looksTextual(data) ? 'text' : 'base64';
        return {
          vmid: Number(args.vmid),
          path: String(args.path),
          bytes: data.length,
          encoding: mode,
          content: mode === 'text' ? data.toString('utf8') : base64,
          truncated: data.length >= maxBytes,
        };
      },
    },
    {
      name: 'vm_file_write',
      description: 'Write a file inside the VM through the guest agent (up to 1 MB per call). Parent directories are created.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        path: { type: 'string', required: true, description: 'Path to the file inside the guest.' },
        data: { type: 'string', description: 'Contents as text.' },
        dataBase64: { type: 'string', description: 'Contents as base64 (for binary files).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vmid: { type: 'number', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true, description: 'How many bytes were written.' },
          },
        },
        render: (args, value) => textOutput(`VM ${value.vmid}: wrote ${value.bytes} bytes to ${value.path}`),
      },
      timeoutMs: 300000,
      async execute(args, exec) {
        const base64 =
          typeof args.dataBase64 === 'string' && args.dataBase64.length > 0
            ? args.dataBase64.replace(/\s+/g, '')
            : typeof args.data === 'string'
              ? Buffer.from(args.data, 'utf8').toString('base64')
              : null;
        if (base64 === null) throw new VmError('either data or dataBase64 is required', 'BAD_ARGS');
        const bytes = Buffer.from(base64, 'base64').length;
        if (bytes > MAX_FILE_BYTES) {
          throw new VmError(`the file is larger than ${MAX_FILE_BYTES} bytes per call; send it in chunks via vm_exec`, 'TOO_LARGE');
        }
        const family = await controller.guestOs(args.vmid, { signal: exec?.signal });
        const argv =
          family === 'windows'
            ? windowsWriteFileArgv(args.path, base64)
            : family === 'linux'
              ? linuxWriteFileArgv(args.path, base64)
              : (() => {
                  throw unsupportedOs(family, 'writing a file');
                })();
        const result = await controller.guestExec(args.vmid, argv, { timeoutMs: args.timeoutMs, signal: exec?.signal });
        if (result.exitcode !== 0) {
          throw new VmError(`failed to write ${args.path}: ${result.stderr.trim() || result.stdout.trim()}`, 'FILE_WRITE');
        }
        return { vmid: Number(args.vmid), path: String(args.path), bytes };
      },
    },
    {
      name: 'vm_type_text',
      description:
        'Type text into the VM, choosing the channel by content. Printable ASCII goes to the console ' +
        '(keysym, the `inputChannel` channel). Non-ASCII: on Windows — a task running in the user\'s ' +
        'session (`SendKeys`, Unicode and any layout, a logged-in session is required), on Linux — the ' +
        'guest agent (xdotool/wtype). On the Windows login screen this tool cannot help: use console_type with ASCII.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        text: { type: 'string', required: true, description: 'Text to type.' },
        settleMs: { type: 'number', description: 'Pause after typing, ms.' },
        observe: { type: 'boolean', description: 'Return a frame after typing (default yes).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vmid: { type: 'number', required: true },
            channel: { type: 'string', required: true, description: 'console, sendkey, session or guest.' },
            text: { type: 'string', required: true, description: 'The text that was typed.' },
            stdout: { type: 'string', description: 'Output of the typing command in the Linux guest.' },
            attachment: { type: 'json', description: 'Frame after typing, if requested.' },
          },
        },
        render: (args, value) => {
          const channel =
            value.channel === 'guest'
              ? 'the guest agent'
              : value.channel === 'sendkey'
                ? 'QEMU sendkey (node monitor)'
                : value.channel === 'session'
                  ? 'a task running in the user\'s session (SendKeys)'
                  : 'the console (RFB keysym)';
          const head = `VM ${value.vmid}: text typed through ${channel}`;
          const tail = value.stdout ? `\n${value.stdout.trim()}` : '';
          const blocks = [{ type: 'text', text: `${head}${tail}` }];
          if (value.attachment) blocks.push({ type: 'image', attachment: value.attachment });
          return blocks;
        },
      },
      timeoutMs: 300000,
      async execute(args, exec) {
        const text = String(args.text ?? '');
        if (text.length === 0) throw new VmError('empty text', 'BAD_ARGS');
        const ascii = /^[\x20-\x7e\r\n\t]*$/.test(text);
        if (ascii) {
          const channel = deps.settings().inputChannel;
          if (channel === 'hmp') {
            // QEMU sendkey: no VNC session is needed, but modifiers are sometimes lost.
            await controller.sendkeys(args.vmid, textToSendkeys(text));
          } else if (channel === 'vnc') {
            await controller.withConsole(args.vmid, async (client) => {
              await client.typeSteps(encodeText(text));
            });
          } else {
            // The reliable plan: Caps Lock for uppercase + keysym over RFB.
            const plan = planTyping(text);
            await controller.withConsole(args.vmid, async (client) => {
              await controller.typePlan(args.vmid, plan, client);
            });
          }
          const value = { vmid: Number(args.vmid), channel: channel === 'hmp' ? 'sendkey' : 'console', text };
          if (args.observe !== false) {
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, args.settleMs ?? 500)));
            value.attachment = await shotAttachment(controller, deps.attachments, args.vmid);
          }
          return value;
        }

        const family = await controller.guestOs(args.vmid, { signal: exec?.signal });
        if (family === 'windows') {
          // Windows: the text is typed by a task running in the user's session (SendKeys) —
          // this way the layout, the modifiers and Unicode are all handled for us.
          const budgetSec = Math.max(10, Math.min(120, Math.round((args.timeoutMs ?? 60000) / 1000) - 10));
          const typed = await controller.guestExec(args.vmid, powershellArgv(windowsTypeScript(text, { timeoutSec: budgetSec })), {
            timeoutMs: args.timeoutMs,
            signal: exec?.signal,
          });
          const output = `${typed.stdout}`.trim();
          if (output.includes('NO_SESSION')) {
            throw new VmError(
              'Windows has no logged-in session: this path types inside the user\'s session (SendKeys), ' +
                'and it is unavailable on the login screen. To log in, use console_type with an ASCII ' +
                'password and console_key (for example, `alt+shift` to switch the layout). ' +
                clipboardHint(args.vmid),
              'NO_SESSION',
            );
          }
          if (typed.exitcode !== 0 || !output.includes('TYPED')) {
            throw new VmError(
              `typing in the user\'s session did not work (code ${typed.exitcode}): ${output || typed.stderr.trim() || 'no output'}`,
              'SESSION_TYPE',
            );
          }
          const value = { vmid: Number(args.vmid), channel: 'session', text, stdout: output };
          if (args.observe !== false) {
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, args.settleMs ?? 500)));
            value.attachment = await shotAttachment(controller, deps.attachments, args.vmid);
          }
          return value;
        }
        if (family !== 'linux') throw unsupportedOs(family, 'typing non-ASCII text');
        const settings = deps.settings();
        const result = await controller.guestExec(args.vmid, typeTextArgv(settings.guestTypeCommand, text), {
          timeoutMs: args.timeoutMs,
          signal: exec?.signal,
        });
        if (result.exitcode !== 0) {
          throw new VmError(
            `typing through the guest agent did not work (code ${result.exitcode}): ${result.stderr.trim() || result.stdout.trim()}`,
            'GUEST_TYPE',
          );
        }
        const value = { vmid: Number(args.vmid), channel: 'guest', text, stdout: result.stdout };
        if (args.observe !== false) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, args.settleMs ?? 500)));
          value.attachment = await shotAttachment(controller, deps.attachments, args.vmid);
        }
        return value;
      },
    },
    {
      name: 'vm_status',
      description:
        'VM state: whether it is in allowVmids, whether qemu-guest-agent responds, which guest OS it is, and whether a console session is open.',
      parameters: {
        vmid: { type: 'number', description: 'VM id.' },
      },
      output: {
        schema: STATUS_SCHEMA,
        render: (args, value) => {
          if (!value.allowed) {
            return textOutput(`VM ${value.vmid}: not in allowVmids — the plugin does not work with it`);
          }
          return textOutput(
            [
              `VM ${value.vmid}: the agent ${value.agent ? 'responds' : 'does not respond'}, OS ${value.os ?? 'unknown'}`,
              value.agentError ? `reason: ${value.agentError}` : null,
              value.config ? `config:\n${value.config}` : null,
              value.console ? `console: ${value.console.resolution}${value.console.alive ? '' : ' (closed)'}` : 'console: no session',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        },
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        if (args.vmid !== undefined) return controller.status(args.vmid, { signal: exec?.signal });
        const settings = deps.settings();
        return {
          vmid: 0,
          allowed: true,
          sessions: controller.listSessions(),
          config: `allowVmids: ${settings.allowVmids.join(', ') || 'empty'}; console: ${settings.enableConsole ? 'on' : 'off'}; agent: ${settings.enableGuest ? 'on' : 'off'}`,
        };
      },
    },
  ].map((options) => defineTool(options));
}

/** Whether the content looks like UTF-8 text. */
function looksTextual(data) {
  if (data.length === 0) return true;
  let suspicious = 0;
  for (const byte of data) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  if (suspicious / data.length > 0.05) return false;
  const decoded = data.toString('utf8');
  return !decoded.includes('\uFFFD');
}

/** Capture a frame for `vm_type_text` (without importing the console tools). */
async function shotAttachment(controller, attachments, vmid) {
  return controller.withConsole(vmid, async (client) => {
    await client.wake();
    client.requestUpdate({ incremental: false });
    await client.waitForUpdate({});
    const frame = client.snapshot();
    const png = encodePng(frame);
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `vm-${vmid}-console.png` });
    return ref;
  });
}
