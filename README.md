# Neuro-DJ

A connectome-inspired fruit fly running a live, two-deck house mixer. It listens to the master output, updates a small sparse neural circuit, and moves the controls you hear and see.

The [master feature roadmap](docs/MASTER_ROADMAP.md) separates the target system from current functionality. Personal teaching notes live in ignored local files; implementation explanations remain in source comments.

## Start listening

Use Node 22.12+ (or a supported newer version), then:

```sh
npm install
npm run dev
```

Start with **Deep / Tech House** and leave **Guided Set** enabled. The original synthesized decks share a tempo and downbeat. The fly holds a groove for eight bars, blends for eight, and repeats in the opposite direction. Its neural outputs shape the blend curve, color the outgoing deck, and can select a short roll before the drop. Independent bass shelves keep one deck's low end during the overlap.

The other presets provide acid, French house, and melodic/Afro-inspired material. These are original procedural loops, not recordings by the artists who inspired their synthesis techniques.

## Train by listening

1. Open **Show Learning**, freeze **Learning Loop**, and listen to a full minute. Record a baseline if you want to compare later.
2. Choose **Practice 5**: it plays and trains on the actual master audio for up to about 80 seconds, then freezes the weights. **Practice 20** runs for up to about 320 seconds. A partially completed pass shortens those times.
3. During training, press **R** immediately after a move you like; press **X** after a bad move. Space starts/stops playback. Short, specific feedback is more useful than repeatedly rewarding the whole set.
4. Once weights freeze, stop/start the same preset and listen again. Compare the transitions, retained kick energy, and restraint of effects. Save the brain if you prefer it.
5. Repeat on another preset before deciding that the behavior generalizes.

**Save Brain** stores the upstream wiring and learned weights together in this browser. Version 2 checkpoints intentionally reject older weight-only saves because their wiring could not be reconstructed. **Preset** loads handcrafted starting weights; it is not a trained expert. Reset clears the learning history.

Keep the page visible while performing or recording: the control loop currently runs with the display animation. Training is experimental; longer practice does not guarantee better music. The reward plot is a diagnostic, not a convergence certificate.

## Learn from demonstrations (experimental)

Open **Learn from a demonstration** in the right-hand tuning panel. Select an original built-in preset, enable **Guided Set**, freeze **Learning Loop**, and start playback. Record two separate takes of 32–64 seconds, including a full blend in each. The first take supplies teaching targets; the second is reserved for evaluation. Pausing, changing sources, enabling learning, or a frame gap over 100 ms discards an active take. Keep this page visible; overloaded devices may be unable to capture an uninterrupted take.

**Train candidate** runs 20 supervised epochs on an isolated copy of the current brain. It learns from four audio bands plus the existing delayed memory, targeting the demonstrated crossfader, filter, and stutter commands. Only KC→DN weights change; the random upstream wiring and sparse activation rule stay fixed. This is supervised readout fitting, **not** the three-factor dopamine rule used by live practice. No cloud model, audio download, or video processing is involved.

The table reports duration-weighted mean squared error for raw motor predictions on take 2, with guidance, reinforcement, and exploration disabled. A candidate must improve the average error by at least 1% without increasing any individual error by more than 0.0001 to enable **Apply candidate & freeze**. These are engineering thresholds, not perceptual standards. Evaluation never selects an epoch or updates weights. The synthetic regression tests verify learnable mappings across three wiring seeds; they do not establish musical improvement.

Save your baseline with **Save Brain** first. Applying a candidate stops playback, disables Guided Set, and freezes learning for an unassisted listening comparison; it does not overwrite the saved checkpoint. Reload that checkpoint to compare the baseline. If weights or sparsity changed after training started, application is rejected. Takes remain in memory only and are cleared on page reload.

**Limits:** the teacher is our authored director, not a professional DJ. Phrase position and separate deck features are absent from the neural inputs, so some demonstrations cannot be learned. The candidate hears recorded teacher audio during evaluation; its own actions will change that audio in live use. Lower imitation error therefore does not prove better sounding mixes. Two takes of one preset test repeatability, not generalization. Per-deck timing inputs and actual listening comparisons remain necessary next steps.

## Capture a clip

Click **Record WAV**, let the set play, then **Stop capture → Download WAV**. Capture taps the stereo master after compression and volume, without replacing the feedback or speaker connections. It exports 16-bit PCM at the audio context's sample rate. Capture automatically finishes at two minutes to bound browser memory. Stopping playback also finishes capture. Recording requires an AudioWorklet-capable browser and localhost or HTTPS.

## What the brain does

The model has 8 sensory channels, 64 Kenyon cells (4 active by default), and 3 descending outputs. The upstream sparse wiring stays fixed during learning. Only KC→DN weights adapt through reward-modulated eligibility traces. Postsynaptic activity is centered, updates account for elapsed time, and acoustic reward is associated with the preceding applied action. Checkpoints preserve the complete wiring.

**Guided Set provides authored musical structure.** Phrasing, transition completion, bass protection, and the roll window are assistance. They were not learned from recordings. **Unassisted** exposes direct smoothed neural control, while retaining bass protection. This is a reduced, biologically inspired model; the repository does not load a full measured FlyWire connectome.

## Imported-track analysis

### Vercel deployment status

`vercel.json` selects the Vite build and publishes `dist`. Use Node 22.12+ in the build environment. Platform-specific Rolldown bindings are installed through Rolldown's optional dependencies so Linux hosting does not require a Mac-only package. `.vercelignore` excludes local environments, caches, and personal teaching notes from deployment uploads.

The budget is zero paid services; Vercel Hobby is the target for this personal, non-commercial project within its free quotas. The deployed frontend supports the existing browser mixer and synthesized presets, but imported-track analysis currently requires the local Python service below. Browser analysis and a searchable, permission-checked free catalog are the next steps, not deployed features. See the roadmap for these constraints.

Set up the local Python analyzer once (tested with Python 3.11):

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install -r analysis/requirements.lock.txt
```

Run `npm run analysis` in one terminal and `npm run dev` in another. The analyzer listens on loopback port 8765; Vite proxies `/api/analysis` to it. Audio stays on your machine. The Vite build does not include Python; the planned free hosted version will replace this service with browser analysis.

Upload a track to either deck. It becomes playable immediately after decoding, while librosa estimates BPM, beat/onset timestamps, a heuristic confidence score, and an RMS energy curve. **Grid A / Grid B** opens a review dialog: adjust BPM, try half/double tempo, move the beat anchor, and audition twelve seconds with clicks. Check the beginning, middle, and end for drift, then **Apply reviewed grid**. Opening the editor stops live playback; finish recording before opening it.

Analysis is cached in `.cache/track-analysis` by file contents and algorithm/configuration version. Renaming a file reuses its metadata. Reviewed corrections are stored separately in this browser/origin and restored when you load the same file again. If the server is unavailable, playback remains available and **Retry A/B** retries analysis after you start it.

Limits: uploads up to 100 MB, duration up to ten minutes, and up to 40 million decoded samples across channels. SoundFile codec support may differ from your browser; WAV and MP3 are the primary intended inputs. RMS/dBFS is not LUFS. Confidence is a heuristic, not a calibrated accuracy probability.

**Beat grids do not establish downbeats or phrases.** Those labels, key, and vocal regions remain unknown, and imported tracks disable the preset-only phrase director. Applying a grid does not change playback tempo, align sources, or time-stretch audio. Use matched, pre-aligned material for clean mixes until those layers are implemented.

## Verification

```sh
npm test
npm run test:analysis
npm run build
```

The deterministic tests cover timing, completed/reversing blends, bass protection, dropout penalties, smoothing, plasticity isolation, frozen weights, checkpoint integrity, and WAV encoding. The TypeScript tests do not require an additional test dependency. Python tests use the analysis environment and cover known-tempo pulses, anti-phase stereo, silence, malformed audio, and cache reuse.

For upload/editor integration checks, generate local fixtures and run the browser suite with both servers running:

```sh
.venv/bin/python scripts/make-analysis-fixtures.py
npm run test:analysis:browser
```

As with the other browser suite, this requires Playwright (or `NEURO_DJ_PLAYWRIGHT_MODULE` pointing to an existing installation). Screenshots, fixtures, and reports stay under ignored `.cache/`. The suite checks audition, correction persistence, renamed-file caching, stale responses, server failures/retry, and preset reset.

For a real DSP comparison, run the dev server, open `/test-audio.html`, and execute the command shown there in the browser console. It renders three seeded 62-second sets through Web Audio and FFT: frozen before, live practice, frozen after. It checks clipping, unintended quiet windows, and control jumps, and reports reward changes without requiring an upward result.

A Playwright installation can also run `npm run test:browser`. Set `NEURO_DJ_URL` if the server is not on port 5173; `NEURO_DJ_PLAYWRIGHT_MODULE` can point to an existing Playwright module. This suite checks the real interface and recording, then writes `docs/audio-evaluation.json`. That report represents one preset and seed, not a perceptual study.

The current local build succeeds with a bundle-size warning. The inspected installation's lint command is blocked by a missing Oxlint native binding; a complete dependency installation is needed to run it.

## Sharing the project

A fair description is: “A connectome-inspired fruit fly DJ with dopamine learning, real audio feedback, and assisted musical phrasing.” Use Guided Set for your first clip. A reference DJ set, a specific transition timestamp, and a few tempo-matched tracks will help guide the next iteration toward your taste.
