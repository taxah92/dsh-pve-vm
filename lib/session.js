/**
 * VM session registry: one ssh console session per VM id plus one-shot
 * guest agent calls.
 *
 * The transport is an ssh process with `qm` running inside it (see lib/ssh.js).
 * The child process is created by the harness `subprocess` service, so the plugin
 * never touches node:child_process directly.
 */
import { RfbClient } from './rfb.js';
import { sendkeysCommand } from './hmp.js';
import {
  decodeGuestText,
  guestExecCommand,
  guestOsFamily,
  guestOsInfoCommand,
  parseCodePage,
  parseGuestExec,
  sshArgv,
  vncPassword,
  vncProxyCommand,
} from './ssh.js';
import { windowsCodePageArgv } from './guest.js';

/** Error with a machine-readable code: tools show its text to the agent. */
export class VmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VmError';
    this.code = code;
  }
}

/**
 * Pause between two `qm` calls to the same VM, ms.
 * QEMU serves one QMP client at a time: the next `qm` connects while the
 * previous one is still closing, and replies get lost. 250 ms is enough to
 * remove the race and is unnoticeable next to a ~300 ms network round trip.
 */
const NODE_CALL_GAP_MS = 250;

/** How long to wait before a retry when the agent "is not running" (the QGA channel blinked). */
const AGENT_RETRY_DELAY_MS = 700;

/** Promise with a timeout and cancellation. */
function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: onTimeout?.() }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * VM control through a Proxmox node.
 */
export class VmController {
  /**
   * @param {{
   *   settings: () => object,
   *   spawn: (spec: object) => object,
   *   cwd: string,
   *   log?: (message: string, detail?: unknown) => void,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<number, object>} */
    this.sessions = new Map();
    /** @type {Map<number, string>} */
    this.osCache = new Map();
    /** @type {Map<number, number|null>} OEM code page of the guest console. */
    this.codePageCache = new Map();
    /** @type {Map<number, Promise<unknown>>} per-VM queue of node commands. */
    this.nodeQueue = new Map();
    /** @type {Map<number, number>} when the last `qm` call for the VM finished. */
    this.nodeQueueUsed = new Map();
    /** The last VM whose console the agent touched: the panel auto-opens on it. */
    this.lastConsole = null;
    this.reaper = setInterval(() => this.#reapIdle(), 30000);
    this.reaper.unref?.();
  }

  /**
   * Run an operation with exclusive access to `qm` on this VM.
   *
   * Why: every tool starts **its own** `qm` process, and a VM has a single QMP
   * socket. Two concurrent `qm guest exec` calls read the same socket and steal
   * each other's replies — PVE answers `qmp command 'guest-exec-status' failed -
   * got timeout` (the default QMP timeout is 5 s, `PVE/QMPClient.pm:140`) even
   * though the command did run in the guest. Live check on 2026-10-17: a pair of
   * `vm_exec` calls in one agent message failed every other time. The console
   * path was already protected this way (`withConsole` + `session.queue`),
   * the guest path was not.
   * @param {number} vmid VM id.
   * @param {() => Promise<T>} operation the action.
   * @returns {Promise<T>}
   * @template T
   */
  #withNodeQueue(vmid, operation) {
    const previous = this.nodeQueue.get(vmid) ?? Promise.resolve();
    const chained = previous.then(
      async () => {
        // The pause between calls: every tool raises its own `qm`, while QEMU
        // holds one QMP socket and accepts the next client only after the
        // previous one closed (PVE/QMPClient.pm: "qemu can only handle 1
        // connection"). Without the pause, back-to-back calls sometimes steal
        // each other's reply and fail with `got timeout` — measured on
        // 2026-10-17: 2 of 19 calls in the suite.
        const idle = Date.now() - (this.nodeQueueUsed.get(vmid) ?? 0);
        if (idle < NODE_CALL_GAP_MS) await new Promise((resolve) => setTimeout(resolve, NODE_CALL_GAP_MS - idle));
        try {
          return await operation();
        } finally {
          this.nodeQueueUsed.set(vmid, Date.now());
        }
      },
      async () => {
        try {
          return await operation();
        } finally {
          this.nodeQueueUsed.set(vmid, Date.now());
        }
      },
    );
    this.nodeQueue.set(
      vmid,
      chained.then(
        () => undefined,
        () => undefined,
      ),
    );
    return chained;
  }

  /**
   * The last console use: the observation panel shows this VM.
   * @returns {{vmid:number, at:number}|null} vmid and time (ms), or null.
   */
  lastConsoleUse() {
    return this.lastConsole;
  }

  /** Validate the VM id against the allowlist and the channel switches. */
  assertAllowed(vmid, channel) {
    const settings = this.deps.settings();
    const id = Number(vmid);
    if (!Number.isInteger(id) || id <= 0) throw new VmError(`invalid VM id "${vmid}"`, 'BAD_VMID');
    if (!settings.allowVmids.includes(id)) {
      throw new VmError(
        `VM ${id} is not in allowVmids (${settings.allowVmids.join(', ') || 'list is empty'}); add it in settings`,
        'NOT_ALLOWED',
      );
    }
    if (channel === 'console' && !settings.enableConsole) {
      throw new VmError('console tools are disabled by the enableConsole setting', 'CHANNEL_DISABLED');
    }
    if (channel === 'guest' && !settings.enableGuest) {
      throw new VmError('guest agent tools are disabled by the enableGuest setting', 'CHANNEL_DISABLED');
    }
    return id;
  }

  /** Build the ssh argv for a command on the node. */
  #sshArgv(command, extraOptions = []) {
    const settings = this.deps.settings();
    return sshArgv({ ...settings.ssh, extraOptions: [...settings.ssh.extraOptions, ...extraOptions], command });
  }

  /** Start an ssh process on the node. */
  #spawnNode(command, { env = {}, collect = false, signal, extraOptions = [], stdin = false } = {}) {
    const settings = this.deps.settings();
    const stdio = collect
      ? {
          stdin: stdin ? 'pipe' : 'ignore',
          stdout: { maxBytes: 16 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        }
      : { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' };
    return this.deps.spawn({
      argv: this.#sshArgv(command, extraOptions),
      cwd: this.deps.cwd,
      stdio,
      graceMs: 3000,
      env: { ...process.env, ...env },
      ...(signal ? { signal } : {}),
    });
  }

  /** Collect text from the collect reader of the child process. */
  #collect(handle, stream) {
    const reader = handle?.collected?.[stream];
    if (!reader || typeof reader.readFrom !== 'function') return '';
    const read = reader.readFrom(0);
    return typeof read?.text === 'string' ? read.text : '';
  }

  /** Run a command on the node and return its output. */
  async #runNode(command, { timeoutMs, signal, collect = true, env, extraOptions, stdinData } = {}) {
    const settings = this.deps.settings();
    let handle;
    try {
      handle = this.#spawnNode(command, { collect, signal, env, extraOptions, stdin: stdinData !== undefined });
    } catch (error) {
      // The local spawn fails before ssh does: a single command argument longer
      // than MAX_ARG_STRLEN (128 KB) gives E2BIG. Explain it to the human instead
      // of returning "spawn E2BIG" — large data has to travel over stdin.
      const detail = error?.code === 'E2BIG' ? ': the command is longer than one argument allows (128 KB) — send the data over stdin' : '';
      throw new VmError(`failed to start ssh${detail} (${error?.message ?? error})`, 'SPAWN_FAILED');
    }
    if (stdinData !== undefined) {
      try {
        handle.stdin?.end(stdinData);
      } catch (error) {
        handle.terminate?.();
        throw new VmError(`failed to hand the data to the guest over stdin: ${error?.message ?? error}`, 'STDIN_FAILED');
      }
    }
    const outcome = await withTimeout(handle.done, timeoutMs ?? settings.guestTimeoutMs, () => {
      handle.terminate();
      return null;
    });
    if (outcome === null || outcome?.timedOut) {
      throw new VmError(`node command timed out after ${timeoutMs ?? settings.guestTimeoutMs} ms`, 'TIMEOUT');
    }
    const stdout = this.#collect(handle, 'stdout');
    const stderr = this.#collect(handle, 'stderr');
    return { ...outcome, stdout, stderr };
  }

  /**
   * Send keys through HMP `sendkey` (QEMU monitor channel, no VNC).
   *
   * Why a separate path: over RFB we send a keysym, and QEMU maps it through
   * its own keymap — letters and shift symbols behave differently (verified
   * 2026-10-13). `sendkey` presses a key code and QEMU holds the modifiers,
   * so `shift-a` is exactly `A`. The channel does not occupy a VNC session
   * and is available on the login screen.
   * @param {number} vmid VM id.
   * @param {string[]} keys sendkey expressions (`shift-a`, `spc`, `ctrl-alt-delete`).
   * @param {{signal?: AbortSignal, delayMs?: number}} [options] cancellation and the pause between keys.
   * @returns {Promise<{count:number}>} how many keys were sent.
   */
  async sendkeys(vmid, keys, options = {}) {
    const id = this.assertAllowed(vmid, 'console');
    const list = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string' && key.length > 0);
    if (list.length === 0) return { count: 0 };
    const settings = this.deps.settings();
    const delayMs = options.delayMs ?? settings.sendkeyDelayMs;
    const command = sendkeysCommand(id, list, { delayMs });
    const timeoutMs = Math.max(settings.guestTimeoutMs, 15_000 + list.length * delayMs * 4);
    const outcome = await this.#withNodeQueue(id, () => this.#runNode(command, { timeoutMs, signal: options.signal }));
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim() || 'no output';
      throw new VmError(`sendkey failed on VM ${id} (${outcome.exitCode}): ${detail}`, 'SENDKEY_FAILED');
    }
    return { count: list.length };
  }

  /**
   * Execute a reliable typing plan (`planTyping`): Caps Lock for uppercase
   * letters is toggled through HMP, everything else goes as ordinary keysyms over RFB.
   *
   * Why so: Shift is unreliable on this path (QEMU emulates it itself and confuses
   * the state), while Caps Lock is an ordinary key, and the "on/off" pairs around
   * a run of uppercase letters give an exact result (verified on `Pa55w0rd!`).
   * @param {number} vmid VM id.
   * @param {Array<{op:string, keysym?:number}>} ops plan from `planTyping`.
   * @param {object} client live RFB client.
   * @param {{signal?:AbortSignal, capsSettleMs?:number}} [options] cancellation and Caps Lock settle pause.
   * @returns {Promise<{count:number, caps:number}>} how many operations and toggles were performed.
   */
  async typePlan(vmid, ops, client, options = {}) {
    const list = Array.isArray(ops) ? ops : [];
    let caps = 0;
    for (const op of list) {
      if (op.op === 'caps') {
        await this.sendkeys(vmid, ['caps_lock'], { signal: options.signal });
        caps += 1;
        // The guest must have time to process the toggle before the next letter.
        await new Promise((resolve) => setTimeout(resolve, options.capsSettleMs ?? 400));
        continue;
      }
      if (op.op === 'shiftTap') {
        await client.tapShifted(op.keysym);
        continue;
      }
      await client.tap(op.keysym);
    }
    return { count: list.length, caps };
  }

  /**
   * VM console: an existing live session or a new one.
   * @param {number} vmid VM id.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<object>} session record.
   */
  async #consoleSession(vmid, signal) {
    const existing = this.sessions.get(vmid);
    if (existing && existing.alive) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) this.#drop(vmid);

    const settings = this.deps.settings();
    const password = vncPassword();
    const handle = this.#spawnNode(vncProxyCommand(vmid), {
      env: { LC_PVE_TICKET: password },
      extraOptions: ['SendEnv=LC_PVE_TICKET', 'LogLevel=ERROR'],
      signal,
    });
    let stderr = '';
    handle.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    const client = new RfbClient({ input: handle.stdout, output: handle.stdin, timeoutMs: settings.consoleTimeoutMs });
    const session = {
      vmid,
      handle,
      client,
      password,
      alive: true,
      lastUsed: Date.now(),
      queue: Promise.resolve(),
      stderrText: () => stderr.trim(),
    };
    // The death of the ssh process marks the session dead; the next call reconnects.
    handle.done
      .then((outcome) => {
        session.alive = false;
        session.exit = outcome;
      })
      .catch(() => {
        session.alive = false;
      });

    const failure = new Promise((_, reject) => {
      handle.done
        .then((outcome) => {
          const detail = stderr.trim();
          reject(
            new VmError(
              `failed to open the console of VM ${vmid}: ssh exited with code ${outcome.exitCode}` +
                (detail ? `: ${detail}` : ''),
              'CONSOLE_FAILED',
            ),
          );
        })
        .catch((error) => reject(new VmError(`node ssh failed: ${error?.message ?? error}`, 'SSH_FAILED')));
    });
    try {
      await Promise.race([client.connect({ password }), failure]);
    } catch (error) {
      session.alive = false;
      this.#drop(vmid);
      // RFB sees EOF before ssh has finished exiting, and the most valuable
      // explanation — the node's stderr — is lost. Give ssh a short grace
      // period: without it "the VNC stream was closed by the node" cannot tell
      // an sshd without AcceptEnv (`LC_PVE_TICKET not set, VNC proxy without
      // password is forbidden`) from a powered-off VM or a busy QMP socket.
      // Verified by a negative test on 2026-10-13 (sshd on :2222, no AcceptEnv).
      const detail = await Promise.race([
        handle.done.then(() => stderr.trim()).catch(() => ''),
        new Promise((resolve) => setTimeout(() => resolve(''), 1500)),
      ]);
      if (detail.length > 0 && error?.code === 'EOF') {
        throw new VmError(`failed to open the console of VM ${vmid}: ${detail}`, 'CONSOLE_FAILED');
      }
      throw error;
    }
    this.sessions.set(vmid, session);
    return session;
  }

  /**
   * Run an operation with exclusive access to the VM console.
   * @param {number} vmid VM id.
   * @param {(client: RfbClient, session: object) => Promise<T>} operation the action.
   * @param {{signal?: AbortSignal, mark?:boolean}} [options] cancellation and the "the agent worked with this VM" mark.
   * @returns {Promise<T>}
   * @template T
   */
  async withConsole(vmid, operation, options = {}) {
    const id = this.assertAllowed(vmid, 'console');
    // A mark for the observation panel: it follows the VM the agent works with.
    // The panel watches frames through this very method, so it has to suppress the
    // mark (`mark: false`) — otherwise watching declares itself agent work and the
    // "follow the agent" mode jumps between VMs (seen on a live panel 2026-10-13:
    // right after a restart `last` named the VM the owner was watching, while no
    // tool had touched it).
    if (options.mark !== false) this.lastConsole = { vmid: id, at: Date.now() };
    const session = await this.#consoleSession(id, options.signal);
    const run = async () => {
      if (!session.alive) {
        this.#drop(id);
        throw new VmError(`the console of VM ${id} closed; retry the call`, 'CONSOLE_CLOSED');
      }
      session.lastUsed = Date.now();
      try {
        return await operation(session.client, session);
      } catch (error) {
        if (error?.code === 'EOF' || error?.code === 'TIMEOUT') {
          session.alive = false;
          this.#drop(id);
          // A stream that died mid-way is explained by ssh's stderr: for
          // instance `qm vncproxy` exiting on its own 15-minute idle timeout.
          const detail = session.stderrText?.() ?? '';
          if (detail.length > 0) {
            throw new VmError(`${error.message}; ssh: ${detail}`, error.code);
          }
        }
        throw error;
      }
    };
    const chained = session.queue.then(run, run);
    session.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  /** Close the VM session. */
  close(vmid) {
    const id = Number(vmid);
    const session = this.sessions.get(id);
    if (!session) return false;
    this.#drop(id);
    return true;
  }

  #drop(vmid) {
    const session = this.sessions.get(vmid);
    if (!session) return;
    this.sessions.delete(vmid);
    session.alive = false;
    try {
      session.handle.stdin?.end();
    } catch {}
    try {
      session.handle.terminate();
    } catch {}
  }

  /** Close sessions that have been idle longer than `sessionIdleMs`. */
  #reapIdle() {
    const settings = this.deps.settings();
    const now = Date.now();
    for (const [vmid, session] of this.sessions) {
      const idle = now - (session.lastUsed ?? 0) > settings.sessionIdleMs;
      if (idle || !session.alive) this.#drop(vmid);
    }
  }

  /** Close all sessions when the plugin is unloaded. */
  closeAll() {
    clearInterval(this.reaper);
    for (const vmid of [...this.sessions.keys()]) this.#drop(vmid);
  }

  /** Live sessions — for `vm_status`. */
  listSessions() {
    return [...this.sessions.values()].map((session) => ({
      vmid: session.vmid,
      alive: session.alive,
      idleMs: Date.now() - (session.lastUsed ?? 0),
      resolution: `${session.client.width}x${session.client.height}`,
    }));
  }

  /**
   * Run a command through the guest agent.
   *
   * Three things here are not obvious and cost live debugging on 2026-10-17:
   *   • `--timeout` in seconds is PVE's wait. Without it `qm guest exec` waits
   *     30 s and returns `{pid}` instead of the result, and the plugin showed
   *     that as "exit code −1" with empty output, that is, it lied about failure.
   *   • our ssh timeout is longer than PVE's wait: that way the honest "still
   *     running" reply (with a pid) arrives in time instead of "the command on
   *     the node did not finish".
   *   • guest output is decoded through the code page (see `decodeGuestText`).
   * @param {number} vmid VM id.
   * @param {string[]} argv the command and its arguments (no shell on the node).
   * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
   * @returns {Promise<{exitcode:number,stdout:string,stderr:string,truncated:boolean,pid:number|null}>}
   */
  async guestExec(vmid, argv, options = {}) {
    const id = this.assertAllowed(vmid, 'guest');
    if (!Array.isArray(argv) || argv.length === 0) throw new VmError('empty command', 'BAD_ARGV');
    return this.#withNodeQueue(id, () => this.#guestExecQueued(id, argv, options));
  }

  /** {@link guestExec} without taking the queue: call only from inside it. */
  async #guestExecQueued(id, argv, options) {
    const timeoutMs = options.timeoutMs ?? this.deps.settings().guestTimeoutMs;
    const syncTimeoutSec = Math.max(1, Math.floor((timeoutMs - 2000) / 1000));
    const spawnOnce = () =>
      this.#runNode(guestExecCommand(id, argv, { syncTimeoutSec, passStdin: options.stdin !== undefined }), {
        timeoutMs: timeoutMs + 8000,
        signal: options.signal,
        stdinData: options.stdin,
      });
    let result = await spawnOnce();
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      // PVE answers "agent is not running" **before** sending the command (the
      // `agent_available` check), so nothing ran in the guest and the retry is
      // safe. The QGA channel sometimes blinks for a second — the live run on
      // 2026-10-17 caught that in 1 call out of ~20.
      if (/agent is not running|no agent/i.test(detail)) {
        await new Promise((resolve) => setTimeout(resolve, AGENT_RETRY_DELAY_MS));
        result = await spawnOnce();
      }
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (/agent is not running|no agent/i.test(detail)) {
        throw new VmError(`qemu-guest-agent is not responding in VM ${id}: ${detail}`, 'AGENT_DOWN');
      }
      throw new VmError(`guest agent of VM ${id} failed (${result.exitCode}): ${detail}`, 'AGENT_ERROR');
    }
    let parsed;
    try {
      parsed = parseGuestExec(result.stdout);
    } catch (error) {
      throw new VmError(`${error.message}${result.stderr.trim() ? ` (stderr: ${result.stderr.trim()})` : ''}`, 'AGENT_PARSE');
    }
    const codePage = await this.#guestCodePage(id);
    const value = {
      exitcode: parsed.exitcode,
      stdout: decodeGuestText(parsed.stdout, codePage),
      stderr: decodeGuestText(parsed.stderr, codePage),
      truncated: parsed.truncated,
      pid: parsed.pid,
      exited: parsed.exited,
    };
    if (!parsed.exited) {
      const body = [value.stdout, value.stderr].filter((part) => part.trim().length > 0).join('\n').trim();
      throw new VmError(
        `the command in VM ${id} did not finish within ${timeoutMs} ms and keeps running in the guest` +
          `${parsed.pid === null ? '' : ` (pid ${parsed.pid})`}. Raise timeoutMs if you need to wait longer.` +
          (body.length > 0 ? `\nCaptured before the timeout:\n${body}` : ''),
        'STILL_RUNNING',
      );
    }
    return value;
  }

  /**
   * OEM code page of the guest console (Windows): `chcp` → 866 on a Russian
   * system. Cached per VM: it is needed only to decode cmd/PowerShell output,
   * which is not written in UTF-8.
   * @param {number} vmid VM id.
   * @returns {Promise<number|null>} the page number, or null (not Windows / could not find out).
   */
  async #guestCodePage(vmid) {
    if (this.codePageCache.has(vmid)) return this.codePageCache.get(vmid);
    let codePage = null;
    try {
      if ((await this.#guestOsQueued(vmid)) === 'windows') {
        const result = await this.#runNode(guestExecCommand(vmid, windowsCodePageArgv(), { syncTimeoutSec: 10 }), {
          timeoutMs: 20000,
        });
        if (result.exitCode === 0) codePage = parseCodePage(decodeGuestText(parseGuestExec(result.stdout).stdout, null));
      }
    } catch {
      // Could not find out — decodeGuestText simply stays on UTF-8.
    }
    this.codePageCache.set(vmid, codePage);
    return codePage;
  }

  /**
   * Guest OS family (cached for the lifetime of the plugin).
   * @param {number} vmid VM id.
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<'windows'|'linux'|'other'>}
   */
  async guestOs(vmid, options = {}) {
    const id = this.assertAllowed(vmid, 'guest');
    return this.#withNodeQueue(id, () => this.#guestOsQueued(id, options));
  }

  /** {@link guestOs} without taking the queue: call only from inside it. */
  async #guestOsQueued(id, options = {}) {
    if (this.osCache.has(id)) return this.osCache.get(id);
    const result = await this.#runNode(guestOsInfoCommand(id), { signal: options.signal });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new VmError(`failed to detect the guest OS of VM ${id}: ${detail}`, 'AGENT_DOWN');
    }
    let family = 'other';
    try {
      family = guestOsFamily(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))));
    } catch {
      family = 'other';
    }
    this.osCache.set(id, family);
    return family;
  }

  /**
   * The guest agent reply to `ping` and the VM state.
   * @param {number} vmid VM id.
   * @param {{signal?:AbortSignal}} [options]
   */
  async status(vmid, options = {}) {
    const id = Number(vmid);
    const allowed = this.deps.settings().allowVmids.includes(id);
    const outcome = { vmid: id, allowed };
    if (!allowed) return outcome;
    return this.#withNodeQueue(id, async () => {
      const ping = await this.#runNode(`/usr/sbin/qm agent ${id} ping`, { timeoutMs: 15000, signal: options.signal });
      outcome.agent = ping.exitCode === 0;
      // The harness rejects a property with `undefined` ("value is not lossless
      // JSON"), so the reason is recorded only when there is one.
      if (!outcome.agent) {
        outcome.agentError = ping.stderr.trim() || ping.stdout.trim();
        // The agent process itself is alive (the Windows log has no 7031/7034
        // and no WER): PVE closes the QGA channel on the 5-second QMP timeout,
        // and qemu-ga spins on EOF without ever reopening it (qga/main.c;
        // analysis in bugs.proxmox.com #6609). That is why recovery actions do
        // not help and only a service restart inside the guest brings the agent back.
        outcome.agentHint =
          'the agent process is alive, but the QGA channel is closed and does not reopen by itself ' +
          '(qemu-ga spins on EOF). Bring it up with `Restart-Service QEMU-GA` in the VM console ' +
          'or `qm reboot <vmid>` from the node. The usual cause is non-ASCII in vm_exec: PVE corrupts ' +
          'such a QMP payload, the request arrives truncated, and the channel breaks on the timeout ' +
          '(bugs.proxmox.com #6609/#6292). Pass Unicode through `command`, which travels in a base64 envelope.';
      }
      const config = await this.#runNode(`/usr/sbin/qm config ${id} 2>/dev/null | grep -E '^(name|ostype|agent|vga):'`, {
        timeoutMs: 15000,
        signal: options.signal,
      });
      outcome.config = config.stdout.trim();
      if (outcome.agent) {
        try {
          outcome.os = await this.#guestOsQueued(id, options);
        } catch (error) {
          outcome.osError = error.message;
        }
      }
      const session = this.sessions.get(id);
      outcome.console = session ? { alive: session.alive, resolution: `${session.client.width}x${session.client.height}` } : null;
      return outcome;
    });
  }
}
