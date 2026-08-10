import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'
// Loaded always, active only under <html data-shell="analog"> (state/theme.ts).
import './styles/analog.css'
import './state/devHandle'
import './lib/closeGuard'
import './lib/autosave'
import './state/assetMemory'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
