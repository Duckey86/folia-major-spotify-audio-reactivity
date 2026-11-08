# Official Soloist capture migration

## Baseline and migration boundary

The reference is fork main `ddd63e8c` (v0.7.25 integration). The target is
upstream stable tag `v0.7.27`, verified against GitHub's latest release on
2026-11-08. Work is on `integrate/folia-v0.7.27-official-soloist`.

The legacy `electron/soloist/manager.cjs` combines executable/key setup, process
launch, a control connection and capture lifecycle. Its `capture.cjs` starts
`native/soloist-audio-capture/main.cpp`, which captures a Windows process tree,
computes a 1024-bin spectrum and six bounded energy values, and sends JSON lines.
The bridge validates these lines and broadcasts `soloist-audio-frame`; preload
exposes a subscription. `soloistCaptureFeed.ts` expires frames after 350 ms.
The old `spotifySoloist.ts` supplies an audio-element timeline, and the provider
recognizes that element in `omni.readAudioAnalysisFrame()`. The visualizer's
existing frame loop writes motion signals and updates `externalAudioReactivity`.
Nebbia and Machi consume those signals and bounded live onset estimates, preferring
model-derived analysis when available. No raw PCM crosses IPC or is persisted.

Upstream's official manager is `electron/spotify/soloist.cjs`; its renderer adapter
is `spotifySoloistPlayback.ts`. Setup, sealed credentials, one control socket,
queue ownership and timing now belong to that implementation and the common
`externalPlayback.ts` route. A straight merge disconnects capture twice: the old
manager owns capture startup, and the visualizer requires a playing internal
audio element for both spectral signals and onset estimates. Official external
playback deliberately has no such playing element.

The integration retains the native helper, capture IPC and live onset adapter,
attaches capture to the official manager's PID, and adds provider-scoped external
analysis through Omni. There is one active playback manager and one capture
helper. The legacy manager, timeline and setup source remain dormant as a migration
reference. Final deletion is deferred until the remaining validation matrix below
is complete; no legacy manager or control connection starts with the application.

## Implemented signal path

1. `electron/spotify/soloist.cjs` owns the official process, authentication, control
   connection, playback commands and timing. Its connected process PID and expected
   executable path are passed to the retained capture bridge. Disconnection,
   replacement, exit and shutdown stop capture; reconnect starts it again.
2. `electron/soloist/capture.cjs` serializes helper replacement, ignores old helper
   output and retries helper crashes with bounded backoff. It requires a positive
   PID. Native capture checks the executable identity and retains a process handle;
   WASAPI includes that process and its children. System capture is used only with
   the existing explicit `FOLIA_SOLOIST_CAPTURE_ALL_AUDIO=1` diagnostic opt-in.
3. The existing native FFT produces six integer energy values and 1024 spectrum
   bins, each in 0–255. It now timestamps each frame and clears its FFT after a
   packet gap. The bridge validates and allowlists fields, bounds line buffers,
   adds a capture generation, and broadcasts the existing `soloist-audio-frame`
   channel. Null frames explicitly invalidate the renderer cache.
4. `soloistCaptureFeed.ts` maintains one IPC subscription, validates frames again,
   rejects pre-session and stale timestamps, and expires data after 350 ms. A
   session cutoff is advanced by real resets, never by every rejected packet.
5. The official provider exposes optional external analysis through Omni. The
   external route supplies an ownership key containing track, attempt and seek
   revision, plus its playback clock. Paused, buffering, foreign, handed-over,
   ended and seeking sessions cannot supply active frames.
6. The existing visualizer RAF writes all energy bands, power and spectrum from
   these frames. A silent internal audio element cannot overwrite the external
   clock or spectra. The live-onset adapter uses the same source and clock and
   resets when capture generation changes. Other routes retain their analyser.
7. Machi's neon, ground ripples and screen flashes and Nebbia's rain/vocal and
   vehicle response retain the fork's bounded live fallback. Upstream model-based
   analysis remains preferred; estimated events are neither stems nor stored
   model analysis. External repeat-one now seeks to zero and resumes on track end
   instead of advancing the queue as if an HTMLAudioElement handled looping.

## Files and migration disposition

The upstream merge includes the complete v0.7.27 tree. These are the integration
areas beyond that release; use `git diff v0.7.27...HEAD` for the complete fork diff.

| Area | Files / changes |
| --- | --- |
| Official process ownership | `electron/main.cjs`, `electron/spotify/soloist.cjs`, `electron/spotify/spotifyApiBridge.cjs` |
| Retained capture | `electron/soloist/capture.cjs`, `native/soloist-audio-capture/main.cpp` |
| Windows distribution | `build/beforePack.cjs`, `packaging/windows/build-soloist-capture.mjs`, `package.json`, `package-lock.json`; retained fork identity and disabled upstream executable updates |
| Analysis contract | `src/types/onlineMusic.ts`, `src/vite-env.d.ts`, `src/services/onlineMusic/omni.ts`, `externalPlayback.ts`, `spotify/spotifySoloistPlayback.ts`, `spotify/soloistCaptureFeed.ts` |
| Motion and timing | `src/services/beatFx/capturedAudioSignals.ts`, `beatFxLive.ts`, `externalAudioReactivity.ts`; `usePlaybackVisualizerBridge.ts`, `useExternalPlaybackBridge.ts` |
| Visual merge resolutions | Machi `createMachiRuntime.ts` / `engine/beatFx.ts`, Nebbia `nebbiaDrizzleRide.ts`; retain fork fallback alongside upstream changes |
| Official setup | Upstream `LoginHost.tsx`, `LoginScreen.tsx`, `spotifyProvider.ts`, `spotifyFailure.ts`; setup note updated in en, zh-CN, in and vi; Traditional Chinese remains generated |
| Preserved reference | Legacy `electron/soloist/manager.cjs`, `spotifySoloist.ts`, legacy setup/UI helpers and tests; no production startup or playback calls into the old manager/timeline |
| Test compatibility | `dev/probes/soloistSetup.probe.tsx`, `test/unit/onlineMusic/platformNamePlaces.ts` |
| New / expanded regression coverage | `test/unit/spotify/soloistCaptureLifecycle.test.ts`, `soloistCaptureFeed.test.ts`, `soloist.test.ts`; `test/unit/appleMusic/externalPlayback.test.ts`; `test/unit/playback/previewLyricClock.test.ts`, `externalPlaybackRepeat.test.ts`; `test/unit/visualizer/externalAudioReactivity.test.ts` |
| Manual diagnostics | `test/manual/soloistAudioSessions.cpp` enumerates render-session PIDs and peak meters without recording PCM |

The FFT, frequency bands, IPC channel and live visual consumers are adapted from
the reference rather than replaced wholesale. Comparison used their existing
regressions and live measurements of the integrated pipeline. A simultaneous or
recorded legacy-versus-official audible A/B comparison was not performed.

## Validation results (Windows, 2026-11-08/09)

| Check | Result |
| --- | --- |
| `npm ci` | Passed. Existing lockfile audit reports 33 vulnerabilities (3 low, 19 moderate, 11 high); no unrelated dependency upgrades applied. |
| `npm run typecheck` | Passed after the repeat-one correction. |
| `npm run test:unit` | 14,692 passed, 9 skipped, 1 failed; 1,165 files passed, 2 skipped, 1 failed. The remaining failure is `modSignature.test.ts:139`: Windows denies creating its test symlink (`EPERM`). The test and product signature logic were not weakened. |
| Focused capture / transport / visuals | 83 tests in 6 files passed, including repeat-one. Other official Soloist, architecture and locale tests passed in the full run. |
| Architecture timeout in earlier run | Passed on isolated rerun and in the final full run. |
| `npm run build` | Passed, exit 0. Existing chunk-size / dynamic-import warnings remain. |
| Native helper | MSVC 2022 + Windows SDK build passed. |
| Windows packaging | NSIS installer generated; unpacked resources contain `soloist-capture/folia-soloist-capture.exe`. Final installer filename: `Folia-Soloist-Setup-0.7.27-soloist.1.exe`. |
| Review | Two independent rounds reviewed lifecycle, IPC bounds, security and renderer ownership. A confirmed delayed-frame starvation finding was fixed and regression-tested. The reviewer reported no other confirmed medium/high findings. The later repeat-one correction received self-review, five new tests and live boundary validation, without a third independent round. |

### Actual audio and visual evidence

Testing used an isolated Electron profile, the user's existing encrypted Soloist
configuration and pairing, and official Soloist 1.3.10.13. The original application
profile was not edited. The user confirmed audible playback. No system-audio
fallback was enabled. A render-session probe identified the official Soloist PID
as the process producing sound; process-specific capture then returned real
nonzero samples and spectra.

An initial run had audible sound but zero captured energy. That observation is
retained: it was not reproduced after restarting the isolated process and checking
the render session, and its precise initial cause was not established. Later
measurements validate working capture, not a diagnosis of that initial incident.

| Runtime scenario | Observed result |
| --- | --- |
| Normal playback | 1024-bin spectrum; independently changing bass, vocal and treble. Example bass maximum 115 in a three-second sample, and 188 in an earlier restart sample. |
| Live onset fallback | Kick sequence advanced 28 → 39 during six seconds; bounded hit history stayed at 32. |
| Machi | Real captured events produced neon gain 1.305, ripple response 0.444 and screen-flash response 0.650 through the actual effect functions. Rendered Machi inspected by screenshot. |
| Nebbia | Mounted animation registered 13 audio-driven vehicle triggers over seven seconds. Rain consumes the changing vocal band through the retained `VocalEnergy` path. Rendered Nebbia inspected by screenshot. |
| Pause | Power and bass 0, spectrum length 0, no live impulses; external clock remained exactly 149.914 seconds across another 500 ms. |
| Resume / seek | Capture returned; seek changed ownership revision. External time 38.41655 vs lyric motion time 38.41365; bass maximum 149. |
| Automatic next | Two-track queue moved from Shape of You to Never Gonna Give You Up, new track ownership key and progressing external clock. |
| Previous / next | Application command-palette actions moved between those tracks. |
| Repeat-one | After the correction, 211-second seek reached the end, briefly buffered, then resumed at zero with revision `:1` → `:2`, bass 146. |
| Shuffle | Normal shuffle command executed; captures did not acquire a second owner. A long shuffled playback run was not performed. |
| Standard / Soloist switch | Standard mode cleared live-onset ownership; switching back restored the external source. Authenticated standard Spotify streaming was not tested in the isolated profile. |
| Local music | Built-in local test song played on the web route with 1024-bin normal analyser, power 69.81, null external source and no external impulses. |
| Soloist restart | Earlier live restart cleared signals, changed capture generation 1 → 2, and resumed nonzero bass (maximum 188). Automated tests cover helper replacement, stale output and crash retry. |
| Renderer reload | Did not keep stale spectra; one reload restored a paused/web route rather than automatically adopting audible playback. Re-establishing the official route recovered capture. Seamless window/reload handoff remains unverified. |
| App shutdown | Isolated app closed; no Soloist or capture-helper process remained. |

### Remaining validation and cleanup gate

The PR remains a draft. Core process capture and genuine reactive visuals are
verified, but the full acceptance matrix is not complete. Before merging and
deleting dormant legacy playback source, complete these checks:

- Run the suite in an environment that permits its symlink fixture.
- Verify packaged installation and playback, wallpaper/focus modes, full window
  recreation and seamless renderer handoff; only development Electron playback
  and the built installer/resource layout were checked here.
- Exercise authenticated standard Spotify and another online provider, HiFi
  playback, extended shuffled/repeat-all queues and prolonged disconnect/reconnect.
  Automated isolation regressions and local playback passed; these live cases are
  not claimed as verified.
- Compare the remaining UI modes with the legacy build, then remove the dormant
  manager/timeline/setup code and update their reference tests in a separate
  cleanup commit. The active implementation already has only one playback owner.

Existing legacy setup files are not silently imported into the official settings
store. Existing users should select their executable and save the key through the
official Soloist setup once. The test profile reused encrypted values locally;
no test profile or credentials are part of the PR.

## Windows manual validation

1. Build with `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run build`
   and `npm run build:electron`. Building the helper requires Visual Studio 2022
   C++ tools, CMake and a Windows SDK supporting process-loopback capture.
2. Check the installer and `release/win-unpacked/resources/soloist-capture/`
   helper. Install using an isolated test profile before replacing a personal build.
3. Use official Spotify → Soloist setup, select the official executable, save the
   key and pair it in Spotify. Do not put a key in commands, logs or bug reports.
4. Play a known track. Confirm one official Soloist process and one helper; keep
   `FOLIA_SOLOIST_CAPTURE_ALL_AUDIO` unset. If capture is silent, inspect endpoint
   sessions with `test/manual/soloistAudioSessions.cpp` and the numeric capture logs.
5. Enable music-driven effects and test Machi neon/ripples/flashes and Nebbia
   rain/vocal response/bumps. Confirm transients and changing bands while the
   external clock advances; a moving idle background alone is not evidence.
6. Pause, seek both directions, resume, change tracks, repeat and shuffle. Verify
   old impulses disappear and resumed capture receives a fresh session identity.
7. Switch playback method/provider/local/HiFi, recreate the window, try focus and
   wallpaper modes, restart Soloist and interrupt its connection. Confirm source
   isolation and recovery without multiple control connections or helpers.
8. Quit Folia and verify both child processes exit. Report the application version,
   Windows version, output endpoint and sanitized lifecycle diagnostics for failures.

## Performance and security

The helper retains the existing approximately 20 Hz FFT snapshots. Renderer
analysis reuses the existing playback RAF and MotionValues without React state
updates or another polling/animation loop. Spectrum conversion is cached by frame
identity; queues, onset history, line size and partial output are bounded. This is
an architectural check, not a controlled CPU/memory benchmark.

Raw PCM stays inside native process memory. Only validated energy/spectrum fields
and timestamps cross IPC; diagnostic logs contain counts and a peak, not samples.
The native helper validates the supplied executable and monitors its process
handle. The app keeps context isolation and the existing preload subscription.
Official Soloist keeps its encrypted credential store and control ownership; its
upstream command-line key limitation still applies (see the setup documentation).
The installer includes the capture helper, not Spotify's separately downloaded
Soloist executable. No credentials, user profile, captured audio or model output
are committed.
