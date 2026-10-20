# TeamViewer reference review

## Target and method

The primary target was the installed copy at `C:\Program Files\TeamViewer`, version `15.82.6.0`, rather than only its setup program. REA's static PE resource inventory was used on `TeamViewer.exe`, `TeamViewer_Desktop.exe`, `TeamViewer_Service.exe`, and the French, English, and Arabic resource DLLs. The setup file was also inspected without running it.

Key evidence:

- Setup PE resources: `ev_5bff0f41e8509a8bb1687162f2186db0099a142f2e3b35613805ea69ca38dc69`; setup artifact graph: `ev_5607bf1b7c822ba4c2f9ee9bab1146efdb4328eebbb3f9acbed7e6cbe0f38e08`.
- Installed executable resources: `TeamViewer.exe` `ev_f1beb4bfe727add0c1e8a25568ecbc600493c1a034564ddb76c4e0bafc2dca43`; desktop component `ev_2d21af75714a7ea58cea8007d46ac544f3b7eb8129bd005e439916e063fd8571`; service component `ev_a4c2d246c5b233a39feadd355162a7a925b7e3897016fb503f777ac3409185d7`.
- Resource inventories for French, English, and Arabic: `ev_768375e453fc5c8de9f2c593729ca763365d67c91da330f9ca13b16b8db16a2a`, `ev_50a2fc43c2d4f7591dcb9bfc7e8468c78ccac6547962f34b365ab5b2680a0329`, and `ev_880dc973bcb9e00564ea6f1ca1ab77b0fddd8a2010d3ff76a1ce810a8e84fdd3`.

The setup file is an 85,117,640-byte PE32 x86 executable. REA's package inventory found no child archive entries, so it did not expose the installed program's contents. The installed `TeamViewer.exe` is PE32+ x64. The three inspected language DLLs each contain 332 `RT_STRING` resource blocks; French, English, and Arabic UI strings were read from the exact payload ranges reported by REA.

## Feature areas observed in UI resources

These are feature names and prompts present in the installed application's resource strings. They identify product areas; they do not prove that each feature is available in every configuration, plan, or operating system.

- Remote support: outgoing and incoming sessions, screen viewing, remote control, full and minimal interaction, session details, password prompts, and LAN-only connection settings.
- Access policy: allow or deny incoming/outgoing sessions, per-operation access rights, partner allow/block lists, and controls for screen, keyboard/mouse interaction, audio, video, chat, and file sharing.
- Device administration: computer/contact lists, account assignment, permanent personal passwords, random passwords, unattended access, device naming, Wake-on-LAN, and remote system information.
- Communication: text chat, audio conferencing/VoIP, video sources, and meetings with organizers, participants, scheduling, roles, and screen presentations.
- Data and tools: file transfer and file boxes, session logs, registry/INI export, VPN connections, and remote printing references.
- Display and privacy: full-screen viewing, screen selection/presentation, scaling and resolution settings, fast video streaming, and an option to disable remote input and show a black screen.
- Product operations: account sign-in, service/component settings, licensing messages, and password management.

Directory metadata shows separate main, desktop, service, note, WebRTC, automation-bridge, architecture-wrapper, and localized-resource components. This suggests a multi-component product layout, but filenames and version metadata alone do not establish each component's runtime responsibility.

## Boundaries of the findings

REA confirmed resource inventories and file identities. The PE resource parser leaves most payloads opaque and cannot establish actual UI loading or feature behavior. The active session reported Ghidra as not configured (`GHIDRA_INSTALL_DIR` unset); Hopper is unsupported on this Windows host, and IDA/Kuna were not configured. The native code, network protocol, service behavior, permissions, and license checks therefore remain unexamined. The findings above come from static labels and prompts, not execution or decompiled control flow.

Sanad remains an independent implementation. It already has screen sharing, session codes, device ID/password, file transfer, separate screen viewing, and consent-gated mouse/keyboard permissions. This update adds a local known-device list and recent-device history, storing only device ID, optional name, and favorite/recent metadata. It never stores the remote password. The desktop host can also select which monitor to share; pointer coordinates are mapped to that selected display, and the host confirms the selection locally. A text chat is now available only while connected and only after the host enables it; the bounded chat history is cleared at session end. Features requiring a privileged service, a meeting system, or a different network architecture are not inferred from string labels alone.
