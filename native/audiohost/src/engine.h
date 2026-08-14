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

#include "vst3bridge.h"

namespace sdengine {

constexpr uint32_t kBlockFrames = 128;
constexpr double kPi = 3.14159265358979323846;

// ---------------------------------------------------------------- params

enum class ParamEventKind : uint8_t {
  SetValue,
  LinearRamp,
  ExponentialRamp,
  SetTarget,
  SetCurve,
  Cancel
};

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
        // A ramp whose END is in the future still shapes [now, end).
        const bool isRamp = e.kind == ParamEventKind::LinearRamp ||
                            e.kind == ParamEventKind::ExponentialRamp;
        if (isRamp && valueTime <= t) {
          const double t0 = valueTime < -1e299 ? anchor : valueTime;
          const double v0 = target ? TargetValueAt(*target, value, t) : value;
          if (e.endTime > t0 && t >= t0) {
            const double phase = (t - t0) / (e.endTime - t0);
            if (e.kind == ParamEventKind::LinearRamp) {
              return v0 + (e.value - v0) * phase;
            }
            // Exponential: v0·(v1/v0)^phase, undefined through zero — the
            // spec requires non-zero same-sign endpoints, so a degenerate
            // pair degrades to the linear reading rather than NaN.
            if (v0 > 0 && e.value > 0) return v0 * std::pow(e.value / v0, phase);
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
        case ParamEventKind::ExponentialRamp:
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
  /** A ramp is anchored at its END; every other event at its own time. */
  static double AnchorTime(const ParamEvent& e) {
    return (e.kind == ParamEventKind::LinearRamp ||
            e.kind == ParamEventKind::ExponentialRamp)
               ? e.endTime
               : e.time;
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

enum class NodeKind : uint8_t {
  Gain,
  Panner,
  Biquad,
  Delay,
  Compressor,
  Convolver,
  Oscillator,
  /** The duplex stream's capture side, channel-selected (phase 3). */
  Input,
  /**
   * Plugin-delay compensation: a pure feed-forward integer delay line.
   * Distinct from Delay, whose read side is deliberately a SOURCE clamped
   * to one block so feedback cycles resolve — PDC is never in a cycle and
   * must be EXACT, including exactly zero (the overwhelmingly common
   * value, and the one Web Audio's DelayNode also passes through
   * untouched, so both backends agree).
   */
  Pdc,
  /**
   * An external-format plugin (VST3) processed IN the audio callback via
   * the vst3host bridge. With no bridge attached, or no slot bound, it
   * passes its input through — the same bypass every other unavailable
   * plugin gets.
   */
  External
};

/**
 * A PDC delay line. Built on the JS thread and swapped in by command (the
 * ConvolverState pattern), so the render thread never allocates one; the
 * write head lives here because it is per-node state.
 */
struct PdcState {
  std::vector<float> channel[2];
  size_t write = 0;
};

/**
 * Node 0 is the OUTPUT — what the device actually hears — and node 1 is
 * the master fader hanging off it. Both are pre-created and
 * indestructible.
 *
 * The split exists for one caller: the loopback calibration plays its
 * stimulus POST-fader, exactly as it does on Web Audio (where the sink is
 * ctx.destination, not the master gain), so a pulled-down master can never
 * decide whether the measurement hears itself.
 */
constexpr uint32_t kOutputNode = 0;
constexpr uint32_t kMasterNode = 1;

// ------------------------------------------------------------------ FFT

/**
 * In-place iterative radix-2 complex FFT (length a power of two). Used
 * by the wavetable builder and the convolver; declared here so both see
 * it. (FftImpl below carries the body.)
 */
inline void Fft(std::vector<float>& re, std::vector<float>& im, bool inverse);

/** Web Audio oscillator waveforms. */
enum class OscType : uint8_t { Sine, Square, Sawtooth, Triangle };

inline OscType ParseOscType(const std::string& name) {
  if (name == "square") return OscType::Square;
  if (name == "sawtooth") return OscType::Sawtooth;
  if (name == "triangle") return OscType::Triangle;
  return OscType::Sine;
}

/**
 * Band-limited oscillator wavetables, matching Web Audio's PeriodicWave.
 *
 * Naive shapes alias badly at musical pitches (a 440 Hz saw folds every
 * harmonic above 24 kHz back into the audible band as inharmonic junk),
 * so each waveform is additively synthesized into a set of tables, one
 * per octave, each holding only the harmonics that fit under Nyquist at
 * that range. Playback picks the range from the frequency and crossfades
 * between neighbours.
 *
 * The conventions were recovered by measuring the real OscillatorNode
 * (see nativeOscillator.test.ts):
 *   - the series are the textbook ones — saw Σ(2/πn)(−1)^(n+1)·sin,
 *     square Σ_odd(4/πn)·sin, triangle Σ_odd(8/π²n²)(−1)^((n−1)/2)·sin
 *   - every table shares ONE normalization scale, chosen so the fullest
 *     table peaks at 1.0. That is why Chromium's saw and square harmonics
 *     all read 0.8483× the ideal (1/1.179, the Gibbs overshoot for a jump
 *     of 2) while sine and triangle — which have no jump — read 1.0×.
 */
constexpr size_t kWaveTableSize = 4096;
constexpr size_t kWaveRanges = 12;
constexpr size_t kWaveMaxHarmonics = kWaveTableSize / 2;

struct WaveTableSet {
  // [range][sample]; range r holds kWaveMaxHarmonics >> r harmonics.
  std::vector<std::vector<float>> ranges;

  void Build(OscType type) {
    ranges.assign(kWaveRanges, std::vector<float>(kWaveTableSize, 0.0f));
    for (size_t r = 0; r < kWaveRanges; r++) {
      const size_t harmonics = std::max<size_t>(1, kWaveMaxHarmonics >> r);
      std::vector<float> re(kWaveTableSize, 0.0f), im(kWaveTableSize, 0.0f);
      for (size_t n = 1; n <= harmonics && n < kWaveTableSize / 2; n++) {
        double b = 0;
        switch (type) {
          case OscType::Sine:
            b = n == 1 ? 1.0 : 0.0;
            break;
          case OscType::Sawtooth:
            b = (2.0 / (kPi * n)) * ((n % 2 == 1) ? 1.0 : -1.0);
            break;
          case OscType::Square:
            b = (n % 2 == 1) ? 4.0 / (kPi * n) : 0.0;
            break;
          case OscType::Triangle:
            b = (n % 2 == 1) ? (8.0 / (kPi * kPi * n * n)) *
                                   (((n - 1) / 2) % 2 == 0 ? 1.0 : -1.0)
                             : 0.0;
            break;
        }
        if (b == 0) continue;
        // A sine component of amplitude b at bin n: the inverse transform
        // of ±b/2 j on the conjugate bin pair.
        im[n] = static_cast<float>(-b * kWaveTableSize / 2.0);
        im[kWaveTableSize - n] = static_cast<float>(b * kWaveTableSize / 2.0);
      }
      Fft(re, im, true);
      ranges[r] = re;
    }
    // ONE scale for every range, from the fullest table's peak.
    double peak = 0;
    for (float v : ranges[0]) peak = std::max(peak, std::fabs(static_cast<double>(v)));
    if (peak > 1e-9) {
      const double scale = 1.0 / peak;
      for (auto& table : ranges) {
        for (float& v : table) v = static_cast<float>(v * scale);
      }
    }
  }

  /** Interpolated sample at a normalized phase, band-limited for `freq`. */
  float Sample(double phase, double freq, double sampleRate) const {
    const double nyquist = sampleRate / 2;
    const double allowed = freq > 1e-9 ? nyquist / std::fabs(freq) : kWaveMaxHarmonics;
    // Range r holds (kWaveMaxHarmonics >> r) harmonics; pick the fractional
    // r whose harmonic count is just under what fits, then crossfade.
    double rPos = std::log2(static_cast<double>(kWaveMaxHarmonics) /
                            std::max(1.0, std::min<double>(allowed, kWaveMaxHarmonics)));
    rPos = std::max(0.0, std::min(static_cast<double>(kWaveRanges - 1), rPos));
    const size_t r0 = static_cast<size_t>(rPos);
    const size_t r1 = std::min(r0 + 1, kWaveRanges - 1);
    const double blend = rPos - static_cast<double>(r0);

    const double pos = phase * kWaveTableSize;
    const size_t i0 = static_cast<size_t>(pos) % kWaveTableSize;
    const size_t i1 = (i0 + 1) % kWaveTableSize;
    const double frac = pos - std::floor(pos);
    const double a = ranges[r0][i0] * (1 - frac) + ranges[r0][i1] * frac;
    const double b = ranges[r1][i0] * (1 - frac) + ranges[r1][i1] * frac;
    return static_cast<float>(a * (1 - blend) + b * blend);
  }
};

/** In-place iterative radix-2 complex FFT (length a power of two). */
inline void FftImpl(std::vector<float>& re, std::vector<float>& im, bool inverse) {
  const size_t n = re.size();
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    const double angle = (inverse ? 1 : -1) * 2.0 * kPi / static_cast<double>(len);
    const double stepRe = std::cos(angle);
    const double stepIm = std::sin(angle);
    const size_t half = len >> 1;
    for (size_t i = 0; i < n; i += len) {
      double wRe = 1, wIm = 0;
      for (size_t k = 0; k < half; k++) {
        const size_t a = i + k;
        const size_t b = a + half;
        const double vRe = re[b] * wRe - im[b] * wIm;
        const double vIm = re[b] * wIm + im[b] * wRe;
        re[b] = static_cast<float>(re[a] - vRe);
        im[b] = static_cast<float>(im[a] - vIm);
        re[a] = static_cast<float>(re[a] + vRe);
        im[a] = static_cast<float>(im[a] + vIm);
        const double nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (size_t i = 0; i < n; i++) {
      re[i] /= static_cast<float>(n);
      im[i] /= static_cast<float>(n);
    }
  }
}

inline void Fft(std::vector<float>& re, std::vector<float>& im, bool inverse) {
  FftImpl(re, im, inverse);
}

/**
 * Uniform partitioned overlap-save convolution — one partition per
 * render block, so the reverb adds NO latency (the first partition
 * covers the current block immediately).
 *
 * Convolution is exact math, so unlike the compressor this can match
 * Chromium sample-for-sample. The one non-obvious part is that
 * ConvolverNode NORMALIZES its impulse response by default; the scale
 * was measured off the real node and is reproduced in BuildFrom (see
 * kConvolverGainCalibration).
 *
 * Cost note: a 1.8 s tail at 48 kHz is ~675 partitions, i.e. ~350k
 * multiply-accumulates per block per channel — a few percent of a core
 * per instance. Fine for one or two reverbs; a non-uniform partition
 * scheme is the optimization if many are ever needed at once.
 */
constexpr size_t kConvFft = kBlockFrames * 2;
/** −58 dB, recovered by measuring ConvolverNode (see the tests). */
constexpr double kConvolverGainCalibration = 0.0012589254117941673;
constexpr double kConvolverCalibrationRate = 44100.0;

struct ConvolverState {
  // Per IR partition, per channel: the partition's spectrum.
  std::vector<std::vector<float>> irRe[2], irIm[2];
  // Frequency-delay line of past input spectra, per channel.
  std::vector<std::vector<float>> fdlRe[2], fdlIm[2];
  size_t partitions = 0;
  size_t head = 0;
  // The previous block's input, for overlap-save's leading half.
  float tail[2][kBlockFrames] = {};
  bool ready = false;

  void BuildFrom(const std::vector<std::vector<float>>& channels, double sampleRate) {
    ready = false;
    if (channels.empty() || channels[0].empty()) return;
    const size_t length = channels[0].size();

    // Chromium's normalization: RMS across every channel and sample.
    double power = 0;
    for (const auto& ch : channels) {
      for (float v : ch) power += static_cast<double>(v) * v;
    }
    power = std::sqrt(power / (static_cast<double>(channels.size()) * length));
    if (!(power > 1.25e-4)) power = 1.25e-4;
    const double scale = (kConvolverGainCalibration / power) *
                         (kConvolverCalibrationRate / sampleRate);

    partitions = (length + kBlockFrames - 1) / kBlockFrames;
    head = 0;
    for (size_t ch = 0; ch < 2; ch++) {
      const auto& src = channels[std::min(ch, channels.size() - 1)];
      irRe[ch].assign(partitions, std::vector<float>(kConvFft, 0.0f));
      irIm[ch].assign(partitions, std::vector<float>(kConvFft, 0.0f));
      fdlRe[ch].assign(partitions, std::vector<float>(kConvFft, 0.0f));
      fdlIm[ch].assign(partitions, std::vector<float>(kConvFft, 0.0f));
      for (size_t p = 0; p < partitions; p++) {
        auto& re = irRe[ch][p];
        auto& im = irIm[ch][p];
        for (size_t i = 0; i < kBlockFrames; i++) {
          const size_t at = p * kBlockFrames + i;
          re[i] = at < src.size() ? static_cast<float>(src[at] * scale) : 0.0f;
        }
        Fft(re, im, false);
      }
      std::fill(tail[ch], tail[ch] + kBlockFrames, 0.0f);
    }
    ready = true;
  }
};

// ------------------------------------------------------- compressor curve

/**
 * Chromium's DynamicsCompressor static curve, reconstructed and verified
 * empirically against the real node (see the audiohost README and
 * src/main/__tests__/nativeCompressor.test.ts):
 *
 *   KneeCurve(x, k) = T + (1 − e^(−k(x − T))) / k      (linear amplitude)
 *   k solved so the dB-domain slope at the knee's end equals 1/ratio
 *   above the knee: linear in dB with slope 1/ratio, anchored there
 *   automatic makeup = (1 / Saturate(1))^0.6
 *
 * The makeup is the surprising part — Chromium BOOSTS below-threshold
 * material (8.2 dB at the default-ish settings), which is why a plain
 * textbook compressor would not match. Predicted vs measured agrees to
 * three decimals across the (threshold, knee, ratio) grid, so this is a
 * recovered algorithm rather than an approximation.
 */
struct CompressorCurve {
  double linearThreshold = 0;
  double k = 1;
  double kneeEndDb = 0;
  double kneeEndOutDb = 0;
  double slope = 1;
  double makeupGain = 1;
  // The inputs this was derived from, so it recomputes only on change.
  double forThresholdDb = 1e300, forKneeDb = 0, forRatio = 0;
};

inline double DbToLinear(double db) { return std::pow(10.0, db / 20.0); }
inline double LinearToDb(double x) {
  return x > 1e-30 ? 20.0 * std::log10(x) : -600.0;
}

inline double KneeCurveAt(double x, double linearThreshold, double k) {
  if (x < linearThreshold) return x;
  return linearThreshold + (1.0 - std::exp(-k * (x - linearThreshold))) / k;
}

/** dB-domain slope of the knee curve at x. */
inline double KneeSlopeAt(double x, double linearThreshold, double k) {
  const double y = KneeCurveAt(x, linearThreshold, k);
  if (y <= 0) return 1;
  return (x / y) * std::exp(-k * (x - linearThreshold));
}

/** Output dB for an input dB through the static curve (makeup excluded). */
inline double CompressorCurveDb(const CompressorCurve& c, double inputDb) {
  if (inputDb <= c.forThresholdDb) return inputDb;
  if (inputDb >= c.kneeEndDb) return c.kneeEndOutDb + (inputDb - c.kneeEndDb) * c.slope;
  return LinearToDb(KneeCurveAt(DbToLinear(inputDb), c.linearThreshold, c.k));
}

inline void UpdateCompressorCurve(CompressorCurve& c, double thresholdDb, double kneeDb,
                                  double ratio) {
  if (c.forThresholdDb == thresholdDb && c.forKneeDb == kneeDb && c.forRatio == ratio) return;
  c.forThresholdDb = thresholdDb;
  c.forKneeDb = kneeDb;
  c.forRatio = ratio;

  c.slope = ratio > 0 ? 1.0 / ratio : 1.0;
  c.linearThreshold = DbToLinear(thresholdDb);
  c.kneeEndDb = thresholdDb + kneeDb;
  const double kneeEndLinear = DbToLinear(c.kneeEndDb);

  if (kneeDb > 0) {
    // Binary search for k giving slope == 1/ratio at the knee's end
    // (Chromium's KAtSlope). Monotone in k, so bisection converges.
    double lo = 0.1, hi = 10000.0;
    for (int i = 0; i < 60; i++) {
      const double mid = (lo + hi) / 2;
      if (KneeSlopeAt(kneeEndLinear, c.linearThreshold, mid) > c.slope) lo = mid;
      else hi = mid;
    }
    c.k = (lo + hi) / 2;
    c.kneeEndOutDb = LinearToDb(KneeCurveAt(kneeEndLinear, c.linearThreshold, c.k));
  } else {
    c.k = 1e9;  // a hard knee: the curve collapses onto the threshold
    c.kneeEndOutDb = thresholdDb;
  }

  // Automatic makeup, normalized off the 0 dBFS point — evaluated through
  // the full curve, since 0 dBFS can land inside the knee (a high
  // threshold with a wide knee), not only above it.
  c.makeupGain = std::pow(DbToLinear(-CompressorCurveDb(c, 0.0)), 0.6);
}

/** Web Audio biquad types (the spec's normative coefficient formulas). */
enum class BiquadType : uint8_t {
  Lowpass,
  Highpass,
  Bandpass,
  Notch,
  Peaking,
  Lowshelf,
  Highshelf,
  Allpass
};

inline BiquadType ParseBiquadType(const std::string& name) {
  if (name == "lowpass") return BiquadType::Lowpass;
  if (name == "highpass") return BiquadType::Highpass;
  if (name == "bandpass") return BiquadType::Bandpass;
  if (name == "notch") return BiquadType::Notch;
  if (name == "lowshelf") return BiquadType::Lowshelf;
  if (name == "highshelf") return BiquadType::Highshelf;
  if (name == "allpass") return BiquadType::Allpass;
  return BiquadType::Peaking;
}

/**
 * A capture ring — one input node's selected channels, written by the
 * render thread and drained by the JS thread at UI cadence (§5's table:
 * capture crosses the process boundary in ~100 ms batches, never at
 * callback cadence).
 *
 * Single writer, single reader, no locks and no allocation on the audio
 * thread: the storage is sized on the JS thread and handed over by
 * command, and only `written` crosses threads — its release/acquire pair
 * also publishes `firstSec`/`sampleRate`, which are written once before
 * the first increment. A reader that falls more than a ring behind loses
 * the OLDEST frames and says so through the next chunk's start time, so a
 * take ends up with an audible hole rather than a silent misalignment.
 */
struct CaptureRing {
  std::vector<float> data;  // interleaved stereo, `capacity` frames
  size_t capacity = 0;
  std::atomic<uint64_t> written{0};
  uint64_t read = 0;   // JS thread only
  double firstSec = 0; // stream time of written-frame 0
  double sampleRate = 0;
};

/** One drained batch: stereo planar frames plus the stream time of the
 *  first of them — the seam's `capture(chunk, firstFrameTime)` currency. */
struct CaptureChunk {
  uint32_t node = 0;
  double startSec = 0;
  uint32_t frames = 0;
  std::vector<float> left, right;
};

struct Node {
  NodeKind kind = NodeKind::Gain;
  bool alive = true;
  /**
   * Named param timelines by slot, defaults set at creation:
   *   gain:    p0 = gain (1)
   *   panner:  p0 = pan (0)
   *   biquad:  p0 = frequency (350), p1 = Q (1), p2 = gain dB (0),
   *            p3 = detune cents (0) — Web Audio's defaults.
   */
  ParamTimeline p0{1.0};
  ParamTimeline p1{0.0};
  ParamTimeline p2{0.0};
  ParamTimeline p3{0.0};
  ParamTimeline p4{0.0};
  BiquadType biquadType = BiquadType::Peaking;
  // Biquad state: DF1 histories per stereo channel.
  double bx1[2] = {}, bx2[2] = {}, by1[2] = {}, by2[2] = {};
  // Delay state: one ring per channel (allocated lazily at first render,
  // when the sample rate is known), plus the write head in ring frames.
  // p0 = delayTime seconds; maxDelaySec fixes the ring's size.
  std::vector<float> ring[2];
  size_t ringWrite = 0;
  double maxDelaySec = 1;
  // Compressor state: derived curve, envelope gain (linear, ≤ 1) and the
  // 6 ms lookahead the detector runs ahead of the audio it attenuates.
  CompressorCurve curve;
  double envelopeGain = 1;
  // Convolver: built on the JS thread and swapped in by command, so the
  // render thread never does the (large) partition-spectra allocation.
  std::shared_ptr<ConvolverState> conv;
  // Oscillator: waveform + running phase in [0, 1).
  OscType oscType = OscType::Sine;
  double phase = 0;
  // Pdc: the delay line, or null until a capacity is configured (in which
  // case the node is an exact passthrough). p0 = delayTime seconds.
  std::shared_ptr<PdcState> pdc;
  // External: the vst3host realtime slot, or -1 = bypass.
  int32_t extSlot = -1;
  /**
   * Input: which hardware channel(s) of the capture side to take —
   * audio/input.ts's semantics exactly (mono duplicates one channel to
   * both sides, stereo takes the channel and the next one). `capture` is
   * non-null while someone is recording this input; it is allocated on
   * the JS thread and swapped in here, never built on the audio thread.
   */
  uint32_t inputChannel = 0;
  bool inputStereo = false;
  std::shared_ptr<CaptureRing> capture;
  /**
   * Scheduled-source lifecycle, for GENERATED voices (an oscillator in a
   * synth note) — what buffer voices get from Voice. The node is silent
   * outside [srcStart, srcStop); once srcStop passes it reports ended
   * under `voiceId`, exactly like a buffer voice running out, so the
   * engine's teardown and bookkeeping stay uniform.
   */
  double srcStart = 0;
  double srcStop = 1e300;
  uint32_t voiceId = 0;
  bool srcEnded = false;
  std::vector<uint32_t> inputs;  // node ids feeding this node
  /**
   * Nodes feeding a PARAM rather than the audio input, per slot — Web
   * Audio's audio-rate modulation (an LFO driving a gain). The connected
   * signal is downmixed to mono and ADDED to the timeline's value.
   */
  std::vector<uint32_t> paramInputs[5];
  // Per-block scratch (stereo interleaved) — render thread only.
  float block[kBlockFrames * 2] = {};
  /**
   * Delay-only: voices targeting a delay deposit HERE, not into `block` —
   * a delay's output (ring reads, past data) and its input (this block's
   * arrivals, written to the ring in the ring pass) are different signals,
   * where every other kind processes its input in place.
   */
  float delayIn[kBlockFrames * 2] = {};
  bool rendered = false;
  /**
   * Whether anything STEREO reached this node this block. Web Audio's
   * StereoPanner has two laws — a mono input is placed with
   * (cos, sin), while a stereo one folds one side into the other — and
   * picking the wrong one makes a hard-panned mono clip 2× too loud.
   * Mono sources write the same sample to both channels here, so the
   * distinction has to be carried explicitly.
   */
  bool sawStereo = false;
};

/** Normalized biquad coefficients (a0 divided through). */
struct BiquadCoefficients {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
};

/**
 * The Web Audio spec's coefficient formulas, verbatim: lowpass/highpass
 * read Q in dB (alpha = sin/2 · 10^(−Q/20)), the shelves use S = 1, and
 * A = 10^(gain/40) where gain applies. `freq` is already clamped to
 * (0, nyquist); parity with Chromium is the acceptance test.
 */
inline BiquadCoefficients ComputeBiquad(BiquadType type, double freq, double sampleRate,
                                        double q, double gainDb) {
  const double w0 = 2.0 * kPi * freq / sampleRate;
  const double cosw = std::cos(w0);
  const double sinw = std::sin(w0);
  const double A = std::pow(10.0, gainDb / 40.0);
  const double alphaQdB = (sinw / 2.0) * std::pow(10.0, -q / 20.0);
  const double qClamped = q > 1e-9 ? q : 1e-9;
  const double alphaQ = sinw / (2.0 * qClamped);
  const double alphaS = (sinw / 2.0) * std::sqrt(2.0);
  const double twoRootAAlphaS = 2.0 * std::sqrt(A) * alphaS;

  double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case BiquadType::Lowpass:
      b0 = (1 - cosw) / 2;
      b1 = 1 - cosw;
      b2 = b0;
      a0 = 1 + alphaQdB;
      a1 = -2 * cosw;
      a2 = 1 - alphaQdB;
      break;
    case BiquadType::Highpass:
      b0 = (1 + cosw) / 2;
      b1 = -(1 + cosw);
      b2 = b0;
      a0 = 1 + alphaQdB;
      a1 = -2 * cosw;
      a2 = 1 - alphaQdB;
      break;
    case BiquadType::Bandpass:
      b0 = alphaQ;
      b1 = 0;
      b2 = -alphaQ;
      a0 = 1 + alphaQ;
      a1 = -2 * cosw;
      a2 = 1 - alphaQ;
      break;
    case BiquadType::Notch:
      b0 = 1;
      b1 = -2 * cosw;
      b2 = 1;
      a0 = 1 + alphaQ;
      a1 = -2 * cosw;
      a2 = 1 - alphaQ;
      break;
    case BiquadType::Allpass:
      b0 = 1 - alphaQ;
      b1 = -2 * cosw;
      b2 = 1 + alphaQ;
      a0 = 1 + alphaQ;
      a1 = -2 * cosw;
      a2 = 1 - alphaQ;
      break;
    case BiquadType::Peaking:
      b0 = 1 + alphaQ * A;
      b1 = -2 * cosw;
      b2 = 1 - alphaQ * A;
      a0 = 1 + alphaQ / A;
      a1 = -2 * cosw;
      a2 = 1 - alphaQ / A;
      break;
    case BiquadType::Lowshelf:
      b0 = A * ((A + 1) - (A - 1) * cosw + twoRootAAlphaS);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
      b2 = A * ((A + 1) - (A - 1) * cosw - twoRootAAlphaS);
      a0 = (A + 1) + (A - 1) * cosw + twoRootAAlphaS;
      a1 = -2 * ((A - 1) + (A + 1) * cosw);
      a2 = (A + 1) + (A - 1) * cosw - twoRootAAlphaS;
      break;
    case BiquadType::Highshelf:
      b0 = A * ((A + 1) + (A - 1) * cosw + twoRootAAlphaS);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      b2 = A * ((A + 1) + (A - 1) * cosw - twoRootAAlphaS);
      a0 = (A + 1) - (A - 1) * cosw + twoRootAAlphaS;
      a1 = 2 * ((A - 1) - (A + 1) * cosw);
      a2 = (A + 1) - (A - 1) * cosw - twoRootAAlphaS;
      break;
  }
  BiquadCoefficients out;
  out.b0 = b0 / a0;
  out.b1 = b1 / a0;
  out.b2 = b2 / a0;
  out.a1 = a1 / a0;
  out.a2 = a2 / a0;
  return out;
}

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
  /** Sustain loop in buffer seconds; endSec <= startSec = no loop. */
  double loopStartSec = 0;
  double loopEndSec = 0;
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
    ConfigureNode,
    Connect,
    ConnectParam,
    DisconnectParam,
    Disconnect,
    DisconnectAll,
    DisposeNode,
    ScheduleParam,
    Play,
    ScheduleSource,
    StopVoice,
    CreateTap,
    DisposeTap,
    ConfigureInput,
    SetInputCapture
  } op;
  uint32_t a = 0;  // node / voice / tap id
  uint32_t b = 0;  // target node / frames / input channel
  NodeKind nodeKind = NodeKind::Gain;
  double x = 0;         // stopVoice atTime (<0 = immediate)
  std::string str;      // param name / biquad type / input mode
  ParamEvent event{};
  int32_t slot = -1;    // CreateNode/ConfigureNode (external plugin slot)
  bool haveSlot = false;
  std::shared_ptr<SharedBuffer> buffer;    // Play
  std::shared_ptr<ConvolverState> convState;  // ConfigureNode (convolver IR)
  std::shared_ptr<CaptureRing> captureRing;   // SetInputCapture (null = off)
  std::shared_ptr<PdcState> pdcState;         // ConfigureNode (pdc capacity)
  Voice voice{};                           // Play template
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
    // The output (0) and the master fader (1) hanging off it — see
    // kOutputNode. Both pre-created and indestructible.
    nodes_.emplace(kOutputNode, std::make_unique<Node>());
    nodes_.emplace(kMasterNode, std::make_unique<Node>());
    nodes_[kOutputNode]->inputs.push_back(kMasterNode);
    // Wavetables are built once, here on the constructing (JS) thread —
    // never on the audio thread, and shared by every oscillator node.
    waveTables_[static_cast<size_t>(OscType::Sine)].Build(OscType::Sine);
    waveTables_[static_cast<size_t>(OscType::Square)].Build(OscType::Square);
    waveTables_[static_cast<size_t>(OscType::Sawtooth)].Build(OscType::Sawtooth);
    waveTables_[static_cast<size_t>(OscType::Triangle)].Build(OscType::Triangle);
  }

  // ---- JS thread ----
  //
  // Ids are CALLER-minted (the renderer's proxy allocates them): every
  // command is then one-way fire-and-forget, which is what lets the same
  // protocol run in-process today and over a MessagePort unchanged —
  // an id round-trip per createNode/play would put renderer→host RPC
  // latency inside the scheduling path for no reason.

  /** `typeName` is the biquad/oscillator waveform, or an input's
   *  "mono"/"stereo" mode; `channel` is an input's first hardware channel;
   *  `externalSlot` is an external node's already-open vst3host slot. */
  void CreateNode(uint32_t id, NodeKind kind, const std::string& typeName = "",
                  double maxDelaySec = 1, uint32_t channel = 0, int32_t externalSlot = -1) {
    Command c{Command::Op::CreateNode};
    c.a = id;
    c.b = channel;
    c.nodeKind = kind;
    c.str = typeName;
    c.x = maxDelaySec;
    c.slot = externalSlot;
    Push(std::move(c));
  }

  void ConfigureNode(uint32_t id, const std::string& biquadType) {
    Command c{Command::Op::ConfigureNode};
    c.a = id;
    c.str = biquadType;
    Push(std::move(c));
  }

  /** Re-point an input node's channel selection without rebuilding it. */
  void ConfigureInput(uint32_t id, const std::string& mode, uint32_t channel) {
    Command c{Command::Op::ConfigureInput};
    c.a = id;
    c.b = channel;
    c.str = mode;
    Push(std::move(c));
  }

  /** Point an external node at a realtime plugin slot (-1 = bypass). */
  void SetExternalSlot(uint32_t id, int32_t slot) {
    Command c{Command::Op::ConfigureNode};
    c.a = id;
    c.slot = slot;
    c.haveSlot = true;
    Push(std::move(c));
  }

  /**
   * Start/stop recording an input node. The ring is sized and allocated
   * HERE, on the JS thread; the render thread only ever swaps the finished
   * object in — the same discipline the convolver's partition spectra
   * follow.
   */
  void SetInputCapture(uint32_t nodeId, bool enabled, uint32_t capacityFrames) {
    std::shared_ptr<CaptureRing> ring;
    if (enabled) {
      ring = std::make_shared<CaptureRing>();
      ring->capacity = std::max<size_t>(capacityFrames, kBlockFrames);
      ring->data.assign(ring->capacity * 2, 0.0f);
    }
    {
      std::lock_guard<std::mutex> lock(captureMutex_);
      if (enabled) captures_[nodeId] = ring;
      else captures_.erase(nodeId);
    }
    Command c{Command::Op::SetInputCapture};
    c.a = nodeId;
    c.captureRing = std::move(ring);
    Push(std::move(c));
  }

  /** Everything captured since the last drain, per input node (JS thread). */
  std::vector<CaptureChunk> DrainCapture() {
    std::vector<CaptureChunk> out;
    std::lock_guard<std::mutex> lock(captureMutex_);
    for (auto& [id, ring] : captures_) {
      const uint64_t w = ring->written.load(std::memory_order_acquire);
      if (w <= ring->read) continue;
      uint64_t available = w - ring->read;
      if (available > ring->capacity) {
        // Fell a whole ring behind: the oldest frames are already
        // overwritten. Skip to what survives — the jump in startSec is
        // what tells the recorder to pad the hole with silence.
        ring->read = w - ring->capacity;
        available = ring->capacity;
      }
      CaptureChunk chunk;
      chunk.node = id;
      chunk.frames = static_cast<uint32_t>(available);
      chunk.startSec =
          ring->firstSec +
          (ring->sampleRate > 0 ? static_cast<double>(ring->read) / ring->sampleRate : 0.0);
      chunk.left.resize(available);
      chunk.right.resize(available);
      for (uint64_t i = 0; i < available; i++) {
        const size_t slot = static_cast<size_t>((ring->read + i) % ring->capacity);
        chunk.left[i] = ring->data[slot * 2];
        chunk.right[i] = ring->data[slot * 2 + 1];
      }
      ring->read = w;
      out.push_back(std::move(chunk));
    }
    return out;
  }

  /**
   * Give a PDC node room for `seconds` of delay. The line is built HERE, on
   * the JS thread — the render thread only swaps it in. Recapacitating
   * CLEARS the line, which is why the caller only ever grows it: PDC
   * capacity changes with the plugin set, not with the delay value.
   */
  void SetPdcCapacity(uint32_t id, double seconds, double sampleRate) {
    auto state = std::make_shared<PdcState>();
    if (seconds > 0 && sampleRate > 0) {
      const size_t size =
          static_cast<size_t>(std::ceil(seconds * sampleRate)) + kBlockFrames + 1;
      state->channel[0].assign(size, 0.0f);
      state->channel[1].assign(size, 0.0f);
    }
    Command c{Command::Op::ConfigureNode};
    c.a = id;
    c.pdcState = std::move(state);
    Push(std::move(c));
  }

  /**
   * Publish the vst3host realtime table (native/shared/vst3bridge.h). Call
   * before any External node exists; a null or ABI-mismatched table leaves
   * every external insert bypassing.
   */
  void SetVst3Bridge(const superdaw::Vst3RtBridge* bridge) {
    bridge_.store(
        bridge != nullptr && bridge->abi == superdaw::kVst3RtBridgeAbi ? bridge : nullptr,
        std::memory_order_release);
  }

  /**
   * Point a convolver at a registered buffer. The partition spectra are
   * built HERE, on the JS thread — the render thread only swaps in the
   * finished state. False = no such buffer.
   */
  bool SetConvolverBuffer(uint32_t id, const std::string& bufferId, double sampleRate) {
    std::shared_ptr<SharedBuffer> buffer;
    {
      std::lock_guard<std::mutex> lock(buffersMutex_);
      auto it = buffers_.find(bufferId);
      if (it == buffers_.end()) return false;
      buffer = it->second;
    }
    auto state = std::make_shared<ConvolverState>();
    state->BuildFrom(buffer->channels, sampleRate > 0 ? sampleRate : buffer->sampleRate);
    Command c{Command::Op::ConfigureNode};
    c.a = id;
    c.convState = std::move(state);
    Push(std::move(c));
    return true;
  }

  void Connect(uint32_t from, uint32_t to) {
    Command c{Command::Op::Connect};
    c.a = from;
    c.b = to;
    Push(std::move(c));
  }

  /** Audio-rate modulation: `from`'s signal adds to `to`'s named param. */
  void ConnectParam(uint32_t from, uint32_t to, const std::string& param, bool disconnect) {
    Command c{disconnect ? Command::Op::DisconnectParam : Command::Op::ConnectParam};
    c.a = from;
    c.b = to;
    c.str = param;
    Push(std::move(c));
  }

  void Disconnect(uint32_t from, bool haveTo, uint32_t to) {
    Command c{haveTo ? Command::Op::Disconnect : Command::Op::DisconnectAll};
    c.a = from;
    c.b = to;
    Push(std::move(c));
  }

  void DisposeNode(uint32_t id) {
    if (id == kOutputNode || id == kMasterNode) return;
    {
      std::lock_guard<std::mutex> lock(captureMutex_);
      captures_.erase(id);
    }
    Command c{Command::Op::DisposeNode};
    c.a = id;
    Push(std::move(c));
  }

  void ScheduleParam(uint32_t node, const std::string& param, ParamEvent event) {
    Command c{Command::Op::ScheduleParam};
    c.a = node;
    c.str = param;
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

  /* False when the buffer is unknown (the caller's play() returns null). */
  bool Play(uint32_t id, const std::string& bufferId, double when, double offsetSec,
            double durationSec, double rate, uint32_t dest, double loopStartSec = 0,
            double loopEndSec = 0) {
    std::shared_ptr<SharedBuffer> buffer;
    {
      std::lock_guard<std::mutex> lock(buffersMutex_);
      auto it = buffers_.find(bufferId);
      if (it == buffers_.end()) return false;
      buffer = it->second;
    }
    Command c{Command::Op::Play};
    c.buffer = std::move(buffer);
    c.voice.id = id;
    c.voice.when = when;
    c.voice.offsetSec = offsetSec;
    c.voice.durationSec = durationSec;
    c.voice.rate = rate > 0 ? rate : 1;
    c.voice.dest = dest;
    c.voice.loopStartSec = loopStartSec;
    c.voice.loopEndSec = loopEndSec;
    Push(std::move(c));
    return true;
  }

  /**
   * Schedule a GENERATED source (an oscillator) as a voice: audible from
   * `when` until `stopAt`, then ended under `voiceId`. `stopAt` of
   * infinity means open-ended — a held live note, ended by StopVoice.
   */
  void ScheduleSource(uint32_t voiceId, uint32_t node, double when, double stopAt) {
    Command c{Command::Op::ScheduleSource};
    c.a = node;
    c.b = voiceId;
    c.x = when;
    c.event.time = stopAt;  // reuse: the command's spare double
    Push(std::move(c));
  }

  void StopVoice(uint32_t id, double atTime) {
    Command c{Command::Op::StopVoice};
    c.a = id;
    c.x = atTime;
    Push(std::move(c));
  }

  void CreateTap(uint32_t id, uint32_t node, uint32_t frames) {
    Command c{Command::Op::CreateTap};
    c.a = id;
    c.b = frames < 32 ? 32 : frames;
    c.voice.dest = node;  // reuse the field
    Push(std::move(c));
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
  void RenderOffline(double startTime, uint32_t frames, double sampleRate, float* out,
                     const float* input = nullptr, uint32_t inputChannels = 0) {
    double t = startTime;
    uint32_t done = 0;
    while (done < frames) {
      const uint32_t n = std::min(kBlockFrames, frames - done);
      // Slice the supplied capture material exactly as the duplex callback
      // hands its own input over, so an offline verification run exercises
      // the identical path.
      SetInputBlock(input != nullptr && inputChannels > 0
                        ? input + static_cast<size_t>(done) * inputChannels
                        : nullptr,
                    inputChannels, n);
      RenderBlock(t, n, sampleRate, out + static_cast<size_t>(done) * 2);
      t += static_cast<double>(n) / sampleRate;
      done += n;
    }
    SetInputBlock(nullptr, 0, 0);
  }

  // ---- render thread ----

  /**
   * The duplex stream's capture side for the block ABOUT TO RENDER —
   * interleaved frames exactly as the device callback delivered them.
   * Borrowed, never owned: valid only for the RenderBlock that follows.
   */
  void SetInputBlock(const float* interleaved, uint32_t channels, uint32_t frames) {
    inputBlock_ = interleaved;
    inputBlockChannels_ = channels;
    inputBlockFrames_ = frames;
  }

  /* One block: apply pending commands, run voices into nodes, walk the
   * graph bottom-up into the master, feed taps. `out` = stereo
   * interleaved, `frames` ≤ kBlockFrames. */
  void RenderBlock(double blockTime, uint32_t frames, double sampleRate, float* out) {
    ApplyPending();

    for (auto& [id, node] : nodes_) {
      std::fill(node->block, node->block + frames * 2, 0.0f);
      if (node->kind == NodeKind::Delay) {
        std::fill(node->delayIn, node->delayIn + frames * 2, 0.0f);
      }
      node->rendered = false;
      node->sawStereo = false;
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

    // Scheduled generated sources report ended once their window closes —
    // swept here rather than in the render so an unreachable node (its
    // chain already torn down) still ends instead of leaking its voice.
    const double blockEnd = blockTime + frames / sampleRate;
    for (auto& [id, node] : nodes_) {
      if (node->voiceId == 0 || node->srcEnded) continue;
      if (blockEnd >= node->srcStop) {
        node->srcEnded = true;
        NotifyEnded(node->voiceId);
      }
    }

    // Input nodes are SOURCES fed by the device's capture side, and they
    // render whether or not anything is listening: recording without
    // monitoring is the normal case, so capture must not depend on the
    // node being reachable from the output.
    for (auto& [id, node] : nodes_) {
      if (node->kind != NodeKind::Input) continue;
      RenderNode(id, blockTime, frames, sampleRate);
      CaptureRing* ring = node->capture.get();
      if (ring == nullptr || ring->capacity == 0) continue;
      const uint64_t at = ring->written.load(std::memory_order_relaxed);
      if (at == 0) {
        ring->firstSec = blockTime;
        ring->sampleRate = sampleRate;
      }
      for (uint32_t i = 0; i < frames; i++) {
        const size_t slot = static_cast<size_t>((at + i) % ring->capacity);
        ring->data[slot * 2] = node->block[i * 2];
        ring->data[slot * 2 + 1] = node->block[i * 2 + 1];
      }
      // Release: publishes the frames above AND firstSec/sampleRate.
      ring->written.store(at + frames, std::memory_order_release);
    }

    // Graph: render the output (0); recursion covers reachable nodes.
    RenderNode(kOutputNode, blockTime, frames, sampleRate);
    std::copy(Get(kOutputNode)->block, Get(kOutputNode)->block + frames * 2, out);

    // Delay ring pass: every delay's INPUT sum (feedback subtrees render
    // here — they hang off the delay and are unreachable from the master)
    // is written into its ring, one block behind the read side by
    // construction (see RenderNode's delay case).
    for (auto& [id, node] : nodes_) {
      if (node->kind != NodeKind::Delay) continue;
      if (!node->rendered) RenderNode(id, blockTime, frames, sampleRate);
      EnsureRing(*node, sampleRate);
      float sum[kBlockFrames * 2] = {};
      // Voice deposits arrive via delayIn (see Node.delayIn), graph-edge
      // inputs via their rendered blocks.
      for (uint32_t i = 0; i < frames * 2; i++) sum[i] = node->delayIn[i];
      for (uint32_t inputId : node->inputs) {
        RenderNode(inputId, blockTime, frames, sampleRate);
        Node* in = Get(inputId);
        if (!in) continue;
        for (uint32_t i = 0; i < frames * 2; i++) sum[i] += in->block[i];
      }
      const size_t size = node->ring[0].size();
      for (uint32_t i = 0; i < frames; i++) {
        const size_t at = (node->ringWrite + i) % size;
        node->ring[0][at] = sum[i * 2];
        node->ring[1][at] = sum[i * 2 + 1];
      }
      node->ringWrite = (node->ringWrite + frames) % size;
    }

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

  /** (kind, name) → timeline slot index 0..4; -1 = unknown, ignored. */
  static int ParamSlotIndex(const Node& node, const std::string& name) {
    switch (node.kind) {
      case NodeKind::Gain:
        return name == "gain" ? 0 : -1;
      case NodeKind::Panner:
        return name == "pan" ? 0 : -1;
      case NodeKind::Biquad:
        if (name == "frequency") return 0;
        if (name == "Q") return 1;
        if (name == "gain") return 2;
        if (name == "detune") return 3;
        return -1;
      case NodeKind::Delay:
      case NodeKind::Pdc:
        return name == "delayTime" ? 0 : -1;
      case NodeKind::External:
        return -1;
      case NodeKind::Compressor:
        if (name == "threshold") return 0;
        if (name == "knee") return 1;
        if (name == "ratio") return 2;
        if (name == "attack") return 3;
        if (name == "release") return 4;
        return -1;
      case NodeKind::Oscillator:
        if (name == "frequency") return 0;
        if (name == "detune") return 1;
        return -1;
      case NodeKind::Convolver:
      case NodeKind::Input:
        return -1;
    }
    return -1;
  }

  static ParamTimeline* SlotTimeline(Node& node, int slot) {
    switch (slot) {
      case 0: return &node.p0;
      case 1: return &node.p1;
      case 2: return &node.p2;
      case 3: return &node.p3;
      case 4: return &node.p4;
      default: return nullptr;
    }
  }

  static ParamTimeline* ParamSlot(Node& node, const std::string& name) {
    return SlotTimeline(node, ParamSlotIndex(node, name));
  }

  /** Summed modulation from param-connected sources at sample `i`. */
  double ParamMod(const Node& node, int slot, uint32_t i) {
    if (slot < 0 || node.paramInputs[slot].empty()) return 0;
    double sum = 0;
    for (uint32_t sourceId : node.paramInputs[slot]) {
      auto it = nodes_.find(sourceId);
      if (it == nodes_.end()) continue;
      // Web Audio downmixes a param connection's signal to mono.
      sum += 0.5 * (it->second->block[i * 2] + it->second->block[i * 2 + 1]);
    }
    return sum;
  }

  void Execute(Command& c) {
    switch (c.op) {
      case Command::Op::CreateNode: {
        auto node = std::make_unique<Node>();
        node->kind = c.nodeKind;
        // Per-kind param defaults (Web Audio's own).
        if (c.nodeKind == NodeKind::Gain) {
          node->p0 = ParamTimeline(1.0);
        } else if (c.nodeKind == NodeKind::Panner) {
          node->p0 = ParamTimeline(0.0);
        } else if (c.nodeKind == NodeKind::Delay) {
          node->p0 = ParamTimeline(0.0);  // delayTime seconds
          node->maxDelaySec = c.x > 0 ? c.x : 1;
        } else if (c.nodeKind == NodeKind::Oscillator) {
          node->p0 = ParamTimeline(440.0);  // frequency Hz
          node->p1 = ParamTimeline(0.0);    // detune cents
          node->oscType = c.str.empty() ? OscType::Sine : ParseOscType(c.str);
        } else if (c.nodeKind == NodeKind::Input) {
          node->inputStereo = c.str == "stereo";
          node->inputChannel = c.b;
        } else if (c.nodeKind == NodeKind::Pdc) {
          node->p0 = ParamTimeline(0.0);  // delayTime seconds
        } else if (c.nodeKind == NodeKind::External) {
          node->extSlot = c.slot;
        } else if (c.nodeKind == NodeKind::Compressor) {
          // Web Audio's DynamicsCompressorNode defaults.
          node->p0 = ParamTimeline(-24.0);  // threshold dB
          node->p1 = ParamTimeline(30.0);   // knee dB
          node->p2 = ParamTimeline(12.0);   // ratio
          node->p3 = ParamTimeline(0.003);  // attack sec
          node->p4 = ParamTimeline(0.25);   // release sec
        } else {
          node->p0 = ParamTimeline(350.0);  // frequency
          node->p1 = ParamTimeline(1.0);    // Q
          node->p2 = ParamTimeline(0.0);    // gain dB
          node->p3 = ParamTimeline(0.0);    // detune cents
          node->biquadType = c.str.empty() ? BiquadType::Peaking : ParseBiquadType(c.str);
        }
        nodes_[c.a] = std::move(node);
        break;
      }
      case Command::Op::ConfigureNode: {
        Node* node = Get(c.a);
        if (!node) break;
        if (node->kind == NodeKind::Biquad && !c.str.empty()) {
          node->biquadType = ParseBiquadType(c.str);
        } else if (node->kind == NodeKind::Oscillator && !c.str.empty()) {
          node->oscType = ParseOscType(c.str);
        } else if (node->kind == NodeKind::Convolver && c.convState) {
          node->conv = std::move(c.convState);  // swap, never build, here
        } else if (node->kind == NodeKind::Pdc && c.pdcState) {
          node->pdc = std::move(c.pdcState);  // swap, never build, here
        }
        if (c.haveSlot && node->kind == NodeKind::External) node->extSlot = c.slot;
        break;
      }
      case Command::Op::Connect: {
        Node* to = Get(c.b);
        if (!to || !Get(c.a)) break;
        auto& inputs = to->inputs;
        if (std::find(inputs.begin(), inputs.end(), c.a) == inputs.end()) inputs.push_back(c.a);
        break;
      }
      case Command::Op::ConnectParam: {
        Node* to = Get(c.b);
        if (!to || !Get(c.a)) break;
        const int slot = ParamSlotIndex(*to, c.str);
        if (slot < 0) break;
        auto& list = to->paramInputs[slot];
        if (std::find(list.begin(), list.end(), c.a) == list.end()) list.push_back(c.a);
        break;
      }
      case Command::Op::DisconnectParam: {
        Node* to = Get(c.b);
        if (!to) break;
        const int slot = ParamSlotIndex(*to, c.str);
        if (slot < 0) break;
        auto& list = to->paramInputs[slot];
        list.erase(std::remove(list.begin(), list.end(), c.a), list.end());
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
          for (auto& list : node->paramInputs) {
            list.erase(std::remove(list.begin(), list.end(), c.a), list.end());
          }
        }
        nodes_.erase(c.a);
        break;
      case Command::Op::ScheduleParam: {
        Node* node = Get(c.a);
        if (!node) break;
        ParamTimeline* slot = ParamSlot(*node, c.str);
        if (slot) slot->Apply(c.event);
        break;
      }
      case Command::Op::Play: {
        auto voice = std::make_unique<Voice>(c.voice);
        voice->buffer = std::move(c.buffer);
        voices_.push_back(std::move(voice));
        break;
      }
      case Command::Op::ScheduleSource: {
        Node* node = Get(c.a);
        if (!node) break;
        node->voiceId = c.b;
        node->srcStart = c.x;
        node->srcStop = c.event.time;
        node->srcEnded = false;
        node->phase = 0;
        break;
      }
      case Command::Op::StopVoice: {
        bool found = false;
        for (auto& voice : voices_) {
          if (voice->id != c.a) continue;
          if (c.x < 0) {
            voice->ended = true;  // immediate: swept + notified this block
          } else {
            voice->stopAt = c.x;
          }
          found = true;
          break;
        }
        if (found) break;
        // Generated sources carry their voice id on the node itself.
        for (auto& [id, node] : nodes_) {
          if (node->voiceId != c.a || node->srcEnded) continue;
          if (c.x < 0) {
            node->srcEnded = true;
            NotifyEnded(c.a);
          } else {
            node->srcStop = c.x;
          }
          break;
        }
        break;
      }
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
      case Command::Op::ConfigureInput: {
        Node* node = Get(c.a);
        if (!node || node->kind != NodeKind::Input) break;
        node->inputStereo = c.str == "stereo";
        node->inputChannel = c.b;
        break;
      }
      case Command::Op::SetInputCapture: {
        Node* node = Get(c.a);
        if (!node) break;
        node->capture = std::move(c.captureRing);
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
    const bool looping = voice.loopEndSec > voice.loopStartSec;
    const double loopStartFrame = voice.loopStartSec * buffer.sampleRate;
    const double loopEndFrame =
        std::min(bufferFrames, voice.loopEndSec * buffer.sampleRate);

    for (uint32_t i = 0; i < frames; i++) {
      const int64_t frame = blockFrame + i;
      if (frame < startAt) continue;
      if (frame >= stopFrame) {
        voice.ended = true;
        return;
      }
      double pos = startFrame + voice.position;
      if (looping) {
        // Wrap back to the loop's start instead of ending — Web Audio's
        // loop/loopStart/loopEnd. The voice then runs until stopped.
        if (pos >= loopEndFrame) {
          const double span = loopEndFrame - loopStartFrame;
          pos = loopStartFrame + std::fmod(pos - loopStartFrame, span);
          voice.position = pos - startFrame;
        }
      } else if (pos >= endFrame) {
        voice.ended = true;
        return;
      }
      const size_t i0 = static_cast<size_t>(pos);
      const double frac = pos - static_cast<double>(i0);
      if (dest) {
        if (channelCount >= 2) dest->sawStereo = true;
        // Delays keep input and output apart (see Node.delayIn).
        float* target = dest->kind == NodeKind::Delay ? dest->delayIn : dest->block;
        for (size_t ch = 0; ch < 2; ch++) {
          const auto& data = buffer.channels[std::min(ch, channelCount - 1)];
          const float s0 = data[i0];
          const float s1 = i0 + 1 < data.size() ? data[i0 + 1] : 0.0f;
          target[i * 2 + ch] += static_cast<float>(s0 + (s1 - s0) * frac);
        }
      }
      voice.position += step;
    }
  }

  static void EnsureRing(Node& node, double sampleRate) {
    if (!node.ring[0].empty()) return;
    const size_t size =
        static_cast<size_t>(std::ceil(node.maxDelaySec * sampleRate)) + 2 * kBlockFrames;
    node.ring[0].assign(size, 0.0f);
    node.ring[1].assign(size, 0.0f);
  }

  /* Bottom-up graph walk: inputs sum, then the node's own processing. */
  void RenderNode(uint32_t id, double blockTime, uint32_t frames, double sampleRate) {
    Node* node = Get(id);
    if (!node || node->rendered) return;
    node->rendered = true;  // set BEFORE recursion: cycles read silence
    // Param modulators must be rendered before the params are read.
    for (const auto& list : node->paramInputs) {
      for (uint32_t sourceId : list) RenderNode(sourceId, blockTime, frames, sampleRate);
    }
    if (node->kind == NodeKind::Oscillator) {
      // A source: no inputs, writes its waveform to both channels (so a
      // param connection's mono downmix sees exactly this signal). A
      // SCHEDULED oscillator (voiceId set) is silent outside its window.
      const double frameDur = 1.0 / sampleRate;
      for (uint32_t i = 0; i < frames; i++) {
        const double t = blockTime + i * frameDur;
        if (node->voiceId != 0 && (t < node->srcStart || t >= node->srcStop)) {
          node->block[i * 2] = 0;
          node->block[i * 2 + 1] = 0;
          continue;
        }
        double freq = node->p0.ValueAt(t) + ParamMod(*node, 0, i);
        const double detune = node->p1.ValueAt(t);
        if (detune != 0) freq *= std::pow(2.0, detune / 1200.0);
        const float v = waveTables_[static_cast<size_t>(node->oscType)].Sample(
            node->phase, freq, sampleRate);
        node->block[i * 2] = v;
        node->block[i * 2 + 1] = v;
        node->phase += freq / sampleRate;
        if (node->phase >= 1.0) node->phase -= std::floor(node->phase);
        if (node->phase < 0) node->phase -= std::floor(node->phase);
      }
      return;
    }
    if (node->kind == NodeKind::Input) {
      // The capture side, channel-selected exactly as audio/input.ts does
      // it: mono duplicates one channel to both sides (centred, so panning
      // still decides placement), stereo takes the channel and the next.
      //
      // The output is ALWAYS two channels — the Web Audio tap's merger is
      // a 2-channel node even in mono mode — so `sawStereo` is set
      // unconditionally and a hard-panned monitor obeys the same one of
      // StereoPanner's two laws on both backends.
      node->sawStereo = true;
      const uint32_t channels = inputBlockChannels_;
      if (inputBlock_ == nullptr || channels == 0) return;  // block is zeroed
      const uint32_t left = std::min(node->inputChannel, channels - 1);
      const uint32_t right = node->inputStereo ? std::min(left + 1, channels - 1) : left;
      const uint32_t n = std::min(frames, inputBlockFrames_);
      for (uint32_t i = 0; i < n; i++) {
        node->block[i * 2] = inputBlock_[static_cast<size_t>(i) * channels + left];
        node->block[i * 2 + 1] = inputBlock_[static_cast<size_t>(i) * channels + right];
      }
      return;
    }
    if (node->kind == NodeKind::Delay) {
      // The read side is a SOURCE: it depends only on PAST blocks, which
      // is what breaks feedback cycles at one-block granularity — Web
      // Audio's in-cycle delay rule, applied uniformly (the builtin
      // delay's minimum time is far above one block, so the clamp is
      // moot for real material). The write side settles in RenderBlock's
      // ring pass after the whole graph has rendered.
      EnsureRing(*node, sampleRate);
      const double frameDur = 1.0 / sampleRate;
      const size_t size = node->ring[0].size();
      const double minDelay = static_cast<double>(frames);
      const double maxDelay = static_cast<double>(size - frames - 1);
      for (uint32_t i = 0; i < frames; i++) {
        double delayFrames =
            (node->p0.ValueAt(blockTime + i * frameDur) + ParamMod(*node, 0, i)) * sampleRate;
        if (delayFrames < minDelay) delayFrames = minDelay;
        if (delayFrames > maxDelay) delayFrames = maxDelay;
        double pos = static_cast<double>(node->ringWrite) + i - delayFrames;
        pos = std::fmod(pos, static_cast<double>(size));
        if (pos < 0) pos += static_cast<double>(size);
        const size_t i0 = static_cast<size_t>(pos);
        const double frac = pos - static_cast<double>(i0);
        const size_t i1 = (i0 + 1) % size;
        for (size_t ch = 0; ch < 2; ch++) {
          node->block[i * 2 + ch] = static_cast<float>(
              node->ring[ch][i0] * (1 - frac) + node->ring[ch][i1] * frac);
        }
      }
      return;
    }
    for (uint32_t inputId : node->inputs) {
      RenderNode(inputId, blockTime, frames, sampleRate);
      Node* input = Get(inputId);
      if (!input) continue;
      // A panner always emits stereo; otherwise stereo-ness propagates.
      if (input->sawStereo || input->kind == NodeKind::Panner) node->sawStereo = true;
      for (uint32_t i = 0; i < frames * 2; i++) node->block[i] += input->block[i];
    }
    const double frameDur = 1.0 / sampleRate;
    if (node->kind == NodeKind::Convolver) {
      // Overlap-save: this block's input joins the previous block's as the
      // FFT's two halves; the circular-convolution result's SECOND half is
      // the true linear convolution (the first is the aliased part).
      // The IR's channels are independent, so the output is stereo even
      // from a mono input — which is the point of a stereo reverb.
      node->sawStereo = true;
      ConvolverState* conv = node->conv.get();
      if (!conv || !conv->ready || conv->partitions == 0) {
        std::fill(node->block, node->block + frames * 2, 0.0f);
        return;
      }
      std::vector<float> re(kConvFft), im(kConvFft, 0.0f);
      std::vector<float> accRe(kConvFft), accIm(kConvFft);
      for (size_t ch = 0; ch < 2; ch++) {
        for (size_t i = 0; i < kBlockFrames; i++) {
          re[i] = conv->tail[ch][i];
          re[kBlockFrames + i] =
              i < frames ? node->block[i * 2 + ch] : 0.0f;
          im[i] = 0.0f;
          im[kBlockFrames + i] = 0.0f;
        }
        // Keep this block's input as the next block's leading half.
        for (size_t i = 0; i < kBlockFrames; i++) {
          conv->tail[ch][i] = i < frames ? node->block[i * 2 + ch] : 0.0f;
        }
        Fft(re, im, false);
        conv->fdlRe[ch][conv->head] = re;
        conv->fdlIm[ch][conv->head] = im;

        std::fill(accRe.begin(), accRe.end(), 0.0f);
        std::fill(accIm.begin(), accIm.end(), 0.0f);
        for (size_t p = 0; p < conv->partitions; p++) {
          const size_t slot = (conv->head + conv->partitions - p) % conv->partitions;
          const auto& xr = conv->fdlRe[ch][slot];
          const auto& xi = conv->fdlIm[ch][slot];
          const auto& hr = conv->irRe[ch][p];
          const auto& hi = conv->irIm[ch][p];
          for (size_t b = 0; b < kConvFft; b++) {
            accRe[b] += xr[b] * hr[b] - xi[b] * hi[b];
            accIm[b] += xr[b] * hi[b] + xi[b] * hr[b];
          }
        }
        Fft(accRe, accIm, true);
        for (uint32_t i = 0; i < frames; i++) {
          node->block[i * 2 + ch] = accRe[kBlockFrames + i];
        }
      }
      conv->head = (conv->head + 1) % conv->partitions;
    } else if (node->kind == NodeKind::Compressor) {
      // Chromium's static curve exactly (see CompressorCurve), driven by a
      // peak detector reading 6 ms AHEAD of the audio it attenuates — the
      // lookahead ring — with one-pole attack/release smoothing on the
      // gain. Steady-state levels therefore match the Web Audio node;
      // transient SHAPE can differ slightly (Chromium's envelope has an
      // adaptive-release refinement this does not reproduce), which is
      // why the port is measured rather than assumed: see the test.
      const double thresholdDb = node->p0.ValueAt(blockTime);
      const double kneeDb = node->p1.ValueAt(blockTime);
      const double ratio = node->p2.ValueAt(blockTime);
      UpdateCompressorCurve(node->curve, thresholdDb, kneeDb, ratio);
      const double attack = std::max(1e-4, node->p3.ValueAt(blockTime));
      const double release = std::max(1e-4, node->p4.ValueAt(blockTime));
      const double attackCoeff = std::exp(-1.0 / (attack * sampleRate));
      const double releaseCoeff = std::exp(-1.0 / (release * sampleRate));

      const size_t lookFrames =
          static_cast<size_t>(std::max(1.0, std::round(0.006 * sampleRate)));
      if (node->ring[0].size() != lookFrames) {
        node->ring[0].assign(lookFrames, 0.0f);
        node->ring[1].assign(lookFrames, 0.0f);
        node->ringWrite = 0;
      }
      for (uint32_t i = 0; i < frames; i++) {
        const float inL = node->block[i * 2];
        const float inR = node->block[i * 2 + 1];
        // Detector on the CURRENT sample; audio out is the delayed one.
        const double peak = std::max(std::fabs(inL), std::fabs(inR));
        const double targetGain =
            peak > 1e-9
                ? DbToLinear(CompressorCurveDb(node->curve, LinearToDb(peak)) - LinearToDb(peak))
                : 1.0;
        const double coeff = targetGain < node->envelopeGain ? attackCoeff : releaseCoeff;
        node->envelopeGain = coeff * node->envelopeGain + (1 - coeff) * targetGain;

        const size_t at = node->ringWrite;
        const float delayedL = node->ring[0][at];
        const float delayedR = node->ring[1][at];
        node->ring[0][at] = inL;
        node->ring[1][at] = inR;
        node->ringWrite = (at + 1) % lookFrames;

        const double g = node->envelopeGain * node->curve.makeupGain;
        node->block[i * 2] = static_cast<float>(delayedL * g);
        node->block[i * 2 + 1] = static_cast<float>(delayedR * g);
      }
    } else if (node->kind == NodeKind::Pdc) {
      // Plugin-delay compensation: an exact integer delay, applied to the
      // summed input. With no line configured the delay is zero and the
      // node is a passthrough — which is what every chain looks like until
      // a plugin actually reports latency.
      PdcState* pdc = node->pdc.get();
      const size_t size = pdc ? pdc->channel[0].size() : 0;
      if (size > frames) {
        int64_t delayFrames =
            static_cast<int64_t>(std::llround(node->p0.ValueAt(blockTime) * sampleRate));
        if (delayFrames < 0) delayFrames = 0;
        if (delayFrames > static_cast<int64_t>(size - frames)) {
          delayFrames = static_cast<int64_t>(size - frames);
        }
        for (uint32_t i = 0; i < frames; i++) {
          const size_t at = (pdc->write + i) % size;
          pdc->channel[0][at] = node->block[i * 2];
          pdc->channel[1][at] = node->block[i * 2 + 1];
          // delayFrames == 0 reads back the sample just written: exact.
          const size_t read = (at + size - static_cast<size_t>(delayFrames)) % size;
          node->block[i * 2] = pdc->channel[0][read];
          node->block[i * 2 + 1] = pdc->channel[1][read];
        }
        pdc->write = (pdc->write + frames) % size;
      }
    } else if (node->kind == NodeKind::External) {
      // The whole point of loading vst3host in this process: the plugin
      // runs HERE, one lock-free slot away from the callback, instead of
      // behind the 2-second windowed preview. De-interleave into the
      // engine's shared scratch (single-threaded render, and every input
      // has finished rendering by now), process, interleave back.
      const superdaw::Vst3RtBridge* bridge = bridge_.load(std::memory_order_acquire);
      if (bridge != nullptr && node->extSlot >= 0) {
        for (uint32_t i = 0; i < frames; i++) {
          extIn_[0][i] = node->block[i * 2];
          extIn_[1][i] = node->block[i * 2 + 1];
        }
        if (bridge->process(node->extSlot, extInPtrs_, 2, extOutPtrs_, 2, frames)) {
          for (uint32_t i = 0; i < frames; i++) {
            node->block[i * 2] = extOut_[0][i];
            node->block[i * 2 + 1] = extOut_[1][i];
          }
          node->sawStereo = true;  // a plugin's output bus is stereo
        }
        // A refusal (slot torn down, process() failed) leaves the input
        // untouched — bypass, like every other unavailable plugin.
      }
    } else if (node->kind == NodeKind::Gain) {
      for (uint32_t i = 0; i < frames; i++) {
        const float g = static_cast<float>(node->p0.ValueAt(blockTime + i * frameDur) +
                                           ParamMod(*node, 0, i));
        node->block[i * 2] *= g;
        node->block[i * 2 + 1] *= g;
      }
    } else if (node->kind == NodeKind::Panner) {
      // The spec's equal-power pan, in BOTH of its forms: a mono input is
      // simply placed between the speakers, while a stereo one folds the
      // trailing side into the leading one. Using the stereo law on mono
      // material would make a hard-panned clip twice as loud.
      const bool stereo = node->sawStereo;
      for (uint32_t i = 0; i < frames; i++) {
        double p = node->p0.ValueAt(blockTime + i * frameDur) + ParamMod(*node, 0, i);
        p = p < -1 ? -1 : (p > 1 ? 1 : p);
        const float L = node->block[i * 2];
        const float R = node->block[i * 2 + 1];
        if (!stereo) {
          const double x = (p + 1) / 2;
          node->block[i * 2] = static_cast<float>(L * std::cos(x * kPi / 2));
          node->block[i * 2 + 1] = static_cast<float>(L * std::sin(x * kPi / 2));
          continue;
        }
        const double x = p <= 0 ? p + 1 : p;
        const float gl = static_cast<float>(std::cos(x * kPi / 2));
        const float gr = static_cast<float>(std::sin(x * kPi / 2));
        if (p <= 0) {
          node->block[i * 2] = L + R * gl;
          node->block[i * 2 + 1] = R * gr;
        } else {
          node->block[i * 2] = L * gl;
          node->block[i * 2 + 1] = R + L * gr;
        }
      }
    } else {
      // Biquad: coefficients from the timelines at the block start
      // (k-rate — Chromium recomputes per render quantum too), DF1 per
      // channel with per-node histories.
      double freq = node->p0.ValueAt(blockTime);
      const double detune = node->p3.ValueAt(blockTime);
      if (detune != 0) freq *= std::pow(2.0, detune / 1200.0);
      const double nyquist = sampleRate / 2;
      freq = freq < 0 ? 0 : (freq > nyquist ? nyquist : freq);
      const BiquadCoefficients k = ComputeBiquad(
          node->biquadType, freq, sampleRate, node->p1.ValueAt(blockTime),
          node->p2.ValueAt(blockTime));
      for (size_t ch = 0; ch < 2; ch++) {
        double x1 = node->bx1[ch], x2 = node->bx2[ch];
        double y1 = node->by1[ch], y2 = node->by2[ch];
        for (uint32_t i = 0; i < frames; i++) {
          const double x = node->block[i * 2 + ch];
          const double y = k.b0 * x + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
          node->block[i * 2 + ch] = static_cast<float>(y);
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
        }
        node->bx1[ch] = x1;
        node->bx2[ch] = x2;
        node->by1[ch] = y1;
        node->by2[ch] = y2;
      }
    }
  }

  std::mutex pendingMutex_;
  std::vector<Command> pending_;

  std::mutex buffersMutex_;
  std::unordered_map<std::string, std::shared_ptr<SharedBuffer>> buffers_;

  std::mutex endedMutex_;
  std::vector<uint32_t> ended_;

  std::mutex tapReadMutex_;

  /** JS-thread-owned view of the live capture rings (the render thread
   *  reaches them only through the node that owns the shared_ptr). */
  std::mutex captureMutex_;
  std::map<uint32_t, std::shared_ptr<CaptureRing>> captures_;

  /** The current block's capture material — see SetInputBlock. */
  const float* inputBlock_ = nullptr;
  uint32_t inputBlockChannels_ = 0;
  uint32_t inputBlockFrames_ = 0;

  /** The vst3host realtime table, or null (every external node bypasses). */
  std::atomic<const superdaw::Vst3RtBridge*> bridge_{nullptr};
  /**
   * De-interleave scratch for external plugins, shared by every External
   * node: rendering is single-threaded and a node's inputs have all
   * finished before it touches this, so one buffer is enough.
   */
  float extIn_[2][kBlockFrames] = {};
  float extOut_[2][kBlockFrames] = {};
  const float* extInPtrs_[2] = {extIn_[0], extIn_[1]};
  float* extOutPtrs_[2] = {extOut_[0], extOut_[1]};

  WaveTableSet waveTables_[4];

  // Render-thread-owned (edited only via commands).
  std::map<uint32_t, std::unique_ptr<Node>> nodes_;
  std::vector<std::unique_ptr<Voice>> voices_;
  std::map<uint32_t, std::unique_ptr<Tap>> taps_;
};

}  // namespace sdengine
