import type { ProviderAudioAnalysisFrame } from '../../../types/onlineMusic';

// Receives feature frames from a local, process-specific Windows WASAPI capture.
// No audio samples or Spotify credentials cross Electron IPC.
export type SoloistCaptureFrame = ProviderAudioAnalysisFrame;
let frame: SoloistCaptureFrame | null = null;
let lastAt = 0;
let installed = false;
let owner: string | null = null;
let notBefore = 0;
const bands = ['power', 'bass', 'lowMid', 'mid', 'vocal', 'treble'] as const;

export function resetSoloistCaptureFrame() {
    frame = null;
    lastAt = 0;
    notBefore = Date.now();
}

/** Validate the boundary again so malformed or queued IPC cannot drive motion. */
export function isSoloistCaptureFrame(value: unknown): value is SoloistCaptureFrame {
    if (!value || typeof value !== 'object') return false;
    const next = value as SoloistCaptureFrame;
    const byte = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;
    return bands.every(key => byte(next[key])) && Array.isArray(next.spectrum)
        && next.spectrum.length === 1024 && next.spectrum.every(byte)
        && (next.captureSession === undefined || (Number.isSafeInteger(next.captureSession) && next.captureSession > 0))
        && (next.capturedAt === undefined || (Number.isFinite(next.capturedAt)
            && Date.now() - next.capturedAt >= -100 && Date.now() - next.capturedAt < 350));
}

export function latestSoloistCaptureFrame(session: string | null = 'legacy'): SoloistCaptureFrame | null {
    if (owner !== session) {
        owner = session;
        resetSoloistCaptureFrame();
    }
    if (!installed && typeof window !== 'undefined' && window.electron?.onSoloistAudioFrame) {
        installed = true;
        const unsubscribe = window.electron.onSoloistAudioFrame(next => {
            if (next === null) {
                resetSoloistCaptureFrame();
                return;
            }
            if (!owner || !isSoloistCaptureFrame(next) || (next.capturedAt !== undefined && next.capturedAt < notBefore)) {
                // Reject queued data without moving the session cutoff ahead of the next packet.
                frame = null;
                lastAt = 0;
                return;
            }
            frame = next;
            lastAt = performance.now();
        });
        import.meta.hot?.dispose(() => { unsubscribe(); installed = false; resetSoloistCaptureFrame(); });
    }
    // Never leave a frozen spectrum behind when the capture helper exits.
    return owner && frame && performance.now() - lastAt < 350
        && (frame.capturedAt === undefined || Date.now() - frame.capturedAt < 350) ? frame : null;
}
