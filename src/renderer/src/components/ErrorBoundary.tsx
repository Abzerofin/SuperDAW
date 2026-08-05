import React from 'react'
import { saveProject } from '@/lib/projectFile'

interface State {
  error: Error | null
}

/**
 * Last line of defense: a render crash must never white-screen the DAW.
 * Project state lives outside React (ProjectStore), so remounting the tree
 * recovers with all work intact — and Save As is offered just in case.
 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('UI crash caught by ErrorBoundary:', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="crash">
        <div className="crash-panel">
          <div className="crash-title">Something went wrong in the interface</div>
          <div className="crash-message mono">{this.state.error.message}</div>
          <div className="crash-note">
            Your project is intact — the interface crashed, not your work.
          </div>
          <div className="crash-actions">
            <button className="corner-btn" onClick={() => this.setState({ error: null })}>
              Recover
            </button>
            <button className="corner-btn" onClick={() => void saveProject(true)}>
              Save project as…
            </button>
          </div>
        </div>
      </div>
    )
  }
}
