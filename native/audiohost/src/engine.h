/*
 * The native graph/param/voice engine (docs/NATIVE_AUDIO_BACKEND.md §3,
 * phase 2 stage 2). Implements the IAudioBackend semantics the renderer
 * engine speaks — gain/stereoPanner nodes, the five Web Audio param
 * events, named-buffer voices with sample-accurate start/stop, analysis
 * taps — as a block renderer the device callback (and the offline test
 * hook) drives.
 *
 * Semantics are Web Audio's on purpose: params follow the AudioParam
 * timeline algorithm, the panner is the spec's equal-power stereo pan,
 * voices read buffers with linear interpolation (what Chromium's
 * AudioBufferSourceNode does), and analyser taps downmix to mono at
 * equal weight. Parity with the Web Audio backend is the acceptance
 * test, so every deviation would surface as a diff.
 *
 * Threading: the JS-facing thread appends commands to a pending list
 * under a mutex; the render thread swaps the list out at BLOCK
 * boundaries with a try_lock (a contended block just defers commands
 * ~2.7 ms — the control plane schedules ≥250 ms ahead, so this is three
 * orders of magnitude inside budget; a fully lock-free queue is a
 * hardening-phase refinement, not a correctness need). Buffers are
 * registered/released on the JS thread; the render thread only ever
 * reads them, and releases are deferred through the ended ring so a
 * playing voice can never lose its buffer mid-block.
 */

#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace sdengine {

constexpr uint32_t kBlockFrames = 128;
constexpr double kPi = 3.14159265358979323846;

// ---------------------------------------------------------------- params

enum class ParamEventKind : uint8_t { SetValue, LinearRamp, SetTarget, SetCurve, Cancel };

struct ParamEvent {
  ParamEventKind kind;
  double value = 0;
  double time = 0;         // setValue / setTarget start / setCurve start / cancel afterTime
  double endTime = 0;      // linearRamp end
  double timeConstant = 0; // setTarget
  double duration = 0;     // setCurve
  std::vector<float> curve;
};

/*
 * The AudioParam timeline: a sorted event list evaluated per sample.
 * Follows the spec's value computation — setValue holds, linearRamp
 * interpolates from the previous event's terminal value/time, setTarget
 * decays exponentially from the value at its start time until the next
 * event, setValueCurve interpolates its samples over its window, cancel
 * removes events at/after a time.
 */
class ParamTimeline {
 public:
  explicit ParamTimeline(double defaultValue) : defaultValue_(defaultValue) {}

  void Apply(const ParamEvent& event) {
    if (event.kind == ParamEventKind::Cancel) {
      events_.erase(
          std::remove_if(events_.begin(), events_.end(),
                         [&](const ParamEvent& e) { return AnchorTime(e) >= event.time; }),
          events_.end());
      return;
    }
    // Insert sorted by anchor time (stable: later insertion after equal
    // times, matching the append semantics the seam documents).
    auto at = std::find_if(events_.begin(), events_.end(), [&](const ParamEvent& e) {
      return AnchorTime(e) > AnchorTime(event);
    });
    events_.insert(at, event);
  }

  /* Value at time t (seconds on the stream clock). */
  double ValueAt(double t) const {
    double value = defaultValue_;
    double valueTime = -1e300;
    const ParamEvent* target = nullptr;  // active setTarget, if any

    for (const ParamEvent& e : events_) {
      const double anchor = AnchorTime(e);
      if (anchor > t) {
        // A linear ramp whose END is in the future still shapes [now, end).
        if (e.kind == ParamEventKind::LinearRamp && valueTime <= t) {
          const double t0 = valueTime < -1e299 ? anchor : valueTime;
          const double v0 = target ? TargetValueAt(*target, value, t) : value;
          if (e.endTime > t0 && t >= t0) {
            const double phase = (t - t0) / (e.endTime - t0);
            return v0 + (e.value - v0) * phase;
          }
        }
        break;
      }
      switch (e.kind) {
        case ParamEventKind::SetValue:
          value = e.value;
          valueTime = e.time;
          target = nullptr;
          break;
        case ParamEventKind::LinearRamp:
          value = e.value;
          valueTime = e.endTime;
          target = nullptr;
          break;
        case ParamEventKind::SetTarget:
          // Value FROM which the decay starts: whatever the timeline held
          // at the event's start.
          value = target ? TargetValueAt(*target, value, e.time) : value;
          valueTime = e.time;
          target = &e;
          break;
        case ParamEventKind::SetCurve: {
          const double end = e.time + e.duration;
          if (t < end) {
            if (e.curve.empty()) return value;
            const double phase = (t - e.time) / e.duration;
            const double pos = phase * (e.curve.size() - 1);
            const size_t i0 = static_cast<size_t>(pos);
            const size_t i1 = std::min(i0 + 1, e.curve.size() - 1);
            const double frac = pos - static_cast<double>(i0);
            return e.curve[i0] * (1 - frac) + e.curve[i1] * frac;
          }
          value = e.curve.empty() ? value : e.curve.back();
          valueTime = end;
          target = nullptr;
          break;
        }
        case ParamEventKind::Cancel:
          break;
      }
    }
    if (target) return TargetValueAt(*target, value, t);
    return value;
  }

 private:
  static double AnchorTime(const ParamEvent& e) {
    return e.kind == ParamEventKind::LinearRamp ? e.endTime : e.time;
  }

  static double TargetValueAt(const ParamEvent& e, double startValue, double t) {
    if (t <= e.time) return startValue;
    const double tc = e.timeConstant > 0 ? e.timeConstant : 1e-9;
    return e.value + (startValue - e.value) * std::exp(-(t - e.time) / tc);
  }

  double defaultValue_;
  std::vector<ParamEvent> events_;
};

// ----------------------------------------------------------------- graph

enum class NodeKind : uint8_t { Gain, Panner };

struct Node {
  NodeKind kind = NodeKind::Gain;
  bool alive = true;
  ParamTimeline gain{1.0};
  ParamTimeline pan{0.0};
  std::vector<uint32_t> inputs;  // node ids feeding this node
  // Per-block scratch (stereo interleaved) — render thread only.
  float block[kBlockFrames * 2] = {};
  bool rendered = false;
};

struct SharedBuffer {
  std::vector<std::vector<float>> channels;
  double sampleRate = 0;
};

struct Voice {
  uint32_t id = 0;
  std::shared_ptr<SharedBuffer> buffer;
  double when = 0;
  double offsetSec = 0;
  double durationSec = -1;  // buffer-content seconds; <0 = to the end
  double rate = 1;
  uint32_t dest = 0;
  double position = 0;  // fractional buffer frames, from offset
  double consumedSec = 0;
  double stopAt = 1e300;
  bool started = false;
  bool ended = false;
};

struct Tap {
  uint32_t node = 0;
  std::vector<float> ring;  // mono
  size_t write = 0;
  bool filled = false;
  bool alive = true;
};

// -------------------------------------------------------------- commands

struct Command {
  enum class Op : uint8_t {
    CreateNode,
    Connect,
    Disconnect,
    DisconnectAll,
    DisposeNode,
    ScheduleParam,
    Play,
    StopVoice,
    CreateTap,
    DisposeTap
  } op;
  uint32_t a = 0;  // node / voice / tap id
  uint32_t b = 0;  // target node / param selector (0 = gain, 1 = pan) / frames
  NodeKind nodeKind = NodeKind::Gain;
  double x = 0;  // stopVoice atTime (<0 = immediate)
  ParamEvent event{};
  std::shared_ptr<SharedBuffer> buffer;  // Play
  Voice voice{};                         // Play template
};

/*
 * The engine. JS thread: the command methods, buffer registry and
 * DrainEnded. Render thread: RenderBlock. Offline verification:
 * RenderOffline (JS thread, device stopped) runs the identical block
 * loop synchronously.
 */
class Engine {
 public:
  Engine() {
    // Node 0 is the master gain, pre-created and indestructible.
    nodes_.emplace(0u, std::make_unique<Node>());
  }

  // ---- JS thread ----

  uint32_t CreateNode(NodeKind kind) {
    const uint32_t id = nextId_++;
    Command c{Command::Op::CreateNode};
    c.a = id;
    c.nodeKind = kind;
    Push(std::move(c));
    return id;
  }

  void Connect(uint32_t from, uint32_t to) {
    Command c{Command::Op::Connect};
    c.a = from;
    c.b = to;
    Push(std::move(c));
  }

  void Disconnect(uint32_t from, bool haveTo, uint32_t to) {
    Command c{haveTo ? Command::Op::Disconnect : Command::Op::DisconnectAll};
    c.a = from;
    c.b = to;
    Push(std::move(c));
  }

  void DisposeNode(uint32_t id) {
    if (id == 0) return;
    Command c{Command::Op::DisposeNode};
    c.a = id;
    Push(std::move(c));
  }

  void ScheduleParam(uint32_t node, bool pan, ParamEvent event) {
    Command c{Command::Op::ScheduleParam};
    c.a = node;
    c.b = pan ? 1 : 0;
    c.event = std::move(event);
    Push(std::move(c));
  }

  void RegisterBuffer(const std::string& bufferId, std::shared_ptr<SharedBuffer> buffer) {
    std::lock_guard<std::mutex> lock(buffersMutex_);
    buffers_[bufferId] = std::move(buffer);
  }

  bool HasBuffer(const std::string& bufferId) {
    std::lock_guard<std::mutex> lock(buffersMutex_);
    return buffers_.count(bufferId) > 0;
  }

  void ReleaseBuffer(const std::string& bufferId) {
    // shared_ptr: playing voices keep their material until they end.
    std::lock_guard<std::mutex> lock(buffersMutex_);
    buffers_.erase(bufferId);
  }

  /* Returns the voice id, or 0 when the buffer is unknown. */
  uint32_t Play(const std::string& bufferId, double when, double offsetSec, double durationSec,
                double rate, uint32_t dest) {
    std::shared_ptr<SharedBuffer> buffer;
    {
      std::lock_guard<std::mutex> lock(buffersMutex_);
      auto it = buffers_.find(bufferId);
      if (it == buffers_.end()) return 0;
      buffer = it->second;
    }
    const uint32_t id = nextId_++;
    Command c{Command::Op::Play};
    c.buffer = std::move(buffer);
    c.voice.id = id;
    c.voice.when = when;
    c.voice.offsetSec = offsetSec;
    c.voice.durationSec = durationSec;
    c.voice.rate = rate > 0 ? rate : 1;
    c.voice.dest = dest;
    Push(std::move(c));
    return id;
  }

  void StopVoice(uint32_t id, double atTime) {
    Command c{Command::Op::StopVoice};
    c.a = id;
    c.x = atTime;
    Push(std::move(c));
  }

  uint32_t CreateTap(uint32_t node, uint32_t frames) {
    const uint32_t id = nextId_++;
    Command c{Command::Op::CreateTap};
    c.a = id;
    c.b = frames < 32 ? 32 : frames;
    c.voice.dest = node;  // reuse the field
    Push(std::move(c));
    return id;
  }

  void DisposeTap(uint32_t id) {
    Command c{Command::Op::DisposeTap};
    c.a = id;
    Push(std::move(c));
  }

  /* Latest tap window into out (mono, tap length). False = no data yet. */
  bool ReadTap(uint32_t id, float* out, size_t frames) {
    std::lock_guard<std::mutex> lock(tapReadMutex_);
    auto it = taps_.find(id);
    if (it == taps_.end() || !it->second->filled) return false;
    Tap& tap = *it->second;
    const size_t n = std::min(frames, tap.ring.size());
    for (size_t i = 0; i < n; i++) {
      out[i] = tap.ring[(tap.write + tap.ring.size() - n + i) % tap.ring.size()];
    }
    return true;
  }

  /* Voice ids that ended since the last drain (JS thread). */
  std::vector<uint32_t> DrainEnded() {
    std::vector<uint32_t> out;
    std::lock_guard<std::mutex> lock(endedMutex_);
    out.swap(ended_);
    return out;
  }

  /*
   * Offline verification: render `frames` from `startTime` into an
   * interleaved stereo buffer, on the CALLER's thread. Requires the
   * device to be stopped (the two must never render concurrently).
   */
  void RenderOffline(double startTime, uint32_t frames, double sampleRate, float* out) {
    double t = startTime;
    uint32_t done = 0;
    while (done < frames) {
      const uint32_t n = std::min(kBlockFrames, frames - done);
      RenderBlock(t, n, sampleRate, out + static_cast<size_t>(done) * 2);
      t += static_cast<double>(n) / sampleRate;
      done += n;
    }
  }

  // ---- render thread ----

  /* One block: apply pending commands, run voices into nodes, walk the
   * graph bottom-up into the master, feed taps. `out` = stereo
   * interleaved, `frames` ≤ kBlockFrames. */
  void RenderBlock(double blockTime, uint32_t frames, double sampleRate, float* out) {
    ApplyPending();

    for (auto& [id, node] : nodes_) {
      std::fill(node->block, node->block + frames * 2, 0.0f);
      node->rendered = false;
    }

    // Voices deposit into their destination node's input stage. A voice
    // whose destination died renders nowhere but still advances/ends.
    for (auto& voice : voices_) {
      if (voice->ended) continue;
      RenderVoice(*voice, blockTime, frames, sampleRate);
    }
    // Sweep ended voices into the notification ring.
    for (auto it = voices_.begin(); it != voices_.end();) {
      if ((*it)->ended) {
        NotifyEnded((*it)->id);
        it = voices_.erase(it);
      } else {
        ++it;
      }
    }

    // Graph: render the master (0); recursion covers reachable nodes.
    RenderNode(0, blockTime, frames, sampleRate);
    std::copy(Get(0)->block, Get(0)->block + frames * 2, out);

    // Taps observe their node's post-processing output (mono downmix).
    {
      std::lock_guard<std::mutex> lock(tapReadMutex_);
      for (auto& [id, tap] : taps_) {
        if (!tap->alive) continue;
        Node* node = Get(tap->node);
        if (!node) continue;
        if (!node->rendered) RenderNode(tap->node, blockTime, frames, sampleRate);
        for (uint32_t i = 0; i < frames; i++) {
          tap->ring[tap->write] = 0.5f * (node->block[i * 2] + node->block[i * 2 + 1]);
          tap->write = (tap->write + 1) % tap->ring.size();
        }
        tap->filled = true;
      }
    }
  }

 private:
  Node* Get(uint32_t id) {
    auto it = nodes_.find(id);
    return it == nodes_.end() ? nullptr : it->second.get();
  }

  void Push(Command c) {
    std::lock_guard<std::mutex> lock(pendingMutex_);
    pending_.push_back(std::move(c));
  }

  void ApplyPending() {
    std::vector<Command> batch;
    {
      // try_lock: never stall the audio thread on the JS thread. Deferred
      // commands land next block (~2.7 ms) — far inside the 250 ms slack.
      std::unique_lock<std::mutex> lock(pendingMutex_, std::try_to_lock);
      if (!lock.owns_lock()) return;
      batch.swap(pending_);
    }
    for (Command& c : batch) Execute(c);
  }

  void Execute(Command& c) {
    switch (c.op) {
      case Command::Op::CreateNode: {
        auto node = std::make_unique<Node>();
        node->kind = c.nodeKind;
        nodes_[c.a] = std::move(node);
        break;
      }
      case Command::Op::Connect: {
        Node* to = Get(c.b);
        if (!to || !Get(c.a)) break;
        auto& inputs = to->inputs;
        if (std::find(inputs.begin(), inputs.end(), c.a) == inputs.end()) inputs.push_back(c.a);
        break;
      }
      case Command::Op::Disconnect: {
        Node* to = Get(c.b);
        if (!to) break;
        auto& inputs = to->inputs;
        inputs.erase(std::remove(inputs.begin(), inputs.end(), c.a), inputs.end());
        break;
      }
      case Command::Op::DisconnectAll:
        for (auto& [id, node] : nodes_) {
          auto& inputs = node->inputs;
          inputs.erase(std::remove(inputs.begin(), inputs.end(), c.a), inputs.end());
        }
        break;
      case Command::Op::DisposeNode:
        for (auto& [id, node] : nodes_) {
          auto& inputs = node->inputs;
          inputs.erase(std::remove(inputs.begin(), inputs.end(), c.a), inputs.end());
        }
        nodes_.erase(c.a);
        break;
      case Command::Op::ScheduleParam: {
        Node* node = Get(c.a);
        if (!node) break;
        (c.b == 1 ? node->pan : node->gain).Apply(c.event);
        break;
      }
      case Command::Op::Play: {
        auto voice = std::make_unique<Voice>(c.voice);
        voice->buffer = std::move(c.buffer);
        voices_.push_back(std::move(voice));
        break;
      }
      case Command::Op::StopVoice:
        for (auto& voice : voices_) {
          if (voice->id != c.a) continue;
          if (c.x < 0) {
            voice->ended = true;  // immediate: swept + notified this block
          } else {
            voice->stopAt = c.x;
          }
          break;
        }
        break;
      case Command::Op::CreateTap: {
        auto tap = std::make_unique<Tap>();
        tap->node = c.voice.dest;
        tap->ring.assign(c.b, 0.0f);
        std::lock_guard<std::mutex> lock(tapReadMutex_);
        taps_[c.a] = std::move(tap);
        break;
      }
      case Command::Op::DisposeTap: {
        std::lock_guard<std::mutex> lock(tapReadMutex_);
        taps_.erase(c.a);
        break;
      }
    }
  }

  void NotifyEnded(uint32_t id) {
    std::lock_guard<std::mutex> lock(endedMutex_);
    ended_.push_back(id);
  }

  /* Linear-interpolated buffer read into the destination node's block.
   * Start/stop comparisons run on INTEGER stream frames: accumulating
   * seconds slips a start by a frame when blockTime + i/rate rounds a
   * hair under `when` — sample accuracy is a parity requirement. */
  void RenderVoice(Voice& voice, double blockTime, uint32_t frames, double sampleRate) {
    const int64_t blockFrame = static_cast<int64_t>(std::llround(blockTime * sampleRate));
    const int64_t startAt =
        static_cast<int64_t>(std::ceil(voice.when * sampleRate - 1e-6));
    if (startAt >= blockFrame + static_cast<int64_t>(frames)) return;  // not yet
    const int64_t stopFrame =
        voice.stopAt > 1e299
            ? INT64_MAX
            : static_cast<int64_t>(std::ceil(voice.stopAt * sampleRate - 1e-6));
    Node* dest = Get(voice.dest);
    const SharedBuffer& buffer = *voice.buffer;
    if (buffer.channels.empty()) {
      voice.ended = true;
      return;
    }
    const double step = voice.rate * buffer.sampleRate / sampleRate;
    const double bufferFrames = static_cast<double>(buffer.channels[0].size());
    const double startFrame = voice.offsetSec * buffer.sampleRate;
    const double endFrame =
        voice.durationSec >= 0
            ? std::min(bufferFrames, startFrame + voice.durationSec * buffer.sampleRate)
            : bufferFrames;
    const size_t channelCount = buffer.channels.size();

    for (uint32_t i = 0; i < frames; i++) {
      const int64_t frame = blockFrame + i;
      if (frame < startAt) continue;
      if (frame >= stopFrame) {
        voice.ended = true;
        return;
      }
      const double pos = startFrame + voice.position;
      if (pos >= endFrame) {
        voice.ended = true;
        return;
      }
      const size_t i0 = static_cast<size_t>(pos);
      const double frac = pos - static_cast<double>(i0);
      if (dest) {
        for (size_t ch = 0; ch < 2; ch++) {
          const auto& data = buffer.channels[std::min(ch, channelCount - 1)];
          const float s0 = data[i0];
          const float s1 = i0 + 1 < data.size() ? data[i0 + 1] : 0.0f;
          dest->block[i * 2 + ch] += static_cast<float>(s0 + (s1 - s0) * frac);
        }
      }
      voice.position += step;
    }
  }

  /* Bottom-up graph walk: inputs sum, then the node's own processing. */
  void RenderNode(uint32_t id, double blockTime, uint32_t frames, double sampleRate) {
    Node* node = Get(id);
    if (!node || node->rendered) return;
    node->rendered = true;  // set BEFORE recursion: cycles read silence
    for (uint32_t inputId : node->inputs) {
      RenderNode(inputId, blockTime, frames, sampleRate);
      Node* input = Get(inputId);
      if (!input) continue;
      for (uint32_t i = 0; i < frames * 2; i++) node->block[i] += input->block[i];
    }
    const double frameDur = 1.0 / sampleRate;
    if (node->kind == NodeKind::Gain) {
      for (uint32_t i = 0; i < frames; i++) {
        const float g = static_cast<float>(node->gain.ValueAt(blockTime + i * frameDur));
        node->block[i * 2] *= g;
        node->block[i * 2 + 1] *= g;
      }
    } else {
      // The spec's equal-power stereo pan.
      for (uint32_t i = 0; i < frames; i++) {
        double p = node->pan.ValueAt(blockTime + i * frameDur);
        p = p < -1 ? -1 : (p > 1 ? 1 : p);
        const double x = p <= 0 ? p + 1 : p;
        const float gl = static_cast<float>(std::cos(x * kPi / 2));
        const float gr = static_cast<float>(std::sin(x * kPi / 2));
        const float L = node->block[i * 2];
        const float R = node->block[i * 2 + 1];
        if (p <= 0) {
          node->block[i * 2] = L + R * gl;
          node->block[i * 2 + 1] = R * gr;
        } else {
          node->block[i * 2] = L * gl;
          node->block[i * 2 + 1] = R + L * gr;
        }
      }
    }
  }

  std::atomic<uint32_t> nextId_{1};

  std::mutex pendingMutex_;
  std::vector<Command> pending_;

  std::mutex buffersMutex_;
  std::unordered_map<std::string, std::shared_ptr<SharedBuffer>> buffers_;

  std::mutex endedMutex_;
  std::vector<uint32_t> ended_;

  std::mutex tapReadMutex_;

  // Render-thread-owned (edited only via commands).
  std::map<uint32_t, std::unique_ptr<Node>> nodes_;
  std::vector<std::unique_ptr<Voice>> voices_;
  std::map<uint32_t, std::unique_ptr<Tap>> taps_;
};

}  // namespace sdengine
