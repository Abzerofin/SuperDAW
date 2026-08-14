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

#include "engine.h"
#include "miniaudio.h"

namespace {

constexpr double kTau = 6.283185307179586476925286766559;

struct HostState {
  ma_context context{};
  bool contextReady = false;

  ma_device device{};
  bool deviceReady = false;

  sdengine::Engine engine;

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
  float engineBlock[sdengine::kBlockFrames * 2] = {};

  uint32_t sampleRate = 0;
  uint32_t channels = 0;
  uint32_t periodFrames = 0;
  uint32_t periodCount = 0;
};

HostState* g_host = nullptr;

/*
 * The realtime callback: the engine renders in kBlockFrames slices
 * (WASAPI shared delivers variable frame counts; the engine's block size
 * is its own), the stream time deriving from the rendered-frame counter.
 * The stage-1 test tone remains as an additive debug source. Frame-count
 * irregularity is tracked as a health signal, not treated as an error.
 */
void DataCallback(ma_device* device, void* output, const void* /*input*/, ma_uint32 frameCount) {
  auto* host = static_cast<HostState*>(device->pUserData);
  auto* out = static_cast<float*>(output);
  const uint32_t channels = host->channels;
  const double sampleRate = static_cast<double>(host->sampleRate);

  std::memset(out, 0, sizeof(float) * frameCount * channels);

  uint64_t framesDone = host->framesRendered.load(std::memory_order_relaxed);
  ma_uint32 offset = 0;
  while (offset < frameCount) {
    const ma_uint32 n =
        std::min<ma_uint32>(sdengine::kBlockFrames, frameCount - offset);
    const double blockTime = static_cast<double>(framesDone + offset) / sampleRate;
    host->engine.RenderBlock(blockTime, n, sampleRate, host->engineBlock);
    for (ma_uint32 i = 0; i < n; i++) {
      for (uint32_t ch = 0; ch < channels; ch++) {
        out[(offset + i) * channels + ch] +=
            host->engineBlock[i * 2 + (ch < 2 ? ch : 1)];
      }
    }
    offset += n;
  }

  const double gain = host->toneGain.load(std::memory_order_relaxed);
  const double freq = host->toneFreq.load(std::memory_order_relaxed);
  if (gain > 0.0 && freq > 0.0 && host->sampleRate > 0) {
    const double step = kTau * freq / sampleRate;
    double phase = host->tonePhase;
    for (ma_uint32 i = 0; i < frameCount; i++) {
      const float sample = static_cast<float>(gain * std::sin(phase));
      phase += step;
      if (phase > kTau) phase -= kTau;
      for (uint32_t ch = 0; ch < channels; ch++) out[i * channels + ch] += sample;
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

// ------------------------------------------------------------ the engine

sdengine::Engine& EngineOf(Napi::Env env) {
  if (g_host == nullptr) g_host = new HostState();
  return g_host->engine;
}

sdengine::ParamEvent UnpackEvent(const Napi::Object& raw) {
  sdengine::ParamEvent event{};
  const std::string kind = raw.Get("kind").As<Napi::String>();
  auto num = [&](const char* key) -> double {
    return raw.Has(key) && raw.Get(key).IsNumber() ? raw.Get(key).As<Napi::Number>() : 0.0;
  };
  if (kind == "setValue") {
    event.kind = sdengine::ParamEventKind::SetValue;
    event.value = num("value");
    event.time = num("time");
  } else if (kind == "linearRamp") {
    event.kind = sdengine::ParamEventKind::LinearRamp;
    event.value = num("value");
    event.endTime = num("endTime");
  } else if (kind == "setTarget") {
    event.kind = sdengine::ParamEventKind::SetTarget;
    event.value = num("value");
    event.time = num("time");
    event.timeConstant = num("timeConstant");
  } else if (kind == "setCurve") {
    event.kind = sdengine::ParamEventKind::SetCurve;
    event.time = num("time");
    event.duration = num("duration");
    if (raw.Has("curve") && raw.Get("curve").IsTypedArray()) {
      auto curve = raw.Get("curve").As<Napi::Float32Array>();
      event.curve.assign(curve.Data(), curve.Data() + curve.ElementLength());
    }
  } else {
    event.kind = sdengine::ParamEventKind::Cancel;
    event.time = num("afterTime");
  }
  return event;
}

/** createNode(id, kind, opts?) — ids are caller-minted (≥ 1); opts.type
 *  configures a biquad's filter type. */
Napi::Value CreateNode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const uint32_t id = info[0].As<Napi::Number>().Uint32Value();
  const std::string kind = info[1].As<Napi::String>();
  std::string biquadType;
  double maxDelay = 1;
  if (info.Length() > 2 && info[2].IsObject()) {
    auto opts = info[2].As<Napi::Object>();
    if (opts.Has("type") && opts.Get("type").IsString()) {
      biquadType = opts.Get("type").As<Napi::String>();
    }
    if (opts.Has("maxDelay") && opts.Get("maxDelay").IsNumber()) {
      maxDelay = opts.Get("maxDelay").As<Napi::Number>().DoubleValue();
    }
  }
  const sdengine::NodeKind nodeKind =
      kind == "stereoPanner" ? sdengine::NodeKind::Panner
      : kind == "biquad"     ? sdengine::NodeKind::Biquad
      : kind == "delay"      ? sdengine::NodeKind::Delay
      : kind == "compressor" ? sdengine::NodeKind::Compressor
                             : sdengine::NodeKind::Gain;
  EngineOf(env).CreateNode(id, nodeKind, biquadType, maxDelay);
  return env.Undefined();
}

/** configureNode(id, opts) — instant attribute changes (biquad type). */
Napi::Value ConfigureNode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const uint32_t id = info[0].As<Napi::Number>().Uint32Value();
  if (info.Length() > 1 && info[1].IsObject()) {
    auto opts = info[1].As<Napi::Object>();
    if (opts.Has("type") && opts.Get("type").IsString()) {
      EngineOf(env).ConfigureNode(id, opts.Get("type").As<Napi::String>());
    }
  }
  return env.Undefined();
}

Napi::Value ConnectNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EngineOf(env).Connect(info[0].As<Napi::Number>().Uint32Value(),
                        info[1].As<Napi::Number>().Uint32Value());
  return env.Undefined();
}

Napi::Value DisconnectNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool haveTo = info.Length() > 1 && info[1].IsNumber();
  EngineOf(env).Disconnect(info[0].As<Napi::Number>().Uint32Value(), haveTo,
                           haveTo ? info[1].As<Napi::Number>().Uint32Value() : 0);
  return env.Undefined();
}

Napi::Value DisposeNode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EngineOf(env).DisposeNode(info[0].As<Napi::Number>().Uint32Value());
  return env.Undefined();
}

/** scheduleParam(nodeId, paramName, events[]) — names resolve per kind. */
Napi::Value ScheduleParam(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const uint32_t node = info[0].As<Napi::Number>().Uint32Value();
  const std::string param = info[1].As<Napi::String>();
  auto events = info[2].As<Napi::Array>();
  for (uint32_t i = 0; i < events.Length(); i++) {
    EngineOf(env).ScheduleParam(node, param, UnpackEvent(events.Get(i).As<Napi::Object>()));
  }
  return env.Undefined();
}

/** registerBuffer(id, channels: Float32Array[], sampleRate) — copies. */
Napi::Value RegisterBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string id = info[0].As<Napi::String>();
  auto channels = info[1].As<Napi::Array>();
  auto buffer = std::make_shared<sdengine::SharedBuffer>();
  buffer->sampleRate = info[2].As<Napi::Number>().DoubleValue();
  for (uint32_t ch = 0; ch < channels.Length(); ch++) {
    auto data = channels.Get(ch).As<Napi::Float32Array>();
    buffer->channels.emplace_back(data.Data(), data.Data() + data.ElementLength());
  }
  EngineOf(env).RegisterBuffer(id, std::move(buffer));
  return env.Undefined();
}

Napi::Value HasBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::Boolean::New(env, EngineOf(env).HasBuffer(info[0].As<Napi::String>()));
}

Napi::Value ReleaseBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EngineOf(env).ReleaseBuffer(info[0].As<Napi::String>());
  return env.Undefined();
}

/** play({id, bufferId, when, offsetSec?, durationSec?, rate?, destination})
 *  → false when the buffer is unknown (caller-minted voice ids). */
Napi::Value PlayVoice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto spec = info[0].As<Napi::Object>();
  auto num = [&](const char* key, double fallback) -> double {
    return spec.Has(key) && spec.Get(key).IsNumber() ? spec.Get(key).As<Napi::Number>()
                                                     : fallback;
  };
  const bool ok = EngineOf(env).Play(
      spec.Get("id").As<Napi::Number>().Uint32Value(), spec.Get("bufferId").As<Napi::String>(),
      num("when", 0), num("offsetSec", 0), num("durationSec", -1), num("rate", 1),
      spec.Get("destination").As<Napi::Number>().Uint32Value());
  return Napi::Boolean::New(env, ok);
}

Napi::Value StopVoice(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const double atTime =
      info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : -1;
  EngineOf(env).StopVoice(info[0].As<Napi::Number>().Uint32Value(), atTime);
  return env.Undefined();
}

/** createTap(id, nodeId, frames) — ids are caller-minted. */
Napi::Value CreateTap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EngineOf(env).CreateTap(info[0].As<Napi::Number>().Uint32Value(),
                          info[1].As<Napi::Number>().Uint32Value(),
                          info[2].As<Napi::Number>().Uint32Value());
  return env.Undefined();
}

/** readTap(id, out: Float32Array) → bool */
Napi::Value ReadTap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto out = info[1].As<Napi::Float32Array>();
  const bool ok = EngineOf(env).ReadTap(info[0].As<Napi::Number>().Uint32Value(), out.Data(),
                                        out.ElementLength());
  return Napi::Boolean::New(env, ok);
}

Napi::Value DisposeTap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EngineOf(env).DisposeTap(info[0].As<Napi::Number>().Uint32Value());
  return env.Undefined();
}

Napi::Value DrainEnded(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const auto ended = EngineOf(env).DrainEnded();
  Napi::Array out = Napi::Array::New(env, ended.size());
  for (size_t i = 0; i < ended.size(); i++) out.Set(i, ended[i]);
  return out;
}

/**
 * renderOffline(startTime, frames, sampleRate) → Float32Array (stereo
 * interleaved). The verification hook: the identical engine renders on
 * the JS thread, so Node tests (and the parity harness) can diff its
 * output numerically. Only valid while the device is stopped.
 */
Napi::Value RenderOffline(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_host != nullptr && g_host->deviceReady) {
    Napi::Error::New(env, "renderOffline requires a stopped device")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double startTime = info[0].As<Napi::Number>().DoubleValue();
  const uint32_t frames = info[1].As<Napi::Number>().Uint32Value();
  const double sampleRate = info[2].As<Napi::Number>().DoubleValue();
  auto out = Napi::Float32Array::New(env, static_cast<size_t>(frames) * 2);
  EngineOf(env).RenderOffline(startTime, frames, sampleRate, out.Data());
  return out;
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
  exports.Set("createNode", Napi::Function::New(env, CreateNode));
  exports.Set("configureNode", Napi::Function::New(env, ConfigureNode));
  exports.Set("connect", Napi::Function::New(env, ConnectNodes));
  exports.Set("disconnect", Napi::Function::New(env, DisconnectNodes));
  exports.Set("disposeNode", Napi::Function::New(env, DisposeNode));
  exports.Set("scheduleParam", Napi::Function::New(env, ScheduleParam));
  exports.Set("registerBuffer", Napi::Function::New(env, RegisterBuffer));
  exports.Set("hasBuffer", Napi::Function::New(env, HasBuffer));
  exports.Set("releaseBuffer", Napi::Function::New(env, ReleaseBuffer));
  exports.Set("play", Napi::Function::New(env, PlayVoice));
  exports.Set("stopVoice", Napi::Function::New(env, StopVoice));
  exports.Set("createTap", Napi::Function::New(env, CreateTap));
  exports.Set("readTap", Napi::Function::New(env, ReadTap));
  exports.Set("disposeTap", Napi::Function::New(env, DisposeTap));
  exports.Set("drainEnded", Napi::Function::New(env, DrainEnded));
  exports.Set("renderOffline", Napi::Function::New(env, RenderOffline));
  return exports;
}

NODE_API_MODULE(audiohost, InitModule)
