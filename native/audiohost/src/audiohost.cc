/*
 * audiohost — SuperDAW's native audio backend addon (phase 2 stage 1;
 * docs/NATIVE_AUDIO_BACKEND.md).
 *
 * This stage is the DEVICE layer: WASAPI (shared, low-latency
 * IAudioClient3 periods) via miniaudio's ma_context/ma_device, a stream
 * clock, device enumeration with stable ids, xrun/health counters, and a
 * deliberately trivial render source (a test tone) standing where the
 * graph/param/voice engine (next stage) will plug in.
 *
 * Threading contract (the design's hard rule): the audio callback runs on
 * an OS audio thread and NEVER calls into JS, allocates, or blocks. It
 * reads atomics published by the JS-facing thread. Everything JS-facing
 * runs on the addon's main thread.
 */

#include <napi.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "miniaudio.h"

namespace {

constexpr double kTau = 6.283185307179586476925286766559;

struct HostState {
  ma_context context{};
  bool contextReady = false;

  ma_device device{};
  bool deviceReady = false;

  // ---- published by the JS thread, read by the audio callback ----
  std::atomic<double> toneFreq{0.0};
  std::atomic<double> toneGain{0.0};

  // ---- written by the audio callback, read by the JS thread ----
  std::atomic<uint64_t> framesRendered{0};
  std::atomic<uint64_t> callbacks{0};
  std::atomic<uint64_t> xruns{0};
  std::atomic<uint32_t> lastCallbackFrames{0};

  // Callback-local (audio thread only — no atomics needed).
  double tonePhase = 0.0;

  uint32_t sampleRate = 0;
  uint32_t channels = 0;
  uint32_t periodFrames = 0;
  uint32_t periodCount = 0;
};

HostState* g_host = nullptr;

/*
 * The realtime callback. Zero-fills, then adds the test tone if audible.
 * Frame-count irregularity (WASAPI shared can deliver uneven periods) is
 * tracked as a health signal, not treated as an error.
 */
void DataCallback(ma_device* device, void* output, const void* /*input*/, ma_uint32 frameCount) {
  auto* host = static_cast<HostState*>(device->pUserData);
  auto* out = static_cast<float*>(output);
  const uint32_t channels = host->channels;

  std::memset(out, 0, sizeof(float) * frameCount * channels);

  const double gain = host->toneGain.load(std::memory_order_relaxed);
  const double freq = host->toneFreq.load(std::memory_order_relaxed);
  if (gain > 0.0 && freq > 0.0 && host->sampleRate > 0) {
    const double step = kTau * freq / static_cast<double>(host->sampleRate);
    double phase = host->tonePhase;
    for (ma_uint32 i = 0; i < frameCount; i++) {
      const float sample = static_cast<float>(gain * std::sin(phase));
      phase += step;
      if (phase > kTau) phase -= kTau;
      for (uint32_t ch = 0; ch < channels; ch++) out[i * channels + ch] = sample;
    }
    host->tonePhase = phase;
  }

  host->framesRendered.fetch_add(frameCount, std::memory_order_relaxed);
  host->callbacks.fetch_add(1, std::memory_order_relaxed);
  host->lastCallbackFrames.store(frameCount, std::memory_order_relaxed);
}

std::string DeviceIdToHex(const ma_device_id& id) {
  // The union's raw bytes, hex-encoded: stable for a given device across
  // sessions (WASAPI ids are endpoint GUID strings underneath).
  const auto* bytes = reinterpret_cast<const unsigned char*>(&id);
  char buf[3];
  std::string out;
  out.reserve(sizeof(ma_device_id) * 2);
  for (size_t i = 0; i < sizeof(ma_device_id); i++) {
    std::snprintf(buf, sizeof(buf), "%02x", bytes[i]);
    out += buf;
  }
  return out;
}

bool HexToDeviceId(const std::string& hex, ma_device_id* out) {
  if (hex.size() != sizeof(ma_device_id) * 2) return false;
  auto* bytes = reinterpret_cast<unsigned char*>(out);
  for (size_t i = 0; i < sizeof(ma_device_id); i++) {
    unsigned value = 0;
    if (std::sscanf(hex.c_str() + i * 2, "%02x", &value) != 1) return false;
    bytes[i] = static_cast<unsigned char>(value);
  }
  return true;
}

Napi::Error MakeError(Napi::Env env, const char* what, ma_result result) {
  std::string message = std::string(what) + ": " + ma_result_description(result);
  return Napi::Error::New(env, message);
}

HostState* EnsureHost(Napi::Env env) {
  if (g_host == nullptr) g_host = new HostState();
  if (!g_host->contextReady) {
    ma_context_config config = ma_context_config_init();
    // Keep the callback path clean: no automatic thread priority games
    // beyond miniaudio's defaults (it already asks for pro-audio class).
    ma_result result = ma_context_init(nullptr, 0, &config, &g_host->context);
    if (result != MA_SUCCESS) {
      MakeError(env, "context init failed", result).ThrowAsJavaScriptException();
      return nullptr;
    }
    g_host->contextReady = true;
  }
  return g_host;
}

/** init() → backend name ("wasapi" expected on Windows). */
Napi::Value Init(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HostState* host = EnsureHost(env);
  if (!host) return env.Undefined();
  return Napi::String::New(env, ma_get_backend_name(host->context.backend));
}

/** enumerateDevices() → [{id, label, kind, isDefault}] */
Napi::Value EnumerateDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HostState* host = EnsureHost(env);
  if (!host) return env.Undefined();

  ma_device_info* playback = nullptr;
  ma_uint32 playbackCount = 0;
  ma_device_info* capture = nullptr;
  ma_uint32 captureCount = 0;
  ma_result result =
      ma_context_get_devices(&host->context, &playback, &playbackCount, &capture, &captureCount);
  if (result != MA_SUCCESS) {
    MakeError(env, "device enumeration failed", result).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array out = Napi::Array::New(env);
  uint32_t index = 0;
  auto push = [&](const ma_device_info& device, const char* kind) {
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("id", DeviceIdToHex(device.id));
    entry.Set("label", Napi::String::New(env, device.name));
    entry.Set("kind", kind);
    entry.Set("isDefault", static_cast<bool>(device.isDefault));
    out.Set(index++, entry);
  };
  for (ma_uint32 i = 0; i < playbackCount; i++) push(playback[i], "output");
  for (ma_uint32 i = 0; i < captureCount; i++) push(capture[i], "input");
  return out;
}

/**
 * start({deviceId?, sampleRate?, bufferFrames?, exclusive?}) →
 *   {sampleRate, outputChannels, periodFrames, periodCount, exclusive}
 *
 * periodFrames is the GRANTED period (drivers negotiate; report the
 * truth, per the design's "driver zoo" mitigation). Idempotent-ish: an
 * already-running device is stopped and reopened with the new settings.
 */
Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HostState* host = EnsureHost(env);
  if (!host) return env.Undefined();

  ma_device_id deviceId{};
  bool haveDeviceId = false;
  uint32_t requestedRate = 0;
  uint32_t requestedFrames = 0;
  bool exclusive = false;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("deviceId") && opts.Get("deviceId").IsString()) {
      haveDeviceId = HexToDeviceId(opts.Get("deviceId").As<Napi::String>(), &deviceId);
    }
    if (opts.Has("sampleRate") && opts.Get("sampleRate").IsNumber()) {
      requestedRate = opts.Get("sampleRate").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("bufferFrames") && opts.Get("bufferFrames").IsNumber()) {
      requestedFrames = opts.Get("bufferFrames").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("exclusive") && opts.Get("exclusive").IsBoolean()) {
      exclusive = opts.Get("exclusive").As<Napi::Boolean>();
    }
  }

  if (host->deviceReady) {
    ma_device_uninit(&host->device);
    host->deviceReady = false;
  }

  ma_device_config config = ma_device_config_init(ma_device_type_playback);
  config.playback.format = ma_format_f32;
  config.playback.channels = 2;
  if (haveDeviceId) config.playback.pDeviceID = &deviceId;
  if (requestedRate > 0) config.sampleRate = requestedRate;
  if (requestedFrames > 0) config.periodSizeInFrames = requestedFrames;
  // The design's default: WASAPI shared with IAudioClient3 low-latency
  // periods. Exclusive mode is the opt-in "lowest latency" toggle.
  config.performanceProfile = ma_performance_profile_low_latency;
  config.wasapi.usage = ma_wasapi_usage_pro_audio;
  if (exclusive) config.playback.shareMode = ma_share_mode_exclusive;
  config.dataCallback = DataCallback;
  config.pUserData = host;

  ma_result result = ma_device_init(&host->context, &config, &host->device);
  if (result != MA_SUCCESS && exclusive) {
    // Exclusive negotiation fails on plenty of drivers — fall back to
    // shared rather than failing the start (the caller sees which via
    // the returned `exclusive` flag).
    exclusive = false;
    config.playback.shareMode = ma_share_mode_shared;
    result = ma_device_init(&host->context, &config, &host->device);
  }
  if (result != MA_SUCCESS) {
    MakeError(env, "device init failed", result).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  host->sampleRate = host->device.sampleRate;
  host->channels = host->device.playback.channels;
  host->periodFrames = host->device.playback.internalPeriodSizeInFrames;
  host->periodCount = host->device.playback.internalPeriods;
  host->framesRendered.store(0);
  host->callbacks.store(0);
  host->xruns.store(0);
  host->tonePhase = 0.0;

  result = ma_device_start(&host->device);
  if (result != MA_SUCCESS) {
    ma_device_uninit(&host->device);
    MakeError(env, "device start failed", result).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  host->deviceReady = true;

  Napi::Object out = Napi::Object::New(env);
  out.Set("sampleRate", host->sampleRate);
  out.Set("outputChannels", host->channels);
  out.Set("periodFrames", host->periodFrames);
  out.Set("periodCount", host->periodCount);
  out.Set("exclusive", exclusive);
  return out;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_host != nullptr && g_host->deviceReady) {
    ma_device_uninit(&g_host->device);
    g_host->deviceReady = false;
  }
  return env.Undefined();
}

/** now() → stream time in seconds (rendered frames / sample rate). */
Napi::Value Now(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_host == nullptr || g_host->sampleRate == 0) return Napi::Number::New(env, 0);
  const double frames = static_cast<double>(g_host->framesRendered.load(std::memory_order_relaxed));
  return Napi::Number::New(env, frames / static_cast<double>(g_host->sampleRate));
}

/**
 * latencySec() → the output buffer depth (period × count / rate): what the
 * stream clock leads the speaker by. The loopback calibration measures
 * the true end-to-end figure on top of this, exactly as with Web Audio.
 */
Napi::Value LatencySec(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_host == nullptr || g_host->sampleRate == 0) return Napi::Number::New(env, 0);
  const double frames = static_cast<double>(g_host->periodFrames) * g_host->periodCount;
  return Napi::Number::New(env, frames / static_cast<double>(g_host->sampleRate));
}

Napi::Value Stats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  if (g_host == nullptr) return out;
  out.Set("framesRendered",
          Napi::Number::New(env, static_cast<double>(g_host->framesRendered.load())));
  out.Set("callbacks", Napi::Number::New(env, static_cast<double>(g_host->callbacks.load())));
  out.Set("xruns", Napi::Number::New(env, static_cast<double>(g_host->xruns.load())));
  out.Set("lastCallbackFrames", g_host->lastCallbackFrames.load());
  out.Set("running", g_host->deviceReady);
  return out;
}

/** setTestTone(freqHz, gain) — the stage-1 render source (0 gain = off). */
Napi::Value SetTestTone(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_host == nullptr) return env.Undefined();
  const double freq = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>() : 0.0;
  const double gain = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>() : 0.0;
  g_host->toneFreq.store(freq, std::memory_order_relaxed);
  g_host->toneGain.store(gain < 0 ? 0 : (gain > 1 ? 1 : gain), std::memory_order_relaxed);
  return env.Undefined();
}

}  // namespace

static Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("enumerateDevices", Napi::Function::New(env, EnumerateDevices));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("now", Napi::Function::New(env, Now));
  exports.Set("latencySec", Napi::Function::New(env, LatencySec));
  exports.Set("stats", Napi::Function::New(env, Stats));
  exports.Set("setTestTone", Napi::Function::New(env, SetTestTone));
  return exports;
}

NODE_API_MODULE(audiohost, InitModule)
