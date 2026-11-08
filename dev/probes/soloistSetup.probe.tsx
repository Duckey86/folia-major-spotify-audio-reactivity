import React, { useCallback, useRef, useState } from 'react';
import LoginWindow from '../../src/components/login/window/LoginWindow';
import SoloistSetup from '../../src/components/spotify/SoloistSetup';
import type { SoloistRequest, SoloistStatus } from '../../src/components/spotify/soloistSetupBridge';
import type { ProbeDefinition } from './definition';

// Exercise the real account window and setup controls without a key, daemon, or external network.
const initial: SoloistStatus = {
    enabled: true, state: 'not-configured', error: null, hasKey: false,
    executable: null, persistentKey: false, external: false,
};

const SoloistProbe = () => {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const current = useRef<SoloistStatus>({ ...initial, ...(scenario === 'existing' ? {
        hasKey: true, persistentKey: true, executable: 'C:\\Soloist\\soloist.exe', state: 'connected' as const,
    } : scenario === 'expired' ? {
        hasKey: true, persistentKey: true, executable: 'C:\\Soloist\\soloist.exe', state: 'error' as const, error: 'build-expired',
    } : {}) });
    const [key, setKey] = useState(0);
    const [opened, setOpened] = useState('');
    const [saved, setSaved] = useState(false);
    const request = useCallback<SoloistRequest>(async (action, payload) => {
        if (action === 'open') setOpened(payload ?? '');
        if (action === 'choose-executable') current.current = { ...current.current, executable: 'C:\\Soloist\\soloist.exe', error: null };
        if (action === 'save' || action === 'reconnect') {
            if (payload || current.current.hasKey) {
                current.current = { ...current.current, hasKey: true, persistentKey: true, state: 'waiting-for-pairing', error: null };
                setSaved(true);
            }
        }
        return { ...current.current };
    }, []);
    return <>
        <div className="fixed bottom-1 left-1 z-[400] flex gap-2 text-xs text-white">
            <button onClick={() => { current.current = { ...current.current, state: 'connected', error: null }; }}>Simulate pairing</button>
            <button onClick={() => setKey(value => value + 1)}>Remount setup</button>
            <output data-testid="opened-link">{opened}</output>
            <output data-testid="saved">{String(saved)}</output>
        </div>
        <LoginWindow isOpen onClose={() => {}} title="Spotify" closeTip="Close"
            providerId="spotify" providerLabel="Spotify" rings={false}
            column={() => null} tile={null} message={null}
            before={<SoloistSetup key={key} request={request} />} />
    </>;
};

export default { id: 'soloistSetup', title: 'Soloist onboarding', description: 'First-run and returning-user setup inside the account window.', Component: SoloistProbe } satisfies ProbeDefinition;
