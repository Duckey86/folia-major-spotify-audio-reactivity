import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercises the actual capture bridge with process/IPC boundaries replaced by observable fakes.
const require = createRequire(import.meta.url);
const { createSoloistCaptureBridge, parseCaptureFrame } = require('../../../electron/soloist/capture.cjs');
const sample = () => ({ power: 80, bass: 200, lowMid: 100, mid: 60, vocal: 120, treble: 30, spectrum: Array(1024).fill(40) });
const setup = (env = {}) => {
    const runs: any[] = [];
    const send = vi.fn();
    const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => {
        const proc: any = new EventEmitter();
        proc.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
        proc.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
        proc.kill = vi.fn();
        runs.push(proc);
        return proc;
    });
    const bridge = createSoloistCaptureBridge({
        app: { isPackaged: true, getAppPath: () => 'C:\\app' }, resourcesPath: 'C:\\installed\\resources',
        BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }] },
        processEnv: env, files: { existsSync: () => true }, startProcess: spawn, platform: 'win32',
        logger: { info: vi.fn(), warn: vi.fn() },
    });
    return { bridge, runs, spawn, send };
};
afterEach(() => vi.useRealTimers());

describe('native capture boundary', () => {
    it('accepts only bounded byte spectra and strips unknown fields', () => {
        expect(parseCaptureFrame(JSON.stringify({ ...sample(), pcm: [1, 2] }))).toEqual(sample());
        for (const value of [null, {}, { ...sample(), bass: -1 }, { ...sample(), power: 256 },
            { ...sample(), mid: 1.5 }, { ...sample(), spectrum: [1] }, { ...sample(), spectrum: Array(1024).fill('4') }]) {
            expect(parseCaptureFrame(JSON.stringify(value))).toBeNull();
        }
        expect(parseCaptureFrame('x'.repeat(8193))).toBeNull();
        expect(parseCaptureFrame('{')).toBeNull();
    });

    it('discovers the installed helper and never captures system audio without opt-in', () => {
        const { bridge, spawn } = setup();
        expect(bridge.helper()).toBe(path.join('C:\\installed\\resources', 'soloist-capture', 'folia-soloist-capture.exe'));
        expect(bridge.start(0)).toBe(false);
        bridge.start(123, 'C:\\Soloist\\soloist.exe');
        bridge.start(123, 'C:\\Soloist\\soloist.exe');
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0][1]).toEqual(['123', 'C:\\Soloist\\soloist.exe']);
        bridge.stop();
        const all = setup({ FOLIA_SOLOIST_CAPTURE_ALL_AUDIO: '1' });
        all.bridge.start(123);
        expect(all.spawn.mock.calls[0][1]).toEqual(['--probe-all']);
        all.bridge.stop();
    });

    it('serializes PID replacement, drops old output, retries crashes and cancels retries on stop', () => {
        vi.useFakeTimers();
        const { bridge, runs, spawn, send } = setup();
        bridge.start(123);
        runs[0].stdout.emit('data', JSON.stringify(sample()) + '\n');
        expect(send).toHaveBeenLastCalledWith('soloist-audio-frame', expect.objectContaining({ bass: 200, captureSession: 1 }));
        bridge.start(456);
        expect(runs[0].kill).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        runs[0].stdout.emit('data', JSON.stringify(sample()) + '\n');
        expect(send).toHaveBeenLastCalledWith('soloist-audio-frame', null);
        runs[0].emit('close');
        vi.advanceTimersByTime(1000);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(spawn.mock.calls[1][1]).toEqual(['456']);
        runs[1].stdout.emit('data', JSON.stringify(sample()) + '\n');
        expect(send).toHaveBeenLastCalledWith('soloist-audio-frame', expect.objectContaining({ captureSession: 2 }));
        runs[1].emit('close');
        vi.advanceTimersByTime(1000);
        expect(spawn).toHaveBeenCalledTimes(3);
        bridge.stop();
        runs[2].emit('close');
        vi.advanceTimersByTime(60000);
        expect(spawn).toHaveBeenCalledTimes(3);
    });

    it('bounds partial output and resumes only with complete valid lines', () => {
        const { bridge, runs, send } = setup();
        bridge.start(123);
        const line = JSON.stringify(sample());
        runs[0].stdout.emit('data', 'x'.repeat(65537));
        runs[0].stdout.emit('data', line.slice(0, 50));
        expect(send).toHaveBeenLastCalledWith('soloist-audio-frame', null);
        runs[0].stdout.emit('data', line.slice(50) + '\n');
        expect(send).toHaveBeenLastCalledWith('soloist-audio-frame', expect.objectContaining({ bass: 200 }));
        bridge.stop();
    });
});
