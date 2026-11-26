/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set at build time from the network whitelist in app.json. */
  readonly VITE_CHAINVISION_BACKEND: string;
}
