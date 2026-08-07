import type { PluginDescriptor, PluginRuntimeStatus } from '@core/plugins/descriptor'
import { matchDescriptor } from '@core/plugins/descriptor'
import { builtinEffectProviders } from './effects'

/**
 * The client-local plugin registry: which plugins THIS machine can
 * instantiate. Resolution answers are ephemeral, per-client facts — the
 * project document only ever stores descriptors (see core/plugins).
 *
 * External hosts (VST/CLAP/AU) plug in later by registering providers;
 * nothing above this interface changes.
 */

export interface PluginNodes {
  readonly input: AudioNode
  readonly output: AudioNode
  /** Push param values into live AudioParams, smoothed (no zippering). */
  apply(params: Readonly<Record<string, number>>, when: number): void
  dispose(): void
}

export interface PluginProvider {
  readonly descriptor: PluginDescriptor
  create(ctx: BaseAudioContext): PluginNodes
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
