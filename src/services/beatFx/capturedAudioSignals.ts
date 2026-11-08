import type { ProviderAudioAnalysisFrame } from '../../types/onlineMusic';
import { audioBands, audioPower } from '../../stores/motionSignals';

// Publishes captured features through the same motion values used by the internal analyser.
const silence = new Uint8Array(0);
let previous: ProviderAudioAnalysisFrame | null = null;
let spectrum: Uint8Array<ArrayBuffer> = silence;

export function writeCapturedAudioSignals(frame: ProviderAudioAnalysisFrame | null) {
    if (frame !== previous) spectrum = frame ? Uint8Array.from(frame.spectrum) : silence;
    previous = frame;
    audioPower.set(frame?.power ?? 0);
    audioBands.bass.set(frame?.bass ?? 0);
    audioBands.lowMid.set(frame?.lowMid ?? 0);
    audioBands.mid.set(frame?.mid ?? 0);
    audioBands.vocal.set(frame?.vocal ?? 0);
    audioBands.treble.set(frame?.treble ?? 0);
    audioBands.spectrum?.set(spectrum);
}
