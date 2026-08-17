// CLAP host addon — phase C1: SCAN ONLY (docs/CLAP_AU_HOSTING.md).
//
// `inspect(path)` loads a .clap bundle, enumerates its plugin factory and
// returns descriptor metadata, then unloads. No plugin is instantiated —
// enumeration reads static descriptor structs, which is the cheapest and
// safest thing a stranger's DLL can be asked for. It still RUNS the DLL's
// entry points (DllMain, clap_entry.init), which is why callers run this
// inside the sacrificial scan utilityProcess with the same crash/hang
// quarantine the VST3 scanner earns its keep with.
//
// The result shape deliberately mirrors vst3host's Inspect() so the scan
// worker treats both formats through one code path:
//   { path, error? } | { path, classes: [{ uid, name, vendor, version,
//     subCategories }] }
// CLAP has no subcategory string; the descriptor's feature list (e.g.
// "audio-effect", "reverb") joins with '|' to fill the same slot.

#include <napi.h>

#include <string>
#include <vector>

#include <clap/entry.h>
#include <clap/factory/plugin-factory.h>
#include <clap/version.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

// One loaded bundle, unloaded on scope exit whatever path the inspection
// takes. deinit() must run before the library unloads (CLAP contract).
class LoadedBundle {
 public:
  explicit LoadedBundle(const std::string& utf8Path) {
#ifdef _WIN32
    const int wideLength =
        MultiByteToWideChar(CP_UTF8, 0, utf8Path.c_str(), -1, nullptr, 0);
    std::wstring widePath(static_cast<size_t>(wideLength), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8Path.c_str(), -1, widePath.data(),
                        wideLength);
    // Route the loader through the bundle's own directory for its
    // dependent DLLs, the way hosts load plugins in practice.
    handle_ = LoadLibraryExW(widePath.c_str(), nullptr,
                             LOAD_WITH_ALTERED_SEARCH_PATH);
#else
    handle_ = dlopen(utf8Path.c_str(), RTLD_LOCAL | RTLD_NOW);
#endif
  }

  ~LoadedBundle() {
    if (entry_ != nullptr && initialized_) entry_->deinit();
    if (handle_ != nullptr) {
#ifdef _WIN32
      FreeLibrary(static_cast<HMODULE>(handle_));
#else
      dlclose(handle_);
#endif
    }
  }

  LoadedBundle(const LoadedBundle&) = delete;
  LoadedBundle& operator=(const LoadedBundle&) = delete;

  bool loaded() const { return handle_ != nullptr; }

  const clap_plugin_entry_t* entry() {
    if (entry_ != nullptr) return entry_;
    if (handle_ == nullptr) return nullptr;
#ifdef _WIN32
    void* symbol = reinterpret_cast<void*>(
        GetProcAddress(static_cast<HMODULE>(handle_), "clap_entry"));
#else
    void* symbol = dlsym(handle_, "clap_entry");
#endif
    entry_ = static_cast<const clap_plugin_entry_t*>(symbol);
    return entry_;
  }

  bool init(const std::string& utf8Path) {
    const clap_plugin_entry_t* e = entry();
    if (e == nullptr || e->init == nullptr) return false;
    initialized_ = e->init(utf8Path.c_str());
    return initialized_;
  }

 private:
  void* handle_ = nullptr;
  const clap_plugin_entry_t* entry_ = nullptr;
  bool initialized_ = false;
};

Napi::Object WithError(Napi::Env env, Napi::Object result,
                       const std::string& message) {
  result.Set("error", Napi::String::New(env, message));
  return result;
}

std::string JoinFeatures(const char* const* features) {
  if (features == nullptr) return "";
  std::string joined;
  for (const char* const* feature = features; *feature != nullptr; ++feature) {
    if (!joined.empty()) joined += "|";
    joined += *feature;
  }
  return joined;
}

const char* OrEmpty(const char* value) { return value == nullptr ? "" : value; }

Napi::Object Inspect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (info.Length() < 1 || !info[0].IsString()) {
    return WithError(env, result, "expected a path string");
  }
  const std::string path = info[0].As<Napi::String>().Utf8Value();
  result.Set("path", Napi::String::New(env, path));

  LoadedBundle bundle(path);
  if (!bundle.loaded()) {
    return WithError(env, result, "could not load the bundle's binary");
  }
  const clap_plugin_entry_t* entry = bundle.entry();
  if (entry == nullptr) {
    return WithError(env, result, "not a CLAP bundle (no clap_entry export)");
  }
  if (!clap_version_is_compatible(entry->clap_version)) {
    return WithError(env, result,
                     "incompatible CLAP version " +
                         std::to_string(entry->clap_version.major) + "." +
                         std::to_string(entry->clap_version.minor));
  }
  if (!bundle.init(path)) {
    return WithError(env, result, "clap_entry.init refused the bundle");
  }

  const auto* factory = static_cast<const clap_plugin_factory_t*>(
      entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
  if (factory == nullptr || factory->get_plugin_count == nullptr ||
      factory->get_plugin_descriptor == nullptr) {
    return WithError(env, result, "bundle exposes no plugin factory");
  }

  const uint32_t count = factory->get_plugin_count(factory);
  Napi::Array classes = Napi::Array::New(env);
  uint32_t emitted = 0;
  for (uint32_t i = 0; i < count; ++i) {
    const clap_plugin_descriptor_t* descriptor =
        factory->get_plugin_descriptor(factory, i);
    // A null descriptor slot or a missing id is the plugin's bug; skip the
    // slot rather than failing the bundle (its other plugins may be fine).
    if (descriptor == nullptr || descriptor->id == nullptr ||
        descriptor->id[0] == '\0') {
      continue;
    }
    Napi::Object entryObject = Napi::Object::New(env);
    entryObject.Set("uid", Napi::String::New(env, descriptor->id));
    entryObject.Set("name", Napi::String::New(env, OrEmpty(descriptor->name)));
    entryObject.Set("vendor",
                    Napi::String::New(env, OrEmpty(descriptor->vendor)));
    entryObject.Set("version",
                    Napi::String::New(env, OrEmpty(descriptor->version)));
    entryObject.Set("subCategories",
                    Napi::String::New(env, JoinFeatures(descriptor->features)));
    classes.Set(emitted++, entryObject);
  }
  if (emitted == 0) {
    return WithError(env, result, "factory reports no usable plugins");
  }
  result.Set("classes", classes);
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("inspect", Napi::Function::New(env, Inspect));
  return exports;
}

}  // namespace

NODE_API_MODULE(claphost, Init)
