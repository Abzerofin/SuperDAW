// Phase 1 of VST3 hosting: discover .vst3 bundles and read their class
// metadata. Deliberately does NOT process audio yet — this layer only
// produces the identity fields that map onto SuperDAW's PluginDescriptor
// (format/uid/name/vendor/version), so the existing registry, resolution
// ladder and missing-plugin placeholder work against real plugins before
// any real-time audio bridge exists.

#include <napi.h>

#include <algorithm>
#include <string>
#include <vector>

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/vsttypes.h"
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
// Returns { path, error? , classes: [...] } — a load failure is DATA, not
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

// One host application instance, shared by every plugin we instantiate.
// Plugins query it for the host's name and for interface support.
HostApplication& hostContext() {
  static HostApplication instance;
  return instance;
}

// Reads a JS Float32Array[] into contiguous per-channel storage.
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

// parameters(path, uid) -> { error? , parameters: [...] }
//
// Reads the plugin's parameter list. Values are VST3 NORMALIZED (0..1);
// the plugin owns the mapping to real units, which is why `display` comes
// back as the plugin's own formatted string rather than something we
// compute.
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
    // Read-only meters//outputs are not things a user sets.
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
    list.Set(emitted++, entry);
  }

  if (ownsController) controller->terminate();
  component->terminate();

  Napi::Object result = Napi::Object::New(env);
  result.Set("parameters", list);
  return result;
}

// Run a buffer through one plugin, offline.
//
// processBuffer(path, uid, { channels: Float32Array[], sampleRate, blockSize? })
//   -> { channels: Float32Array[] } | { error }
//
// Offline (whole-buffer) on purpose: it is the shape the freeze/mixdown
// path already wants, and it needs no real-time thread, so it is provable
// today. Live playback is a separate problem — see native/README.md.
Napi::Object ProcessBuffer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsObject()) {
    return Fail(env, "expected (path, uid, options)");
  }

  const std::string path = info[0].As<Napi::String>().Utf8Value();
  const std::string uidStr = info[1].As<Napi::String>().Utf8Value();
  Napi::Object options = info[2].As<Napi::Object>();

  if (!options.Has("channels") || !options.Get("channels").IsArray()) {
    return Fail(env, "options.channels must be a Float32Array[]");
  }
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

  auto parsedUid = VST3::UID::fromString(uidStr);
  if (!parsedUid) return Fail(env, "could not parse uid: " + uidStr);

  std::string moduleError;
  auto module = VST3::Hosting::Module::create(path, moduleError);
  if (!module) {
    return Fail(env, moduleError.empty() ? "failed to load module" : moduleError);
  }

  const auto factory = module->getFactory();
  factory.setHostContext(&hostContext());

  auto component = factory.createInstance<IComponent>(*parsedUid);
  if (!component) return Fail(env, "could not create component");

  if (component->initialize(&hostContext()) != kResultOk) {
    return Fail(env, "component->initialize failed");
  }

  // Everything past here must run terminate()/setActive(false) on the way
  // out, so failures funnel through this one cleanup.
  auto cleanup = [&](const std::string& message) {
    component->terminate();
    return Fail(env, message);
  };

  FUnknownPtr<IAudioProcessor> processor(component);
  if (!processor) return cleanup("plugin exposes no IAudioProcessor");

  if (processor->canProcessSampleSize(kSample32) != kResultOk) {
    return cleanup("plugin does not support 32-bit float processing");
  }

  // Ask for the channel count we actually have, on the plugin's main buses.
  const int32 wantChannels = static_cast<int32>(input.size());
  SpeakerArrangement arrangement =
      wantChannels >= 2 ? SpeakerArr::kStereo : SpeakerArr::kMono;
  const int32 inBusCount = component->getBusCount(kAudio, kInput);
  const int32 outBusCount = component->getBusCount(kAudio, kOutput);
  if (outBusCount < 1) return cleanup("plugin has no audio output bus");

  std::vector<SpeakerArrangement> inArr(inBusCount > 0 ? inBusCount : 0,
                                        arrangement);
  std::vector<SpeakerArrangement> outArr(outBusCount, arrangement);
  // A refusal here is not fatal — the plugin keeps its own default layout,
  // which we read back below rather than assuming ours won.
  processor->setBusArrangements(inArr.empty() ? nullptr : inArr.data(), inBusCount,
                                outArr.data(), outBusCount);

  SpeakerArrangement actualOut = arrangement;
  processor->getBusArrangement(kOutput, 0, actualOut);
  const int32 outChannels = SpeakerArr::getChannelCount(actualOut);
  if (outChannels < 1) return cleanup("plugin reported zero output channels");

  SpeakerArrangement actualIn = arrangement;
  int32 inChannels = 0;
  if (inBusCount > 0) {
    processor->getBusArrangement(kInput, 0, actualIn);
    inChannels = SpeakerArr::getChannelCount(actualIn);
  }

  ProcessSetup setup{};
  setup.processMode = kOffline;
  setup.symbolicSampleSize = kSample32;
  setup.maxSamplesPerBlock = blockSize;
  setup.sampleRate = sampleRate;
  if (processor->setupProcessing(setup) != kResultOk) {
    return cleanup("setupProcessing failed");
  }

  // Main buses only; anything else (sidechains, aux) stays silent for now.
  for (int32 bus = 0; bus < inBusCount; ++bus) {
    component->activateBus(kAudio, kInput, bus, bus == 0);
  }
  for (int32 bus = 0; bus < outBusCount; ++bus) {
    component->activateBus(kAudio, kOutput, bus, bus == 0);
  }

  if (component->setActive(true) != kResultOk) return cleanup("setActive failed");
  processor->setProcessing(true);

  // Per-block scratch. Input channels the plugin wants but we don't have
  // are fed silence rather than left dangling.
  std::vector<std::vector<float>> inBlock(std::max(inChannels, 0),
                                          std::vector<float>(blockSize, 0.f));
  std::vector<std::vector<float>> outBlock(outChannels,
                                           std::vector<float>(blockSize, 0.f));
  std::vector<float*> inPtrs(inBlock.size());
  std::vector<float*> outPtrs(outBlock.size());
  for (size_t i = 0; i < inBlock.size(); ++i) inPtrs[i] = inBlock[i].data();
  for (size_t i = 0; i < outBlock.size(); ++i) outPtrs[i] = outBlock[i].data();

  std::vector<std::vector<float>> output(outChannels, std::vector<float>(frames, 0.f));

  AudioBusBuffers inBuffers{};
  inBuffers.numChannels = static_cast<int32>(inBlock.size());
  inBuffers.channelBuffers32 = inPtrs.empty() ? nullptr : inPtrs.data();
  AudioBusBuffers outBuffers{};
  outBuffers.numChannels = outChannels;
  outBuffers.channelBuffers32 = outPtrs.data();

  ParameterChanges emptyChanges;
  ProcessData data{};
  data.processMode = kOffline;
  data.symbolicSampleSize = kSample32;
  data.numInputs = inBusCount > 0 ? 1 : 0;
  data.numOutputs = 1;
  data.inputs = inBusCount > 0 ? &inBuffers : nullptr;
  data.outputs = &outBuffers;
  data.inputParameterChanges = &emptyChanges;

  for (size_t offset = 0; offset < frames; offset += blockSize) {
    const int32 n =
        static_cast<int32>(std::min<size_t>(blockSize, frames - offset));

    for (size_t ch = 0; ch < inBlock.size(); ++ch) {
      // Fewer real channels than the plugin asked for: reuse the last one
      // (mono into a stereo input) instead of feeding silence.
      const size_t src = std::min(ch, input.size() - 1);
      std::copy(input[src].begin() + offset, input[src].begin() + offset + n,
                inBlock[ch].begin());
      std::fill(inBlock[ch].begin() + n, inBlock[ch].end(), 0.f);
    }
    for (auto& channel : outBlock) std::fill(channel.begin(), channel.end(), 0.f);

    data.numSamples = n;
    if (processor->process(data) != kResultOk) {
      processor->setProcessing(false);
      component->setActive(false);
      return cleanup("process() failed");
    }

    for (int32 ch = 0; ch < outChannels; ++ch) {
      std::copy(outBlock[ch].begin(), outBlock[ch].begin() + n,
                output[ch].begin() + offset);
    }
  }

  processor->setProcessing(false);
  component->setActive(false);
  component->terminate();

  Napi::Array jsOut = Napi::Array::New(env, output.size());
  for (size_t ch = 0; ch < output.size(); ++ch) {
    Napi::Float32Array arr = Napi::Float32Array::New(env, frames);
    std::copy(output[ch].begin(), output[ch].end(), arr.Data());
    jsOut.Set(static_cast<uint32_t>(ch), arr);
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("channels", jsOut);
  result.Set("inputChannels", Napi::Number::New(env, inChannels));
  result.Set("outputChannels", Napi::Number::New(env, outChannels));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("scanPaths", Napi::Function::New(env, ScanPaths));
  exports.Set("inspect", Napi::Function::New(env, Inspect));
  exports.Set("processBuffer", Napi::Function::New(env, ProcessBuffer));
  exports.Set("parameters", Napi::Function::New(env, Parameters));
  return exports;
}

}  // namespace

NODE_API_MODULE(vst3host, Init)
