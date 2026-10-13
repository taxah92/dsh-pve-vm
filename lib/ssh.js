/**
 * Transport to the Proxmox node: an ssh process with `qm` running inside it.
 *
 * Why this way: a VM has no TCP port for VNC — QEMU listens on the unix socket
 * `/var/run/qemu-server/<VM id>.vnc`, and `qm vncproxy` bridges that socket to its own
 * stdin/stdout. So the ssh process is the RFB transport: no ports, no TLS,
 * no websocket. The VNC password travels as an environment variable through `SendEnv`
 * (the node's sshd accepts `AcceptEnv LC_*`), so it is not visible in `ps`.
 *
 * IMPORTANT: the stdin of the child process must not be closed — the CLI bridge
 * (`PVE::CLI::qm::run_vnc_proxy`) treats EOF on its stdin as "exit" and
 * drops the connection without sending a single byte.
 */

/** Quoting of a single argument for the remote side's POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * VNC password: 8 printable ASCII characters (a PVE requirement, `PVE::Ticket::generate_vnc_password`).
 * The alphabet has no quotes or backslashes, so the value is safe in any context.
 * @returns {string}
 */
export function vncPassword() {
  const alphabet = '!#%+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Assemble the argv of the ssh client.
 * @param {{host:string,user?:string,port?:number,keyPath?:string,sshConfig?:string,hostKeyAlias?:string,command:string,extraOptions?:string[]}} spec
 * @returns {string[]} argv for spawn.
 */
export function sshArgv(spec) {
  const argv = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (spec.sshConfig) argv.push('-F', spec.sshConfig);
  if (spec.port) argv.push('-p', String(spec.port));
  if (spec.keyPath) argv.push('-i', spec.keyPath);
  for (const option of spec.extraOptions ?? []) argv.push('-o', option);
  argv.push(spec.user ? `${spec.user}@${spec.host}` : spec.host, spec.command);
  return argv;
}

/** Console command: `qm vncproxy` serves RFB on stdin/stdout. */
export function vncProxyCommand(vmid) {
  return `/usr/sbin/qm vncproxy ${Number(vmid)}`;
}

/**
 * Guest agent command. The arguments are quoted so that the remote shell
 * assembles exactly the argv the agent asked for.
 * @param {number|string} vmid VM id.
 * @param {string[]} argv the command and its arguments.
 * @returns {string}
 */
export function guestExecCommand(vmid, argv) {
  return `/usr/sbin/qm guest exec ${Number(vmid)} -- ${argv.map(shellQuote).join(' ')}`;
}

/** Guest information request (used to detect the OS). */
export function guestOsInfoCommand(vmid) {
  return `/usr/sbin/qm guest cmd ${Number(vmid)} get-osinfo`;
}

/** Check whether the guest agent shell is installed in the VM. */
export function guestPingCommand(vmid) {
  return `/usr/sbin/qm agent ${Number(vmid)} ping`;
}

/**
 * Detect the guest OS from the agent's response.
 * @param {unknown} osinfo the parsed `get-osinfo` JSON.
 * @returns {'windows'|'linux'|'other'}
 */
export function guestOsFamily(osinfo) {
  const id = String(osinfo?.id ?? '').toLowerCase();
  if (id.includes('windows') || id === 'mswindows') return 'windows';
  if (id === 'linux' || id.includes('linux')) return 'linux';
  return 'other';
}

/**
 * Parse the output of `qm guest exec`.
 * @param {string} stdout the stdout of the ssh process.
 * @returns {{exitcode:number,stdout:string,stderr:string,exited:boolean,truncated:boolean}}
 */
export function parseGuestExec(stdout) {
  const text = String(stdout).trim();
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error(`failed to parse the guest agent response: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text.slice(start));
  return {
    exitcode: typeof parsed.exitcode === 'number' ? parsed.exitcode : -1,
    stdout: typeof parsed['out-data'] === 'string' ? parsed['out-data'] : '',
    stderr: typeof parsed['err-data'] === 'string' ? parsed['err-data'] : '',
    exited: parsed.exited === 1 || parsed.exited === true,
    truncated: Boolean(parsed['out-truncated'] || parsed['err-truncated']),
  };
}
