# DJ Lesson Builder

A local, free pipeline that turns an imported DJ video/audio clip into a versioned, schema-validated "lesson" folder that `snn_dj/` can load. It never uploads media to an external AI service. This is new, additive functionality: it does not change the existing browser mixer, the SNN training loop, or the imported-track analyzer in `analysis/`.

## Where the implementation lives

| Path | Responsibility |
| --- | --- |
| `lesson_builder/importer.py` | Permission-gated local/URL import, ffmpeg/ffprobe probing, safe yt-dlp subprocess calls, sanitized provenance |
| `lesson_builder/audio_prep.py` | Reference decoding, the stereo 22,050 Hz analysis copy, silence/clipping/abrupt-edit/speech-heavy heuristics |
| `lesson_builder/musical_analysis.py` | BPM/beat reuse of `analysis.analyzer.estimate_rhythm`, chroma/key candidates, RMS/spectral/band time series, suggested transition regions |
| `lesson_builder/schema.py` | Versioned lesson contract, readiness computation, action-timeline validation, train/eval leakage guard |
| `lesson_builder/export.py` | Builds and atomically publishes a versioned lesson folder |
| `lesson_builder/server.py` | Loopback-only HTTP API (port 8766) behind Vite's `/api/lesson-builder` proxy |
| `lesson_builder/cli.py` | `python -m lesson_builder.cli` for scripted/headless builds |
| `snn_dj/lesson_loader.py` | Loads and validates exported lessons for the SNN side; keeps reference-only and paired-action lessons as distinct types |
| `src/graphics/LessonBuilderPanel.tsx` | The editor UI (import, waveform review, beat-grid correction, technique/notes, save) |
| `src/audio/LessonBuilderClient.ts`, `src/audio/LessonBuilder.ts` | Fetch wrapper and response type guard for the panel |
| `tests/test_lesson_builder.py`, `tests/test_lesson_loader.py` | Automated coverage (see Verification below) |

## Setup

Reuses the existing `analysis/` Python environment (librosa, soundfile, numpy) plus two system binaries:

```sh
.venv/bin/pip install -r analysis/requirements.lock.txt   # if not already installed
brew install ffmpeg yt-dlp                                # or your platform's equivalent
```

`ffmpeg`/`ffprobe` decode and probe media; `yt-dlp` performs best-effort URL import. Both are called as subprocesses with argument lists (never a shell string) — no Python bindings are installed for them, so there is nothing to add to `lesson_builder/requirements.txt` beyond a comment documenting this. If either binary is missing, every entry point raises a `SetupError` naming exactly what to install; nothing downloads or vendors a binary on your behalf.

Run the backend and the app in two terminals:

```sh
npm run lesson-builder    # .venv/bin/python -m lesson_builder.server, loopback port 8766
npm run dev                # Vite proxies /api/lesson-builder -> 127.0.0.1:8766
```

Open the app, click **Lesson Builder** in the top controls.

## Import

- Local files: any container/codec ffmpeg can probe (MP4, MOV, WebM, WAV, MP3, FLAC, …), up to 500 MiB and 10 minutes.
- Public URLs: best-effort via `yt-dlp`, bounded by `--max-filesize 500M`, a 30s socket timeout, and `--ignore-config`/no cookies or credentials — Neuro-DJ never bypasses login walls, age gates, private-account restrictions, or DRM. A failed or unsupported URL always returns an actionable message telling you to download the clip yourself and use local-file import.
- Both paths require an explicit "I own or have permission to use this material" confirmation *before* any file I/O or subprocess call — this is enforced in `importer.py`, not just in the UI.
- Provenance is preserved: source URL (with tracking/auth query parameters stripped), creator/uploader, upload date, platform, raw-file SHA-256, ffmpeg/ffprobe/yt-dlp versions, and the sanitized extraction command.

## Audio preparation

- `reference.wav` is the **unprocessed reference**: the first audio stream decoded losslessly with `ffmpeg`, no trimming, resampling, or channel remixing. It is 24-bit PCM (`pcm_s24le`) — chosen over a higher-precision float format specifically because it is universally decodable by browsers (`<audio>` elements and Web Audio's `decodeAudioData` both reject 64-bit float WAV outright; this was caught by manager testing against a real browser, not by source review or unit tests, and is exactly why the editor's own audio preview and waveform now work).
- A separate stereo 22,050 Hz **analysis copy** is derived from the reference, with every transformation (decode, channel remix, resample, segment trim) recorded as an ordered list in `lesson.json`'s `audio.transformations`.
- Silence, clipping, abrupt-edit, and speech-heavy regions are heuristic, confidence-scored, and exposed for review — never silently trimmed or discarded.

## Musical analysis

For the selected segment: BPM/beat timing (reusing `analysis.analyzer.estimate_rhythm`, so there is exactly one beat tracker in the repo), a ranked list of 24 major/minor key candidates (Krumhansl–Schmuckler correlation — never collapsed to one forced key, since a mixed recording can contain simultaneous keys/tempos), RMS/spectral-flux/band-energy time series, and heuristic "suggested transition regions" that are always labeled `suggested` end-to-end (schema, API, UI) — never presented as a detected transition, a downbeat, or a musical phrase.

## Teaching targets and schema

Every lesson has a `readiness` computed from its contents, never set directly:

- **`reference_only`** — finished mix, analysis, and human annotations only. No verified DJ actions.
- **`paired_sources`** — adds separately supplied `source_A`/`source_B` originals plus a named, timestamped human review of their alignment (`humanAnnotations.reviewedSourceAlignment`).
- **`paired_actions`** — adds a validated `observedControllerActions` timeline. Every action entry must declare `source: "controller_log"` or `"authored"`; anything else, an out-of-bounds timestamp, or a value shape other than the two bounded rate increments `snn_dj.mixer.OfflineMixer` actually accepts is rejected by name, not silently coerced. Nothing in this pipeline infers crossfader/EQ/cue/effect values from mixed audio or from video hand movement — there is no pose-estimation or vision code here at all.

The schema keeps four namespaces distinct and never lets one populate another: `measured` (direct signal measurements), `heuristicEstimates` (BPM/beat/chroma/key/region detectors), `humanAnnotations` (only what a person typed or reviewed in the editor), and `observedControllerActions` (only genuine logs or explicit authored targets). `source_A`/`source_B`, when present, must be `kind: "user_supplied_original"` — this pipeline does not implement source separation and cannot reconstruct original decks from a mixed recording.

`performance_group_id` is derived from the source video's platform+ID (URL imports) or the raw file hash (local imports), so multiple clips cut from the same performance can be grouped and kept out of opposite sides of a train/eval split; `lesson_builder.schema.assert_no_group_leakage` / `snn_dj.lesson_loader.assert_no_group_leakage` enforce this.

## Export

`export_lesson` validates then atomically publishes a versioned folder (`<lessonId>-v1/`) containing `lesson.json`, `reference.wav`, `features.npz`, `annotations.json`, optionally `source_A.wav`/`source_B.wav`/`actions.json`, and a generated `summary.md`. `lesson.json` documents units, sample rates, the timestamp origin (always seconds from the original file's start), the schema/analysis-version strings, and how the source/segment/action timelines relate (`actions[].timestamp` is segment-relative; everything else is original-file-relative).

## SNN integration (`snn_dj/lesson_loader.py`)

`load_lesson(folder)` returns a `ReferenceLesson`, `PairedSourcesLesson`, or `PairedActionsLesson` — distinct types, so a reference-only lesson's absent actions can never be mistaken for a no-op action by calling code. **This loader validates and loads data; it does not add an imitation-learning algorithm.** The existing reward-modulated STDP loop in `snn_dj/learning.py` trains from live rendered consequences of its own actions — it does not, and after this change still does not, learn by imitating a finished recording. Using a `paired_actions` lesson for supervised/behavior-cloning training needs a training algorithm this change does not implement; `validate_alignment_and_actions` only confirms the actions are well-formed and dimensionally compatible with the current two-action mixer, and reports any unsupported action type by name.

## Verification

Automated (no network, no real media, synthetic fixtures generated with `ffmpeg -f lavfi` and numpy/soundfile — matching `tests/test_analysis.py`'s existing style):

```sh
npm run test:lesson          # .venv,  10 tests: import, extraction/trim timing, silence/clipping,
                              #   schema round-trip, invalid action rejection, reference-vs-paired-action
                              #   distinction, leakage rejection
npm run test:lesson-loader   # .venv-snn, 6 tests: reference-only vs paired-action loading, unsupported
                              #   action reporting, tampered-readiness rejection, feature-array corruption
```

Regression (both still pass unchanged): `npm run test:analysis`, `npm run test:snn`.

One generated example: `examples/lessons/synthetic-chord-pulses-v1/` (regenerate with `npm run lesson:example`) — a 3-second original synthetic fixture, `reference_only`, with no invented tempo (too short for the rhythm tracker's evidence gate) and explicit warnings saying so.

**Manual checklist for URL imports** (deliberately excluded from automated tests):

1. With permission, try one clip each from YouTube, TikTok, and Instagram. Confirm the imported lesson's `provenance.platform`/`creator`/`uploadDate` are populated and `performance_group_id` is stable if you re-import the same URL.
2. Try a private, age-gated, or region-restricted URL and confirm the failure message tells you to download the clip yourself and use local-file import — never that it silently succeeded via a workaround.
3. Confirm the reference audio plays and the waveform decodes in the editor (this is what actually exercises the browser's WAV codec/Range-request support end-to-end).
4. Inspect `lesson.json`'s `provenance.extractionCommand`/URL fields for anything resembling a token, cookie, or credential; there should be none.
5. Cancel an in-progress import and confirm the temporary directory is cleaned up (`lesson-import-*` under the OS temp dir should not linger).

## What is measured vs. inferred vs. reviewed vs. still unsupported

- **Measured**: RMS, spectral flux, band energy, sample rates, durations, file hashes — direct signal/file measurements.
- **Inferred (heuristic, confidence-scored)**: BPM/beat grid, onsets, chroma-derived key candidates, suggested transition regions, silence/clipping/abrupt-edit/speech-heavy flags. All are exposed for review, never auto-applied as fact.
- **Human-reviewed**: whatever a person actually edits and saves in the panel — reviewed transition segment, reviewed beat grid, reviewed source alignment, technique label, notes.
- **Still unsupported / explicitly out of scope**: an imitation/behavior-cloning training algorithm for `paired_actions` lessons (loading and validation only); playback of the original source video (only the extracted reference audio is retained/served); source separation of a mixed recording into its original decks; any inference of exact controller values from audio or video.
