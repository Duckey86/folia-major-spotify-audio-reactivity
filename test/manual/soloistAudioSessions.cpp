#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <wrl/client.h>
#include <cstdio>

// Lists render-session PIDs and peak meters for diagnosis; never captures or stores PCM.
using Microsoft::WRL::ComPtr;
int main() {
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
    ComPtr<IMMDeviceEnumerator> devices;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)))) return 2;
    ComPtr<IMMDeviceCollection> outputs;
    if (FAILED(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &outputs))) return 3;
    UINT count = 0;
    outputs->GetCount(&count);
    std::printf("endpoints=%u\n", count);
    for (UINT deviceIndex = 0; deviceIndex < count; ++deviceIndex) {
        ComPtr<IMMDevice> device;
        if (FAILED(outputs->Item(deviceIndex, &device))) continue;
        ComPtr<IAudioSessionManager2> manager;
        if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager))) continue;
        ComPtr<IAudioSessionEnumerator> sessions;
        const HRESULT enumerated = manager->GetSessionEnumerator(&sessions);
        if (FAILED(enumerated)) { std::printf("enumeration failed=%08lx\n", enumerated); continue; }
        int sessionCount = 0;
        sessions->GetCount(&sessionCount);
        for (int index = 0; index < sessionCount; ++index) {
            ComPtr<IAudioSessionControl> session;
            if (FAILED(sessions->GetSession(index, &session))) continue;
            ComPtr<IAudioSessionControl2> control;
            if (FAILED(session.As(&control))) continue;
            DWORD pid = 0;
            control->GetProcessId(&pid);
            AudioSessionState state;
            control->GetState(&state);
            ComPtr<IAudioMeterInformation> meter;
            float peak = 0;
            if (SUCCEEDED(session.As(&meter))) meter->GetPeakValue(&peak);
            std::printf("endpoint=%u pid=%lu state=%d peak=%.6f\n", deviceIndex, pid, state, peak);
        }
    }
    // Process exit releases COM after the local interface holders are destroyed.
}
