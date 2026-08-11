import { useState } from 'react'
import { legalGate, useLegalGate } from '@/state/legalGate'

/**
 * A blocking overlay shown once per launch, before anything else renders.
 * No backdrop-click or Escape dismissal — the only way through is the
 * checkbox + button. Covers plugin/EULA responsibility (see
 * PLUGIN_LICENSE_TERMS.md); the app itself stays GPLv3 (see LICENSE).
 */
export function LegalGate(): React.JSX.Element | null {
  const gate = useLegalGate()
  const [checked, setChecked] = useState(false)

  if (gate.accepted) return null

  return (
    <div className="legal-gate-backdrop">
      <div className="legal-gate-window">
        <h2>Before you start</h2>
        <p className="settings-dim">
          SuperDAW loads third-party plugins, and in a collaboration session a plugin&apos;s
          parameter values are shared project data like any other edit — so a collaborator can
          change them and your own installed copy will follow. SuperDAW does not license, vet,
          or take responsibility for any plugin — that&apos;s between you and its maker.
        </p>
        <p className="settings-dim">By continuing, you confirm that:</p>
        <ul className="legal-gate-list settings-dim">
          <li>You own or are licensed to use every plugin you install and load.</li>
          <li>
            You&apos;ve checked that your plugins&apos; EULAs permit how you intend to use them,
            including parameter values authored by collaborators who do not hold a licence for
            that plugin. Settings ▸ Collaboration can limit adjustment to people who have it.
          </li>
          <li>
            You accept sole responsibility for plugin licensing compliance — SuperDAW&apos;s
            creators are not liable for violations.
          </li>
        </ul>
        <p className="settings-dim">
          Full terms: <span className="mono">PLUGIN_LICENSE_TERMS.md</span> in the SuperDAW
          repository.
        </p>
        <label className="legal-gate-checkbox">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          I have read this and agree
        </label>
        <button
          className="corner-btn legal-gate-continue"
          disabled={!checked}
          onClick={() => legalGate.accept()}
        >
          Continue
        </button>
      </div>
    </div>
  )
}
