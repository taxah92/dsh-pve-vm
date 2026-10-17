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
 *
 * `--timeout` is PVE's wait **in seconds**, not our timeout: without it
 * `qm guest exec` waits 30 s and returns a pid instead of the result (verified
 * on 2026-10-17: `ping -n 35` came back with exitcode −1 and empty output,
 * because the plugin could not tell "the command is still running" from
 * "the command failed").
 * `--pass-stdin` is the only way to hand the guest more than ~8 KB of data:
 * PVE reads our stdin and puts it into `input-data` (base64 in JSON, up to
 * 1 MiB) instead of argv, which Windows caps at 32 767 characters.
 * @param {number|string} vmid VM id.
 * @param {string[]} argv the command and its arguments.
 * @param {{syncTimeoutSec?: number, passStdin?: boolean}} [options] the PVE wait and stdin feeding.
 * @returns {string}
 */
export function guestExecCommand(vmid, argv, options = {}) {
  const seconds = Number(options.syncTimeoutSec);
  // The options go before `--`: that is exactly what it is for — it stops
  // Getopt::Long from parsing the tail as its own switches.
  const sync = Number.isFinite(seconds) && seconds >= 1 ? ` --timeout ${Math.floor(seconds)}` : '';
  const stdin = options.passStdin === true ? ' --pass-stdin' : '';
  return `/usr/sbin/qm guest exec ${Number(vmid)}${sync}${stdin} -- ${argv.map(shellQuote).join(' ')}`;
}

/** Status of a previously started command: `qm guest exec-status`. */
export function guestExecStatusCommand(vmid, pid) {
  return `/usr/sbin/qm guest exec-status ${Number(vmid)} ${Number(pid)}`;
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
 *
 * The guest agent reports `id` from `/etc/os-release` (`ID=`), and every distro
 * uses its own name there: `redos`, `debian`, `ubuntu`, `altlinux`, `astra-linux`…
 * So "id == linux" is not a usable Linux test — it filtered out almost every real
 * distribution (found during acceptance on 2026-10-13: RedOS 8 reports `redos`,
 * Debian reports `debian`; both landed in `other` and every `vm_*` tool refused
 * to work). Windows must be checked first: its agent also reports
 * `kernel-release` (the NT build number), so "has kernel-release => Linux" is
 * wrong on its own — the order of the checks matters.
 *
 * @param {unknown} osinfo the parsed `get-osinfo` JSON.
 * @returns {'windows'|'linux'|'other'}
 */
export function guestOsFamily(osinfo) {
  const id = String(osinfo?.id ?? '').toLowerCase();
  const name = String(osinfo?.name ?? '').toLowerCase();
  const pretty = String(osinfo?.['pretty-name'] ?? '').toLowerCase();
  if (id === 'mswindows' || id.includes('windows') || name.includes('windows')) return 'windows';
  if (id.includes('linux') || name.includes('linux') || pretty.includes('linux')) return 'linux';
  // Whatever is left is a non-Windows guest that answered get-osinfo. Only
  // Windows and Linux are supported, so it is Linux; `kernel-release` is a
  // sanity check on the reply (an empty agent response never reaches here).
  const kernel = String(osinfo?.['kernel-release'] ?? '');
  if (kernel.length > 0) return 'linux';
  return 'other';
}

/**
 * Parse the output of `qm guest exec`.
 *
 * Two reply shapes: a finished command (`exited: 1`, `exitcode` present) and
 * "still running" — PVE returns `{ "pid": N }` without `exited` once its
 * `--timeout` runs out. The second shape must not be shown as exit code −1:
 * that is not a command failure but our impatience (verified on 2026-10-17
 * with `ping -n 35`).
 * @param {string} stdout the stdout of the ssh process.
 * @returns {{exitcode:number,stdout:string,stderr:string,exited:boolean,truncated:boolean,pid:number|null}}
 */
export function parseGuestExec(stdout) {
  const text = String(stdout).trim();
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error(`failed to parse the guest agent response: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text.slice(start));
  const exited = parsed.exited === 1 || parsed.exited === true;
  return {
    exitcode: typeof parsed.exitcode === 'number' ? parsed.exitcode : -1,
    stdout: typeof parsed['out-data'] === 'string' ? parsed['out-data'] : '',
    stderr: typeof parsed['err-data'] === 'string' ? parsed['err-data'] : '',
    exited,
    truncated: Boolean(parsed['out-truncated'] || parsed['err-truncated']),
    pid: typeof parsed.pid === 'number' ? parsed.pid : null,
  };
}

/** Code pages TextDecoder knows, keyed by the number reported by `chcp`. */
const CODE_PAGE_LABELS = new Map([
  [866, 'ibm866'],
  [1251, 'windows-1251'],
  [1252, 'windows-1252'],
  [1250, 'windows-1250'],
  [1253, 'windows-1253'],
  [1254, 'windows-1254'],
  [1255, 'windows-1255'],
  [1256, 'windows-1256'],
  [1257, 'windows-1257'],
  [1258, 'windows-1258'],
  [874, 'windows-874'],
  [65001, 'utf-8'],
]);

/**
 * The code page number from `chcp` output (the text is localized, the number is ASCII).
 * @param {string} text `chcp` output.
 * @returns {number|null}
 */
export function parseCodePage(text) {
  const match = String(text).match(/(\d{3,5})\s*$/m) ?? String(text).match(/(\d{3,5})/);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) && code > 0 ? code : null;
}

/**
 * Decode guest text from a `qm guest exec` reply.
 *
 * Two traps at once, both verified live on 2026-10-17:
 *   1. PVE puts the guest's bytes into JSON as **latin-1**: `decode_base64`
 *      yields a byte string without the UTF-8 flag, and `encode_json` turns
 *      every byte into a U+00xx code point. So the bytes have to be reassembled
 *      first (`latin1`); otherwise `out-data` is no longer what the guest wrote
 *      (observed: cp866 bytes of a Russian word arrived as `¢¥¤¥­¨ï`).
 *   2. The Windows console writes text in the OEM code page (cp866 on a Russian
 *      system), not in UTF-8. Decoding order: UTF-8 when the bytes are valid
 *      (ASCII, and programs that write UTF-8 themselves), otherwise the guest
 *      code page. One code page is not enough: the messages of `cmd.exe` itself
 *      arrive in the system ANSI code page when its output is redirected (verified
 *      live on 2026-10-17: cp1251 bytes), so there are two candidates — OEM and
 *      ANSI (see decodeGuestBytes).
 * @param {string} jsonText the `out-data`/`err-data` value from the agent reply.
 * @param {number|null} [codePage] the guest code page (from `chcp`).
 * @returns {string}
 */
export function decodeGuestText(jsonText, codePage) {
  return decodeGuestBytes(Buffer.from(String(jsonText ?? ''), 'latin1'), codePage);
}

/**
 * Pairs of “console OEM code page → system ANSI code page” for common locales.
 *
 * `chcp` reports the **console** code page (OEM), but some programs — above all
 * the messages of `cmd.exe` itself — write their bytes in the system ANSI code
 * page when the output is redirected. Verified live on 2026-10-17: `cmd.exe /c chcp`
 * returned cp1251 bytes, and decoding them as cp866 produced
 * “╥хъє∙р ъюфютр ёЄЁрэшЎр: 866” instead of “Текущая кодовая страница: 866”.
 */
const ANSI_FOR_OEM = new Map([
  [866, 1251],
  [855, 1251],
  [852, 1250],
  [737, 1253],
  [775, 1257],
  [857, 1254],
  [862, 1255],
  [437, 1252],
  [850, 1252],
]);

/**
 * How many characters in the text are ones a normal output almost never has:
 * box drawing and blocks, currencies, typographic punctuation, the replacement
 * character. That is the sign of bytes decoded with the wrong single-byte code
 * page — the correct candidate has fewer of them.
 * @param {string} text the decoded text.
 * @returns {number} the count of suspicious characters.
 */
function mojibakeScore(text) {
  let score = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (
      (code >= 0x0080 && code <= 0x00bf) ||
      (code >= 0x2010 && code <= 0x203f) ||
      (code >= 0x20a0 && code <= 0x20bf) ||
      (code >= 0x2100 && code <= 0x22ff) ||
      (code >= 0x2500 && code <= 0x25ff) ||
      code === 0xfffd
    ) {
      score += 1;
    }
  }
  return score;
}

/**
 * Decode raw guest output bytes (for instance, from a base64 envelope).
 *
 * UTF-8 when the bytes are valid (ASCII, and programs that write UTF-8 themselves);
 * otherwise two single-byte candidates: the console code page (OEM) and the system
 * ANSI code page for it. The one with fewer “suspicious” characters wins; on a tie
 * OEM wins, because the envelope for non-ASCII commands writes its file in the OEM
 * code page and there OEM is the correct one.
 * @param {Buffer} bytes the bytes as the guest wrote them.
 * @param {number|null} [codePage] the guest code page.
 * @returns {string}
 */
export function decodeGuestBytes(bytes, codePage) {
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  const page = codePage === null || codePage === undefined ? null : Number(codePage);
  const labels = [];
  const label = page === null ? undefined : CODE_PAGE_LABELS.get(page);
  if (label !== undefined && label !== 'utf-8') labels.push(label);
  if (page !== null) {
    const ansi = ANSI_FOR_OEM.get(page);
    const ansiLabel = ansi === undefined ? undefined : CODE_PAGE_LABELS.get(ansi);
    if (ansiLabel !== undefined && !labels.includes(ansiLabel)) labels.push(ansiLabel);
  }
  let best = utf8;
  let bestScore = mojibakeScore(utf8);
  for (const candidate of labels) {
    let text;
    try {
      text = new TextDecoder(candidate).decode(bytes);
    } catch {
      continue;
    }
    const score = mojibakeScore(text);
    if (score < bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best;
}
