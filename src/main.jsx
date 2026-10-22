import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './auth/index.js'
import { applyDensity, readDensity } from './utils/density.js'

// Set the remembered density before the first paint so a compact table never flashes comfortable.
applyDensity(document.documentElement, readDensity(window.localStorage))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
