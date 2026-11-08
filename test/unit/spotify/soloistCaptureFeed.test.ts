import { afterEach, describe, expect, it, vi } from 'vitest';
import { spotifyProvider } from '../../../src/services/onlineMusic/spotify/spotifyProvider';
import * as timeline from '../../../src/services/onlineMusic/spotify/spotifySoloist';
import type { ProviderAudioAnalysisFrame } from '../../../src/types/onlineMusic';
import { isSoloistCaptureFrame, latestSoloistCaptureFrame, resetSoloistCaptureFrame } from '../../../src/services/onlineMusic/spotify/soloistCaptureFeed';

// Verifies external analysis ownership, IPC subscription and stale-frame expiry through the adapter.

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Soloist audio analysis', () => {
    it('rejects malformed spectra and delayed IPC frames', () => {
        const valid = { power: 20, bass: 30, lowMid: 40, mid: 50, vocal: 60, treble: 70, spectrum: Array(1024).fill(8) };
        expect(isSoloistCaptureFrame(valid)).toBe(true);
        for (const value of [null, {}, { ...valid, bass: NaN }, { ...valid, vocal: 256 },
            { ...valid, spectrum: [1] }, { ...valid, captureSession: -1 }, { ...valid, capturedAt: Date.now() - 400 }]) {
            expect(isSoloistCaptureFrame(value)).toBe(false);
        }
    });
    it('uses capture only for its timeline and keeps expired capture distinct from native audio', () => {
        const externalAudio = {} as HTMLAudioElement;
        const nativeAudio = {} as HTMLAudioElement;
        vi.spyOn(timeline, 'isSoloistTimelineAudio').mockImplementation(audio => audio === externalAudio);
        let receive!: (frame: ProviderAudioAnalysisFrame) => void;
        const subscribe = vi.fn((callback: typeof receive) => {
            receive = callback;
            return () => {};
        });
        vi.stubGlobal('window', { electron: { onSoloistAudioFrame: subscribe } });
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
        const read = spotifyProvider.playback!.readAudioAnalysisFrame!;

        expect(read(nativeAudio)).toBeUndefined();
        expect(subscribe).not.toHaveBeenCalled();
        expect(read(externalAudio)).toBeNull();
        const frame = { power: 50, bass: 20, lowMid: 30, mid: 40, vocal: 50, treble: 60, spectrum: Array(1024).fill(20) };
        receive(frame);
        expect(read(externalAudio)).toBe(frame);
        expect(read(nativeAudio)).toBeUndefined();
        clock.mockReturnValue(1349);
        expect(read(externalAudio)).toBe(frame);
        clock.mockReturnValue(1350);
        expect(read(externalAudio)).toBeNull();
        receive(frame);
        expect(read(externalAudio)).toBe(frame);
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(latestSoloistCaptureFrame('official:track:1')).toBeNull();
        receive(frame);
        expect(latestSoloistCaptureFrame('official:track:1')).toBe(frame);
        expect(latestSoloistCaptureFrame(null)).toBeNull();
        receive(frame);
        expect(latestSoloistCaptureFrame('official:track:1')).toBeNull();
        receive(frame);
        expect(latestSoloistCaptureFrame('official:track:1:seek')).toBeNull();
        resetSoloistCaptureFrame();
        const wall = vi.spyOn(Date, 'now').mockReturnValue(10000);
        latestSoloistCaptureFrame('delayed-session');
        // A continuous 100 ms IPC delay is within the freshness limit. Old pre-seek frames must
        // not move the cutoff on every arrival and starve all following valid frames.
        for (let n = 0; n < 10; n += 1) {
            const arrivedAt = 10050 + n * 50;
            wall.mockReturnValue(arrivedAt);
            receive({ ...frame, capturedAt: arrivedAt - 100 });
        }
        expect(latestSoloistCaptureFrame('delayed-session')).not.toBeNull();
        wall.mockReturnValue(10750);
        expect(latestSoloistCaptureFrame('delayed-session')).toBeNull();
    });
});
