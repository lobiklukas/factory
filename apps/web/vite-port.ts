import { loadEnv } from "vite";

/**
 * The dashboard's dev-server port: `VITE_PORT` from the shell, else from a `.env` in `envDir`, else
 * 3000 (LOB-256). Vite fills only `import.meta.env` from `envDir`, after the config has loaded, so
 * the file is read here with `loadEnv`. A shell value wins over the file, as it does for the API.
 */
export const devPort = (
  mode: string,
  envDir: string,
  shell: Readonly<Record<string, string | undefined>>,
) =>
  Number(
    shell["VITE_PORT"] ?? loadEnv(mode, envDir, "VITE_")["VITE_PORT"] ?? 3000,
  );
