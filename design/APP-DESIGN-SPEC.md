# Quantum Safe — app design spec (input for pen.dev)

One app, one look, every screen size. Same tokens as the website.

## Tokens
- Dark: bg #0B1020, bg-2 #121933, line #232C4D, fg #E8ECF7, muted #8A93B2, accent #2EE6D6, danger #E5484D, warn #F5A524, ok #3DD68C, key-2 blue #5B8CFF
- Light: bg #FAFAF7, bg-2 #F0F0EA, line #DDDDD3, fg #111526, muted #5C6480, accent #0FA89B
- Type: IBM Plex Sans (UI), IBM Plex Mono (addresses, amounts, hashes). Sizes 12/14/16/20/28/40.
- Radius 8 (inputs) / 12 (cards) / 20 (sheets). Spacing grid 4. No gradients, no glassmorphism.
- Every screen in both themes.

## Screen sizes (frames)
| Group | Size | Notes |
|---|---|---|
| Watch (Wear OS / watchOS) | 198×242 | balance + approve/deny only |
| Phone small (iPhone SE) | 375×667 | |
| Phone (Android / iPhone 15) | 390×844 | main reference |
| Phone large (Pro Max) | 430×932 | |
| Foldable, folded / unfolded | 344×882 / 673×841 | two-pane when open |
| Tablet portrait (iPad mini) | 744×1133 | sidebar collapses into a rail |
| Tablet landscape (iPad Pro) | 1366×1024 | sidebar + detail pane |
| Browser extension popup | 360×600 | |
| Extension side panel | 400×800 | |
| Laptop / desktop app | 1280×800 | fixed sidebar 240 |
| Desktop large | 1920×1080 | 3-column: sidebar, main, activity |
| Ultrawide | 2560×1080 | content max 1600, centered |

Breakpoints: <600 bottom tab bar · 600–1023 icon rail (72) · ≥1024 full sidebar (240) · ≥1600 extra activity column.

## Navigation
- Sidebar / rail / tab bar items: Home, Send, Receive, Vault, Activity, Settings. Bottom of sidebar: network pill (Devnet), account switcher, theme toggle.
- Tab bar on phone: Home, Vault, [Send FAB center], Activity, Settings.

## Screens
1. Onboarding: welcome (3D qubit), create or import, back up seed phrase (12 words, blur until tapped), confirm 3 words, create second key (Winternitz), done.
2. Unlock: PIN pad + biometric.
3. Home: total balance (QC + SOL), vault status card ("Locked by 2 keys"), quick actions, recent activity.
4. Send: amount (large mono numpad), recipient (paste / QR / address book), review, sign with key 1, sign with key 2, result.
5. Receive: QR, address copy, share.
6. Vault: vault list, deposit, withdraw, key status (key 1 Ed25519, key 2 WOTS with one-time use counter, "N keys left").
7. Activity: list grouped by day, filters (sent / received / vault), transaction detail with explorer link.
8. Settings (sections):
   - Account: name, avatar, multiple accounts, export public key
   - Security: PIN, biometric, auto-lock timer (1/5/15 min), view recovery phrase, rotate WOTS key, connected sites (extension)
   - Network: Mainnet / Devnet, custom RPC, priority fee (low/normal/fast)
   - Display: theme (system/light/dark), language (10 hand-written + more), currency (USD/IDR/EUR…), hide balances
   - Sound & haptics: master toggle, volume, per-event toggles, haptics on/off
   - Notifications: incoming, vault changes, price alerts
   - About: version, audit report, terms, support
   - Danger zone: reset wallet (red, typed confirmation)
9. Empty, loading (skeleton), error, offline states for Home, Activity, Vault.
10. Extension only: connect-site request, sign-message request, network mismatch warning.

## Motion
| Moment | Animation | Duration / easing |
|---|---|---|
| Screen change | slide 16px + fade | 220ms, cubic-bezier(.2,.8,.2,1) |
| Sheet open | rise from bottom, backdrop fade to 50% | 280ms spring |
| Balance load | count-up from 0 | 900ms ease-out |
| Key 1 signed | orbit ring 1 lights up, bead snaps to top | 400ms |
| Key 2 signed | ring 2 lights up, both beads meet at center | 400ms |
| Sending | qubit core pulses, dotted line travels to recipient | loop 1.2s |
| Confirmed | core bursts into check mark, ring expands and fades | 600ms |
| Failed | horizontal shake 3×6px, red outline | 360ms |
| Vault lock | shackle drops, click | 300ms |
| Pull to refresh | qubit spins with the pull distance | follows finger |
| Copy address | text flips to "Copied" | 150ms, back after 1.5s |
Reduced motion: fades only, no movement, no loops.

## Sound (SFX)
Short, soft, no melodies. Off by default on desktop, on for mobile. Peak -18 dBFS, all under 400ms.
| Event | Sound |
|---|---|
| Tap / toggle | soft tick, 30ms |
| Key signed | low glass click, 120ms |
| Both keys signed | two-note rise (key 1 then key 2 pitch) |
| Sent / confirmed | warm chime, 350ms |
| Received | two soft bells, 300ms |
| Error | low muted thud, 200ms |
| Vault lock / unlock | metallic latch, 180ms |
| Copy | paper swish, 80ms |
Haptics mirror these: light (tap), medium (key signed), success pattern (confirmed), error pattern (failed).

## Deliverables
- quantum-safe.pen with one page per size group, both themes.
- PNG export per frame to E:\Download\quantum-safe-designs\
- Motion + SFX sheet as its own page (storyboard frames for send flow: idle → key1 → key2 → sending → confirmed).
