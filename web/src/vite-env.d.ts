/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the API stub runs: 'node' (port 3001 behind the proxy) or 'msw' (in the browser). Set in vite.config.ts. */
  readonly VITE_STUB: 'node' | 'msw'
}
