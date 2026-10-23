/**
 * Commands inside the guest: assembled as argv for the guest agent.
 *
 * No shell strings are glued together on the node: `qm guest exec <VM id> -- <argv…>`
 * receives ready-made arguments, and everything variable (paths, text, file
 * contents) travels as base64, so quotes and Unicode cannot break parsing.
 */

/** Size limit for a file in a single `vm_file_read`/`vm_file_write` call. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** base64 from a UTF-8 string. */
export function b64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

/**
 * PowerShell script through `-EncodedCommand` (UTF-16LE base64) — no quoting problems.
 *
 * `$ProgressPreference` is silenced right away: with a redirected stderr PowerShell
 * serializes the progress stream into CLIXML (`#< CLIXML … "Preparing modules for
 * first use"`), and that noise used to land in the text of tool errors (verified
 * 2026-10-17: reading 1 MB "failed" with CLIXML instead of the actual cause).
 * @param {string} script script text.
 * @returns {string[]} argv for the guest agent.
 */
export function powershellArgv(script) {
  const full = `$ProgressPreference='SilentlyContinue'\n${script}`;
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')];
}

/** Single shape of the "this OS is not supported" error. */
export function unsupportedOs(family, what) {
  return new Error(`${what} is not supported for OS "${family}": need Windows or Linux with a guest agent`);
}

/**
 * Reading a file in a Linux guest: `tail -c` + `head -c` + base64.
 * `offsetBytes` is needed to read in parts: the agent reply travels through the same QGA,
 * and on Windows output larger than ~512 KB does not reach us (measured 2026-10-17).
 */
export function linuxReadFileArgv(path, maxBytes, offsetBytes = 0, nonce = '') {
  const script = [
    'p=$1; n=$2; o=$3; t=$4',
    '[ -f "$p" ] || { echo "no such file: $p" >&2; exit 2; }',
    // The request marker and the file size go out before the data: the marker tells
    // our own reply from a foreign one (qemu-ga reuses pids), the size tells a real
    // end of file from a short reply (see parseFileChunk).
    'printf "DSH_NONCE=%s\\n" "$t"',
    'printf "DSH_SIZE=%s\\n" "$(wc -c < "$p")"',
    'if base64 --help 2>&1 | grep -q -- "-w"; then tail -c +$((o+1)) -- "$p" | head -c "$n" | base64 -w0; else tail -c +$((o+1)) -- "$p" | head -c "$n" | base64 | tr -d "\\n"; fi',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'dsh-pve-vm', String(path), String(maxBytes), String(offsetBytes), String(nonce)];
}

/**
 * Writing a file in a Linux guest: the data arrives **on stdin**.
 *
 * It cannot go through argv: base64 of a megabyte file is 1.37 MB in a single argument,
 * and Linux cuts one argument at `MAX_ARG_STRLEN` (128 KB) — `spawn E2BIG` arrives
 * before ssh even starts (measured 2026-10-17 on 64 KB of data).
 */
export function linuxWriteFileStdinArgv(path) {
  const script = ['p=$1', 'mkdir -p "$(dirname "$p")"', 'cat > "$p"', 'wc -c < "$p"'].join('\n');
  return ['/bin/sh', '-c', script, 'dsh-pve-vm', String(path)];
}

/** Reading a file in a Windows guest through PowerShell (in parts, see `offsetBytes`). */
export function windowsReadFileArgv(path, maxBytes, offsetBytes = 0, nonce = '') {
  const script =
    `$ErrorActionPreference='Stop'\n` +
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))\n` +
    `if(-not (Test-Path -LiteralPath $p)){Write-Error "no such file: $p"; exit 2}\n` +
    `$fs=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)\n` +
    `try{\n` +
    // The request marker and the file size go out before the data: the marker tells
    // our own reply from a foreign one (qemu-ga reuses pids), the size tells a real
    // end of file from a short reply (see parseFileChunk).
    `  'DSH_NONCE=${nonce}'\n` +
    `  'DSH_SIZE=' + $fs.Length\n` +
    `  if(${Number(offsetBytes)} -gt 0){$fs.Seek(${Number(offsetBytes)},[IO.SeekOrigin]::Begin) | Out-Null}\n` +
    `  $n=${Number(maxBytes)}\n` +
    `  $buf=New-Object byte[] $n\n` +
    `  $read=$fs.Read($buf,0,$n)\n` +
    `  if($read -le 0){ '' } else { if($read -lt $n){$buf=$buf[0..($read-1)]}; [Convert]::ToBase64String($buf) }\n` +
    `} finally { $fs.Dispose() }\n`;
  return powershellArgv(script);
}

/**
 * Parse the reply of the read scripts: the request marker, a `DSH_SIZE=<file length>`
 * line and the base64 chunk.
 *
 * Why the marker: qemu-ga reuses pids, and the tail of a previous command can arrive as
 * the answer to a new one (verified live on 2026-10-17: reading a **missing** path
 * returned the contents of a file read by the previous call — a silently wrong result).
 * Why the size: even a genuine reply can come back short, and the read loop used to
 * mistake that for the end of the file and return truncated data as complete.
 * @param {string} stdout the output of a read script.
 * @param {string} [nonce] the marker that was passed to the script.
 * @returns {{nonceOk:boolean,size:number|null,bytes:Buffer}} whether this is our reply, the file length and the chunk.
 */
export function parseFileChunk(stdout, nonce = '') {
  const text = String(stdout ?? '');
  const nonceOk = nonce === '' || text.includes(`DSH_NONCE=${nonce}`);
  const match = /DSH_SIZE=(\d+)/.exec(text);
  const size = match === null ? null : Number(match[1]);
  const base64 = text
    .replace(/DSH_NONCE=[^\r\n]*/, '')
    .replace(/DSH_SIZE=\d+/, '')
    .replace(/\s+/g, '');
  return { nonceOk, size, bytes: Buffer.from(base64, 'base64') };
}

/**
 * Writing a file in a Windows guest: the data arrives **on stdin**.
 *
 * Why not argv: the command goes into `CreateProcess` through qemu-guest-agent, and
 * the limit there is 32 767 characters. A script with a base64 payload grows threefold,
 * so in practice ~8 KB of data pass, and at 10 KB the agent answers
 * `Failed to execute helper program (Invalid argument)` (measured 2026-10-17).
 * stdin instead is limited only by the PVE check of 1 MiB.
 */
export function windowsWriteFileStdinArgv(path) {
  const script =
    `$ErrorActionPreference='Stop'\n` +
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))\n` +
    `$dir=Split-Path -Parent $p\n` +
    `if($dir -and -not (Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Force -Path $dir | Out-Null}\n` +
    `$ms=New-Object IO.MemoryStream\n` +
    `[Console]::OpenStandardInput().CopyTo($ms)\n` +
    `[IO.File]::WriteAllBytes($p,$ms.ToArray())\n` +
    `(Get-Item -LiteralPath $p).Length\n`;
  return powershellArgv(script);
}

/** Shell command for the guest OS. */
export function shellArgv(family, command) {
  if (family === 'windows') return ['cmd.exe', '/c', String(command)];
  if (family === 'linux') return ['/bin/sh', '-c', String(command)];
  throw unsupportedOs(family, 'running a command through a shell');
}

/** Whether the text has anything outside ASCII. */
export function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text ?? ''));
}

/** Console code page of a Windows guest (OEM): printed by `chcp`. */
export function windowsCodePageArgv() {
  return ['cmd.exe', '/c', 'chcp'];
}

/**
 * Envelope for a command with non-ASCII in a Windows guest.
 *
 * Why: **PVE truncates a non-ASCII QMP payload by 1 byte per character** —
 * `IO::Multiplex` counts the length in characters but writes bytes and trims the
 * buffer treating the number of written bytes as characters (`PVE::QMPClient` +
 * `libio-multiplex-perl`, bugs.proxmox.com #6609 and #6292). A `guest-exec`
 * request carries two JSON documents in a row, so one non-ASCII character eats the
 * trailing `\n` (the command still runs), and two or more eat the closing `}`:
 * the agent stops answering, QMP reports "got timeout", PVE tears the QGA channel
 * down, and the agent stays stuck until the service is restarted (verified
 * 2026-10-17 on VM 117: a non-ASCII `cmd.exe /c echo` → timeout, then
 * `qm agent ping` → "QEMU guest agent is not running", and the qemu-ga log has no
 * record of the command at all). That is why the text travels to the guest as
 * **base64** and only clean ASCII stays on the wire: a PowerShell script (itself
 * sent through `-EncodedCommand`) writes the command into a `.cmd` file in the
 * guest console code page and runs that file — cmd semantics are preserved, and
 * the output comes back as raw bytes in base64, so the plugin can decode it with
 * the same code page.
 * @param {string} commandText the command for `cmd.exe /c`.
 * @param {string} [nonce] the request marker: the envelope prints it, and the tool uses it
 *   to tell our own reply from a foreign one (qemu-ga reuses pids).
 * @returns {string[]} argv for `qm guest exec` (ASCII).
 */
export function windowsExecScriptArgv(commandText, nonce = '') {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$cp = [Console]::OutputEncoding.CodePage',
    `$cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(commandText)}'))`,
    `$stem = Join-Path $env:TEMP ('dsh-exec-' + [guid]::NewGuid().ToString('N'))`,
    `$file = $stem + '.cmd'; $out = $stem + '.out'; $err = $stem + '.err'`,
    // OEM code page: cmd.exe reads a .cmd exactly in it, UTF-8 it does not understand.
    `[IO.File]::WriteAllText($file, $cmd, [Text.Encoding]::GetEncoding($cp))`,
    `$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $file + '"') -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err`,
    `'DSH_NONCE=${nonce}'`,
    `'DSH_CP=' + $cp`,
    `'DSH_EXIT=' + $proc.ExitCode`,
    `'DSH_OUT=' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($out))`,
    `'DSH_ERR=' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($err))`,
    `Remove-Item -Force -ErrorAction SilentlyContinue $file, $out, $err`,
  ].join('\n');
  return powershellArgv(script);
}

/**
 * Parse the reply of the {@link windowsExecScriptArgv} envelope.
 *
 * A missing marker or exit code is **not** “success with empty output”: a foreign reply
 * from qemu-ga (a reused pid) used to be parsed as `exitcode 0` with an empty stdout, and
 * the tool quietly returned emptiness. Now such a reply is flagged (`nonceOk: false` /
 * `exitcode: null`) and the caller retries.
 * @param {string} stdout output of the PowerShell script.
 * @param {string} [nonce] the marker that was passed to the envelope.
 * @returns {{nonceOk:boolean,codePage:number|null,exitcode:number|null,stdoutB64:string|null,stderrB64:string|null}}
 */
export function parseWindowsExecEnvelope(stdout, nonce = '') {
  const text = String(stdout ?? '');
  const pick = (name) => {
    const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
    return match ? match[1].trim() : null;
  };
  const nonceOk = nonce === '' || pick('DSH_NONCE') === nonce;
  const codePage = Number(pick('DSH_CP'));
  const exitRaw = pick('DSH_EXIT');
  const exitcode = exitRaw === null || exitRaw === '' ? null : Number(exitRaw);
  return {
    nonceOk,
    codePage: Number.isInteger(codePage) && codePage > 0 ? codePage : null,
    exitcode: Number.isInteger(exitcode) ? exitcode : null,
    stdoutB64: pick('DSH_OUT'),
    stderrB64: pick('DSH_ERR'),
  };
}

/**
 * Text input inside a Linux guest through the script from the settings.
 *
 * The script travels as base64, not in argv: PVE corrupts non-ASCII in QMP
 * requests (`libio-multiplex-perl`, bugs.proxmox.com #6609/#6292) — a script
 * from the settings may contain non-ASCII, and two or more non-ASCII
 * characters break the QGA channel ("got timeout", the agent gets stuck until
 * the service is restarted; verified 2026-10-23 on VM 121). The text is base64
 * too: the script waits for it in `$1` and decodes it itself.
 * @param {string} script the script from the settings (`guestTypeCommand`).
 * @param {string} text the text to type.
 * @returns {string[]} argv for the guest agent (ASCII only).
 */
export function typeTextArgv(script, text) {
  const scriptB64 = b64(Buffer.from(String(script), 'utf8'));
  const command = `echo ${scriptB64} | base64 -d | /bin/sh -s ${b64(text)}`;
  return ['/bin/sh', '-c', command];
}

/** Clipboard hint — the only path for non-ASCII in the Windows GUI. */
export function clipboardHint(vmid) {
  return (
    'Alternative — the VNC clipboard (the console_paste tool): ' +
    `qm set ${vmid} -vga std,clipboard=vnc, a full stop/start of the VM (not a reboot), then install ` +
    'the spice-vdagent agent in the guest (the spice-agent or vdservice service) — the virtio-win ISO ' +
    'does not have it, take it from spice-space.org. ' +
    'After that console_paste puts the text into the guest clipboard and presses Ctrl+V ' +
    '(any Unicode, the layout does not matter).'
  );
}

/** Service files and the task name for typing text in a Windows session. */
export const WINDOWS_TYPE = {
  payload: 'C:\\Windows\\Temp\\dsh-pve-vm-payload.txt',
  typer: 'C:\\Windows\\Temp\\dsh-pve-vm-type.ps1',
  sentinel: 'C:\\Windows\\Temp\\dsh-pve-vm-type.done',
  task: 'DshPveVmType',
};

/**
 * Text of the typing script: it reads the payload and types it into the active window.
 *
 * Why this way and not with keys through VNC: `SendKeys` works inside the user
 * session, so it depends on neither the layout nor the modifiers, and it
 * supports Unicode (verified 2026-10-13 — Cyrillic in Notepad).
 * @returns {string} the text of the PowerShell script (written to a file as UTF-8 with BOM).
 */
export function windowsTyperScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [IO.File]::ReadAllText('${WINDOWS_TYPE.payload}', [Text.Encoding]::UTF8)`,
    // SendKeys understands line breaks and tabs only as {ENTER} / {TAB}.
    "$text = $payload -replace \"`r`n\", '{ENTER}' -replace \"`n\", '{ENTER}' -replace \"`t\", '{TAB}'",
    // SendKeys special characters are escaped with curly braces.
    "$escaped = $text -replace '([+^%~(){}\\[\\]])', '{$1}'",
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.SendKeys]::SendWait($escaped)',
    `[IO.File]::WriteAllText('${WINDOWS_TYPE.sentinel}', 'ok')`,
  ].join('\n');
}

/**
 * Assemble a single PowerShell script that puts the text and the typer into the guest,
 * registers a task in the user session, waits for the result and cleans
 * up after itself. It is sent in one guest agent call.
 * @param {string} text the text to type (any Unicode).
 * @param {{timeoutSec?:number}} [options] how long to wait for the typing.
 * @returns {string} the script text for `-EncodedCommand`.
 */
export function windowsTypeScript(text, options = {}) {
  const timeoutSec = Math.max(5, Math.min(120, options.timeoutSec ?? 30));
  const payloadB64 = b64(Buffer.from(String(text), 'utf8'));
  const typerB64 = b64(Buffer.from(windowsTyperScript(), 'utf8'));
  return [
    "$ErrorActionPreference = 'Stop'",
    `[IO.File]::WriteAllBytes('${WINDOWS_TYPE.payload}', [Convert]::FromBase64String('${payloadB64}'))`,
    `$typer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${typerB64}'))`,
    // UTF-8 with BOM: without it PowerShell 5.1 reads Cyrillic as ANSI.
    `[IO.File]::WriteAllText('${WINDOWS_TYPE.typer}', $typer, (New-Object Text.UTF8Encoding $true))`,
    `Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_TYPE.sentinel}'`,
    '$user = (Get-CimInstance Win32_ComputerSystem).UserName',
    "if (-not $user) { Write-Output 'NO_SESSION'; exit 3 }",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${WINDOWS_TYPE.typer}'`,
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest",
    `Register-ScheduledTask -TaskName '${WINDOWS_TYPE.task}' -Action $action -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${WINDOWS_TYPE.task}'`,
    `$deadline = (Get-Date).AddSeconds(${timeoutSec})`,
    `while (-not (Test-Path '${WINDOWS_TYPE.sentinel}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }`,
    `$ok = Test-Path '${WINDOWS_TYPE.sentinel}'`,
    `Unregister-ScheduledTask -TaskName '${WINDOWS_TYPE.task}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_TYPE.typer}', '${WINDOWS_TYPE.payload}', '${WINDOWS_TYPE.sentinel}'`,
    "if ($ok) { Write-Output ('TYPED user=' + $user) } else { Write-Output 'TIMEOUT'; exit 4 }",
  ].join('\n');
}

/**
 * Service files and task names for the Windows guest clipboard.
 *
 * Why a task in the user session: the Windows clipboard is tied to the session,
 * and `qm guest exec` runs as SYSTEM in session 0 and cannot see the owner's
 * clipboard. A task with `-LogonType Interactive` runs in the user session and
 * can see it — the same technique as `windowsTypeScript` (text input).
 */
export const WINDOWS_CLIPBOARD = {
  payload: 'C:\\Windows\\Temp\\dsh-pve-vm-clip-payload.txt',
  output: 'C:\\Windows\\Temp\\dsh-pve-vm-clip-out.txt',
  setter: 'C:\\Windows\\Temp\\dsh-pve-vm-clip-set.ps1',
  getter: 'C:\\Windows\\Temp\\dsh-pve-vm-clip-get.ps1',
  setSentinel: 'C:\\Windows\\Temp\\dsh-pve-vm-clip-set.done',
  getSentinel: 'C:\\Windows\\Temp\\dsh-pve-vm-clip-get.done',
  setTask: 'DshPveVmClipSet',
  getTask: 'DshPveVmClipGet',
};

/** Limit of the text put into the clipboard: PVE gives the guest up to 1 MiB of stdin. */
export const MAX_CLIPBOARD_BYTES = 512 * 1024;
/** Read limit: a guest agent reply larger than ~512 KB does not arrive. */
export const MAX_CLIPBOARD_READ_BYTES = 256 * 1024;

/** Clipboard setter script: runs in the Windows user session. */
export function windowsClipboardSetterScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$text = [IO.File]::ReadAllText('${WINDOWS_CLIPBOARD.payload}', [Text.Encoding]::UTF8)`,
    'try {',
    '  if ($text.Length -eq 0) {',
    // Set-Clipboard does not accept an empty string — clear the clipboard directly.
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    [System.Windows.Forms.Clipboard]::Clear()',
    '  } else {',
    // Set-Clipboard from PowerShell 5.1 works through WinForms and needs STA:
    // powershell.exe starts in STA by default, so this is enough.
    '    Set-Clipboard -Value $text',
    '  }',
    `  [IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.setSentinel}', 'ok')`,
    '} catch {',
    `  [IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.setSentinel}', ('ERR: ' + $_.Exception.Message))`,
    '}',
  ].join('\n');
}

/** Clipboard reader script: runs in the Windows user session. */
export function windowsClipboardGetterScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    // `-Raw` — otherwise multiline text arrives as an array of strings.
    '  $text = Get-Clipboard -Raw',
    "  if ($null -eq $text) { $text = '' }",
    // UTF-8 without BOM: the file is read by SYSTEM, an extra BOM would land in the text.
    `  [IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.output}', $text, (New-Object Text.UTF8Encoding $false))`,
    `  [IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.getSentinel}', 'ok')`,
    '} catch {',
    `  [IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.getSentinel}', ('ERR: ' + $_.Exception.Message))`,
    '}',
  ].join('\n');
}

/**
 * Put text into the Windows guest clipboard.
 *
 * The text arrives **on stdin** (`--pass-stdin`): it cannot go through argv —
 * CreateProcess caps the command line at 32 767 characters, while PVE gives
 * stdin up to 1 MiB.
 * @returns {string[]} argv for `qm guest exec` (ASCII).
 */
export function windowsClipboardSetStdinArgv() {
  const setterB64 = b64(Buffer.from(windowsClipboardSetterScript(), 'utf8'));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$ms = New-Object IO.MemoryStream',
    '[Console]::OpenStandardInput().CopyTo($ms)',
    `[IO.File]::WriteAllBytes('${WINDOWS_CLIPBOARD.payload}', $ms.ToArray())`,
    `$setter = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${setterB64}'))`,
    // UTF-8 with BOM: without it PowerShell 5.1 reads Cyrillic as ANSI.
    `[IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.setter}', $setter, (New-Object Text.UTF8Encoding $true))`,
    `Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_CLIPBOARD.setSentinel}'`,
    '$user = (Get-CimInstance Win32_ComputerSystem).UserName',
    "if (-not $user) { Write-Output 'NO_SESSION'; exit 3 }",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${WINDOWS_CLIPBOARD.setter}'`,
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest",
    `Register-ScheduledTask -TaskName '${WINDOWS_CLIPBOARD.setTask}' -Action $action -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${WINDOWS_CLIPBOARD.setTask}'`,
    '$deadline = (Get-Date).AddSeconds(30)',
    `while (-not (Test-Path '${WINDOWS_CLIPBOARD.setSentinel}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }`,
    `$ok = Test-Path '${WINDOWS_CLIPBOARD.setSentinel}'`,
    `$detail = if ($ok) { (Get-Content -Raw -Encoding UTF8 -LiteralPath '${WINDOWS_CLIPBOARD.setSentinel}').Trim() } else { '' }`,
    `Unregister-ScheduledTask -TaskName '${WINDOWS_CLIPBOARD.setTask}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_CLIPBOARD.setter}', '${WINDOWS_CLIPBOARD.payload}', '${WINDOWS_CLIPBOARD.setSentinel}'`,
    "if (-not $ok) { Write-Output 'TIMEOUT'; exit 4 }",
    "if ($detail -ne 'ok') { Write-Output ('CLIP_ERROR ' + $detail); exit 5 }",
    "Write-Output ('CLIP_SET user=' + $user)",
  ].join('\n');
  return powershellArgv(script);
}

/**
 * Read the Windows guest text clipboard.
 *
 * Two steps: a task in the user session saves the clipboard to a file, then
 * SYSTEM reads the file and returns it as base64 (otherwise the task output
 * never comes back).
 * @param {string} [nonce] request marker: qga reuses pids, and a reply may
 *   arrive from the previous command.
 * @returns {string[]} argv for `qm guest exec` (ASCII).
 */
export function windowsClipboardGetArgv(nonce = '') {
  const getterB64 = b64(Buffer.from(windowsClipboardGetterScript(), 'utf8'));
  const limit = MAX_CLIPBOARD_READ_BYTES;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$getter = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${getterB64}'))`,
    `[IO.File]::WriteAllText('${WINDOWS_CLIPBOARD.getter}', $getter, (New-Object Text.UTF8Encoding $true))`,
    `Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_CLIPBOARD.output}', '${WINDOWS_CLIPBOARD.getSentinel}'`,
    '$user = (Get-CimInstance Win32_ComputerSystem).UserName',
    "if (-not $user) { Write-Output 'NO_SESSION'; exit 3 }",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${WINDOWS_CLIPBOARD.getter}'`,
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest",
    `Register-ScheduledTask -TaskName '${WINDOWS_CLIPBOARD.getTask}' -Action $action -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${WINDOWS_CLIPBOARD.getTask}'`,
    '$deadline = (Get-Date).AddSeconds(30)',
    `while (-not (Test-Path '${WINDOWS_CLIPBOARD.getSentinel}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }`,
    `$ok = Test-Path '${WINDOWS_CLIPBOARD.getSentinel}'`,
    `$detail = if ($ok) { (Get-Content -Raw -Encoding UTF8 -LiteralPath '${WINDOWS_CLIPBOARD.getSentinel}').Trim() } else { '' }`,
    `Unregister-ScheduledTask -TaskName '${WINDOWS_CLIPBOARD.getTask}' -Confirm:$false -ErrorAction SilentlyContinue`,
    'if (-not $ok) {',
    `  Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_CLIPBOARD.getter}', '${WINDOWS_CLIPBOARD.output}', '${WINDOWS_CLIPBOARD.getSentinel}'`,
    "  Write-Output 'TIMEOUT'",
    '  exit 4',
    '}',
    `if ($detail -ne 'ok') {`,
    `  Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_CLIPBOARD.getter}', '${WINDOWS_CLIPBOARD.output}', '${WINDOWS_CLIPBOARD.getSentinel}'`,
    "  Write-Output ('CLIP_ERROR ' + $detail)",
    '  exit 5',
    '}',
    `$bytes = [IO.File]::ReadAllBytes('${WINDOWS_CLIPBOARD.output}')`,
    `Remove-Item -Force -ErrorAction SilentlyContinue '${WINDOWS_CLIPBOARD.getter}', '${WINDOWS_CLIPBOARD.output}', '${WINDOWS_CLIPBOARD.getSentinel}'`,
    `if ($bytes.Length -gt ${limit}) { $trim = New-Object byte[] ${limit}; [Array]::Copy($bytes, $trim, ${limit}); $bytes = $trim }`,
    `Write-Output 'DSH_NONCE=${nonce}'`,
    "Write-Output ('DSH_CLIP=' + [Convert]::ToBase64String($bytes))",
    "Write-Output 'DSH_OK'",
  ].join('\n');
  return powershellArgv(script);
}

/**
 * Parse the reply of {@link windowsClipboardGetArgv}.
 * @param {string} stdout script output.
 * @param {string} [nonce] expected marker.
 * @returns {{nonceOk:boolean, text:string|null}} whether the reply is ours and the clipboard text.
 */
export function parseWindowsClipboardEnvelope(stdout, nonce = '') {
  const text = String(stdout ?? '');
  const nonceOk = nonce === '' || text.includes(`DSH_NONCE=${nonce}`);
  const match = /^DSH_CLIP=(.*)$/m.exec(text);
  const base64 = match === null ? null : match[1].trim();
  return { nonceOk, text: base64 === null ? null : Buffer.from(base64, 'base64').toString('utf8') };
}

/**
 * Shared script lines for the Linux guest: find the active graphical session.
 *
 * Same discovery as in the `guestTypeCommand` setting (xdotool), only without it:
 * the clipboard needs xsel/xclip (X11) or wl-copy/wl-paste (Wayland). With GDM
 * XAUTHORITY lives in /run/user/<uid>/gdm/Xauthority, and ~/.Xauthority may not exist.
 *
 * IMPORTANT: the whole script text is ASCII only. PVE corrupts non-ASCII in QMP
 * requests (bugs.proxmox.com #6609/#6292): two or more non-ASCII characters — and
 * `qm guest exec` fails with "got timeout", while qemu-ga gets stuck until the
 * service is restarted (verified 2026-10-23 on VM 121: a non-ASCII echo through
 * the agent killed the channel, an ASCII script of the same length worked). That
 * is why script messages are English.
 * @returns {string[]} POSIX-sh lines (ASCII).
 */
function linuxSessionLines() {
  return [
    'uid=""; home=""; disp=""; xauth=""; wd=""',
    "for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do",
    '  [ "$(loginctl show-session "$s" -p Active --value 2>/dev/null)" = "yes" ] || continue',
    '  uid=$(loginctl show-session "$s" -p User --value 2>/dev/null) || continue',
    '  [ -n "$uid" ] || continue',
    '  home=$(getent passwd "$uid" | cut -d: -f6)',
    '  disp=$(loginctl show-session "$s" -p Display --value 2>/dev/null)',
    '  wd=$(loginctl show-session "$s" -p Type --value 2>/dev/null)',
    '  break',
    'done',
    '[ -n "$uid" ] || { echo "no active graphical session" >&2; exit 3; }',
    // loginctl on RedOS 8 returns an empty Display even for an X11 session (verified
    // 2026-10-23 on VM 121), so without an explicit value assume :0 — the same
    // as the input script in the `guestTypeCommand` setting does.
    '[ -n "$disp" ] || disp=":0"',
    'if [ -n "$home" ] && [ -f "$home/.Xauthority" ]; then xauth="$home/.Xauthority"',
    'elif [ -f "/run/user/$uid/gdm/Xauthority" ]; then xauth="/run/user/$uid/gdm/Xauthority"',
    'else xauth=$(ls -1 /run/user/$uid/*/Xauthority /run/user/$uid/xauth* 2>/dev/null | head -1)',
    'fi',
    'run() { if [ -n "$xauth" ]; then XAUTHORITY="$xauth" DISPLAY="$disp" "$@"; else DISPLAY="$disp" "$@"; fi; }',
  ];
}

/**
 * Put text into the Linux guest clipboard (the text arrives on stdin).
 * @returns {string[]} argv for `qm guest exec`.
 */
export function linuxClipboardSetArgv() {
  const script = [
    ...linuxSessionLines(),
    'if [ -n "$disp" ] && command -v xsel >/dev/null 2>&1; then run xsel --clipboard --input; exit 0; fi',
    'if [ -n "$disp" ] && command -v xclip >/dev/null 2>&1; then run xclip -selection clipboard -i; exit 0; fi',
    'if [ "$wd" = "wayland" ] && command -v wl-copy >/dev/null 2>&1; then',
    '  XDG_RUNTIME_DIR="/run/user/$uid" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" wl-copy; exit 0',
    'fi',
    'echo "no xsel/xclip/wl-copy in guest - cannot set clipboard" >&2',
    'exit 4',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'dsh-pve-vm'];
}

/**
 * Read the Linux guest clipboard: base64 in the reply, so the result does not
 * depend on the encoding and trailing newlines are not lost.
 * @param {string} [nonce] request marker (see `parseLinuxClipboardEnvelope`).
 * @returns {string[]} argv for `qm guest exec`.
 */
export function linuxClipboardGetArgv(nonce = '') {
  const limit = MAX_CLIPBOARD_READ_BYTES;
  const script = [
    ...linuxSessionLines(),
    'printf "DSH_NONCE=%s\\n" "$1"',
    'printf "DSH_CLIP="',
    'if [ -n "$disp" ] && command -v xsel >/dev/null 2>&1; then',
    `  run xsel --clipboard --output 2>/dev/null | head -c ${limit} | { if base64 --help 2>&1 | grep -q -- "-w"; then base64 -w0; else base64 | tr -d "\\n"; fi; }`,
    'elif [ -n "$disp" ] && command -v xclip >/dev/null 2>&1; then',
    `  run xclip -selection clipboard -o 2>/dev/null | head -c ${limit} | { if base64 --help 2>&1 | grep -q -- "-w"; then base64 -w0; else base64 | tr -d "\\n"; fi; }`,
    'elif [ "$wd" = "wayland" ] && command -v wl-paste >/dev/null 2>&1; then',
    `  XDG_RUNTIME_DIR="/run/user/$uid" WAYLAND_DISPLAY="\${WAYLAND_DISPLAY:-wayland-0}" wl-paste --no-newline 2>/dev/null | head -c ${limit} | { if base64 --help 2>&1 | grep -q -- "-w"; then base64 -w0; else base64 | tr -d "\\n"; fi; }`,
    'else',
    '  echo "no xsel/xclip/wl-paste in guest - cannot read clipboard" >&2',
    '  exit 4',
    'fi',
    'printf "\\n"',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'dsh-pve-vm', nonce];
}

/**
 * Parse the reply of {@link linuxClipboardGetArgv}.
 * @param {string} stdout script output.
 * @param {string} [nonce] expected marker.
 * @returns {{nonceOk:boolean, text:string|null}} whether the reply is ours and the clipboard text.
 */
export function parseLinuxClipboardEnvelope(stdout, nonce = '') {
  const text = String(stdout ?? '');
  const nonceOk = nonce === '' || text.includes(`DSH_NONCE=${nonce}`);
  const match = /^DSH_CLIP=(.*)$/m.exec(text);
  const base64 = match === null ? null : match[1].replace(/\s+/g, '');
  return { nonceOk, text: base64 === null ? null : Buffer.from(base64, 'base64').toString('utf8') };
}
