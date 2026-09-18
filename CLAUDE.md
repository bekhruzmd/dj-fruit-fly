# Project Reference & Delegation Guide

## Codex Delegation: Manager and Workers

You are the MANAGER for this task. You plan, set acceptance criteria, make taste and architecture calls, and review everything before it ships. You do not type the implementation yourself for anything non-trivial — that goes to a worker through the Codex CLI, then gets audited before it's used.

1. **Decide: delegate or inline**
   Delegate by default. Handle inline only when the task is trivial (under ~2 tool calls), a judgment call (architecture, naming, prioritization, review verdict), or conversational (explaining, summarizing). Everything else — writing or editing code, running tests, chasing a bug, a multi-file refactor — gets a worker.

2. **Route to a model**
   * **GPT-6 Astra** — the hardest coding: multi-file refactors, computer-use tasks, anything a cheaper model already failed on twice.
   * **GPT-5.6 Sol** — routine builds, tests, debugging, log/repo digging, boilerplate, brief-driven drafts.
   Judge the output, not the price tag: if Sol's result misses the acceptance criteria, escalate to Astra without asking permission first.

3. **Write the dispatch prompt**
   Every dispatch needs: the exact files or directories to touch, what "done" looks like in concrete checkable terms, the exact command to run before reporting back, and anything the worker must not do.
   ```bash
   codex exec </dev/null -s workspace-write -c approval_policy="never" -c model="<model-id>" -c model_reasoning_effort=high -C <repo-path> "<task: files to touch, what done looks like, commands to run before reporting>"
   ```
   Fix rounds resume the same session:
   ```bash
   codex exec </dev/null resume --last -c approval_policy="never" "<exact error text or next chunk of work>"
   ```

4. **Audit before use**
   Run the real thing — execute the test suite, hit the endpoint, render the page. A diff that looks plausible can still be broken; only running it counts as verification. Check the diff too, for scope creep or a silently added dependency. On failure, resume the same worker with the exact error text, not a paraphrase. Give a model two honest attempts at a sub-task — if it's still failing on the third, escalate to the next tier up.

5. **Rules workers operate under**
   No silent scope changes — a worker that hits a wrong or impossible step says so and stops, it doesn't improvise. No secrets in prompts or output, ever. Short summaries, not raw dumps — what changed, what was verified, what's still open. Label output by which model produced it. Sandbox the blast radius — narrowest write scope and approval policy the task allows.

6. **When this doesn't apply**
   You're pair-programming interactively and want to type it yourself. The change is destructive or hard to reverse (schema drops, force-pushes, prod deploys) — those need explicit human sign-off regardless of model. No repo context exists yet — write a short skeleton first, then delegate the fill-in.

---

## Session Handoff — 2026-09-17

This section supersedes the older architecture snapshot below wherever they disagree. The fly animation work is implemented and was visually checked. The assisted djay integration is **in progress, with native control availability unresolved**. Do not describe it as a proven autonomous DJ or a completed live transition.

### User goal and agreed first milestone

The user supplied [TuragaLab/flybody](https://github.com/TuragaLab/flybody), asked for correct model scale and DJ animations, then asked to make the fly actually mix decently in djay. The agreed first milestone is **one clean, repeatable transition between two manually loaded tracks**, before autonomous track selection or a full set.

The intended workflow is: load compatible tracks, use djay's BPM + Beat Sync, enter the actual synced BPM, prepare the incoming bass, and explicitly start an eight-bar blend on a phrase downbeat. Phrase alignment is supplied by the user; automatic phrase detection is not implemented. Learning remains observational in this first live-control version.

### Completed fly model and animation work

Files: `src/graphics/FlyAvatar3D.ts`, `src/App.tsx`, `src/index.css`.

- The page uses the FlyBody OBJ parts in `public/models/flybody/`. The separate `wildtype_male_drosophila_melanogaster/scene.gltf` upload is not the active rig.
- Fixed the coordinate mismatch: the OBJ model is Z-up and faces -X. Its vertices are converted to stage coordinates `(-Y, Z, -X)`, then placed in an upright DJ stance.
- Replaced the old wingspan-based height normalization with body-only normalization. The head/thorax/abdomen determine a 1.55-unit longitudinal size; wings no longer shrink the body.
- Added one shared pivot per wing, so veins and membrane stay together; added a head pivot with fitted headphones, and middle/hind leg pivots.
- Reused the original front femur/tibia meshes in articulated arms, replacing placeholder cylinder geometry. The arm targets use the actual booth geometry.
- Added body groove, head nods/turns, leg movement, and wing flourishes. A silent 16-second offline demo cycles through scratching, headphone cueing, and a raised-arm pump.
- Added **Play/Pause demo moves**. Demo choreography does not send djay commands or fabricate platter playback; live bridge state takes priority. Reduced-motion preference suppresses decorative rig movement.
- Adjusted camera distance for narrow windows and the DJ view; made the header controls wrap inside their panel.
- Visually inspected Orbit, Front, and DJ views in Chrome, including the demo toggle. These checks were completed before the later assisted-mixing UI changes.

### Findings in the original live-control path

- `App.tsx` called `sendControl(payload)` without its required `liveAudio` argument, whose default was false. Consequently the client rejected outgoing controls.
- The old native dispatcher only attempted crossfader keyboard nudges and an `F` cut shortcut. Filter requests were unsupported; it did not load tracks, cue, sync, or adjust EQ.
- The live neural loop receives the combined audio spectrum, not independent deck positions or a verified phrase grid. Reward/penalty alone cannot provide that missing information.
- Existing `MusicalDirector.ts` and `MusicalTiming.ts` contain timing helpers for earlier experiments, but they do not establish real djay phrase timing.

### Assisted transition implementation currently in the working tree

| File | Current responsibility |
| --- | --- |
| `scripts/djay_transition.py` | Testable server-clock transition state machine and crossfader/bass target curves. |
| `scripts/djay_accessibility.py` | Named AX control discovery, reads, supported-action checks, explicit deck button presses, and bounded slider increments/decrements with readback. |
| `scripts/djay_bridge.py` | Transition command validation, serialized native worker, owner heartbeat, telemetry, and local WebSocket service. |
| `scripts/check-djay-bridge.py` | Read-only bridge snapshot; `--native` diagnoses native control discovery without sending mixer commands. |
| `src/bridge/protocol.ts` | Validated optional transition telemetry, writable-control flags, progress, and stale-state handling. |
| `src/bridge/DjayBridgeClient.ts` | Explicit prepare/start/stop/heartbeat/deck-action commands and rejection messages. |
| `src/graphics/TransitionPanel.tsx` | Direction, BPM, deck buttons, preparation, sync confirmation, start/stop, progress, and availability explanations. |
| `src/App.tsx` | Panel integration, heartbeat, Escape/visibility/listening-stop handling, actual crossfader display, and teardown. |
| `src/index.css` | Assisted-mix panel styling and responsive placement. |
| `tests/test_djay_transition.py` | Pure controller and AX parsing regression tests using simulated mixer feedback. |

Behavior implemented so far:

- Supports Deck 1 → 2 and Deck 2 → 1, at a manually entered 60–180 BPM, for 32 beats (eight bars in 4/4).
- Preparation lowers only the inaudible incoming deck's bass. It requires the crossfader at the source endpoint, centered source bass and filters, raised channel volumes, and readable/actionable controls.
- Start requires preparation and explicit confirmation that both decks are playing in beat sync. A measured paused deck blocks the run; unknown transport state is not represented as verified playback.
- Uses a smooth monotonic crossfader curve. Outgoing bass falls during 40–50% of the blend; incoming bass rises during 50–60%. The outgoing bass remains cut after completion.
- Stop holds the current mixer position. Loss of heartbeat, timing stalls, missing readback, a measured paused deck, outside mixer movement, and sustained control lag stop the routine.
- Free-running neural control dispatch has been removed from the page. The bridge rejects the legacy control message route; old keyboard-dispatch code remains in the file as an unused legacy implementation and needs review/cleanup.
- Explicit Play/Pause, Cue, and Sync buttons use supported AX press actions. Successful dispatch is not claimed as proof of transport or beat alignment.
- The fly still follows measured crossfader/filter state. Dedicated bass-EQ knob/hand animation has **not** been added.
- The WebSocket listens on `127.0.0.1:8766` and currently accepts browser origins `http://127.0.0.1:5173` and `http://localhost:5173` only. A Vite fallback port such as 5174 will not connect without a deliberate origin configuration change.

### Unresolved native djay blocker

The bridge diagnostic reported `djay: true`, `accessibility: true`, and `dispatch: true`, but all mixer readings were unknown and all writable flags false. Native discovery found the expected descriptions (Crossfader, Low EQ, Filter, Line volume, Sync, Play/Pause, CUE), but **every discovered matching control reported `AXEnabled = false`**. Disabled candidates are deliberately not cached for control.

This conflicts with the computer-use accessibility view, which showed some deck controls enabled. A screenshot showed the two-deck mixer and a “Start Free Trial” button, without establishing a subscription problem. **Do not assume an expired subscription or bypass disabled-control checks.** A process check found one djay application process, so duplicate app processes were not established as the cause.

Discovery diagnostics added during investigation:

- Use `CFHash(node)` for traversal identity instead of raw reference addresses.
- Count visited/pending nodes and AX errors; native diagnostics also sample slider labels and count enabled/disabled candidates.
- Observed native error codes included `-25205`, `-25212`, and occasionally `-25204`; these have not yet been resolved into a confirmed root cause.

The main thread's last question to the user was: **“Can you move djay’s crossfader and Low EQ knobs manually right now? The bridge reports them as disabled, although they’re visible.”** No answer was present when this handoff was written.

### Verification and remaining work

- `npm run build` passed after the main assisted-transition changes. Vite warns that Node 22.8.0 is below its supported range (20.19+ or 22.12+) and about the large bundle.
- `npm run lint` passed with one existing ref-cleanup warning in `TrackAnalysisPanel.tsx` at the last run.
- All 11 new Python transition tests passed: both directions, exact eight-bar duration, preparation, bass exclusivity, input validation, missing controls, Stop, heartbeat/stall handling, manual override, paused transport, and failed/nonmoving controls.
- The existing `npm test` suite passed. The new Python tests are a separate command, not wired into `npm test`.
- Python compilation passed before the latest diagnostic additions; those additions were subsequently exercised by the native diagnostic command.
- `git diff --check` found trailing whitespace on two edited `App.tsx` lines (crossfader thumb style and connected-status text). This was still outstanding at interruption.
- **No real eight-bar djay transition has been completed or listened to.** Native writes remain unverified. The new mix panel still needs a successful visual/interaction review, and the latest diagnostics need final build/lint checks.
- Add protocol/client/server ownership tests, review native failure handling and capability freshness, and verify timing under actual AX latency before calling the integration complete.
- Once control availability is resolved, verify preparation and each control with readback, run both blend directions, check Stop/disconnect/manual intervention, and listen to the result. Do not infer musical quality from passing simulated tests.

Useful commands:

```bash
npm run dev -- --host 127.0.0.1
npm run bridge
.venv/bin/python scripts/check-djay-bridge.py
.venv/bin/python scripts/check-djay-bridge.py --native
.venv/bin/python -m unittest discover -s tests -p 'test_djay_transition.py' -v
npm test
npm run build
npm run lint
git diff --check
```

The preview on port 5173 and a bridge process may still be running from the interrupted main session. A duplicate preview that fell back to 5174 was stopped. Check current processes before starting duplicates; process/session identifiers are not stable. No commit or deployment was made. `.serena/project.yml` was already modified before this work and was left alone.

References consulted: [FlyBody model XML](https://github.com/TuragaLab/flybody/blob/main/flybody/fruitfly/assets/fruitfly.xml), [djay BPM + Beat Sync](https://help.algoriddim.com/user-manual/djay-pro-mac/dj-tools/beatgrids-bpm-sync/sync), [Automix](https://help.algoriddim.com/user-manual/djay-pro-mac/mixing-basics/using-automix), and [sound/EQ settings](https://help.algoriddim.com/user-manual/djay-pro-mac/settings/sound).

---

## Earlier Architecture Snapshot (Historical)

The following notes describe the earlier keyboard-based integration. Use the session handoff above for the current implementation and its verification limits.

A connectome-inspired fruit fly AI that listens to live music from **djay Pro (streaming Spotify Premium)** via **BlackHole 2ch**, updates a sparse neural mushroom body circuit in real time, and physically moves the mixer controls in `djay Pro`.

### Core Architecture Components

```
┌─────────────────────────────────────────────────────────────┐
│                    djay Pro (macOS)                         │
│   • Plays Spotify playlists on Deck 1 & Deck 2              │
│   • Master Audio Output → Multi-Output Device (BlackHole)   │
└──────────────┬───────────────────────────────▲──────────────┘
               │ Audio Stream                  │ Keystrokes (Direct PID)
               ▼                               │
┌──────────────────────────────┐ ┌─────────────┴──────────────┐
│        BlackHole 2ch         │ │     scripts/djay_bridge.py │
│   Virtual Audio Driver       │ │    (WebSocket Port :8766)  │
│   Feeds live stereo master   │ │    • macOS CoreGraphics    │
└──────────────┬───────────────┘ │    • CGEventPostToPid      │
               │                 └─────────────▲──────────────┘
               │ Web Audio API                 │ WebSocket
               ▼                               │ Commands
┌──────────────────────────────────────────────┴──────────────┐
│               Neuro-DJ Web App (Vite React)                 │
│   • AudioFeatureExtractor (Johnston's Organ FFT analyzer)   │
│   • FlyWireCircuit (64 Kenyon Cells, APL sparse coding)     │
│   • 3-Factor Dopamine Plasticity (Reward: 'R', Punish: 'X') │
│   • FlyAvatar3D (Three.js Club DJ Booth & Animated Fly)     │
│   • CircuitHUD (Floating Neural Activity & Sparsity HUD)    │
└─────────────────────────────────────────────────────────────┘
```

### Recent Overhaul & Current Features

1. **djay Pro (Spotify) Bridge Integration**:
   * **`scripts/djay_bridge.py`**: A Python WebSocket server listening on `127.0.0.1:8766`.
   * Automatically finds `djay Pro`'s process ID via `pgrep` and uses `CGEventPostToPid` to send native key events (`Ctrl + Left/Right Arrow` for crossfader, `F` for cuts) directly to `djay Pro` even when in the background.
   * **`src/bridge/DjayBridgeClient.ts`**: Frontend WebSocket client streaming crossfader, filter, and stutter commands with auto-reconnection.
   * **System Permissions**: Requires **Terminal** (or host IDE) to be enabled under **System Settings > Privacy & Security > Accessibility**.

2. **Upgraded 3D Club DJ Booth (`src/graphics/FlyAvatar3D.ts`)**:
   * **Club Sound System**: Two massive subwoofer stacks flanking the booth with circular speaker cones that physically punch and pump outward on kick drum transients (`subBass`).
   * **Overhead Stage Truss & Lasers**: 4 moving volumetric laser spotlights that sweep and pan in time with music.
   * **Pioneer-style CDJs & Mixer**: Backlit platter rings (cyan on Deck 1, pink on Deck 2), spinning needle markers, sliding channel volume faders, and front LED matrix spectrum facade.
   * **Fly DJ Headset**: Stylized neon-cushioned DJ headphones fitted over the fruit fly's head.
   * **Interactive Limb Reach**: Procedural front legs/arms that reach forward to touch the crossfader and filter knobs as the fly performs.
   * **Dopamine Aura**: Emerald shockwave ring expands on **R** (reward); crimson strobe on **X** (penalty).
   * **Camera Presets**: 1-click toggles between `Orbit View`, `Front View` (crowd view), and `DJ View` (over-the-shoulder).

3. **Streamlined Web Frontend (`src/App.tsx`)**:
   * Removed legacy file uploaders, drag-and-drop inputs, manual beatgrid audition/editor modals, and imitation demonstration panels.
   * Direct live audio selector defaulting to **★ BlackHole 2ch** with 1-click audio device refresh.
   * Real-time bridge connection status badge (`🟢 Bridge Active`).
   * Big **REWARD [R]** and **PENALTY [X]** buttons for training the fly's weights on real Spotify sets.

### Quick Commands Reference

```bash
# Start frontend dev server (runs on http://localhost:5173)
npm run dev

# Start djay Pro Python bridge (runs on ws://127.0.0.1:8766)
npm run bridge

# Run deterministic test suite
npm test

# Production build and typecheck
npm run build
```
