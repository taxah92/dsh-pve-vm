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

/** PowerShell script through `-EncodedCommand` (UTF-16LE base64) — no quoting problems. */
export function powershellArgv(script) {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** Single shape of the "this OS is not supported" error. */
export function unsupportedOs(family, what) {
  return new Error(`${what} is not supported for OS "${family}": need Windows or Linux with a guest agent`);
}

/** Reading a file in a Linux guest: `head -c N | base64 -w0`. */
export function linuxReadFileArgv(path, maxBytes) {
  const script = [
    'p=$1; n=$2',
    '[ -f "$p" ] || { echo "no such file: $p" >&2; exit 2; }',
    'if base64 --help 2>&1 | grep -q -- "-w"; then head -c "$n" -- "$p" | base64 -w0; else head -c "$n" -- "$p" | base64 | tr -d "\\n"; fi',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'dsh-pve-vm', String(path), String(maxBytes)];
}

/** Writing a file in a Linux guest. */
export function linuxWriteFileArgv(path, base64Data) {
  const script = [
    'p=$1',
    'mkdir -p "$(dirname "$p")"',
    'printf %s "$2" | base64 -d > "$p"',
    'wc -c < "$p"',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'dsh-pve-vm', String(path), String(base64Data)];
}

/** Reading a file in a Windows guest through PowerShell. */
export function windowsReadFileArgv(path, maxBytes) {
  const script =
    `$ErrorActionPreference='Stop'\n` +
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))\n` +
    `if(-not (Test-Path -LiteralPath $p)){Write-Error "no such file: $p"; exit 2}\n` +
    `$b=[IO.File]::ReadAllBytes($p)\n` +
    `if($b.Length -gt ${Number(maxBytes)}){$b=$b[0..(${Number(maxBytes)} - 1)]}\n` +
    `[Convert]::ToBase64String($b)\n`;
  return powershellArgv(script);
}

/** Writing a file in a Windows guest through PowerShell. */
export function windowsWriteFileArgv(path, base64Data) {
  const script =
    `$ErrorActionPreference='Stop'\n` +
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))\n` +
    `$d=[Convert]::FromBase64String('${base64Data}')\n` +
    `$dir=Split-Path -Parent $p\n` +
    `if($dir -and -not (Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Force -Path $dir | Out-Null}\n` +
    `[IO.File]::WriteAllBytes($p,$d)\n` +
    `(Get-Item -LiteralPath $p).Length\n`;
  return powershellArgv(script);
}

/** Shell command for the guest OS. */
export function shellArgv(family, command) {
  if (family === 'windows') return ['cmd.exe', '/c', String(command)];
  if (family === 'linux') return ['/bin/sh', '-c', String(command)];
  throw unsupportedOs(family, 'running a command through a shell');
}

/** Text input inside a Linux guest through the script from the settings. */
export function typeTextArgv(script, text) {
  return ['/bin/sh', '-c', String(script), 'dsh-pve-vm', b64(text)];
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
