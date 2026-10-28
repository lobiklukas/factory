/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_ENABLE_DEVTOOLS: string;
  readonly VITE_DEVTOOLS_URL?: string;
  /** The control-plane credential the dashboard sends (LOB-20); unset on an open control plane. */
  readonly VITE_FACTORY_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
