# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

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
