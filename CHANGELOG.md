# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

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
