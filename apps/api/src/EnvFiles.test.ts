import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, it } from "vitest";
import {
  autoloadedEnvFiles,
  describeLoadedEnvFiles,
  explicitEnvFiles,
  loadedEnvFiles,
} from "./EnvFiles";

const loadedWith = (
  present: readonly string[],
  input: {
    readonly execArgv: readonly string[];
    readonly cwd?: string;
    readonly nodeEnv?: string;
  },
) =>
  Effect.runPromise(
    loadedEnvFiles({
      execArgv: input.execArgv,
      cwd: input.cwd ?? "/repo/apps/api",
      nodeEnv: input.nodeEnv,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Path.layer,
          FileSystem.layerNoop({
            exists: (path) => Effect.succeed(present.includes(path)),
          }),
        ),
      ),
    ),
  );

describe("explicitEnvFiles", () => {
  it("reads both spellings of --env-file, in order, and ignores other flags", () => {
    expect(
      explicitEnvFiles([
        "--watch",
        "--env-file=../../.env",
        "--env-file",
        "local.env",
        "--hot",
      ]),
    ).toEqual(["../../.env", "local.env"]);
  });

  it("finds none when no flag names one", () => {
    expect(explicitEnvFiles([])).toEqual([]);
    expect(explicitEnvFiles(["--env-file"])).toEqual([]);
  });
});

describe("autoloadedEnvFiles", () => {
  it("follows NODE_ENV the way Bun does", () => {
    expect(autoloadedEnvFiles(undefined)).toEqual([
      ".env",
      ".env.development",
      ".env.local",
    ]);
    expect(autoloadedEnvFiles("production")).toEqual([
      ".env",
      ".env.production",
      ".env.local",
    ]);
    expect(autoloadedEnvFiles("test")).toEqual([".env", ".env.test"]);
  });
});

describe("loadedEnvFiles", () => {
  it("lists the root file the dev script names, as an absolute path", async () => {
    expect(
      await loadedWith(["/repo/.env"], { execArgv: ["--env-file=../../.env"] }),
    ).toEqual(["/repo/.env"]);
  });

  it("omits a file that does not exist: a flag naming it supplied nothing", async () => {
    expect(
      await loadedWith([], { execArgv: ["--env-file=../../.env"] }),
    ).toEqual([]);
  });

  it("lists the package's own autoloaded file beside the root one, once each", async () => {
    expect(
      await loadedWith(["/repo/.env", "/repo/apps/api/.env"], {
        execArgv: ["--env-file=../../.env", "--env-file=.env"],
      }),
    ).toEqual(["/repo/.env", "/repo/apps/api/.env"]);
  });
});

describe("describeLoadedEnvFiles", () => {
  it("names paths and says values are never logged", () => {
    const line = describeLoadedEnvFiles(["/repo/.env"]);
    expect(line).toContain("/repo/.env");
    expect(line).toContain("never logged");
  });

  it("says plainly when nothing was loaded", () => {
    expect(describeLoadedEnvFiles([])).toBe(
      "env files loaded: none (the process environment only)",
    );
  });
});
