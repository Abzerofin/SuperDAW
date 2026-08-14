import type { PluginDescriptor, PluginRuntimeStatus } from '@core/plugins/descriptor'
import { matchDescriptor } from '@core/plugins/descriptor'
import type { BackendNodeId, IAudioBackend } from './backend'
import { builtinEffectProviders } from './effects'

/**
 * The client-local plugin registry: which plugins THIS machine can
 * instantiate. Resolution answers are ephemeral, per-client facts — the
 * project document only ever stores descriptors (see core/plugins).
 *
 * External hosts (VST/CLAP/AU) plug in later by registering providers;
 * nothing above this interface changes.
 */

/**
 * Live analysis handles a plugin's nodes may expose so the UI can draw
 * what the effect is doing to the audio. Purely observational: taps and
 * read-only values, never part of the processing path.
 *
 * IMPORTANT for implementers: the engine calls `output.disconnect()` when
 * rewiring insert chains, which severs EVERY outgoing connection of the
 * output node. Analyser taps must therefore hang off an INTERNAL node —
 * never off `output` itself — or they go silent after the first rewire.
 */
export interface PluginAnalysis {
  /** Post-effect output tap (frequency + time domain). */
  readonly spectrum?: AnalyserNode
  /** Pre-effect input tap (for dynamics: where on the curve we operate). */
  readonly input?: AnalyserNode
  /** Current gain reduction in dB (≤ 0), from a DynamicsCompressorNode. */
  reductionDb?(): number
}

export interface PluginNodes {
  /** Backend node ids — the seam's currency, so wiring is backend-blind. */
  readonly input: BackendNodeId
  readonly output: BackendNodeId
  /** Push param values into the live nodes, smoothed (no zippering). */
  apply(params: Readonly<Record<string, number>>, when: number): void
  /** Full teardown, backend registrations included — the builder owns
   *  every node it made. */
  dispose(): void
  /** Optional live-visualization handle (see PluginAnalysis). */
  readonly analysis?: PluginAnalysis
}

export interface PluginProvider {
  readonly descriptor: PluginDescriptor
  /**
   * Build against a backend. Null = this provider cannot run there (an
   * effect still needing Web Audio escapes, asked to run natively) — the
   * engine bypasses it cleanly, exactly like a missing plugin.
   */
  create(backend: IAudioBackend): PluginNodes | null
}

export interface Resolution {
  readonly provider: PluginProvider
  /** 'exact' or 'version' only — format substitution is never automatic. */
  readonly quality: 'exact' | 'version'
}

export class PluginRegistry {
  private providers: PluginProvider[] = []
  private listeners = new Set<() => void>()
  private externalHas: ((descriptor: PluginDescriptor) => boolean) | null = null

  register(provider: PluginProvider): void {
    this.providers.push(provider)
    for (const fn of this.listeners) fn()
  }

  /**
   * Availability of OUT-OF-PROCESS plugins (VST3), injected by the app so
   * this module stays free of Electron. These have no provider — they
   * cannot join the audio graph — so they never affect `resolve()`; they
   * only make `status()` answer 'offline' instead of 'missing'.
   */
  setExternalIndex(has: ((descriptor: PluginDescriptor) => boolean) | null): void {
    this.externalHas = has
    for (const fn of this.listeners) fn()
  }

  /** Notifies when providers change (a placeholder may come alive). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Best usable provider: exact match, else same-plugin compatible
   * version. 'format' matches are deliberately excluded — offering the
   * same plugin in another format requires user confirmation, via
   * formatAlternatives().
   */
  resolve(want: PluginDescriptor): Resolution | null {
    let best: Resolution | null = null
    for (const provider of this.providers) {
      const quality = matchDescriptor(want, provider.descriptor)
      if (quality === 'exact') return { provider, quality }
      if (quality === 'version' && !best) best = { provider, quality }
    }
    return best
  }

  /** Same plugin available in a different format — candidates to ASK about. */
  formatAlternatives(want: PluginDescriptor): PluginProvider[] {
    return this.providers.filter((p) => matchDescriptor(want, p.descriptor) === 'format')
  }

  /**
   * Runtime status of a descriptor on this client. 'remote' and 'proxy'
   * become reachable once collaborator audio streaming / proxy renders
   * land — the state machine is in place now so the UI and document model
   * never need to change for them.
   */
  status(want: PluginDescriptor): PluginRuntimeStatus {
    if (this.resolve(want)) return 'local'
    if (this.externalHas?.(want)) return 'offline'
    return 'missing'
  }
}

/** App-wide registry with the builtin suite pre-registered. */
export const pluginRegistry = new PluginRegistry()
for (const provider of builtinEffectProviders()) pluginRegistry.register(provider)
