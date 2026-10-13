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
  guestExecCommand,
  guestOsFamily,
  guestOsInfoCommand,
  parseGuestExec,
  sshArgv,
  vncPassword,
  vncProxyCommand,
} from './ssh.js';

/** Error with a machine-readable code: tools show its text to the agent. */
export class VmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VmError';
    this.code = code;
  }
}

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
    this.reaper = setInterval(() => this.#reapIdle(), 30000);
    this.reaper.unref?.();
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
  #spawnNode(command, { env = {}, collect = false, signal, extraOptions = [] } = {}) {
    const settings = this.deps.settings();
    const stdio = collect
      ? { stdin: 'ignore', stdout: { maxBytes: 16 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } }
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
  async #runNode(command, { timeoutMs, signal, collect = true, env, extraOptions } = {}) {
    const settings = this.deps.settings();
    const handle = this.#spawnNode(command, { collect, signal, env, extraOptions });
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
    this.assertAllowed(vmid, 'console');
    const list = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string' && key.length > 0);
    if (list.length === 0) return { count: 0 };
    const settings = this.deps.settings();
    const delayMs = options.delayMs ?? settings.sendkeyDelayMs;
    const command = sendkeysCommand(vmid, list, { delayMs });
    const timeoutMs = Math.max(settings.guestTimeoutMs, 15_000 + list.length * delayMs * 4);
    const outcome = await this.#runNode(command, { timeoutMs, signal: options.signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim() || 'no output';
      throw new VmError(`sendkey failed on VM ${vmid} (${outcome.exitCode}): ${detail}`, 'SENDKEY_FAILED');
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
      throw error;
    }
    this.sessions.set(vmid, session);
    return session;
  }

  /**
   * Run an operation with exclusive access to the VM console.
   * @param {number} vmid VM id.
   * @param {(client: RfbClient, session: object) => Promise<T>} operation the action.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<T>}
   * @template T
   */
  async withConsole(vmid, operation, options = {}) {
    const id = this.assertAllowed(vmid, 'console');
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
   * @param {number} vmid VM id.
   * @param {string[]} argv the command and its arguments (no shell on the node).
   * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
   * @returns {Promise<{exitcode:number,stdout:string,stderr:string,truncated:boolean}>}
   */
  async guestExec(vmid, argv, options = {}) {
    const id = this.assertAllowed(vmid, 'guest');
    if (!Array.isArray(argv) || argv.length === 0) throw new VmError('empty command', 'BAD_ARGV');
    const timeoutMs = options.timeoutMs ?? this.deps.settings().guestTimeoutMs;
    const result = await this.#runNode(guestExecCommand(id, argv), { timeoutMs, signal: options.signal });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (/agent is not running|no agent/i.test(detail)) {
        throw new VmError(`qemu-guest-agent is not responding in VM ${id}: ${detail}`, 'AGENT_DOWN');
      }
      throw new VmError(`guest agent of VM ${id} failed (${result.exitCode}): ${detail}`, 'AGENT_ERROR');
    }
    try {
      return parseGuestExec(result.stdout);
    } catch (error) {
      throw new VmError(`${error.message}${result.stderr.trim() ? ` (stderr: ${result.stderr.trim()})` : ''}`, 'AGENT_PARSE');
    }
  }

  /**
   * Guest OS family (cached for the lifetime of the plugin).
   * @param {number} vmid VM id.
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<'windows'|'linux'|'other'>}
   */
  async guestOs(vmid, options = {}) {
    const id = this.assertAllowed(vmid, 'guest');
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
    const ping = await this.#runNode(`/usr/sbin/qm agent ${id} ping`, { timeoutMs: 15000, signal: options.signal });
    outcome.agent = ping.exitCode === 0;
    // The harness rejects a property with `undefined` ("value is not lossless
    // JSON"), so the reason is recorded only when there is one.
    if (!outcome.agent) outcome.agentError = ping.stderr.trim() || ping.stdout.trim();
    const config = await this.#runNode(`/usr/sbin/qm config ${id} 2>/dev/null | grep -E '^(name|ostype|agent|vga):'`, {
      timeoutMs: 15000,
      signal: options.signal,
    });
    outcome.config = config.stdout.trim();
    if (outcome.agent) {
      try {
        outcome.os = await this.guestOs(id, options);
      } catch (error) {
        outcome.osError = error.message;
      }
    }
    const session = this.sessions.get(id);
    outcome.console = session ? { alive: session.alive, resolution: `${session.client.width}x${session.client.height}` } : null;
    return outcome;
  }
}
