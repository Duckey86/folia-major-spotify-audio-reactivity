// Folia Soloist audio visualizer bridge. Source integration for the Folia fork.
// Captures ONLY the target process tree's Windows render stream; never records files,
// replays samples, or forwards the captured PCM to the JavaScript renderer.
// Windows 11 / Windows SDK 10.0.20348+.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <tlhelp32.h>
#include <initguid.h>
#include <objbase.h>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <array>
#include <atomic>
#include <complex>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")

namespace {
constexpr unsigned FFT_N = 2048;
constexpr float PI = 3.14159265358979323846f;
constexpr DWORD RATE = 44100;

void logError(const char* where, HRESULT hr) {
    std::fprintf(stderr, "[capture] %s failed (HRESULT 0x%08lX)\n", where,
        static_cast<unsigned long>(hr));
}

DWORD findSoloist() {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    DWORD pid = 0;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (_wcsicmp(entry.szExeFile, L"soloist.exe") == 0) { pid = entry.th32ProcessID; break; }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return pid;
}

// Windows completes this asynchronously. The returned IAudioClient is marshalled
// within the MTA, and its pointer is acquired before the capture thread proceeds.
class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    explicit Activation(HANDLE event) : event_(event) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (iid == __uuidof(IUnknown) ||
            iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (iid == __uuidof(IAgileObject)) {
            *object = static_cast<IAgileObject*>(this);
        } else return E_NOINTERFACE;
        AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG n = --references_;
        if (!n) delete this;
        return n;
    }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        IUnknown* unknown = nullptr;
        HRESULT operationResult = E_FAIL;
        const HRESULT result = operation->GetActivateResult(&operationResult, &unknown);
        status_ = FAILED(result) ? result : operationResult;
        if (SUCCEEDED(status_) && unknown) {
            status_ = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client_));
        }
        if (unknown) unknown->Release();
        SetEvent(event_);
        return S_OK;
    }
    HRESULT status() const { return status_; }
    IAudioClient* takeClient() { auto* c = client_; client_ = nullptr; return c; }
private:
    ~Activation() { if (client_) client_->Release(); }
    std::atomic<ULONG> references_{1};
    HANDLE event_;
    HRESULT status_ = E_FAIL;
    IAudioClient* client_ = nullptr;
};

struct Analyzer {
    std::array<float, FFT_N> history{};
    size_t write = 0;
    size_t available = 0;
    void consume(const BYTE* bytes, UINT32 frames, DWORD flags) {
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        auto* pcm = reinterpret_cast<const int16_t*>(bytes);
        for (UINT32 i = 0; i < frames; ++i) {
            // The capture format below is stereo PCM16, not the endpoint mix format.
            const float mono = silent ? 0.0f : (float(pcm[i * 2]) + float(pcm[i * 2 + 1])) / 65536.0f;
            history[write] = mono;
            write = (write + 1) % FFT_N;
            if (available < FFT_N) ++available;
        }
    }
    void printFrame() const {
        std::array<std::complex<float>, FFT_N> f{};
        for (unsigned i = 0; i < FFT_N; ++i) {
            const float x = available == FFT_N ? history[(write + i) % FFT_N] : 0.0f;
            const float window = 0.5f - 0.5f * std::cos(2.0f * PI * i / (FFT_N - 1));
            f[i] = { x * window, 0.0f };
        }
        // In-place iterative radix-2 FFT, approximately 20 times/second.
        for (unsigned i = 1, j = 0; i < FFT_N; ++i) {
            unsigned bit = FFT_N >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) std::swap(f[i], f[j]);
        }
        for (unsigned len = 2; len <= FFT_N; len <<= 1) {
            const float angle = -2.0f * PI / len;
            const std::complex<float> wlen(std::cos(angle), std::sin(angle));
            for (unsigned i = 0; i < FFT_N; i += len) {
                std::complex<float> w{1, 0};
                for (unsigned j = 0; j < len / 2; ++j) {
                    const auto u = f[i + j];
                    const auto v = f[i + j + len / 2] * w;
                    f[i + j] = u + v;
                    f[i + j + len / 2] = u - v;
                    w *= wlen;
                }
            }
        }
        std::array<int, FFT_N / 2> spectrum{};
        for (unsigned i = 0; i < spectrum.size(); ++i) {
            const float magnitude = std::abs(f[i]) / (FFT_N * 0.25f);
            const float db = 20.0f * std::log10(std::max(magnitude, 1e-9f));
            spectrum[i] = std::clamp(static_cast<int>((db + 80.0f) * (255.0f / 68.0f)), 0, 255);
        }
        auto energy = [&](float minHz, float maxHz) -> float {
            const unsigned lo = std::max(1u, static_cast<unsigned>(minHz * FFT_N / RATE));
            const unsigned hi = std::min(unsigned(spectrum.size() - 1), static_cast<unsigned>(maxHz * FFT_N / RATE));
            float sum = 0;
            for (unsigned i = lo; i <= hi; ++i) sum += spectrum[i];
            return sum / std::max(1u, hi - lo + 1);
        };
        auto scaled = [](float value, float boost) -> int {
            return std::clamp(static_cast<int>(std::pow(value / 255.0f, boost) * 255.0f), 0, 255);
        };
        float bass = energy(20, 150), low = energy(150, 400);
        FILETIME stamp{};
        GetSystemTimePreciseAsFileTime(&stamp);
        ULARGE_INTEGER ticks{};
        ticks.LowPart = stamp.dwLowDateTime;
        ticks.HighPart = stamp.dwHighDateTime;
        const auto capturedAt = (ticks.QuadPart - 116444736000000000ULL) / 10000ULL;
        std::printf("{\"capturedAt\":%llu,\"power\":%d,\"bass\":%d,\"lowMid\":%d,\"mid\":%d,\"vocal\":%d,\"treble\":%d,\"spectrum\":[", capturedAt,
            scaled((bass + low) / 2, 3), scaled(bass, 1.8f), scaled(low, 2),
            scaled(energy(400, 1200), 2), scaled(energy(1000, 3500), 1.5f),
            scaled(energy(3500, 12000), 2));
        for (unsigned i = 0; i < spectrum.size(); ++i) {
            std::printf("%s%d", i ? "," : "", spectrum[i]);
        }
        std::puts("]}");
        std::fflush(stdout);
    }
};
} // namespace

int wmain(int argc, wchar_t** argv) {
    // 0: scan for existing external Soloist; otherwise explicitly named PID.
    // Only used by a manual terminal test: captures every other process's output
    // to check whether Windows loopback works independently of a target PID.
    // The analyzer outputs spectral features only; it never stores/replays PCM.
    const bool probeAll = argc > 1 && _wcsicmp(argv[1], L"--probe-all") == 0;
    DWORD pid = probeAll ? GetCurrentProcessId() : ((argc > 1) ? wcstoul(argv[1], nullptr, 10) : 0);
    if (!pid) pid = findSoloist();
    if (!pid) { std::fprintf(stderr, "[capture] soloist.exe not found\n"); return 2; }
    // An adopted PID can have been reused: verify it still belongs to the configured program.
    HANDLE target = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!target) { std::fprintf(stderr, "[capture] target process unavailable\n"); return 2; }
    if (!probeAll && argc > 2) {
        wchar_t image[32768]{};
        DWORD length = 32768;
        if (!QueryFullProcessImageNameW(target, 0, image, &length) || _wcsicmp(image, argv[2]) != 0) {
            CloseHandle(target);
            std::fprintf(stderr, "[capture] target process identity changed\n");
            return 2;
        }
    }
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { logError("CoInitializeEx", hr); return 3; }
    HANDLE activated = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!activated || !ready) return 4;
    auto* completion = new Activation(activated);
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = probeAll
        ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
        : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT activationBlob{};
    activationBlob.vt = VT_BLOB;
    activationBlob.blob.cbSize = sizeof(params);
    activationBlob.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    IActivateAudioInterfaceAsyncOperation* operation = nullptr;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
                                      &activationBlob, completion, &operation);
    if (FAILED(hr)) { logError("ActivateAudioInterfaceAsync", hr); return 5; }
    const DWORD wait = WaitForSingleObject(activated, 10000);
    if (wait != WAIT_OBJECT_0) { std::fprintf(stderr, "[capture] activation timed out\n"); return 6; }
    hr = completion->status();
    IAudioClient* client = completion->takeClient();
    completion->Release();
    if (operation) operation->Release();
    if (FAILED(hr) || !client) { logError("ActivateCompleted", hr); return 7; }

    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = RATE;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = RATE * 4;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                            0, 0, &format, nullptr);
    if (FAILED(hr)) { logError("IAudioClient::Initialize", hr); return 8; }
    IAudioCaptureClient* capture = nullptr;
    hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
    if (FAILED(hr)) { logError("GetService(IAudioCaptureClient)", hr); return 9; }
    hr = client->SetEventHandle(ready);
    if (FAILED(hr)) { logError("SetEventHandle", hr); return 10; }
    hr = client->Start();
    if (FAILED(hr)) { logError("Start", hr); return 11; }
    std::fprintf(stderr, "[capture] active mode=%s target_pid=%lu rate=%lu fft=%u\n",
        probeAll ? "PROBE-ALL (excluding helper)" : "INCLUDE-TARGET", pid, RATE, FFT_N);
    if (probeAll) std::fprintf(stderr,
        "[capture] WARNING: probe-all analyses system-wide audio; close after the test. No PCM is saved.\n");
    Analyzer fft;
    // Approx. 20 snapshots per second; avoids expensive IPC per audio packet.
    ULONGLONG lastSent = 0;
    ULONGLONG lastPacket = 0;
    ULONGLONG lastDiagnostic = GetTickCount64();
    unsigned long long intervalPackets = 0, intervalFrames = 0;
    unsigned long long intervalSilentPackets = 0, intervalNonzeroSamples = 0;
    int intervalPeakPcm16 = 0;
    for (;;) {
        if (target && WaitForSingleObject(target, 0) == WAIT_OBJECT_0) break;
        WaitForSingleObject(ready, 50);
        UINT32 count = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&count)) && count) {
            BYTE* data = nullptr;
            DWORD flags = 0;
            UINT64 position = 0, qpc = 0;
            const HRESULT readHr = capture->GetBuffer(&data, &count, &flags, &position, &qpc);
            if (FAILED(readHr)) { logError("GetBuffer", readHr); break; }
            // [capture diagnostic] Only counts and peak amplitude, never stores audio.
            ++intervalPackets;
            intervalFrames += count;
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
                ++intervalSilentPackets;
            } else {
                const auto* samples = reinterpret_cast<const int16_t*>(data);
                for (UINT32 i = 0; i < count * 2; ++i) {
                    const int amplitude = std::abs(static_cast<int>(samples[i]));
                    if (amplitude) ++intervalNonzeroSamples;
                    if (amplitude > intervalPeakPcm16) intervalPeakPcm16 = amplitude;
                }
            }
            fft.consume(data, count, flags);
            lastPacket = GetTickCount64();
            capture->ReleaseBuffer(count);
        }
        const ULONGLONG now = GetTickCount64();
        if (now - lastDiagnostic >= 1000) {
            std::fprintf(stderr,
                "[capture diagnostic] pid=%lu packets=%llu frames=%llu silent_packets=%llu "
                "nonzero_samples=%llu peak_pcm16=%d fft_available=%zu\n",
                pid, intervalPackets, intervalFrames, intervalSilentPackets,
                intervalNonzeroSamples, intervalPeakPcm16, fft.available);
            intervalPackets = intervalFrames = intervalSilentPackets = intervalNonzeroSamples = 0;
            intervalPeakPcm16 = 0;
            lastDiagnostic = now;
        }
        if (now - lastSent >= 50) {
            // WASAPI may stop delivering packets in silence; never keep publishing the old FFT.
            if (now - lastPacket >= 150) fft.available = 0;
            fft.printFrame();
            if (std::ferror(stdout)) break; // Stop when Electron closes the pipe.
            lastSent = now;
        }
    }
    if (target) CloseHandle(target);
    client->Stop();
    capture->Release();
    client->Release();
    CloseHandle(ready);
    CloseHandle(activated);
    CoUninitialize();
    return 0;
}
