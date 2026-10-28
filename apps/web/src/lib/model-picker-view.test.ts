/**
 * The New session form's model picker (LOB-274). That the server resolves and pins the model is
 * proven where it happens (`packages/core`'s `SessionService.test.ts`); the browser drive
 * (`.pi/skills/verify-web/model.sh`) proves the page sends it. These are the rules a drive does not
 * reach cheaply: a server that has not answered, a model two roles share, and the default sent as
 * nothing at all.
 */
import { describe, expect, it } from "vitest";
import { modelChoices, modelInput, SERVER_DEFAULT } from "./model-picker-view";

const info = {
  defaultModel: "faux/faux-cheap",
  models: ["faux/faux-1", "faux/faux-cheap", "faux/faux-spec"],
  roleModels: [
    { role: "reviewer", model: "faux/faux-spec" },
    { role: "specifier", model: "faux/faux-spec" },
  ],
};

describe("modelChoices", () => {
  it("offers the server's default first, then every model it serves, in its order", () => {
    expect(modelChoices(info)).toEqual([
      { value: SERVER_DEFAULT, label: "Server default (faux/faux-cheap)" },
      { value: "faux/faux-1", label: "faux/faux-1" },
      { value: "faux/faux-cheap", label: "faux/faux-cheap (default)" },
      {
        value: "faux/faux-spec",
        label: "faux/faux-spec (reviewer, specifier)",
      },
    ]);
  });

  /** Mutation: offer a hard-coded model list, or nothing, before `getServerInfo` answers. */
  it("offers only the server's default before the server has said what it serves", () => {
    expect(modelChoices(undefined)).toEqual([
      { value: SERVER_DEFAULT, label: "Server default" },
    ]);
  });
});

describe("modelInput", () => {
  /** Mutation: send `model: ""`, or the default's key, which would pin it over a column's role. */
  it("sends no model for the server's default, and the model for any other choice", () => {
    expect(modelInput(SERVER_DEFAULT)).toEqual({});
    expect("model" in modelInput(SERVER_DEFAULT)).toBe(false);
    expect(modelInput("faux/faux-spec")).toEqual({ model: "faux/faux-spec" });
  });
});
