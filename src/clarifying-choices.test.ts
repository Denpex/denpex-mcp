// MCP must render the engine's questions in the form an AGENT can act on, and must
// not lead the witness while doing it.
//
// The MCP caller is almost always a model, not a person. Handed "tell me whether the
// fabric is healthy", an agent has to invent a way to find out, and inventing is
// exactly what produces a confident, fabricated answer flowing back into the next
// verdict. Handed an enumerated option list it can pick one, or run `command` and
// report the real output.
//
// The rule under test is the same one the engine enforces: `(Recommended)` may appear
// only on an ACTION question. A recommendation on a question of FACT ("did this hit
// one rank or all of them?") returns the hinted answer rather than the observed one.
// The renderer therefore suppresses the marker on a fact question even when the
// payload sets it, so a stale or malicious worker cannot bias the caller.
import { describe, it, expect } from "vitest";
import { viewFromCloud, renderDiagnosis } from "./format";

/** Minimal payload in the shape /api/diagnose returns. */
const payload = (clarifyingChoices: unknown, clarifying: string[] = []) => ({
  success: true,
  meta: { failureType: "NCCL_TIMEOUT", confidence: 55, source: "tier0", tier: 0 },
  fix: {
    summary: "Not enough evidence to isolate one cause.",
    action: "1. Check the fabric.",
    prevention: [],
    steps: [],
    evidence: [],
    clarifyingQuestions: clarifying,
    clarifyingChoices,
  },
});

const ACTION_Q = {
  id: "check-fabric",
  kind: "action",
  question: "Which of these can you run right now?",
  allowOther: true,
  command: "ibstat && ibv_devinfo",
  options: [
    { id: "act.ibstat", label: "Check the fabric link state", detail: "ibstat and ibv_devinfo.", recommended: true },
    { id: "act.none", label: "None of these right now" },
  ],
};

const FACT_Q = {
  id: "blast-radius",
  kind: "fact",
  question: "Did the failure hit one rank or all of them?",
  allowOther: true,
  options: [
    { id: "scope.one-rank", label: "One rank" },
    { id: "scope.all-ranks", label: "Every rank at once" },
    { id: "unsure", label: "I'm not sure" },
  ],
};

describe("MCP carries the structured questions", () => {
  it("extracts clarifyingChoices from the payload", () => {
    const v = viewFromCloud(payload([ACTION_Q]));
    expect(v.clarifyingChoices).toHaveLength(1);
    expect(v.clarifyingChoices[0]?.id).toBe("check-fabric");
  });

  it("renders each option with its id, so an agent can answer with one", () => {
    const md = renderDiagnosis(viewFromCloud(payload([ACTION_Q])));
    expect(md).toContain("act.ibstat");
    expect(md).toContain("act.none");
    expect(md).toContain("Which of these can you run right now?");
  });

  it("tells the agent how to reply", () => {
    const md = renderDiagnosis(viewFromCloud(payload([ACTION_Q])));
    expect(md).toContain("diagnose_crash");
    expect(md).toContain("operatorAnswers");
  });

  it("surfaces the exact command behind the recommended option", () => {
    const md = renderDiagnosis(viewFromCloud(payload([ACTION_Q])));
    expect(md).toContain("ibstat && ibv_devinfo");
  });

  it("falls back to the plain list when the worker is older and sends no choices", () => {
    // A stale diagnosis worker must degrade to the previous behaviour, not to silence.
    const md = renderDiagnosis(viewFromCloud(payload(undefined, ["Check ibstat on node012"])));
    expect(md).toContain("Check ibstat on node012");
    expect(md).toContain("ask_followup");
  });

  it("renders nothing about questions when there are none", () => {
    const md = renderDiagnosis(viewFromCloud(payload(undefined, [])));
    expect(md).not.toContain("To narrow it down");
  });
});

describe("MCP does not lead the witness", () => {
  it("marks the recommended option on an ACTION question", () => {
    const md = renderDiagnosis(viewFromCloud(payload([ACTION_Q])));
    expect(md).toContain("(Recommended)");
  });

  it("SUPPRESSES a recommendation on a FACT question even if the payload sets one", () => {
    // The engine forbids this shape. This asserts MCP is independently safe against
    // it, because the payload crosses a network boundary from a worker that may be
    // older than this client.
    const poisoned = { ...FACT_Q, options: [{ ...FACT_Q.options[0], recommended: true }, ...FACT_Q.options.slice(1)] };
    const md = renderDiagnosis(viewFromCloud(payload([poisoned])));
    expect(md).toContain("Did the failure hit one rank");
    expect(md).not.toContain("(Recommended)");
  });

  it("tells the agent not to guess on a question of fact", () => {
    const md = renderDiagnosis(viewFromCloud(payload([FACT_Q])));
    expect(md.toLowerCase()).toContain("rather than guessing");
  });

  it("offers the honest 'not known' option on a fact question", () => {
    const md = renderDiagnosis(viewFromCloud(payload([FACT_Q])));
    expect(md).toContain("unsure");
  });
});

describe("malformed payloads cannot crash the renderer", () => {
  // Everything here arrives over the network from another process. Model output and
  // stale workers are both untrusted input.
  it.each([
    ["null", null],
    ["a string", "not an array"],
    ["an empty array", []],
    ["array of nulls", [null, undefined]],
    ["question with no options", [{ id: "q", question: "Why?" }]],
    ["options with no labels", [{ id: "q", question: "Why?", options: [{}, {}] }]],
    ["question with no text", [{ id: "q", options: [{ id: "a", label: "A" }] }]],
  ])("survives %s", (_name, choices) => {
    expect(() => renderDiagnosis(viewFromCloud(payload(choices)))).not.toThrow();
  });
});
