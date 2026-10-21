# Bitvise SSH Client 9.66 — precise inventory vs bvrs coverage

Produced with the repository's own tooling (clean-room, no decompilation):
`ripper detect`/`ripper extract` over the whole installation
(`C:\Program Files (x86)\Bitvise SSH Client`), Win32 dialog decoding
(`dialogs/*.json`), built-in CLI usage capture, and the RTF help texts
embedded in `BvSsh.exe`. See
[workflow-clean-room-reimplementation](../../docs/workflow-clean-room-reimplementation.md).

## 1. Executables (all Native C/C++; x86 except BvDump64)

| Executable | Role (from resources/usage) | bvrs status |
|---|---|---|
| `BvSsh.exe` | GUI client: Login/Terminal/SFTP/C2S/S2C/Services/… tabs, profiles | 🟡 `bvrs-gui` v1: connection bar + Terminal + SFTP browse/transfer |
| `stermc.exe` | Scriptable interactive terminal | ✅ `bvrs shell` (PTY, resize, `~.`) |
| `sexec.exe` | One-shot remote execution | ✅ `bvrs exec` (exit codes, stderr) |
| `sftpc.exe` | Scriptable SFTP client | ✅ `bvrs sftp` (batch, `-cmd=`, `-cmdFile=`, `-ce`, cd/lcd) |
| `stnlc.exe` | Tunneling/port-forwarding + FTP-to-SFTP bridge | ❌ not implemented |
| `bvtermc.exe` | Bitvise `bvterm` protocol terminal | ❌ (bvrs uses standard PTY/xterm bytes) |
| `totermc/totermw.exe` | VT100/xterm terminal clients | ❌ (covered in part by `bvrs shell`) |
| `spksc.exe` | Manage client public keys on the server | ❌ |
| `log.exe` | Record output of a command line program | ❌ (out of scope) |
| `retry.exe` | Retry a command until it succeeds | ❌ (out of scope) |
| `BvSshCtrl.exe` | Automation control sample (C++ source shipped) | n/a (GUI automation) |
| `BvSshUpdate.exe` | Update manager | n/a |
| `BvDump32/64.exe`, `BvInputDiag.exe` | Diagnostic tools | n/a |

## 2. Libraries (DLLs)

| Library | Role | Replaced in bvrs by |
|---|---|---|
| `FlowSshC32/64.dll` | The SSH engine (protocol, crypto, keys) | `russh` 0.63 (ring backend) + `russh-sftp` |
| `FlowSshNet32/64.dll` (+ MSI) | .NET bindings for FlowSsh | n/a (Rust lib API of `bvrs`) |
| `CiWinCng32/64.dll` | Windows CNG crypto provider | `ring` (pure Rust) |
| `BvWinFsp/` | SFTP drive mapping via WinFsp | ❌ not implemented |
| `MstscTitle32/64.dll` | RDP window title helper | ❌ (RDP tunneling not implemented) |
| `WRC-*` folders | Runtime components of the installer | n/a |

## 3. BvSsh.exe GUI — tabs (from embedded RTF help) and dialogs (decoded)

Main window tabs (documented in RTF help resources):

| Tab | Purpose (RTF) | bvrs-gui status |
|---|---|---|
| Login | Host, port, obfuscation, user, auth methods | 🟡 host/port/user/password/key + strict; no obfuscation, no GSSAPI/keyboard-interactive |
| Terminal | bvterm/ansi/vt100/xterm, colors, beeping, recording | 🟡 single xterm-ish PTY, ANSI stripped; no palette/recording |
| SFTP | default dirs, transfer modes, **drive mapping (WinFsp)** | 🟡 dual-pane browse + upload/download + progress; no transfer modes, no mapping |
| C2S | client-to-server forwarding rules | ❌ |
| S2C | server-to-client forwarding rules | ❌ |
| Services | integrated SOCKS4/4A/5 + HTTP CONNECT proxy, RDP single-click | ❌ |
| Remote Desktop | single-click tunneled RDP | ❌ |
| SSH | algorithm selection (KEX incl. ML-KEM hybrids, ciphers, MACs) | ❌ (russh safe defaults; no UI) |
| Options | auto-reconnect, timeouts, IPv4/6 | ❌ |
| About | version, updates, license | n/a |

Decoded dialogs (57 with content, `dialogs/*.json`), grouped:

- **Connection**: `#101` Login controls (port, obfuscation keyword, Kerberos/SPN), `#102` main window (Log in/Exit/Topic), `#105` SSH settings, `#106` proxy, `#243` options/reconnect, `#551` SSH timeouts.
- **Keys**: `#107/#108` client & host key managers, `#111` modify key (fingerprints SHA-256/MD5/bubble-babble), `#112` change passphrase, `#113` generate keypair, `#114/#115/#116` export/import, `#119/#447/#448/#449` host key export/modify/import.
- **SFTP window**: `#234` "Bitvise SFTP [disconnected]", `#354/#531` General, `#355` Permissions, `#476` Attributes, `#494` Hashes, `#477` Mirror, `#415` rename dialog, `#450/#451/#452` editor/move/link, `#543` SFTP options, `#385` initial dir.
- **Terminal**: `#417` terminal settings, `#527` session recording, `#530` window title, `#547` window dimensions.
- **Services/RDP**: `#392` proxy listen interface/port, `#525` custom RDP.
- **Misc**: `#178` installed resources/updates, `#194` activation, `#505` app settings, `#546` popup settings.

bvrs-gui implements none of these dialogs individually (single-window v1);
the list above is the backlog for GUI parity.

## 4. CLI option surface (captured from the tools' built-in usage)

Shared by sftpc/stermc/sexec: destination, `-user/-host/-port`, `-pw`,
`-pk` (agent), `-kbdi` (keyboard-interactive), `-gka/-gma` (GSSAPI),
proxies (`-proxy*`), jump host (`-jump*`), algorithm lists (`-*Algs`,
`-*Mod`), `-strictKex`, keepalive `-ka/-kre`, `-hostKeyFp/-hostKeyFile`,
`-keypairFile/-keypairPass`, `-traceLog`, `-noRegistry`.

bvrs supports: destination forms, `-user/-host/-port`, `-pw`,
`-keypairFile/-keypairPass`, `-hostKeyFp/-hostKeyFile`, `-cmd/-cmdFile/-ce`,
`-progress`, `-noRegistry` (ignored). Everything else is rejected with an
explicit `not supported` error. sftpc interactive commands: 20 of ~40
implemented (see bitvise-rs README).

## 5. Coverage summary

- **CLI core (stermc/sexec/sftpc)**: ✅ complete for common scripting use.
- **Bitvise option compatibility**: 🟡 subset (12 options).
- **GUI (BvSsh)**: 🟡 v1 — connect + terminal + SFTP transfers.
- **Not started**: port forwarding (C2S/S2C/SOCKS/HTTP), stnlc FTP bridge,
  WinFsp drive mapping, RDP tunneling, profiles, agent/Pageant,
  keyboard-interactive, GSSAPI, obfuscation, bvterm, spksc.
