import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExternalPlaybackBridge } from '../../../src/components/app/playback/bridges/useExternalPlaybackBridge';

// External repeat belongs to the transport: queue navigation must not consume a repeat-one end.
const state = vi.hoisted(() => ({
    loopMode: 'off',
    isFmMode: false,
    listener: null as ((event: { type: string }) => void) | null,
    seek: vi.fn(() => true),
}));
vi.mock('react', async original => ({ ...(await original<typeof import('react')>()), useRef: (current: unknown) => ({ current }), useEffect: (effect: () => unknown) => effect() }));
vi.mock('react-i18next', async original => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/stores/usePlaybackStore', () => ({ usePlaybackStore: { getState: () => state } }));
vi.mock('../../../src/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore: { getState: () => state } }));
vi.mock('../../../src/services/onlineMusic/externalPlayback', () => ({
    installExternalPlayback: vi.fn(),
    seekExternalPlayback: state.seek,
    subscribeExternalPlayback: (listener: typeof state.listener) => { state.listener = listener; return () => {}; },
}));

describe('external playback repeat', () => {
    beforeEach(() => {
        state.loopMode = 'off';
        state.isFmMode = false;
        state.seek.mockReset().mockReturnValue(true);
    });

    it('seeks and resumes repeat-one without advancing the queue', () => {
        const next = vi.fn();
        useExternalPlaybackBridge({ handleNextTrack: next });
        state.loopMode = 'one';
        state.listener!({ type: 'ended' });
        expect(state.seek).toHaveBeenCalledWith(0, { resume: true });
        expect(next).not.toHaveBeenCalled();
    });

    it.each(['off', 'all', 'fm', 'missing'])('preserves queue handling for %s', mode => {
        const next = vi.fn();
        useExternalPlaybackBridge({ handleNextTrack: next });
        state.loopMode = mode === 'off' || mode === 'all' ? mode : 'one';
        state.isFmMode = mode === 'fm';
        state.seek.mockReturnValue(mode !== 'missing');
        state.listener!({ type: 'ended' });
        expect(next).toHaveBeenCalledWith({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
        if (mode !== 'missing') expect(state.seek).not.toHaveBeenCalled();
    });
});
