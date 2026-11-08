import type { ProviderAudioAnalysisFrame } from '../../types/onlineMusic';
import { DRUM_KICK, DRUM_SNARE, type DrumHits } from '../analysis/drumHitPicking';
import type { BeatFxEvent } from './clock';

// Bounded, session-only onset estimates for external audio engines; never saved as model analysis.
// Low-band rises drive kick-like motion; mid/high rises drive snare-like light. Neither is a separated stem.
export class ExternalAudioReactivity {
    private source: string | null = null;
    private frame: ProviderAudioAnalysisFrame | null = null;
    private freshAt = -Infinity;
    private low = 0;
    private high = 0;
    private lastLow = -Infinity;
    private lastHigh = -Infinity;
    time = 0;
    generation = 0;
    kickSequence = 0;
    kickAt = -Infinity;
    kickStrength = 0;
    hitOffset = 0;
    events: BeatFxEvent[] = [];
    hits: DrumHits = { times: new Float64Array(), strengths: new Float32Array(), kinds: new Uint8Array() };

    /** Called once by the existing playback frame loop, with Omni's external-engine frame only. */
    update(source: string | null, time: number, frame: ProviderAudioAnalysisFrame | null | undefined, now: number) {
        if (!source || !frame || !Number.isFinite(time)) {
            this.reset();
            return;
        }
        const low = Math.max(0, Math.min(255, frame.bass));
        const high = Math.max(0, Math.min(255, (frame.mid + frame.treble) / 2));
        if (source !== this.source || frame.captureSession !== this.frame?.captureSession
            || time < this.time || time - this.time > 0.5 || now - this.freshAt >= 350) {
            this.reset();
            this.source = source;
            this.low = low;
            this.high = high;
            this.frame = frame;
            this.freshAt = now;
            this.time = time;
            return;
        }
        this.time = time;
        // The capture helper runs more slowly than RAF: never count the same frame twice.
        if (frame === this.frame) return;
        this.frame = frame;
        this.freshAt = now;
        const lowRise = low - this.low;
        const highRise = high - this.high;
        // Stay above consumers' ripple/bump gaps so rolling history never changes their chosen hits.
        if (low > 40 && lowRise > 24 && time - this.lastLow >= 0.35) {
            const strength = Math.min(1, lowRise / 100);
            this.lastLow = time;
            this.kickAt = time;
            this.kickStrength = strength;
            this.kickSequence += 1;
            this.events.push({ t: time, kind: 'beat', impact: strength });
            // Remove a multiple of three so Machi's existing neon group assignment stays stable.
            if (this.events.length > 96) this.events.splice(0, 3);
            this.addHit(time, strength, DRUM_KICK);
        }
        if (high > 40 && highRise > 24 && highRise > lowRise * 0.7 && time - this.lastHigh >= 0.35) {
            this.lastHigh = time;
            this.addHit(time, Math.min(1, highRise / 100), DRUM_SNARE);
        }
        this.low = low;
        this.high = high;
    }

    /** No stale, paused or previous-track impulses may leak into another picture. */
    read(now = performance.now()): ExternalAudioReactivity | null {
        return this.source && now - this.freshAt < 350 ? this : null;
    }

    reset() {
        if (this.source === null) return;
        this.source = null;
        this.frame = null;
        this.freshAt = -Infinity;
        this.lastLow = this.lastHigh = this.kickAt = -Infinity;
        this.generation += 1;
        this.hitOffset = 0;
        this.events = [];
        this.hits = { times: new Float64Array(), strengths: new Float32Array(), kinds: new Uint8Array() };
    }

    private addHit(time: number, strength: number, kind: number) {
        const start = Math.max(0, this.hits.times.length - 31);
        this.hitOffset += start;
        this.hits = {
            times: new Float64Array([...this.hits.times.subarray(start), time]),
            strengths: new Float32Array([...this.hits.strengths.subarray(start), strength]),
            kinds: new Uint8Array([...this.hits.kinds.subarray(start), kind]),
        };
    }
}

export const externalAudioReactivity = new ExternalAudioReactivity();
