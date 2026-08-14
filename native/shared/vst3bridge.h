/*
 * The realtime bridge between `vst3host` and `audiohost`.
 *
 * Both are Node-API addons. When the audio utilityProcess loads BOTH
 * (docs/NATIVE_AUDIO_BACKEND.md §5, "Interaction with the existing VST3
 * host"), a VST3 insert can be processed INSIDE the audio callback rather
 * than behind the 2-second windowed preview — but only if the audio thread
 * can reach the plugin without going through JS. It cannot call across a
 * Node-API boundary to do that, so `vst3host` publishes a plain C function
 * table and `audiohost` calls it directly.
 *
 * The table travels as a `napi_external` (an opaque pointer): vst3host's
 * `realtimeBridge()` hands one out, audiohost's `attachVst3Bridge()` takes
 * it. `abi` is checked on arrival, so a stale pair of binaries declines
 * instead of corrupting the audio thread — the two addons are built
 * separately and nothing guarantees they were built together.
 *
 * THIS HEADER IS THE CONTRACT. Both binding.gyp files put `../shared` on
 * the include path; changing anything below means bumping kVst3RtBridgeAbi.
 */

#pragma once

#include <stdint.h>

namespace superdaw {

/** Bump on ANY change to the struct or to a function's meaning. */
constexpr uint32_t kVst3RtBridgeAbi = 1;

/** Slots are a fixed array, so a slot id is stable and lock-free to read. */
constexpr int32_t kVst3RtSlots = 64;

struct Vst3RtBridge {
  uint32_t abi;

  /**
   * REALTIME-SAFE: called from the audio callback, must not allocate,
   * lock, or call into JS. Runs `frames` of planar `in` through the plugin
   * bound to `slot`, writing planar `out`. `in` and `out` may not alias.
   *
   * False means "nothing happened, do not use `out`" — an unknown slot, a
   * plugin being torn down, or a process() that failed. The caller's
   * correct response is to pass its input through unchanged, which is what
   * every other unavailable-plugin path in SuperDAW does.
   */
  bool (*process)(int32_t slot, const float* const* in, uint32_t inChannels,
                  float* const* out, uint32_t outChannels, uint32_t frames);
};

}  // namespace superdaw
