/*
 * The single miniaudio implementation TU (docs/NATIVE_AUDIO_BACKEND.md §4).
 *
 * Only the WASAPI backend is compiled in — shared mode with IAudioClient3
 * low-latency periods is the design's default path, exclusive mode its
 * opt-in escape hatch, and ASIO is rejected outright on license grounds
 * (GPL-incompatible SDK), so nothing else may even be linkable. The
 * high-level layers (engine, node graph, resource manager, decoders) are
 * excluded: SuperDAW brings its own graph/param/voice engine, because its
 * semantics must match Web Audio's, not miniaudio's.
 */
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_ENGINE
#define MA_NO_NODE_GRAPH
#define MA_NO_RESOURCE_MANAGER

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
