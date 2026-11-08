'use strict';
// Local-only *analysis* stream. The helper captures Soloist's decoded samples,
// calculates spectral features and publishes these values; no PCM is saved or forwarded.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const SIGNALS = ['power', 'bass', 'lowMid', 'mid', 'vocal', 'treble'];

function parseCaptureFrame(line) {
  if (typeof line !== 'string' || line.length > 8192) return null;
  let frame;
  try { frame = JSON.parse(line); } catch { return null; }
  if (!frame || !Array.isArray(frame.spectrum) || frame.spectrum.length !== 1024) return null;
  if (SIGNALS.some(key => !Number.isInteger(frame[key]) || frame[key] < 0 || frame[key] > 255)) return null;
  if (frame.spectrum.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  if (frame.capturedAt !== undefined && (!Number.isSafeInteger(frame.capturedAt)
      || Date.now() - frame.capturedAt < -100 || Date.now() - frame.capturedAt >= 350)) return null;
  // Allowlist the payload: unknown fields (including PCM) never cross IPC.
  return Object.fromEntries([...SIGNALS.map(key => [key, frame[key]]), ['spectrum', frame.spectrum],
    ...(frame.capturedAt === undefined ? [] : [['capturedAt', frame.capturedAt]])]);
}

function createSoloistCaptureBridge({ app, BrowserWindow, processEnv = process.env,
                                     files = fs, startProcess = spawn, logger = console,
                                     platform = process.platform, resourcesPath = process.resourcesPath }) {
  let child = null;
  let output = '';
  let targetPid = 0;
  let runningPid = 0;
  let targetExecutable = null;
  let retry = null;
  let retryMs = 1000;
  let generation = 0;
  const broadcast = frame => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('soloist-audio-frame', frame);
    }
  };
  const scheduleRetry = () => {
    if (!targetPid || retry) return;
    retry = setTimeout(() => { retry = null; start(targetPid, targetExecutable); }, retryMs);
    retry.unref?.();
    retryMs = Math.min(30000, retryMs * 2);
  };
  const helper = () => {
    const fromEnv = processEnv.FOLIA_SOLOIST_CAPTURE_EXE;
    const candidates = [
      fromEnv && path.isAbsolute(fromEnv) ? fromEnv : null,
      app.isPackaged ? path.join(resourcesPath, 'soloist-capture', 'folia-soloist-capture.exe') : null,
      path.join(app.getAppPath(), 'build', 'soloist-capture', 'folia-soloist-capture.exe'),
    ];
    return candidates.find(filename => filename && files.existsSync(filename));
  };
  function start(pid = 0, executable = null) {
    if (platform !== 'win32' || processEnv.FOLIA_SOLOIST_CAPTURE === '0') return false;
    // The official owner must identify its process. Never select an unrelated soloist.exe by name.
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return false;
    targetPid = pid;
    targetExecutable = executable;
    if (child) {
      if (runningPid !== pid) { runningPid = 0; broadcast(null); child.kill(); }
      return true; // The old helper's close event starts the replacement: no overlap.
    }
    clearTimeout(retry);
    retry = null;
    const exe = helper();
    if (!exe) {
      logger.warn('[Soloist capture] helper not built; music playback remains available without audio-reactive effects');
      return false;
    }
    output = '';
    // Explicit opt-in fallback: process-loopback INCLUDE currently produces
    // silence for Soloist on some Windows audio paths. In this mode, the native
    // helper uses --probe-all and sees other applications' sound as well.
    // Keep it OFF by default to avoid responding to unrelated private audio.
    const allAudio = processEnv.FOLIA_SOLOIST_CAPTURE_ALL_AUDIO === '1';
    if (allAudio) {
      logger.warn('[Soloist capture] SYSTEM-AUDIO fallback enabled: other applications can influence the visualizer. Only spectral data crosses IPC; no PCM is saved.');
    }
    const captureArg = allAudio ? '--probe-all' : String(pid || 0);
    let running;
    try {
      running = startProcess(exe, [captureArg, ...(executable && !allAudio ? [executable] : [])], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
      });
    } catch (error) {
      logger.warn('[Soloist capture] helper launch failed', error);
      scheduleRetry();
      return false;
    }
    child = running;
    runningPid = pid;
    const session = ++generation;
    broadcast(null);
    running.stdout?.setEncoding('utf8');
    running.stdout?.on('data', data => {
      if (child !== running || runningPid !== pid || targetPid !== pid) return;
      output += data;
      // A partial/unbounded line must never grow forever.
      if (output.length > 65536) { output = ''; return; }
      for (let index; (index = output.indexOf('\n')) !== -1;) {
        const line = output.slice(0, index).trim();
        output = output.slice(index + 1);
        const frame = parseCaptureFrame(line);
        if (!frame) continue;
        retryMs = 1000;
        broadcast({ ...frame, capturedAt: frame.capturedAt ?? Date.now(), captureSession: session });
      }
    });
    running.stderr?.setEncoding('utf8');
    running.stderr?.on('data', data => logger.info(`[Soloist capture] ${String(data).trim().slice(0, 400)}`));
    running.once('error', error => {
      logger.warn('[Soloist capture] helper launch failed', error);
    });
    running.once('exit', code => {
      logger.info(`[Soloist capture] helper exited (${code})`);
    });
    running.once('close', () => {
      if (child !== running) return;
      child = null;
      runningPid = 0;
      output = '';
      broadcast(null);
      scheduleRetry();
    });
    return true;
  }
  function stop() {
    targetPid = 0;
    runningPid = 0;
    clearTimeout(retry);
    retry = null;
    output = '';
    broadcast(null);
    if (child) {
      const running = child;
      running.kill();
    }
  }
  return { start, stop, helper };
}
module.exports = { createSoloistCaptureBridge, parseCaptureFrame };
