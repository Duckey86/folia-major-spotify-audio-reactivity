import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalAudioReactivity, externalAudioReactivity } from '../../../src/services/beatFx/externalAudioReactivity';
import type { ProviderAudioAnalysisFrame } from '../../../src/types/onlineMusic';
import { createMachiBeatFrame, resolveMachiNeonPulse, resolveMachiDrumRipples, resolveMachiScreenFlash } from '../../../src/components/visualizer/machi/engine/beatFx';
import { NebbiaDrizzleRide } from '../../../src/components/visualizer/nebbia/nebbiaDrizzleRide';
import { VocalEnergy } from '../../../src/components/visualizer/nebbia/nebbiaHits';
import { setBeatFxLiveEffects } from '../../../src/services/beatFx/beatFxLive';
import { BEAT_EFFECT_IDS, beatEffectPartId } from '../../../src/services/beatFx/beatEffects';
import type { NebbiaGlassMotion } from '../../../src/components/visualizer/nebbia/nebbiaDrops';

// Regression coverage for distinct live frequency inputs and their actual new visualizer consumers.
const frame = (bass = 0, mid = 0, treble = 0, vocal = 0): ProviderAudioAnalysisFrame => ({
    power: bass, bass, lowMid: bass, mid, treble, vocal, spectrum: [],
});
afterEach(() => { externalAudioReactivity.reset(); setBeatFxLiveEffects({}); vi.restoreAllMocks(); });

describe('external audio reactivity', () => {
    it('resets onset history when the native helper restarts even at the same track time', () => {
        const live = new ExternalAudioReactivity();
        live.update('first', 0, { ...frame(), captureSession: 1 }, 0);
        live.update('first', 0.1, { ...frame(180), captureSession: 1 }, 100);
        expect(live.events).toHaveLength(1);
        live.update('first', 0.2, { ...frame(240), captureSession: 2 }, 200);
        expect(live.events).toHaveLength(0);
        expect(live.hits.times).toHaveLength(0);
    });
    it('does not confuse vocal energy, low-band onsets and mid/high onsets', () => {
        const live = new ExternalAudioReactivity();
        live.update('first', 0, frame(), 0);
        live.update('first', 0.1, frame(0, 0, 0, 240), 100);
        expect(live.events).toHaveLength(0);
        expect(live.hits.times).toHaveLength(0);
        live.update('first', 0.2, frame(180), 200);
        expect(live.hits.kinds).toEqual(new Uint8Array([0]));
        live.update('first', 0.3, frame(180, 200, 200), 300);
        expect(live.hits.kinds).toEqual(new Uint8Array([0, 1]));
        expect(live.events).toHaveLength(1);
    });

    it('drives Machi neon, ground ripples and screen lights through different signals', () => {
        const live = new ExternalAudioReactivity();
        live.update('first', 0, frame(), 0);
        live.update('first', 0.1, frame(180), 100);
        live.update('first', 0.2, frame(180, 200, 200), 200);
        const out = createMachiBeatFrame();
        const rings = new Float32Array(8);
        resolveMachiNeonPulse(live.events, 0.4, 1, 1, out);
        expect(Math.max(...out.neonGroups)).toBeGreaterThan(1);
        expect(resolveMachiDrumRipples(live.hits, 0.4, 1, rings)).toBeGreaterThan(0);
        resolveMachiScreenFlash(live.hits, 0.4, 1, out);
        expect(Math.max(...out.swellAmp)).toBeGreaterThan(0);
        resolveMachiScreenFlash(live.hits, 0.4, 0, out);
        expect(Math.max(...out.swellAmp)).toBe(0);
    });

    it('discards history on seek, track change, pause, stale capture and native playback', () => {
        const live = new ExternalAudioReactivity();
        live.update('first', 0, frame(), 0);
        live.update('first', 0.1, frame(180), 100);
        expect(live.read(449)).toBe(live);
        expect(live.read(450)).toBeNull();
        live.update('first', 40, frame(230), 200);
        expect(live.events).toHaveLength(0);
        live.update('second', 0, frame(240), 250);
        expect(live.hits.times).toHaveLength(0);
        live.update(null, 0, frame(240), 300);
        expect(live.read(300)).toBeNull();
        live.update('native', 0, undefined, 350);
        expect(live.read(350)).toBeNull();
        live.update('second', 0, null, 400);
        expect(live.read(400)).toBeNull();
    });

    it('keeps existing screen flashes in place when the bounded hit history rolls over', () => {
        const live = new ExternalAudioReactivity();
        for (let n = 0; n < 32; n += 1) {
            live.update('first', n * 0.4, frame(), n * 400);
            live.update('first', n * 0.4 + 0.1, frame(0, 200, 200), n * 400 + 100);
        }
        const before = createMachiBeatFrame();
        resolveMachiScreenFlash(live.hits, 12.95, 1, before, live.hitOffset);
        live.update('first', 12.8, frame(), 12800);
        live.update('first', 12.9, frame(0, 200, 200), 12900);
        const after = createMachiBeatFrame();
        resolveMachiScreenFlash(live.hits, 12.95, 1, after, live.hitOffset);
        expect(after.swellAt[1]).toBeCloseTo(before.swellAt[0]);
        expect(after.swellAmp[1]).toBeCloseTo(before.swellAmp[0]);
    });

    it('ignores duplicate frames, sustained notes and close onsets, and bounds history', () => {
        const live = new ExternalAudioReactivity();
        live.update('first', 0, frame(), 0);
        const loud = frame(180);
        live.update('first', 0.1, loud, 100);
        live.update('first', 0.11, loud, 110);
        live.update('first', 0.12, frame(180), 120);
        live.update('first', 0.13, frame(), 130);
        live.update('first', 0.14, frame(180), 140);
        expect(live.events).toHaveLength(1);
        for (let n = 1; n < 300; n += 1) {
            live.update('first', n * 0.4, frame(), n * 400);
            live.update('first', n * 0.4 + 0.1, frame(180), n * 400 + 100);
        }
        expect(live.events.length).toBeLessThanOrEqual(96);
        expect(live.hits.times.length).toBeLessThanOrEqual(32);
    });

    it('keeps existing ripples alive when dense low-band onsets roll the history', () => {
        const live = new ExternalAudioReactivity();
        let n = 0;
        const next = () => {
            live.update('first', n * 0.31, frame(), n * 310);
            live.update('first', n * 0.31 + 0.1, frame(180), n * 310 + 100);
            n += 1;
        };
        while (live.hits.times.length < 32 && n < 100) next();
        expect(live.hits.times).toHaveLength(32);
        const previous = live.hits;
        while (live.hitOffset === 0 && n < 110) next();
        expect(live.hitOffset).toBeGreaterThan(0);
        const time = live.time + 0.01;
        const before = new Float32Array(8);
        const after = new Float32Array(8);
        resolveMachiDrumRipples(previous, time, 1, before);
        resolveMachiDrumRipples(live.hits, time, 1, after);
        const ages = (rings: Float32Array) => [rings[0], rings[2], rings[4], rings[6]].filter(age => age >= 0);
        for (const age of ages(before)) {
            expect(ages(after).some(kept => Math.abs(kept - age) < 0.001)).toBe(true);
        }
    });

    it('lets Nebbia react to live low-band bumps while its rain reads the vocal band', () => {
        const id = BEAT_EFFECT_IDS.nebbiaDrizzleRide;
        setBeatFxLiveEffects({ [id]: 1, [beatEffectPartId(id, 'rain')]: 0.7, [beatEffectPartId(id, 'bump')]: 1 });
        const now = vi.spyOn(performance, 'now').mockReturnValue(0);
        const motion = { beginFrame: vi.fn(), trigger: vi.fn() };
        const ride = new NebbiaDrizzleRide();
        externalAudioReactivity.update('first', 0, frame(), 0);
        ride.step(motion as unknown as NebbiaGlassMotion, 0, 0, false, 1);
        now.mockReturnValue(100);
        externalAudioReactivity.update('first', 0.1, frame(180), 100);
        ride.step(motion as unknown as NebbiaGlassMotion, 0.1, 0.1, false, 1);
        expect(motion.trigger).toHaveBeenCalledTimes(1);
        ride.step(motion as unknown as NebbiaGlassMotion, 0.12, 0.12, false, 1);
        expect(motion.trigger).toHaveBeenCalledTimes(1);
        expect(ride.env).toBeNull();
        expect(ride.rain).toBe(0.7);
        const vocal = new VocalEnergy();
        expect(vocal.update(200, 1 / 60)).toBeGreaterThan(vocal.update(0, 1 / 60));
        setBeatFxLiveEffects({});
        ride.step(motion as unknown as NebbiaGlassMotion, 0.2, 0.2, false, 1);
        expect(motion.beginFrame).toHaveBeenLastCalledWith(0.2, false, true);
    });
});
