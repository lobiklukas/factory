/**
 * The editor's vocabulary (D6, `./definitionVocabulary`) is the rules' own: every key and role it
 * offers is one `authoredDefinitionFaults` accepts, and every key the rules accept is offered — so a
 * picker built from it can neither offer a refusal nor hide a key a file could declare.
 */
import type { BoardColumn } from "@repo/domain/Task";
import { DefinitionId } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { authoredDefinitionFaults, HARNESS_ROLES } from "./boardDefine";
import { definitionVocabulary } from "./definitionVocabulary";
import {
  CHECKED_REQUIREMENTS,
  HUMAN_GATE_REQUIREMENTS,
  KNOWN_REQUIREMENTS,
} from "./requirements";

const TABLE = new Set(["builder"]);
const DECLARED = new Set(["planner", "triager"]);
const vocabulary = definitionVocabulary({ table: TABLE, declared: DECLARED });

/** A valid version whose `doing` column requires `key` and names `role`, behind a gated move. */
const authored = (requires: ReadonlyArray<string>, role?: string) => {
  const doing: BoardColumn = {
    name: "doing",
    kind: "working",
    ...(role === undefined ? {} : { role }),
    skills: [],
    requires: requires.map((key) => ({ key, description: key })),
    transitions: [{ to: "done", gate: "sign-off" }],
  };
  return {
    id: DefinitionId.make("vocabulary"),
    name: "Vocabulary",
    initialColumn: "doing",
    columns: [
      doing,
      {
        name: "done",
        kind: "terminal" as const,
        skills: [],
        requires: [],
        transitions: [],
      },
    ],
  };
};

const library = {
  skills: new Set<string>(),
  roles: TABLE,
  knownRoles: new Set([...HARNESS_ROLES, ...DECLARED]),
};

describe("the definition vocabulary (D6)", () => {
  /** Mutation: drop a key from the list, or offer a key the rules do not know. */
  it("offers exactly the keys the rules know, sorted, each accepted on a gated column", () => {
    const keys = vocabulary.requirements.map((option) => option.key);
    expect(keys).toEqual([...KNOWN_REQUIREMENTS].toSorted());
    expect(authoredDefinitionFaults(authored(keys), library)).toEqual([]);
    expect(
      authoredDefinitionFaults(authored(["not_a_key"]), library).map(
        (fault) => fault.field,
      ),
    ).toEqual(["columns[0].requires[0].key"]);
  });

  /** Mutation: mark every key checked, or none a gate label — the picker would promise a gate. */
  it("marks each key checked and gate-labelled from the rules' own sets, and words it", () => {
    for (const option of vocabulary.requirements) {
      expect(option.checked).toBe(CHECKED_REQUIREMENTS.has(option.key));
      expect(option.humanGate).toBe(HUMAN_GATE_REQUIREMENTS.has(option.key));
      expect(option.description.trim()).not.toBe("");
    }
    expect(
      vocabulary.requirements.find((option) => option.key === "verified")
        ?.description,
    ).toBe("a passing verification of every surface the card's change touched");
  });

  /** Mutation: offer the role table alone — `specifier` and the declared `planner` go missing. */
  it("offers the harness's roles, the declared roles and the role table's, each one the rules accept", () => {
    expect(vocabulary.roles).toEqual(
      [...new Set([...HARNESS_ROLES, ...DECLARED, ...TABLE])].toSorted(),
    );
    expect(vocabulary.roles).toEqual(
      expect.arrayContaining(["builder", "planner", "specifier", "reviewer"]),
    );
    for (const role of vocabulary.roles) {
      expect(authoredDefinitionFaults(authored([], role), library)).toEqual([]);
    }
    expect(
      authoredDefinitionFaults(authored([], "buidler"), library).map(
        (fault) => fault.field,
      ),
    ).toEqual(["columns[0].role"]);
  });
});
