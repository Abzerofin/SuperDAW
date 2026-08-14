// VST3 hosting for SuperDAW.
//
// Two processing modes share one setup path:
//
//   processBuffer()  one-shot, whole buffer, plugin created and destroyed.
//                    Used by the freeze/render path.
//   openInstance()   a PERSISTENT plugin that survives across calls, so
//                    consecutive chunks continue each other's state. Live
//                    playback streams chunks through these; without state
//                    continuity a reverb tail or delay feedback would reset
//                    at every chunk boundary, which is plainly audible.
//
// A third mode, openRealtime(), shares the same setup path but is driven
// from ANOTHER addon's audio callback rather than from JS — see the
// "Realtime instances" section and native/shared/vst3bridge.h.
//
// Identity only ever crosses the boundary as descriptor fields — never a
// filesystem path from the document. See native/README.md.

#include <napi.h>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include <algorithm>
#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "vst3bridge.h"

#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/vsttypes.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "public.sdk/source/vst/utility/uid.h"

namespace {

using namespace Steinberg;
using namespace Steinberg::Vst;

// A VST3 processor class, as opposed to the controller/other classes a
// bundle may also export. Only these become inserts.
constexpr const char* kAudioModuleClass = "Audio Module Class";

// One host application instance, shared by every plugin we instantiate.
// Plugins query it for the host's name and for interface support.
HostApplication& hostContext() {
  static HostApplication instance;
  return instance;
}

Napi::Object Fail(Napi::Env env, const std::string& message) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("error", Napi::String::New(env, message));
  return result;
}

std::string FromString128(const String128 text) {
  std::u16string wide;
  for (int i = 0; i < 128 && text[i] != 0; ++i) {
    wide.push_back(static_cast<char16_t>(text[i]));
  }
  return VST3::StringConvert::convert(wide);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

Napi::Array ScanPaths(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto paths = VST3::Hosting::Module::getModulePaths();
  Napi::Array out = Napi::Array::New(env, paths.size());
  for (size_t i = 0; i < paths.size(); ++i) {
    out.Set(i, Napi::String::New(env, paths[i]));
  }
  return out;
}

// Open one bundle and describe the audio-processor classes it exports.
// Returns { path, error?, classes: [...] } — a load failure is DATA, not
// a thrown exception: one broken plugin in a scan must never abort the
// whole scan or take the app down with it.
Napi::Object Inspect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (info.Length() < 1 || !info[0].IsString()) {
    result.Set("error", Napi::String::New(env, "expected a path string"));
    return result;
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();
  result.Set("path", Napi::String::New(env, path));

  std::string error;
  auto module = VST3::Hosting::Module::create(path, error);
  if (!module) {
    result.Set("error", Napi::String::New(env, error.empty()
                                                   ? "failed to load module"
                                                   : error));
    return result;
  }

  const auto factory = module->getFactory();
  const auto factoryInfo = factory.info();

  Napi::Array classes = Napi::Array::New(env);
  uint32_t emitted = 0;
  for (const auto& classInfo : factory.classInfos()) {
    if (classInfo.category() != kAudioModuleClass) continue;

    Napi::Object entry = Napi::Object::New(env);
    entry.Set("uid", Napi::String::New(env, classInfo.ID().toString()));
    entry.Set("name", Napi::String::New(env, classInfo.name()));
    // A class may omit its vendor; the factory's vendor is the fallback.
    const std::string vendor =
        classInfo.vendor().empty() ? factoryInfo.vendor() : classInfo.vendor();
    entry.Set("vendor", Napi::String::New(env, vendor));
    entry.Set("version", Napi::String::New(env, classInfo.version()));
    entry.Set("sdkVersion", Napi::String::New(env, classInfo.sdkVersion()));
    entry.Set("subCategories",
              Napi::String::New(env, classInfo.subCategoriesString()));
    classes.Set(emitted++, entry);
  }

  result.Set("classes", classes);
  return result;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * A plugin's edit controller, which owns its parameter list. It may be a
 * separate class (getControllerClassId) or the component itself for
 * single-component effects — both shapes are real and must be handled.
 */
IPtr<IEditController> MakeController(const VST3::Hosting::PluginFactory& factory,
                                     IComponent* component, bool& ownsController) {
  ownsController = false;
  TUID controllerCid;
  if (component->getControllerClassId(controllerCid) == kResultOk) {
    auto controller =
        factory.createInstance<IEditController>(VST3::UID(controllerCid));
    if (controller) {
      if (controller->initialize(&hostContext()) != kResultOk) return nullptr;
      ownsController = true;
      return controller;
    }
  }
  // Single-component effect: the component IS the controller, and is
  // already initialized — do not initialize it a second time.
  FUnknownPtr<IEditController> embedded(component);
  return embedded ? IPtr<IEditController>(embedded) : nullptr;
}

// parameters(path, uid) -> { error?, parameters: [...] }
//
// Values are VST3 NORMALIZED (0..1); the plugin owns the mapping to real
// units, which is why `display` comes back as the plugin's own formatted
// string rather than something we compute.
Napi::Object Parameters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    return Fail(env, "expected (path, uid)");
  }
  const std::string path = info[0].As<Napi::String>().Utf8Value();
  auto parsedUid = VST3::UID::fromString(info[1].As<Napi::String>().Utf8Value());
  if (!parsedUid) return Fail(env, "could not parse uid");

  std::string moduleError;
  auto module = VST3::Hosting::Module::create(path, moduleError);
  if (!module) return Fail(env, moduleError.empty() ? "failed to load" : moduleError);

  const auto factory = module->getFactory();
  factory.setHostContext(&hostContext());
  auto component = factory.createInstance<IComponent>(*parsedUid);
  if (!component) return Fail(env, "could not create component");
  if (component->initialize(&hostContext()) != kResultOk) {
    return Fail(env, "component->initialize failed");
  }

  bool ownsController = false;
  auto controller = MakeController(factory, component, ownsController);
  if (!controller) {
    component->terminate();
    return Fail(env, "plugin exposes no IEditController");
  }

  Napi::Array list = Napi::Array::New(env);
  uint32_t emitted = 0;
  const int32 count = controller->getParameterCount();
  for (int32 i = 0; i < count; ++i) {
    ParameterInfo pinfo{};
    if (controller->getParameterInfo(i, pinfo) != kResultOk) continue;
    // Read-only meters/outputs are not things a user sets.
    if (pinfo.flags & ParameterInfo::kIsReadOnly) continue;

    String128 display{};
    controller->getParamStringByValue(pinfo.id, pinfo.defaultNormalizedValue, display);

    Napi::Object entry = Napi::Object::New(env);
    entry.Set("id", Napi::Number::New(env, static_cast<double>(pinfo.id)));
    entry.Set("title", Napi::String::New(env, FromString128(pinfo.title)));
    entry.Set("units", Napi::String::New(env, FromString128(pinfo.units)));
    entry.Set("defaultNormalized",
              Napi::Number::New(env, pinfo.defaultNormalizedValue));
    entry.Set("stepCount", Napi::Number::New(env, pinfo.stepCount));
    entry.Set("defaultDisplay", Napi::String::New(env, FromString128(display)));
    entry.Set("isBypass",
              Napi::Boolean::New(env, (pinfo.flags & ParameterInfo::kIsBypass) != 0));
    entry.Set("canAutomate",
              Napi::Boolean::New(env, (pinfo.flags & ParameterInfo::kCanAutomate) != 0));
    list.Set(emitted++, entry);
  }

  if (ownsController) controller->terminate();
  component->terminate();

  Napi::Object result = Napi::Object::New(env);
  result.Set("parameters", list);
  return result;
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

/**
 * A live plugin: module, component and processor kept together because the
 * module must outlive everything loaded from it. Scratch buffers are sized
 * once so per-block processing allocates nothing.
 */
struct Instance {
  VST3::Hosting::Module::Ptr module;
  IPtr<IComponent> component;
  IPtr<IAudioProcessor> processor;
  int32 blockSize = 512;
  int32 inChannels = 0;
  int32 outChannels = 0;
  int32 inBusCount = 0;
  int32 processMode = kRealtime;
  /**
   * The plugin's own reported delay, in samples, read AFTER activation
   * (the point the spec says it is valid). This is what plugin-delay
   * compensation compensates: a look-ahead limiter or a linear-phase EQ
   * answers with thousands of samples here, and everything else in the
   * mix has to wait for it. Read once — a plugin may in principle change
   * it and call restartComponent(kLatencyChanged), which this host does
   * not yet chase.
   */
  int32 latency = 0;

  std::vector<std::vector<float>> inBlock, outBlock;
  std::vector<float*> inPtrs, outPtrs;

  ~Instance() {
    if (processor) processor->setProcessing(false);
    if (component) {
      component->setActive(false);
      component->terminate();
    }
  }
};

/**
 * Restore a previously captured component state chunk. Applied after
 * setupProcessing and before activation, the safest point in the VST3
 * setup sequence. Failure is non-fatal: a plugin that rejects an old or
 * foreign chunk keeps its defaults, which is what every other host does.
 */
void ApplyState(IComponent* component, const char* data, size_t size) {
  if (!data || size == 0) return;
  MemoryStream stream(const_cast<char*>(data), static_cast<TSize>(size));
  int64 pos = 0;
  stream.seek(0, IBStream::kIBSeekSet, &pos);
  component->setState(&stream);
}

/** The optional `state` Buffer out of an options object, or empty. */
std::vector<char> ReadStateOption(const Napi::Object& options) {
  if (!options.Has("state") || !options.Get("state").IsBuffer()) return {};
  Napi::Buffer<char> buf = options.Get("state").As<Napi::Buffer<char>>();
  return std::vector<char>(buf.Data(), buf.Data() + buf.Length());
}

/** Instantiate, negotiate buses, and activate. Null on failure. */
std::unique_ptr<Instance> CreateInstance(const std::string& path,
                                         const VST3::UID& uid, double sampleRate,
                                         int32 blockSize, int32 wantChannels,
                                         int32 processMode, std::string& error,
                                         const std::vector<char>& stateChunk = {}) {
  auto state = std::make_unique<Instance>();
  state->blockSize = blockSize;
  state->processMode = processMode;

  state->module = VST3::Hosting::Module::create(path, error);
  if (!state->module) {
    if (error.empty()) error = "failed to load module";
    return nullptr;
  }

  const auto factory = state->module->getFactory();
  factory.setHostContext(&hostContext());
  state->component = factory.createInstance<IComponent>(uid);
  if (!state->component) {
    error = "could not create component";
    return nullptr;
  }
  if (state->component->initialize(&hostContext()) != kResultOk) {
    error = "component->initialize failed";
    state->component = nullptr; // nothing to terminate
    return nullptr;
  }

  FUnknownPtr<IAudioProcessor> processor(state->component);
  if (!processor) {
    error = "plugin exposes no IAudioProcessor";
    return nullptr;
  }
  state->processor = IPtr<IAudioProcessor>(processor);

  if (state->processor->canProcessSampleSize(kSample32) != kResultOk) {
    error = "plugin does not support 32-bit float processing";
    return nullptr;
  }

  SpeakerArrangement arrangement =
      wantChannels >= 2 ? SpeakerArr::kStereo : SpeakerArr::kMono;
  state->inBusCount = state->component->getBusCount(kAudio, kInput);
  const int32 outBusCount = state->component->getBusCount(kAudio, kOutput);
  if (outBusCount < 1) {
    error = "plugin has no audio output bus";
    return nullptr;
  }

  std::vector<SpeakerArrangement> inArr(
      state->inBusCount > 0 ? state->inBusCount : 0, arrangement);
  std::vector<SpeakerArrangement> outArr(outBusCount, arrangement);
  // A refusal is not fatal — the plugin keeps its own default layout, which
  // we read back below rather than assuming ours won.
  state->processor->setBusArrangements(inArr.empty() ? nullptr : inArr.data(),
                                       state->inBusCount, outArr.data(),
                                       outBusCount);

  SpeakerArrangement actualOut = arrangement;
  state->processor->getBusArrangement(kOutput, 0, actualOut);
  state->outChannels = SpeakerArr::getChannelCount(actualOut);
  if (state->outChannels < 1) {
    error = "plugin reported zero output channels";
    return nullptr;
  }
  if (state->inBusCount > 0) {
    SpeakerArrangement actualIn = arrangement;
    state->processor->getBusArrangement(kInput, 0, actualIn);
    state->inChannels = SpeakerArr::getChannelCount(actualIn);
  }

  ProcessSetup setup{};
  setup.processMode = processMode;
  setup.symbolicSampleSize = kSample32;
  setup.maxSamplesPerBlock = blockSize;
  setup.sampleRate = sampleRate;
  if (state->processor->setupProcessing(setup) != kResultOk) {
    error = "setupProcessing failed";
    return nullptr;
  }

  ApplyState(state->component, stateChunk.data(), stateChunk.size());

  // Main buses only; sidechains/aux stay silent for now.
  for (int32 bus = 0; bus < state->inBusCount; ++bus) {
    state->component->activateBus(kAudio, kInput, bus, bus == 0);
  }
  for (int32 bus = 0; bus < outBusCount; ++bus) {
    state->component->activateBus(kAudio, kOutput, bus, bus == 0);
  }
  if (state->component->setActive(true) != kResultOk) {
    error = "setActive failed";
    return nullptr;
  }
  state->processor->setProcessing(true);
  state->latency = state->processor->getLatencySamples();

  state->inBlock.assign(std::max(state->inChannels, 0),
                        std::vector<float>(blockSize, 0.f));
  state->outBlock.assign(state->outChannels, std::vector<float>(blockSize, 0.f));
  state->inPtrs.resize(state->inBlock.size());
  state->outPtrs.resize(state->outBlock.size());
  for (size_t i = 0; i < state->inBlock.size(); ++i) {
    state->inPtrs[i] = state->inBlock[i].data();
  }
  for (size_t i = 0; i < state->outBlock.size(); ++i) {
    state->outPtrs[i] = state->outBlock[i].data();
  }
  return state;
}

/** Reads a JS Float32Array[] into contiguous per-channel storage. */
bool ReadChannels(const Napi::Array& jsChannels, std::vector<std::vector<float>>& out,
                  size_t& frames, std::string& error) {
  const uint32_t count = jsChannels.Length();
  if (count == 0) {
    error = "channels must not be empty";
    return false;
  }
  out.resize(count);
  frames = 0;
  for (uint32_t ch = 0; ch < count; ++ch) {
    Napi::Value value = jsChannels.Get(ch);
    if (!value.IsTypedArray()) {
      error = "each channel must be a Float32Array";
      return false;
    }
    Napi::TypedArray typed = value.As<Napi::TypedArray>();
    if (typed.TypedArrayType() != napi_float32_array) {
      error = "each channel must be a Float32Array";
      return false;
    }
    Napi::Float32Array data = value.As<Napi::Float32Array>();
    if (ch == 0) {
      frames = data.ElementLength();
    } else if (data.ElementLength() != frames) {
      error = "all channels must be the same length";
      return false;
    }
    out[ch].assign(data.Data(), data.Data() + data.ElementLength());
  }
  return frames > 0;
}

/** Parameter values as a change at sample 0. Values are normalized 0..1. */
void FillParamChanges(const Napi::Object& options, ParameterChanges& changes) {
  if (!options.Has("params") || !options.Get("params").IsObject()) return;
  Napi::Object params = options.Get("params").As<Napi::Object>();
  Napi::Array ids = params.GetPropertyNames();
  for (uint32_t i = 0; i < ids.Length(); ++i) {
    Napi::Value key = ids.Get(i);
    ParamID id = 0;
    try {
      id = static_cast<ParamID>(std::stoul(key.ToString().Utf8Value()));
    } catch (...) {
      continue; // a non-numeric key is not a VST3 parameter id
    }
    const double value = params.Get(key).ToNumber().DoubleValue();
    int32 queueIndex = 0;
    if (auto* queue = changes.addParameterData(id, queueIndex)) {
      int32 pointIndex = 0;
      queue->addPoint(0, std::min(1.0, std::max(0.0, value)), pointIndex);
    }
  }
}

/** Push `frames` of `input` through `state`, returning per-channel output. */
std::vector<std::vector<float>> RunBlocks(Instance& state,
                                          const std::vector<std::vector<float>>& input,
                                          size_t frames,
                                          ParameterChanges& changes) {
  std::vector<std::vector<float>> output(state.outChannels,
                                         std::vector<float>(frames, 0.f));

  AudioBusBuffers inBuffers{};
  inBuffers.numChannels = static_cast<int32>(state.inBlock.size());
  inBuffers.channelBuffers32 = state.inPtrs.empty() ? nullptr : state.inPtrs.data();
  AudioBusBuffers outBuffers{};
  outBuffers.numChannels = state.outChannels;
  outBuffers.channelBuffers32 = state.outPtrs.data();

  ProcessData data{};
  data.processMode = state.processMode;
  data.symbolicSampleSize = kSample32;
  data.numInputs = state.inBusCount > 0 ? 1 : 0;
  data.numOutputs = 1;
  data.inputs = state.inBusCount > 0 ? &inBuffers : nullptr;
  data.outputs = &outBuffers;
  data.inputParameterChanges = &changes;

  for (size_t offset = 0; offset < frames; offset += state.blockSize) {
    const int32 n = static_cast<int32>(
        std::min<size_t>(state.blockSize, frames - offset));

    for (size_t ch = 0; ch < state.inBlock.size(); ++ch) {
      // Fewer real channels than the plugin asked for: reuse the last one
      // (mono into a stereo input) instead of feeding silence.
      const size_t src = std::min(ch, input.size() - 1);
      std::copy(input[src].begin() + offset, input[src].begin() + offset + n,
                state.inBlock[ch].begin());
      std::fill(state.inBlock[ch].begin() + n, state.inBlock[ch].end(), 0.f);
    }
    for (auto& channel : state.outBlock) std::fill(channel.begin(), channel.end(), 0.f);

    data.numSamples = n;
    if (state.processor->process(data) != kResultOk) return {};

    for (int32 ch = 0; ch < state.outChannels; ++ch) {
      std::copy(state.outBlock[ch].begin(), state.outBlock[ch].begin() + n,
                output[ch].begin() + offset);
    }
  }
  return output;
}

Napi::Array ToJsChannels(Napi::Env env,
                         const std::vector<std::vector<float>>& channels) {
  Napi::Array out = Napi::Array::New(env, channels.size());
  for (size_t ch = 0; ch < channels.size(); ++ch) {
    Napi::Float32Array arr = Napi::Float32Array::New(env, channels[ch].size());
    std::copy(channels[ch].begin(), channels[ch].end(), arr.Data());
    out.Set(static_cast<uint32_t>(ch), arr);
  }
  return out;
}

// processBuffer(path, uid, { channels, sampleRate, blockSize?, params? })
//   -> { channels, inputChannels, outputChannels } | { error }
//
// One-shot: the plugin is created and destroyed around the call, so there
// is no state to carry. Used by the freeze/render path.
Napi::Object ProcessBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsObject()) {
    return Fail(env, "expected (path, uid, options)");
  }
  const std::string path = info[0].As<Napi::String>().Utf8Value();
  Napi::Object options = info[2].As<Napi::Object>();
  if (!options.Has("channels") || !options.Get("channels").IsArray()) {
    return Fail(env, "options.channels must be a Float32Array[]");
  }
  auto parsedUid = VST3::UID::fromString(info[1].As<Napi::String>().Utf8Value());
  if (!parsedUid) return Fail(env, "could not parse uid");

  const double sampleRate = options.Has("sampleRate")
                                ? options.Get("sampleRate").ToNumber().DoubleValue()
                                : 48000.0;
  int32 blockSize = options.Has("blockSize")
                        ? options.Get("blockSize").ToNumber().Int32Value()
                        : 512;
  if (blockSize <= 0) blockSize = 512;

  std::vector<std::vector<float>> input;
  size_t frames = 0;
  std::string readError;
  if (!ReadChannels(options.Get("channels").As<Napi::Array>(), input, frames,
                    readError)) {
    return Fail(env, readError.empty() ? "empty input" : readError);
  }

  std::string error;
  auto state = CreateInstance(path, *parsedUid, sampleRate, blockSize,
                              static_cast<int32>(input.size()), kOffline, error,
                              ReadStateOption(options));
  if (!state) return Fail(env, error);

  ParameterChanges changes;
  FillParamChanges(options, changes);
  auto output = RunBlocks(*state, input, frames, changes);
  if (output.empty()) return Fail(env, "process() failed");

  Napi::Object result = Napi::Object::New(env);
  result.Set("channels", ToJsChannels(env, output));
  result.Set("inputChannels", Napi::Number::New(env, state->inChannels));
  result.Set("outputChannels", Napi::Number::New(env, state->outChannels));
  // The freeze path trims this off the head so a frozen track lands on the
  // grid rather than late by the plugin's own delay.
  result.Set("latencySamples", Napi::Number::New(env, state->latency));
  return result;
}

// ---------------------------------------------------------------------------
// Persistent instances (live playback)
// ---------------------------------------------------------------------------

std::map<int32_t, std::unique_ptr<Instance>> gInstances;
int32_t gNextHandle = 1;

// openInstance(path, uid, { sampleRate, blockSize?, channels? })
//   -> { handle, inputChannels, outputChannels } | { error }
Napi::Object OpenInstance(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsObject()) {
    return Fail(env, "expected (path, uid, options)");
  }
  const std::string path = info[0].As<Napi::String>().Utf8Value();
  auto parsedUid = VST3::UID::fromString(info[1].As<Napi::String>().Utf8Value());
  if (!parsedUid) return Fail(env, "could not parse uid");

  Napi::Object options = info[2].As<Napi::Object>();
  const double sampleRate = options.Has("sampleRate")
                                ? options.Get("sampleRate").ToNumber().DoubleValue()
                                : 48000.0;
  int32 blockSize = options.Has("blockSize")
                        ? options.Get("blockSize").ToNumber().Int32Value()
                        : 512;
  if (blockSize <= 0) blockSize = 512;
  int32 channels = options.Has("channels")
                       ? options.Get("channels").ToNumber().Int32Value()
                       : 2;
  if (channels <= 0) channels = 2;

  std::string error;
  auto state = CreateInstance(path, *parsedUid, sampleRate, blockSize, channels,
                              kRealtime, error, ReadStateOption(options));
  if (!state) return Fail(env, error);

  const int32_t handle = gNextHandle++;
  Napi::Object result = Napi::Object::New(env);
  result.Set("handle", Napi::Number::New(env, handle));
  result.Set("inputChannels", Napi::Number::New(env, state->inChannels));
  result.Set("outputChannels", Napi::Number::New(env, state->outChannels));
  result.Set("latencySamples", Napi::Number::New(env, state->latency));
  gInstances.emplace(handle, std::move(state));
  return result;
}

// processInstance(handle, { channels, params? }) -> { channels } | { error }
//
// The plugin's internal state CARRIES OVER between calls — that is the
// whole point. Chunk N+1 continues chunk N's reverb tail and delay lines.
Napi::Object ProcessInstance(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    return Fail(env, "expected (handle, options)");
  }
  const int32_t handle = info[0].As<Napi::Number>().Int32Value();
  auto found = gInstances.find(handle);
  if (found == gInstances.end()) return Fail(env, "unknown instance handle");

  Napi::Object options = info[1].As<Napi::Object>();
  if (!options.Has("channels") || !options.Get("channels").IsArray()) {
    return Fail(env, "options.channels must be a Float32Array[]");
  }
  std::vector<std::vector<float>> input;
  size_t frames = 0;
  std::string readError;
  if (!ReadChannels(options.Get("channels").As<Napi::Array>(), input, frames,
                    readError)) {
    return Fail(env, readError.empty() ? "empty input" : readError);
  }

  ParameterChanges changes;
  FillParamChanges(options, changes);
  auto output = RunBlocks(*found->second, input, frames, changes);
  if (output.empty()) return Fail(env, "process() failed");

  Napi::Object result = Napi::Object::New(env);
  result.Set("channels", ToJsChannels(env, output));
  return result;
}

// getInstanceState(handle) -> { component: Buffer } | { error }
//
// Captures the component's state chunk — the same bytes a .vst3 preset
// stores. Parameter changes applied during processing land in here, so a
// chunk captured from one instance and passed as `state` when opening
// another reproduces its settings exactly.
Napi::Object GetInstanceState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return Fail(env, "expected (handle)");
  }
  auto found = gInstances.find(info[0].As<Napi::Number>().Int32Value());
  if (found == gInstances.end()) return Fail(env, "unknown instance handle");

  MemoryStream stream;
  if (found->second->component->getState(&stream) != kResultOk) {
    return Fail(env, "plugin refused to serialize its state");
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("component",
             Napi::Buffer<char>::Copy(env, stream.getData(),
                                      static_cast<size_t>(stream.getSize())));
  return result;
}

// closeInstance(handle) -> { closed: boolean }
Napi::Object CloseInstance(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  if (info.Length() < 1 || !info[0].IsNumber()) {
    result.Set("closed", Napi::Boolean::New(env, false));
    return result;
  }
  const size_t erased =
      gInstances.erase(info[0].As<Napi::Number>().Int32Value());
  result.Set("closed", Napi::Boolean::New(env, erased > 0));
  return result;
}

// ---------------------------------------------------------------------------
// Realtime instances (live in-callback playback)
// ---------------------------------------------------------------------------
//
// Same plugin setup as openInstance, but driven from the AUDIO THREAD of a
// different addon (audiohost) through the plain C table in
// native/shared/vst3bridge.h. Nothing here may allocate, lock or call into
// JS on that path:
//
//   - Slots are a FIXED array. A std::map lookup racing an insert from the
//     JS thread would be undefined behaviour; an atomic pointer in a fixed
//     slot is not.
//   - `gRtBusy` is per SLOT, never per instance, so a teardown can wait for
//     an in-flight process() without the audio thread ever touching freed
//     memory (it takes the flag BEFORE it loads the pointer).
//   - Parameter changes cross a single-producer/single-consumer ring of
//     plain values; the ParameterChanges object is pre-sized at open, so
//     draining the ring reuses queues instead of allocating them.

struct RtParamChange {
  uint32_t id = 0;
  float value = 0;
};

/** Ring capacity. Overflow drops the OLDEST unread change (see Push). */
constexpr uint32_t kRtParamRing = 512;
/** Distinct parameters one block may carry without ParameterChanges growing. */
constexpr int32 kRtMaxParams = 256;

struct RtInstance {
  std::unique_ptr<Instance> instance;
  ParameterChanges changes{kRtMaxParams};

  RtParamChange ring[kRtParamRing];
  std::atomic<uint32_t> writeIndex{0};
  std::atomic<uint32_t> readIndex{0};

  /** JS thread only: queue one change for the next block to pick up. */
  void Push(uint32_t id, float value) {
    const uint32_t write = writeIndex.load(std::memory_order_relaxed);
    ring[write % kRtParamRing] = RtParamChange{id, value};
    writeIndex.store(write + 1, std::memory_order_release);
  }
};

std::atomic<RtInstance*> gRtSlots[superdaw::kVst3RtSlots];
/** Held by the audio thread for the duration of one process() call. */
std::atomic<bool> gRtBusy[superdaw::kVst3RtSlots];
/** JS-thread ownership, so a slot is not handed out twice. */
std::unique_ptr<RtInstance> gRtOwned[superdaw::kVst3RtSlots];

/**
 * REALTIME. Drains queued parameter changes into the pre-sized
 * ParameterChanges. Each id lands as one point at sample 0 — the same
 * shape the offline path uses, and all the document's param model can say
 * (values change per gesture, not per sample).
 */
void RtDrainParams(RtInstance& rt) {
  rt.changes.clearQueue();
  const uint32_t write = rt.writeIndex.load(std::memory_order_acquire);
  uint32_t read = rt.readIndex.load(std::memory_order_relaxed);
  // A ring that overflowed while the device was stopped: skip to the last
  // kRtParamRing entries rather than replaying stale values.
  if (write - read > kRtParamRing) read = write - kRtParamRing;
  for (; read != write; ++read) {
    const RtParamChange& change = rt.ring[read % kRtParamRing];
    int32 queueIndex = 0;
    if (auto* queue = rt.changes.addParameterData(change.id, queueIndex)) {
      int32 pointIndex = 0;
      queue->addPoint(0, std::min(1.0, std::max(0.0, static_cast<double>(change.value))),
                      pointIndex);
    }
  }
  rt.readIndex.store(write, std::memory_order_relaxed);
}

/** REALTIME. The bridge's process(); see vst3bridge.h for the contract. */
bool RtProcess(int32_t slot, const float* const* in, uint32_t inChannels,
               float* const* out, uint32_t outChannels, uint32_t frames) {
  if (slot < 0 || slot >= superdaw::kVst3RtSlots || frames == 0) return false;
  // Take the slot BEFORE reading the pointer: a teardown clears the pointer
  // and then waits on this flag, so an instance can never be destroyed
  // under a call that is already running.
  bool expected = false;
  if (!gRtBusy[slot].compare_exchange_strong(expected, true, std::memory_order_acquire)) {
    return false;
  }
  RtInstance* rt = gRtSlots[slot].load(std::memory_order_acquire);
  if (rt == nullptr) {
    gRtBusy[slot].store(false, std::memory_order_release);
    return false;
  }

  Instance& state = *rt->instance;
  RtDrainParams(*rt);

  AudioBusBuffers inBuffers{};
  inBuffers.numChannels = static_cast<int32>(state.inBlock.size());
  inBuffers.channelBuffers32 = state.inPtrs.empty() ? nullptr : state.inPtrs.data();
  AudioBusBuffers outBuffers{};
  outBuffers.numChannels = state.outChannels;
  outBuffers.channelBuffers32 = state.outPtrs.data();

  ProcessData data{};
  data.processMode = state.processMode;
  data.symbolicSampleSize = kSample32;
  data.numInputs = state.inBusCount > 0 ? 1 : 0;
  data.numOutputs = 1;
  data.inputs = state.inBusCount > 0 ? &inBuffers : nullptr;
  data.outputs = &outBuffers;
  data.inputParameterChanges = &rt->changes;

  bool ok = true;
  for (uint32_t offset = 0; offset < frames && ok;
       offset += static_cast<uint32_t>(state.blockSize)) {
    const int32 n = static_cast<int32>(
        std::min<uint32_t>(static_cast<uint32_t>(state.blockSize), frames - offset));
    for (size_t ch = 0; ch < state.inBlock.size(); ++ch) {
      // Mono material into a stereo input reuses the last real channel,
      // exactly as the offline path does.
      const size_t src = inChannels > 0 ? std::min<size_t>(ch, inChannels - 1) : 0;
      if (inChannels > 0) {
        std::copy(in[src] + offset, in[src] + offset + n, state.inBlock[ch].begin());
      } else {
        std::fill(state.inBlock[ch].begin(), state.inBlock[ch].begin() + n, 0.f);
      }
      std::fill(state.inBlock[ch].begin() + n, state.inBlock[ch].end(), 0.f);
    }
    data.numSamples = n;
    ok = state.processor->process(data) == kResultOk;
    if (!ok) break;
    for (uint32_t ch = 0; ch < outChannels; ++ch) {
      const int32 src = std::min<int32>(static_cast<int32>(ch), state.outChannels - 1);
      std::copy(state.outBlock[src].begin(), state.outBlock[src].begin() + n,
                out[ch] + offset);
    }
    // Only the first sub-block carries the queued parameter points; a
    // second one must not re-apply them at ITS sample 0.
    data.inputParameterChanges = nullptr;
  }

  gRtBusy[slot].store(false, std::memory_order_release);
  return ok;
}

superdaw::Vst3RtBridge gRtBridge{superdaw::kVst3RtBridgeAbi, &RtProcess};

/** realtimeBridge() -> external pointer to the C table (see vst3bridge.h). */
Napi::Value RealtimeBridge(const Napi::CallbackInfo& info) {
  return Napi::External<superdaw::Vst3RtBridge>::New(info.Env(), &gRtBridge);
}

/**
 * openRealtime(path, uid, { sampleRate, blockSize?, channels?, state? })
 *   -> { slot, latencySamples, inputChannels, outputChannels } | { error }
 *
 * `blockSize` must be at least the audio engine's block, since the caller
 * hands whole blocks in one call.
 */
Napi::Object OpenRealtime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsObject()) {
    return Fail(env, "expected (path, uid, options)");
  }
  int32_t slot = -1;
  for (int32_t i = 0; i < superdaw::kVst3RtSlots; ++i) {
    if (!gRtOwned[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) return Fail(env, "no free realtime slot");

  const std::string path = info[0].As<Napi::String>().Utf8Value();
  auto parsedUid = VST3::UID::fromString(info[1].As<Napi::String>().Utf8Value());
  if (!parsedUid) return Fail(env, "could not parse uid");

  Napi::Object options = info[2].As<Napi::Object>();
  const double sampleRate = options.Has("sampleRate")
                                ? options.Get("sampleRate").ToNumber().DoubleValue()
                                : 48000.0;
  int32 blockSize = options.Has("blockSize")
                        ? options.Get("blockSize").ToNumber().Int32Value()
                        : 128;
  if (blockSize <= 0) blockSize = 128;
  int32 channels = options.Has("channels")
                       ? options.Get("channels").ToNumber().Int32Value()
                       : 2;
  if (channels <= 0) channels = 2;

  std::string error;
  auto state = CreateInstance(path, *parsedUid, sampleRate, blockSize, channels,
                              kRealtime, error, ReadStateOption(options));
  if (!state) return Fail(env, error);

  auto rt = std::make_unique<RtInstance>();
  rt->instance = std::move(state);
  const int32 latency = rt->instance->latency;
  const int32 inChannels = rt->instance->inChannels;
  const int32 outChannels = rt->instance->outChannels;

  gRtOwned[slot] = std::move(rt);
  // Publish LAST: until this store the audio thread cannot see the slot.
  gRtSlots[slot].store(gRtOwned[slot].get(), std::memory_order_release);

  Napi::Object result = Napi::Object::New(env);
  result.Set("slot", Napi::Number::New(env, slot));
  result.Set("latencySamples", Napi::Number::New(env, latency));
  result.Set("inputChannels", Napi::Number::New(env, inChannels));
  result.Set("outputChannels", Napi::Number::New(env, outChannels));
  return result;
}

/** setRealtimeParams(slot, params) — normalized 0..1, keyed by param id. */
Napi::Value SetRealtimeParams(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) return env.Undefined();
  const int32_t slot = info[0].As<Napi::Number>().Int32Value();
  if (slot < 0 || slot >= superdaw::kVst3RtSlots || !gRtOwned[slot]) return env.Undefined();
  RtInstance& rt = *gRtOwned[slot];
  Napi::Object params = info[1].As<Napi::Object>();
  Napi::Array ids = params.GetPropertyNames();
  for (uint32_t i = 0; i < ids.Length(); ++i) {
    Napi::Value key = ids.Get(i);
    uint32_t id = 0;
    try {
      id = static_cast<uint32_t>(std::stoul(key.ToString().Utf8Value()));
    } catch (...) {
      continue;  // a non-numeric key is not a VST3 parameter id
    }
    rt.Push(id, static_cast<float>(params.Get(key).ToNumber().DoubleValue()));
  }
  return env.Undefined();
}

/** closeRealtime(slot) -> { closed } — waits out any in-flight process(). */
Napi::Object CloseRealtime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  const int32_t slot =
      info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : -1;
  if (slot < 0 || slot >= superdaw::kVst3RtSlots || !gRtOwned[slot]) {
    result.Set("closed", Napi::Boolean::New(env, false));
    return result;
  }
  gRtSlots[slot].store(nullptr, std::memory_order_release);
  // One block is microseconds; a spin with yields is bounded and keeps the
  // audio thread free of any teardown handshake at all.
  while (gRtBusy[slot].load(std::memory_order_acquire)) std::this_thread::yield();
  gRtOwned[slot].reset();
  result.Set("closed", Napi::Boolean::New(env, true));
  return result;
}

// ---------------------------------------------------------------------------
// Plugin editors (GUI hosting)
// ---------------------------------------------------------------------------

/**
 * The host half of a plugin editor: receives knob gestures
 * (IComponentHandler) and resize requests (IPlugFrame) from the plugin's
 * GUI and forwards them to JS through a ThreadSafeFunction — GUI events
 * arrive from the window procedure, outside any JS call frame, so they
 * must be queued onto the event loop rather than called into directly.
 */
class EditorHost : public IComponentHandler, public IPlugFrame {
 public:
  Napi::ThreadSafeFunction tsfn;
#ifdef _WIN32
  /** The editor's own top-level window (ours, not Electron's). */
  HWND window = nullptr;
#endif

  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    QUERY_INTERFACE(_iid, obj, FUnknown::iid, IComponentHandler)
    QUERY_INTERFACE(_iid, obj, IComponentHandler::iid, IComponentHandler)
    QUERY_INTERFACE(_iid, obj, IPlugFrame::iid, IPlugFrame)
    *obj = nullptr;
    return kNoInterface;
  }
  // Owned by its EditorSession, never by the plugin — refcounting is moot.
  uint32 PLUGIN_API addRef() override { return 1000; }
  uint32 PLUGIN_API release() override { return 1000; }

  tresult PLUGIN_API beginEdit(ParamID id) override {
    emit("begin", static_cast<double>(id), 0);
    return kResultOk;
  }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue value) override {
    emit("edit", static_cast<double>(id), value);
    return kResultOk;
  }
  tresult PLUGIN_API endEdit(ParamID id) override {
    emit("end", static_cast<double>(id), 0);
    return kResultOk;
  }
  /**
   * The plugin telling the host something about it changed wholesale. With
   * kParamValuesChanged it means "re-read my parameters" — which is how a
   * plugin reports a change that produced no per-parameter performEdit.
   * Loading a preset from the plugin's OWN browser is the everyday case,
   * and swallowing this notification is why those settings used to stay
   * invisible to the document (and so to collaborators without the plugin)
   * until the editor was closed.
   *
   * Only a nudge is emitted, never values: this can arrive on the plugin's
   * UI thread mid-restart, so JS comes back through getEditorParams once
   * the queued call runs and reads a settled controller.
   */
  tresult PLUGIN_API restartComponent(int32 flags) override {
    if (flags & kParamValuesChanged) emit("restart", static_cast<double>(flags), 0);
    return kResultOk;
  }

  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* rect) override {
    if (!rect) return kInvalidArgument;
    // Per spec the HOST resizes the window, then tells the view. The
    // window is ours, so the whole handshake happens right here.
#ifdef _WIN32
    if (window) {
      RECT frame{0, 0, rect->getWidth(), rect->getHeight()};
      AdjustWindowRect(&frame, static_cast<DWORD>(GetWindowLongW(window, GWL_STYLE)),
                       FALSE);
      SetWindowPos(window, nullptr, 0, 0, frame.right - frame.left,
                   frame.bottom - frame.top,
                   SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
#endif
    if (view) view->onSize(rect);
    // Docked overlays reserve space in the app's layout, so the renderer
    // needs to know the plugin changed its own size.
    emit("resize", rect->getWidth(), rect->getHeight());
    return kResultOk;
  }

  void emit(const char* type, double a, double b) {
    if (!tsfn) return;
    std::string kind(type);
    tsfn.NonBlockingCall([kind, a, b](Napi::Env env, Napi::Function cb) {
      Napi::Object event = Napi::Object::New(env);
      event.Set("type", Napi::String::New(env, kind));
      event.Set("a", Napi::Number::New(env, a));
      event.Set("b", Napi::Number::New(env, b));
      cb.Call({event});
    });
  }
};

#ifdef _WIN32
/** Editor hosts by their window, for the WndProc. Main-thread only. */
std::map<HWND, EditorHost*> gWndHosts;

/**
 * Closing the window must NOT destroy it here: the final state chunk has
 * to be captured first, so WM_CLOSE only tells JS, and JS comes back
 * through closeEditor (capture, then teardown destroys the window).
 */
LRESULT CALLBACK EditorWndProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_CLOSE) {
    auto found = gWndHosts.find(hwnd);
    if (found != gWndHosts.end()) found->second->emit("close", 0, 0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, w, l);
}

std::wstring Utf8ToWide(const std::string& utf8) {
  if (utf8.empty()) return L"";
  const int needed =
      MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
                          nullptr, 0);
  std::wstring wide(needed, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
                      wide.data(), needed);
  return wide;
}
#endif

/**
 * One open plugin editor: its own component + controller, independent of
 * any processing instance. Settings round-trip through the document's
 * stateBlob instead of sharing objects — param edits flow out as ops, and
 * the final component chunk is captured at close.
 */
struct EditorSession {
  VST3::Hosting::Module::Ptr module;
  IPtr<IComponent> component;
  IPtr<IEditController> controller;
  bool ownsController = false;
  IPtr<IPlugView> view;
  std::unique_ptr<EditorHost> host;
#ifdef _WIN32
  /**
   * The editor's own TOP-LEVEL native window. Electron windows are out of
   * the picture entirely: Chromium creates its windows with
   * WS_EX_NOREDIRECTIONBITMAP (no classic paint surface — everything goes
   * through DirectComposition), so a plugin rendering GL/GDI into any
   * child of one draws into a surface DWM never displays. A plain Win32
   * top-level window — what classic DAW hosts use — composites normally.
   */
  HWND top = nullptr;
#endif

  ~EditorSession() {
    if (view) view->removed();
#ifdef _WIN32
    if (top) {
      gWndHosts.erase(top);
      DestroyWindow(top);
    }
#endif
    if (controller) {
      controller->setComponentHandler(nullptr);
      FUnknownPtr<IConnectionPoint> compCP(component);
      FUnknownPtr<IConnectionPoint> ctrlCP(controller);
      if (compCP && ctrlCP) {
        compCP->disconnect(ctrlCP);
        ctrlCP->disconnect(compCP);
      }
      if (ownsController) controller->terminate();
    }
    if (component) component->terminate();
    if (host && host->tsfn) host->tsfn.Release();
  }
};

std::map<int32_t, std::unique_ptr<EditorSession>> gEditors;
int32_t gNextEditor = 1;

// openEditor(path, uid, { title?, state?: Buffer, onEvent: fn })
//   -> { editor, width, height } | { error }
//
// Opens the plugin's own IPlugView in a native top-level window WE create
// (see EditorSession.top for why it cannot live inside an Electron
// window). onEvent receives { type: 'begin'|'edit'|'end', a: paramId,
// b: value } and { type: 'close' } when the user closes the window —
// the caller must then call closeEditor to capture state and tear down.
Napi::Object OpenEditor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsObject()) {
    return Fail(env, "expected (path, uid, options)");
  }
  const std::string path = info[0].As<Napi::String>().Utf8Value();
  auto parsedUid = VST3::UID::fromString(info[1].As<Napi::String>().Utf8Value());
  if (!parsedUid) return Fail(env, "could not parse uid");

  Napi::Object options = info[2].As<Napi::Object>();
  if (!options.Has("onEvent") || !options.Get("onEvent").IsFunction()) {
    return Fail(env, "options.onEvent must be a function");
  }
  const std::string title = options.Has("title") && options.Get("title").IsString()
                                ? options.Get("title").As<Napi::String>().Utf8Value()
                                : std::string("Plugin");
  // Borderless mode: no caption, positioned by the caller (the renderer
  // "docks" it over a reserved area of the app window). An `owner` HWND
  // keeps it above that window and minimizes with it.
  const bool borderless =
      options.Has("borderless") && options.Get("borderless").ToBoolean().Value();
  void* ownerHwnd = nullptr;
  if (options.Has("owner") && options.Get("owner").IsBuffer()) {
    Napi::Buffer<char> ownerBuf = options.Get("owner").As<Napi::Buffer<char>>();
    if (ownerBuf.Length() >= sizeof(void*)) {
      ownerHwnd = *reinterpret_cast<void* const*>(ownerBuf.Data());
    }
  }

  auto session = std::make_unique<EditorSession>();
  std::string error;
  session->module = VST3::Hosting::Module::create(path, error);
  if (!session->module) {
    return Fail(env, error.empty() ? "failed to load module" : error);
  }
  const auto factory = session->module->getFactory();
  factory.setHostContext(&hostContext());

  session->component = factory.createInstance<IComponent>(*parsedUid);
  if (!session->component) return Fail(env, "could not create component");
  if (session->component->initialize(&hostContext()) != kResultOk) {
    session->component = nullptr;
    return Fail(env, "component->initialize failed");
  }

  session->controller =
      MakeController(factory, session->component, session->ownsController);
  if (!session->controller) return Fail(env, "plugin exposes no IEditController");

  // Component ↔ controller connection points: GUI-only plugins move their
  // settings over this private channel, which is how edits made in the
  // editor end up inside the component chunk we capture at close.
  {
    FUnknownPtr<IConnectionPoint> compCP(session->component);
    FUnknownPtr<IConnectionPoint> ctrlCP(session->controller);
    if (compCP && ctrlCP) {
      compCP->connect(ctrlCP);
      ctrlCP->connect(compCP);
    }
  }

  // Restore the document's saved settings, and mirror them into the
  // controller so the GUI opens showing what the user actually hears.
  const std::vector<char> chunk = ReadStateOption(options);
  if (!chunk.empty()) {
    ApplyState(session->component, chunk.data(), chunk.size());
    MemoryStream forController(const_cast<char*>(chunk.data()),
                               static_cast<TSize>(chunk.size()));
    int64 pos = 0;
    forController.seek(0, IBStream::kIBSeekSet, &pos);
    session->controller->setComponentState(&forController);
  }

  session->host = std::make_unique<EditorHost>();
  session->host->tsfn = Napi::ThreadSafeFunction::New(
      env, options.Get("onEvent").As<Napi::Function>(), "vst3-editor", 0, 1);
  // The TSFN must not keep the process alive after the app quits.
  session->host->tsfn.Unref(env);
  session->controller->setComponentHandler(session->host.get());

  session->view = owned(session->controller->createView(Vst::ViewType::kEditor));
  if (!session->view) return Fail(env, "plugin has no editor view");
  session->view->setFrame(session->host.get());

  ViewRect size{};
  session->view->getSize(&size);

#ifdef _WIN32
  static bool classRegistered = false;
  static const wchar_t* kClass = L"SuperDAWVst3Editor";
  if (!classRegistered) {
    WNDCLASSW wc{};
    wc.lpfnWndProc = EditorWndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = kClass;
    wc.style = CS_DBLCLKS;
    wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    RegisterClassW(&wc);
    classRegistered = true;
  }
  // Fixed-size window: plugins drive their size; resizeView is the only
  // resize path. Docked overlays are bare popups; floating editors get a
  // caption.
  const DWORD style =
      borderless ? WS_POPUP : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
  RECT frame{0, 0, size.getWidth(), size.getHeight()};
  AdjustWindowRect(&frame, style, FALSE);

  // A remembered position is only honored while it is still on a live
  // monitor — display setups change, and a window restored to a detached
  // screen is simply lost.
  int x = CW_USEDEFAULT;
  int y = CW_USEDEFAULT;
  if (options.Has("x") && options.Get("x").IsNumber() && options.Has("y") &&
      options.Get("y").IsNumber()) {
    POINT p{options.Get("x").As<Napi::Number>().Int32Value(),
            options.Get("y").As<Napi::Number>().Int32Value()};
    if (MonitorFromPoint(p, MONITOR_DEFAULTTONULL) != nullptr) {
      x = p.x;
      y = p.y;
    }
  }

  session->top = CreateWindowExW(
      borderless ? WS_EX_TOOLWINDOW : WS_EX_APPWINDOW, kClass,
      Utf8ToWide(title).c_str(), style, x, y, frame.right - frame.left,
      frame.bottom - frame.top, static_cast<HWND>(ownerHwnd), nullptr,
      GetModuleHandleW(nullptr), nullptr);
  if (!session->top) return Fail(env, "could not create editor window");
  gWndHosts[session->top] = session->host.get();
  session->host->window = session->top;

  if (session->view->attached(session->top, kPlatformTypeHWND) != kResultOk) {
    return Fail(env, "editor refused to attach to the window");
  }
  if (borderless) {
    // The caller positions it before showing; SW_SHOWNA avoids stealing
    // focus from the app window it overlays.
    ShowWindow(session->top, SW_SHOWNA);
  } else {
    ShowWindow(session->top, SW_SHOW);
    SetForegroundWindow(session->top);
  }
#else
  return Fail(env, "editor hosting is Windows-only for now");
#endif

  const int32_t handle = gNextEditor++;
  Napi::Object result = Napi::Object::New(env);
  result.Set("editor", Napi::Number::New(env, handle));
  result.Set("width", Napi::Number::New(env, size.getWidth()));
  result.Set("height", Napi::Number::New(env, size.getHeight()));
  gEditors.emplace(handle, std::move(session));
  return result;
}

// editorResized(editor, width, height) — completes a resizeView handshake.
Napi::Object EditorResized(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  if (info.Length() < 3 || !info[0].IsNumber()) return Fail(env, "expected (editor, w, h)");
  auto found = gEditors.find(info[0].As<Napi::Number>().Int32Value());
  if (found == gEditors.end()) return Fail(env, "unknown editor");
  const int width = info[1].As<Napi::Number>().Int32Value();
  const int height = info[2].As<Napi::Number>().Int32Value();
  ViewRect rect(0, 0, width, height);
  found->second->view->onSize(&rect);
  return result;
}

// moveEditor(editor, { x, y, visible, clipTop?, clipBottom? })
//
// Positions a docked overlay in PHYSICAL screen pixels. clipTop/clipBottom
// (pixels of the window to hide, from its own top/bottom) let the overlay
// respect the dock's scroll viewport instead of overhanging it.
Napi::Object MoveEditor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    return Fail(env, "expected (editor, options)");
  }
  auto found = gEditors.find(info[0].As<Napi::Number>().Int32Value());
  if (found == gEditors.end()) return Fail(env, "unknown editor");
#ifdef _WIN32
  HWND hwnd = found->second->top;
  if (!hwnd) return Fail(env, "editor has no window");
  Napi::Object options = info[1].As<Napi::Object>();
  const bool visible =
      !options.Has("visible") || options.Get("visible").ToBoolean().Value();
  if (!visible) {
    ShowWindow(hwnd, SW_HIDE);
    return result;
  }
  const int x = options.Get("x").ToNumber().Int32Value();
  const int y = options.Get("y").ToNumber().Int32Value();
  SetWindowPos(hwnd, HWND_TOP, x, y, 0, 0,
               SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);

  RECT bounds{};
  GetWindowRect(hwnd, &bounds);
  const int width = bounds.right - bounds.left;
  const int height = bounds.bottom - bounds.top;
  const auto clip = [&](const char* key) {
    return options.Has(key) ? std::max(0, options.Get(key).ToNumber().Int32Value()) : 0;
  };
  // Visible region in window-local coords: the renderer's clip values...
  int visLeft = clip("clipLeft");
  int visTop = clip("clipTop");
  int visRight = width - clip("clipRight");
  int visBottom = height - clip("clipBottom");
  // ...HARD-intersected with the app window's bounds (physical screen
  // coords) when given. The renderer's geometry can be wrong; the caller's
  // window bounds are authoritative — a docked overlay must never be able
  // to leave the app window, whatever the reported dock rect says.
  const auto bound = [&](const char* key, int fallback) {
    return options.Has(key) ? options.Get(key).ToNumber().Int32Value() : fallback;
  };
  visLeft = std::max(visLeft, bound("boundLeft", bounds.left) - x);
  visTop = std::max(visTop, bound("boundTop", bounds.top) - y);
  visRight = std::min(visRight, bound("boundRight", bounds.right) - x);
  visBottom = std::min(visBottom, bound("boundBottom", bounds.bottom) - y);

  const bool fullyVisible =
      visLeft <= 0 && visTop <= 0 && visRight >= width && visBottom >= height;
  if (visRight <= visLeft || visBottom <= visTop) {
    ShowWindow(hwnd, SW_HIDE); // nothing of it may show
  } else if (fullyVisible) {
    SetWindowRgn(hwnd, nullptr, TRUE);
  } else {
    HRGN region = CreateRectRgn(std::max(0, visLeft), std::max(0, visTop),
                                std::min(width, visRight), std::min(height, visBottom));
    SetWindowRgn(hwnd, region, TRUE); // the window owns the region now
  }
#endif
  return result;
}

// getEditorParams(editor) -> { error?, params: { "<id>": normalized } }
//
// The plugin's CURRENT values, read straight off the live controller —
// the counterpart to setEditorParam. Needed because a plugin's own GUI can
// change many parameters without emitting a performEdit for each (loading
// a preset is the common case), so the document's param map would
// otherwise never learn the true values. The renderer publishes this as a
// plugin/setParams snapshot so collaborators WITHOUT the plugin see what
// it is actually set to instead of factory defaults.
//
// Same filter as Parameters(): read-only meters are not user settings, and
// bypass is excluded there too (the insert chain owns bypass), so the keys
// here line up with the descriptor's paramDefs.
Napi::Object GetEditorParams(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return Fail(env, "expected (editor)");
  auto found = gEditors.find(info[0].As<Napi::Number>().Int32Value());
  if (found == gEditors.end()) return Fail(env, "unknown editor");
  IEditController* controller = found->second->controller;
  if (!controller) return Fail(env, "editor has no controller");

  Napi::Object params = Napi::Object::New(env);
  const int32 count = controller->getParameterCount();
  for (int32 i = 0; i < count; ++i) {
    ParameterInfo pinfo{};
    if (controller->getParameterInfo(i, pinfo) != kResultOk) continue;
    if (pinfo.flags & ParameterInfo::kIsReadOnly) continue;
    if (pinfo.flags & ParameterInfo::kIsBypass) continue;
    params.Set(std::to_string(pinfo.id),
               Napi::Number::New(env, controller->getParamNormalized(pinfo.id)));
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("params", params);
  return result;
}

// setEditorParam(editor, paramId, normalized) — our sliders → the GUI.
Napi::Object SetEditorParam(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  if (info.Length() < 3 || !info[0].IsNumber()) {
    return Fail(env, "expected (editor, paramId, value)");
  }
  auto found = gEditors.find(info[0].As<Napi::Number>().Int32Value());
  if (found == gEditors.end()) return Fail(env, "unknown editor");
  found->second->controller->setParamNormalized(
      static_cast<ParamID>(info[1].As<Napi::Number>().Uint32Value()),
      std::min(1.0, std::max(0.0, info[2].As<Napi::Number>().DoubleValue())));
  return result;
}

// closeEditor(editor) -> { component?: Buffer }
//
// Captures the final component chunk BEFORE teardown — for GUI-only
// plugins this chunk is the only place their edits exist.
Napi::Object CloseEditor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  if (info.Length() < 1 || !info[0].IsNumber()) return result;
  auto found = gEditors.find(info[0].As<Napi::Number>().Int32Value());
  if (found == gEditors.end()) return result;

  MemoryStream stream;
  if (found->second->component->getState(&stream) == kResultOk) {
    result.Set("component",
               Napi::Buffer<char>::Copy(env, stream.getData(),
                                        static_cast<size_t>(stream.getSize())));
  }
#ifdef _WIN32
  // Where the user left the window, so the next open can return there.
  if (found->second->top) {
    RECT where{};
    if (GetWindowRect(found->second->top, &where)) {
      result.Set("x", Napi::Number::New(env, where.left));
      result.Set("y", Napi::Number::New(env, where.top));
    }
  }
#endif
  gEditors.erase(found);
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("scanPaths", Napi::Function::New(env, ScanPaths));
  exports.Set("inspect", Napi::Function::New(env, Inspect));
  exports.Set("parameters", Napi::Function::New(env, Parameters));
  exports.Set("processBuffer", Napi::Function::New(env, ProcessBuffer));
  exports.Set("openInstance", Napi::Function::New(env, OpenInstance));
  exports.Set("getInstanceState", Napi::Function::New(env, GetInstanceState));
  exports.Set("openEditor", Napi::Function::New(env, OpenEditor));
  exports.Set("closeEditor", Napi::Function::New(env, CloseEditor));
  exports.Set("editorResized", Napi::Function::New(env, EditorResized));
  exports.Set("moveEditor", Napi::Function::New(env, MoveEditor));
  exports.Set("setEditorParam", Napi::Function::New(env, SetEditorParam));
  exports.Set("getEditorParams", Napi::Function::New(env, GetEditorParams));
  exports.Set("processInstance", Napi::Function::New(env, ProcessInstance));
  exports.Set("closeInstance", Napi::Function::New(env, CloseInstance));
  exports.Set("realtimeBridge", Napi::Function::New(env, RealtimeBridge));
  exports.Set("openRealtime", Napi::Function::New(env, OpenRealtime));
  exports.Set("setRealtimeParams", Napi::Function::New(env, SetRealtimeParams));
  exports.Set("closeRealtime", Napi::Function::New(env, CloseRealtime));
  return exports;
}

}  // namespace

NODE_API_MODULE(vst3host, Init)
