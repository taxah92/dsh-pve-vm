/**
 * Guest agent tools: commands, files, state.
 * All of this is cheaper and more reliable than pixels — the console is only needed for the GUI.
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { encodeText } from '../lib/keys.js';
import { textToSendkeys } from '../lib/hmp.js';
import { planTyping } from '../lib/keys.js';
import { encodePng } from '../lib/png.js';
import { VmError } from '../lib/session.js';
import { decodeGuestBytes } from '../lib/ssh.js';
import {
  MAX_FILE_BYTES,
  clipboardHint,
  hasNonAscii,
  parseFileChunk,
  parseWindowsExecEnvelope,
  powershellArgv,
  windowsExecScriptArgv,
  windowsTypeScript,
  linuxReadFileArgv,
  linuxWriteFileStdinArgv,
  shellArgv,
  typeTextArgv,
  unsupportedOs,
  windowsReadFileArgv,
  windowsWriteFileStdinArgv,
} from '../lib/guest.js';

/**
 * How many raw file bytes to pull per guest agent call.
 * 256 KB → ~341 KB of base64, that is comfortably below the verified 512 KB.
 */
const FILE_CHUNK_BYTES = 256 * 1024;

/** How many times a call is retried: qemu-ga sometimes answers with a foreign or short reply (a reused pid). */
const REPLY_ATTEMPTS = 3;

/** Pause between chunk retries, ms. */
const RETRY_DELAY_MS = 300;

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
        'and does not see the graphical user session: GUI applications cannot be pressed this way. On Windows a `command` ' +
        'with non-ASCII travels in a base64 envelope (the agent does not survive Unicode in argv), while an `argv` with ' +
        'non-ASCII is rejected. cmd/PowerShell output is decoded through the guest code page, so non-Latin text is readable.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        command: { type: 'string', description: 'Command for the guest shell (if argv is not set).' },
        argv: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ready-made argv without a shell — more reliable for PowerShell and paths with spaces. On Windows only ASCII is allowed.',
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
        const given = Array.isArray(args.argv) && args.argv.length > 0 ? args.argv.map(String) : null;
        const command = typeof args.command === 'string' && args.command.length > 0 ? args.command : null;
        if (!given && !command) throw new VmError('either command or a non-empty argv is required', 'BAD_ARGS');
        let family = args.shell ?? 'auto';
        if (family === 'auto') family = await controller.guestOs(args.vmid, { signal: exec?.signal });

        // Windows + non-ASCII: PVE truncates such a QMP payload by a byte per
        // character (see windowsExecScriptArgv). The shell form is saved by the
        // base64 envelope, while a ready-made argv has no safe path — we refuse
        // honestly, with a hint.
        if (family === 'windows' && (given ? given.some(hasNonAscii) : hasNonAscii(command))) {
          if (!command) {
            throw new VmError(
              'the argv for Windows contains non-ASCII, and PVE corrupts such a payload in QMP: `IO::Multiplex` writes ' +
                'bytes but trims the buffer by the number of characters, so the `guest-exec` request arrives truncated — ' +
                'the agent does not answer, PVE tears the QGA channel down, and the agent stays stuck until the service ' +
                'is restarted (bugs.proxmox.com #6609, #6292; verified 2026-10-17). Pass the same thing through `command` ' +
                '(the shell): it travels in a base64 envelope and works with Unicode. Or keep only ASCII in the argv ' +
                '(paths and names — via vm_file_write/vm_file_read, they already travel as base64).',
              'UNICODE_ARGV_WINDOWS',
            );
          }
          // Request marker: qemu-ga reuses pids, and the output of a previous command can
          // arrive as the answer to a new one (verified live on 2026-10-17: an empty
          // “success” instead of `echo Привет-Мир`). Our own nonce in the reply tells our
          // answer from a foreign one: a mismatch means retry, not “success with no output”.
          let envelope = null;
          let problem = null;
          for (let attempt = 1; attempt <= REPLY_ATTEMPTS; attempt += 1) {
            const nonce = randomUUID();
            const typed = await controller.guestExec(args.vmid, windowsExecScriptArgv(command, nonce), {
              timeoutMs: args.timeoutMs,
              signal: exec?.signal,
            });
            const parsed = parseWindowsExecEnvelope(typed.stdout, nonce);
            if (parsed.nonceOk && parsed.exitcode !== null) {
              envelope = { ...parsed, truncated: typed.truncated };
              break;
            }
            problem = parsed.nonceOk ? 'the envelope reply has no exit code' : 'the reply does not match the request marker (foreign agent output)';
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          }
          if (envelope === null) {
            throw new VmError(`the command in VM ${args.vmid} did not run: ${problem}; call it again`, 'STALE_REPLY');
          }
          return {
            vmid: Number(args.vmid),
            exitcode: envelope.exitcode,
            stdout: decodeGuestBytes(Buffer.from(envelope.stdoutB64 ?? '', 'base64'), envelope.codePage),
            stderr: decodeGuestBytes(Buffer.from(envelope.stderrB64 ?? '', 'base64'), envelope.codePage),
            truncated: envelope.truncated,
            command: ['cmd.exe', '/c', command],
          };
        }

        const argv = given ?? shellArgv(family, command);
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
        '(up to 1 MB), binary files as a binary marker and base64. Large files are read in chunks: an agent reply ' +
        'larger than ~512 KB does not reach the plugin.',
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
        const readArgv = (offset, size, nonce) => {
          if (family === 'windows') return windowsReadFileArgv(args.path, size, offset, nonce);
          if (family === 'linux') return linuxReadFileArgv(args.path, size, offset, nonce);
          throw unsupportedOs(family, 'reading a file');
        };
        // In chunks: the agent reply travels through the same QGA, and output
        // larger than ~512 KB does not reach the plugin (measured 2026-10-17:
        // 512 KB — 2 s, 1 MB — `guest-exec-status got timeout` and a closed agent channel).
        //
        // Every chunk is checked twice: against the request marker (is this our reply —
        // qemu-ga reuses pids and hands over foreign output) and against the real file
        // length reported by the read script. A short/foreign “success” used to be taken
        // for the end of the file, and the tool silently returned truncated or plainly
        // foreign data with `truncated: false`. Now such a reply is retried, and if the
        // chunk still does not add up, the tool fails honestly instead of lying quietly.
        const chunks = [];
        let bytes = 0;
        let fileSize = null;
        let truncated = false;
        while (bytes < maxBytes) {
          const want = Math.min(FILE_CHUNK_BYTES, maxBytes - bytes);
          let chunk = null;
          let problem = null;
          for (let attempt = 1; attempt <= REPLY_ATTEMPTS; attempt += 1) {
            const nonce = randomUUID();
            const result = await controller.guestExec(args.vmid, readArgv(bytes, want, nonce), {
              timeoutMs: args.timeoutMs,
              signal: exec?.signal,
            });
            if (result.exitcode !== 0) {
              problem = result.stderr.trim() || result.stdout.trim();
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
              continue;
            }
            const parsed = parseFileChunk(result.stdout, nonce);
            if (!parsed.nonceOk) {
              // Foreign reply: the pid was reused and a previous command's output arrived
              // (verified live on 2026-10-17: reading a missing path returned the contents
              // of a file read earlier). Retry with a fresh marker.
              problem = 'the reply does not match the request marker (foreign agent output)';
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
              continue;
            }
            if (parsed.size !== null) fileSize = parsed.size;
            const complete = fileSize !== null && bytes + parsed.bytes.length >= fileSize;
            if (parsed.bytes.length === 0 && complete) {
              chunk = parsed.bytes;
              break;
            }
            if ((result.truncated || parsed.bytes.length < want) && !complete) {
              problem =
                `the agent answered ${parsed.bytes.length} bytes instead of ${want}` +
                (result.truncated ? ' (the reply was truncated on the node)' : '');
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
              continue;
            }
            chunk = parsed.bytes;
            break;
          }
          if (chunk === null) {
            throw new VmError(
              `failed to read ${args.path}${bytes > 0 ? ` (at offset ${bytes})` : ''}: ${problem ?? 'empty agent reply'}`,
              'FILE_READ',
            );
          }
          if (chunk.length === 0) break;
          chunks.push(chunk);
          bytes += chunk.length;
          if (bytes >= maxBytes) {
            truncated = fileSize === null || fileSize > bytes;
            break;
          }
          if (fileSize !== null && bytes >= fileSize) break;
        }
        const data = Buffer.concat(chunks);
        const mode = args.encoding && args.encoding !== 'auto' ? args.encoding : looksTextual(data) ? 'text' : 'base64';
        return {
          vmid: Number(args.vmid),
          path: String(args.path),
          bytes: data.length,
          encoding: mode,
          content: mode === 'text' ? data.toString('utf8') : data.toString('base64'),
          truncated,
        };
      },
    },
    {
      name: 'vm_file_write',
      description:
        'Write a file inside the VM through the guest agent (up to 1 MB per call). Parent directories are created. ' +
        'The contents travel to the guest over stdin: only ~8 KB fit through the command arguments (the CreateProcess limit).',
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
        const data =
          typeof args.dataBase64 === 'string' && args.dataBase64.length > 0
            ? Buffer.from(args.dataBase64.replace(/\s+/g, ''), 'base64')
            : typeof args.data === 'string'
              ? Buffer.from(args.data, 'utf8')
              : null;
        if (data === null) throw new VmError('either data or dataBase64 is required', 'BAD_ARGS');
        if (data.length > MAX_FILE_BYTES) {
          throw new VmError(`the file is larger than ${MAX_FILE_BYTES} bytes per call; send it in chunks via vm_exec`, 'TOO_LARGE');
        }
        const family = await controller.guestOs(args.vmid, { signal: exec?.signal });
        const argv =
          family === 'windows'
            ? windowsWriteFileStdinArgv(args.path)
            : family === 'linux'
              ? linuxWriteFileStdinArgv(args.path)
              : (() => {
                  throw unsupportedOs(family, 'writing a file');
                })();
        // The data goes to stdin: argv does not carry more than ~8 KB (the Windows
        // CreateProcess limit of 32 767 characters), while PVE accepts up to 1 MiB on stdin.
        const result = await controller.guestExec(args.vmid, argv, {
          timeoutMs: args.timeoutMs,
          signal: exec?.signal,
          stdin: data,
        });
        if (result.exitcode !== 0) {
          throw new VmError(`failed to write ${args.path}: ${result.stderr.trim() || result.stdout.trim()}`, 'FILE_WRITE');
        }
        return { vmid: Number(args.vmid), path: String(args.path), bytes: data.length };
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
              value.agentHint ? `how to recover: ${value.agentHint}` : null,
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
