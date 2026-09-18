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

## Neuro-DJ System Architecture & Current State

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