# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [0.2.5] — 2026-10-23

### Fixed

* **The first frame of a QXL/SPICE VM could come out blank.** On guests with a hardware cursor
  (`vga: qxl`, that is every SPICE VM) QEMU sends a “cursor only” update before the full frame, and
  the first `waitForUpdate` sometimes ended exactly there — `console_shot` and the “VM screen” panel
  returned a white frame (reproduced on a 3440x1336 guest: the single wait returned the blank frame,
  the real one arrived 79–300 ms later). `RfbClient.waitForFrame()` now keeps reading until an update
  carries a real rectangle, console captures use it, and the panel allows the first frame of a session
  up to 1.5 s (`FIRST_FRAME_WAIT_MS`) while later frames keep the cheap incremental wait.
* **The clipboard did not work on SPICE VMs at all.** `console_paste` and `console_clipboard` required
  `vga: <type>,clipboard=vnc` plus a SPICE agent, which is impossible on `vga: qxl`: the
  `com.redhat.spice.0` channel is taken by `spicevmc`, and enabling `clipboard=vnc` there would remove
  the SPICE agent (dynamic resolution and the owner's SPICE clipboard). Both tools now use the guest
  agent first — on Windows a scheduled task in the logged-in user session (the clipboard is
  per-session; SYSTEM in session 0 cannot see it), on Linux `xsel`/`xclip`/`wl-copy`/`wl-paste` in the
  active graphical session, with `XAUTHORITY` discovered the same way as for `vm_type_text`. The VNC
  clipboard stays as a fallback when the VM has `clipboard=vnc`. A logged-in session is required:
  there is no clipboard on the logon screen.
* **Non-ASCII in a guest `argv` could wedge the guest agent.** PVE truncates non-ASCII QMP payloads
  (`libio-multiplex-perl`, [Proxmox #6609](https://bugzilla.proxmox.com/show_bug.cgi?id=6609),
  [#6292](https://bugzilla.proxmox.com/show_bug.cgi?id=6292)), so the request arrives cut, `qm guest
  exec` times out and `qemu-ga` gets stuck until its service is restarted. `VmController` now refuses
  such an `argv` before anything is sent (`NON_ASCII_ARGV`) and points at stdin/base64 envelopes.

### Changed

* **`typeTextArgv` passes the guest script via base64.** The script from `guestTypeCommand` may contain
  non-ASCII and used to travel in `argv` — exactly the failure above. It now goes as a base64 payload
  decoded into `/bin/sh -s`, with the text still arriving in `$1`.
* `console_paste` and `console_clipboard` timeouts were raised for the task round trip (paste 180 s,
  read 120 s, a guest-agent read waits at least 15 s), and the clipboard result gained `channel` and
  `truncated`.
* **The default Linux input script now picks the first active graphical session.** `loginctl` on
  RedOS 8 reports an empty `Display` even for an X11 session, so the old `[ -n "$disp" ]` criterion
  fell through to root's tty sessions and `xdotool` failed with “No protocol specified”. The script
  filters by session type (`x11`/`wayland`/`mir`) and breaks on the first match.

## [0.2.4] — 2026-10-18

### Added

* **Simplified Chinese (`zh`) translation.** The web UI's settings card and the “VM screen” sidebar
  panel now follow the Chinese locale that DeepSeek Harness ships (`zh`, falling back to `en` for
  anything untranslated). The plugin card in *Settings ▸ Plugins* also reads Chinese, because
  `locale/zh.json` joins the existing `en`/`ru` metadata files. `tools/check-client.mjs` now fails
  when a locale is missing a key or a `{placeholder}` differs between dictionaries, so the three
  dictionaries cannot drift apart silently.

## [0.2.3] — 2026-10-17

### Fixed

* **The npm package was missing `tools/`, so installing from the registry was broken.** `index.js`
  imports `./tools/console.js` and `./tools/guest.js` — the definitions of all 16 tools — but the
  `files` list in `package.json` never included that directory. The published tarball therefore could
  not even be imported: `dsh plugin --profile web add dsh-pve-vm` failed with
  `ERR_MODULE_NOT_FOUND: Cannot find module '…/tools/console.js'`. Every release up to and including
  0.2.2 was affected; the GitHub install path (`github:taxah92/dsh-pve-vm`) was not, because it uses
  the repository itself. `files` now includes `tools/`, and the two-copy gate
  (`tools/sync-pve-vm.mjs`) checks that every relative import of the packed tree resolves inside the
  package — so packaging cannot silently drop a directory again. The check was verified against the
  old list: it reports exactly `index.js → ./tools/console.js` and `index.js → ./tools/guest.js`.

### Notes

* No runtime code changed since 0.2.2.

## [0.2.2] — 2026-10-17

The guest-agent half made reliable. Everything below was found by running the plugin against a real
Windows guest (Windows Server 2025 with Defender, 4 GB of RAM), not by reading the code: a live
19-check suite went from “fails somewhere on every run” to green.

### Fixed

* **A non-ASCII `command` could wedge the guest agent until the `QEMU-GA` service was restarted.**
  The fault is not in `qemu-ga`: Proxmox truncates non-ASCII QMP payloads by one byte per character
  (`IO::Multiplex` writes bytes but slices by characters,
  [Proxmox #6609](https://bugzilla.proxmox.com/show_bug.cgi?id=6609),
  [#6292](https://bugzilla.proxmox.com/show_bug.cgi?id=6292)), so the `guest-exec` JSON arrives cut.
  The agent never answers, the QMP call times out, PVE tears the QGA channel down and `qemu-ga` gets
  stuck on EOF. A Windows `command` containing non-ASCII now travels as a base64 envelope — a `.cmd`
  file written in the guest OEM code page and launched as a file, with raw output returned as base64;
  `argv` with non-ASCII is refused before anything is sent (`UNICODE_ARGV_WINDOWS`).
* **Russian output came back as mojibake** (`lvl=¢¥¤¥­¨ï` instead of `Сведения`). Two things
  stacked up: PVE puts guest bytes into JSON as latin-1, and a Windows console writes text in its OEM
  code page (`chcp` → 866), not UTF-8. Output is now decoded from bytes — latin-1 → UTF-8, or the
  guest code page when it is not UTF-8 — with the code page cached per VM. One code page turned out
  to be not enough: the messages of `cmd.exe` itself arrive in the system **ANSI** code page
  (cp1251 on a Russian system) even though `chcp` reports the OEM one, so the decoder tries both and
  keeps the candidate without box-drawing/currency junk — `Текущая кодовая страница: 866` instead of
  `╥хъє∙р ъюфютр ёЄЁэшЎр: 866`.
* **A command longer than 30 s reported a false failure** (`exitcode -1`, empty output): `qm guest
  exec` waits 30 s by default and returns `{pid}` **without** `exited`, and the plugin did not check.
  It now passes `--timeout` (our timeout minus 2 s) and inspects `exited`; a command that did not
  finish is reported as `STILL_RUNNING` with its pid and whatever output was collected, instead of
  being called a failure.
* **`vm_file_write` worked only up to ~8 KB.** The payload travelled as base64 inside `argv`, and a
  Windows command line is capped at 32 767 characters (`CreateProcess`; Linux has `MAX_ARG_STRLEN`),
  so 10 KB gave `Failed to execute helper program` and 64 KB failed locally with `spawn E2BIG`.
  File data now goes over stdin (`--pass-stdin`), which raises the limit to **1 MiB per call**.
* **`vm_file_read` broke the QGA channel at 1 MiB.** An agent reply above ~512 KB does not survive
  (`guest-exec-status … got timeout`; 512 KB still took ~2 s). Files are now read in 256 KiB chunks
  with an offset, and a chunk is retried — reading is idempotent.
* **A successful but short or foreign agent reply could silently corrupt a result.** `qemu-ga`
  reuses pids, and the tail of a previous command can arrive as the answer to a new one (one live
  run got the stdout of a running `ping` in reply to `chcp`; another got the contents of a file read
  earlier in reply to reading a **missing** path). The chunked read mistook a short reply for the end
  of the file and returned partial data with `truncated: false` — a silent wrong answer. Every read
  script and the non-ASCII command envelope now print a per-call request marker (`DSH_NONCE=`) and
  the real file length (`DSH_SIZE=`); a reply that does not match the marker, or a chunk that does
  not add up, is retried up to three times, and if it still does not, the tool fails
  (`FILE_READ` / `STALE_REPLY`) instead of returning a quietly incomplete or foreign result. A
  foreign reply to the non-ASCII envelope used to be parsed as “success with empty output” — that
  hole is closed too. `truncated` is now derived from the file length, so a file that exactly fills
  `maxBytes` is no longer flagged as truncated.
* **PowerShell progress noise ended up in error texts.** With stderr redirected, PowerShell
  serialises its progress stream into CLIXML (`#< CLIXML …`), and one 1 MiB read “failed” with that
  blob instead of a reason. Every generated script now starts with
  `$ProgressPreference='SilentlyContinue'`.

### Changed

* **All `qm` calls to one VM are serialised, with a 250 ms gap between them.** QEMU serves one QMP
  client at a time and accepts the next connection only after the previous one is closed; without
  the gap, back-to-back calls stole each other's replies (`guest-exec-status … got timeout`).
* A failed call is retried exactly once, and only when PVE answers “agent is not running” — that
  check runs **before** the command is sent, so nothing has been executed in the guest.
* `vm_status` now explains how to recover a wedged guest agent.
* Tool descriptions now state the real limits (1 MiB write over stdin, chunked reads, ASCII-only
  `argv`).

### Notes

* A command that outlives `timeoutMs` **keeps running** in the guest — the plugin says so honestly.
  Long commands are therefore better given a larger `timeoutMs` than cut off by the timeout.
* Residual transport flakiness on a busy guest is PVE/QMP behaviour, not the plugin: on mixed load
  one call in ~20 can still catch the 5-second QMP timeout, and `qemu-ga` can hand back the output of
  an earlier command when Windows reuses a pid. A chunked file read detects that case (the reply is
  checked against the file length) and retries; for a plain `vm_exec` reply there is nothing to check
  it against, so a foreign stdout remains possible — that is a `qemu-ga` artefact, not a plugin bug.

## [0.2.1] — 2026-10-14

The plugin card finally speaks Russian — along with the English title it always carried.

### Fixed

* **`locale/en.json` and `locale/ru.json` were written in a format the panel never reads.** The
  reader (`readPluginMeta` in `dsh-app-boot`) takes display text from a `meta` object —
  `{"meta": {"title": …, "description": …}}` — and silently drops a flat `{title, description}` file.
  Both files were flat, so the card in the plugin inventory showed the package name `dsh-pve-vm` and
  the manifest description, and the Russian text never appeared anywhere. Wrapped in `meta`: the card
  now reads “Proxmox VE VM control” / “Управление ВМ Proxmox VE” and follows the panel language.

### Checks

* `tools/check-plugin.mjs` now verifies the card metadata: the `meta` shape of every `locale/*.json`,
  field parity between the languages, and — through the installed harness — that `readPluginMeta`
  really answers with a translation map instead of the package-name fallback.

## [0.2.0] — 2026-10-13

Watch the agent work: a live VM screen in the right sidebar of the web UI.

### Added

* **The “VM screen” tab** — a right-sidebar panel that streams the frames the agent sees. The frames
  come from the agent's own RFB session, so no second VNC session appears and the `qm vncproxy`
  password is never reset; captures and tools share one session queue. Watch-only by design: the
  panel injects nothing into the guest.
* **`viewAutoOpen`** (off by default) — reveal the tab by itself when the agent touches a console.
* **`viewFollowAgent`** (on by default) — the panel follows the VM the agent works with; a VM chip
  pins it by hand. Watching never counts as agent work: frame requests suppress the activity mark
  (`withConsole(..., { mark: false })`), so the panel cannot chase itself.
* **`viewFps`** (2) and **`viewScale`** (2) — frame pace and resolution divisor, both changeable on
  the fly inside the panel.
* **Host routes** `/pve-vm/console/state`, `/frame` and `/release` on the harness web server,
  registered only when the composition has a `webServer`. They carry a loopback-only fence: Host must
  be loopback, a present Origin must match Host, `sec-fetch-site: cross-site` is refused and POST must
  be `application/json`. A harness bound to a LAN therefore keeps the panel dark.
* `RfbClient.waitForUpdate({ idleOk: true })` — silence at a message boundary means "the screen did
  not change" instead of an error, while a timeout inside a message stays fatal.

### Fixed

* **`inputChannel` and `sendkeyDelayMs` never reached the tools.** Both keys were missing from
  `CONFIG_KEYS`, so `snapshot()` dropped them and every run silently used the built-in `auto`/80 ms
  defaults. The form accepted the values, the code ignored them.

## [0.1.1] — 2026-10-13

Linux guest support. Everything below was found by running the plugin against a real RedOS 8
guest with a MATE desktop, not by reading the code.

### Fixed

* **Guest OS detection rejected almost every Linux distribution.** The guest agent reports `id`
  from `/etc/os-release`, and only IDs containing `linux` were accepted — RedOS reports `redos`,
  Debian `debian`, Ubuntu `ubuntu`. All of them landed in `other` and every `vm_*` tool answered
  *running a shell command is not supported for guest OS «other»*, so the whole guest-agent half
  was dead on Linux. Windows was unaffected (`mswindows`), which is why it went unnoticed.
  Windows is now matched first, Linux by `id`/`name`/`pretty-name`, and a non-Windows guest that
  answered `get-osinfo` with a non-empty `kernel-release` counts as Linux.
* **`vm_type_text` typed nothing on a GDM desktop.** The built-in typing script used
  `$home/.Xauthority`, which does not exist when GDM owns the session — RedOS and RHEL keep the
  file at `/run/user/<uid>/gdm/Xauthority`. `xdotool` then talked to the X server with no
  authorization at all, failed with *No protocol specified*, and the text never appeared. The
  script now tries `~/.Xauthority`, then the GDM path, then any `/run/user/<uid>/*/Xauthority`.
* **`vm_type_text` could not submit text.** `text=$(… | base64 -d)` — command substitution strips
  trailing newlines, so text ending in `"\n"` was typed without pressing Enter and the shell
  prompt never came back.
* **Console errors hid the actual cause.** When the node's `sshd` does not accept `AcceptEnv`,
  `LC_PVE_TICKET` never arrives and `qm vncproxy` exits with a precise
  *LC_PVE_TICKET not set, VNC proxy without password is forbidden* — but the RFB reader saw EOF
  before ssh had finished exiting, so only *the VNC stream was closed by the node* surfaced. The
  ssh stderr is now reported (after a short grace period), both during the handshake and when a
  live session dies mid-way.

### Known limitations

* Proxmox applies a **default 5-second timeout to QMP commands** (`PVE/QMPClient.pm`), and
  `guest-exec` waits for the guest agent to acknowledge. While a previous long command is still
  running inside the guest that acknowledgement arrives too late and the call fails with
  *qmp command 'guest-exec' failed - got timeout*. On an idle guest 10 out of 10 calls complete
  in about a second. `vm_exec` is currently synchronous and does not retry.

## [0.1.0] — 2026-10-13

Initial public release.

### Added

* **Console (VNC/RFB) tools** — `console_shot`, `console_move`, `console_click`, `console_drag`,
  `console_scroll`, `console_type`, `console_key`, `console_paste`, `console_batch`,
  `console_clipboard`, `console_release`. Frames come back as inline images with an attachment
  reference; `region` and `scale` cut the cost of large desktops.
* **Guest agent tools** — `vm_exec`, `vm_file_read`, `vm_file_write`, `vm_type_text`, `vm_status`
  through `qm guest exec` / `qm guest cmd`.
* **Transport** — a single ssh session to the Proxmox node; `qm vncproxy` bridges the VM's unix
  VNC socket to the plugin's stdin/stdout, so no port, TLS or websocket is involved. The VNC
  password travels as `LC_PVE_TICKET` via `SendEnv`, never in `argv`.
* **Reliable typing** — uppercase through Caps Lock (`qm monitor` → HMP `sendkey`), shifted
  symbols through RFB keysyms with a settle delay; `inputChannel` selects `auto`, `hmp` or `vnc`.
* **Unicode text** — on Windows, a scheduled task running in the logged-in user session uses
  `SendKeys`; on Linux guests, `xdotool` (X11) or `wtype` (Wayland) inside the active session.
* **Clipboard** — `console_paste` writes UTF-8 text into the guest clipboard over RFB
  `ClientCutText`; `console_clipboard` reads it back through the extended VNC clipboard
  (`VNC_ENCODING_CLIPBOARD_EXT`).
* **Settings card** — a client-side `settings.section` card (15 fields, English and Russian
  labels) backed by `configForms`, writing to the profile patch layer.
* **Checks** — `tools/check-plugin.mjs` (schemas, tool set, layout contract) and
  `tools/check-client.mjs` (browser bundle format), plus standalone probes
  (`probe-rfb.mjs`, `live-test.mjs`, `clipboard-test.mjs`, `clipboard-read-test.mjs`).

### Known limitations

* Proxmox VE only (`qm` CLI on the node); LXC containers are not supported.
* The node's `sshd` must accept `AcceptEnv LC_*`, otherwise the VNC password never reaches `qm`.
* Clipboard exchange needs `vga: <type>,clipboard=vnc` on the VM plus a SPICE agent in the guest,
  and applies only after a full VM stop/start.
* Unicode typing in a Windows guest needs a logged-in interactive session.
