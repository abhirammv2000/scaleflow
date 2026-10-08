// The two LLM agents, with the OpenAI client replaced by a script. No network and no API key.
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  }
}));

import { ReasoningAgent } from "@/lib/agents/ReasoningAgent";
import { SynthesisAgent } from "@/lib/agents/SynthesisAgent";

const UUID = "3f2b8c1e-4d5a-4b6c-9d7e-1a2b3c4d5e6f";
const SHEET = { sheetId: "sheet-1", columnNames: ["fobvalue", "reporterDesc"], rowIds: [UUID] };

function replyWith(content: string | null) {
  create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

function plan(overrides: object = {}) {
  return {
    type: "semantic",
    query: "Australia exports November 2023",
    filters: { rowIds: ["*"], reporterISO: "AUS", flowCode: "X", refYear: 2023, refMonth: 11, isAggregate: false },
    reasoning: "get the export rows",
    ...overrides
  };
}

beforeEach(() => {
  create.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ReasoningAgent.planRetrieval", () => {
  const agent = new ReasoningAgent();

  it("returns the validated plan and thoughts", async () => {
    replyWith(JSON.stringify({ thoughts: ["need exports"], plan: [plan()] }));

    const result = await agent.planRetrieval("Australia exports in Nov 2023?", SHEET);

    expect(result.thoughts).toEqual(["need exports"]);
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0].filters.reporterISO).toBe("AUS");
  });

  it("asks for JSON, a low temperature and the sheet context", async () => {
    replyWith(JSON.stringify({ thoughts: [], plan: [plan()] }));

    await agent.planRetrieval("q", SHEET);

    const request = create.mock.calls[0][0];
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.temperature).toBeLessThanOrEqual(0.2);
    expect(request.messages[0].content).toContain("sheet-1");
    expect(request.messages[0].content).toContain("fobvalue, reporterDesc");
  });

  it("puts earlier turns between the system prompt and the new question", async () => {
    replyWith(JSON.stringify({ thoughts: [], plan: [plan()] }));
    const history = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" }
    ];

    await agent.planRetrieval("follow up", SHEET, history);

    const roles = create.mock.calls[0][0].messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(create.mock.calls[0][0].messages[3].content).toBe("follow up");
  });

  it("accepts keyword and specific plans when their required field is there", async () => {
    replyWith(
      JSON.stringify({
        thoughts: [],
        plan: [plan({ type: "keyword", query: undefined, keywords: ["wheat"] }), plan({ type: "specific", query: undefined, blockIds: [UUID] })]
      })
    );

    const result = await agent.planRetrieval("q", SHEET);

    expect(result.plan.map((p) => p.type)).toEqual(["keyword", "specific"]);
  });

  it.each([
    ["a semantic plan with no query", plan({ query: undefined })],
    ["a semantic plan with a blank query", plan({ query: "   " })],
    ["a keyword plan with no keywords", plan({ type: "keyword", query: undefined })],
    ["a keyword plan with an empty list", plan({ type: "keyword", keywords: [] })],
    ["a specific plan with no block ids", plan({ type: "specific", query: undefined })],
    ["a specific plan with a block id that is not a uuid", plan({ type: "specific", blockIds: ["not-a-uuid"] })],
    ["an unknown plan type", plan({ type: "magic" })],
    ["a plan with no reasoning", plan({ reasoning: undefined })],
    ["a filter of the wrong type", plan({ filters: { refYear: "2023" } })]
  ])("rejects %s", async (_name, badPlan) => {
    replyWith(JSON.stringify({ thoughts: [], plan: [badPlan] }));

    await expect(agent.planRetrieval("q", SHEET)).rejects.toThrow(/Reasoning agent output failed validation/);
  });

  it("rejects an answer with no plan key", async () => {
    replyWith(JSON.stringify({ thoughts: ["x"] }));

    await expect(agent.planRetrieval("q", SHEET)).rejects.toThrow(/failed validation/);
  });

  it("reports output that is not JSON", async () => {
    replyWith("Sure! Here is the plan: ...");

    await expect(agent.planRetrieval("q", SHEET)).rejects.toThrow(/not valid JSON/);
  });

  it("reports empty content", async () => {
    replyWith(null);

    await expect(agent.planRetrieval("q", SHEET)).rejects.toThrow(/empty content/);
  });

  it("wraps a provider failure so the caller can tell where it came from", async () => {
    create.mockRejectedValueOnce(new Error("429 rate limited"));

    await expect(agent.planRetrieval("q", SHEET)).rejects.toThrow("ReasoningAgent failed: 429 rate limited");
  });
});

describe("SynthesisAgent.synthesizeAnswer", () => {
  const agent = new SynthesisAgent();
  const evidence = [
    { rowId: "row-1", content: "reporter Australia, fobvalue $1,000 [cell:abc]", metadata: { isAggregate: false } },
    { rowId: "row-2", content: "reporter Australia, fobvalue $2,000 [cell:def]", metadata: { isAggregate: false } }
  ] as never[];

  it("does not call the model when there is no evidence", async () => {
    const answer = await agent.synthesizeAnswer("q", [], SHEET);

    expect(answer).toMatch(/couldn't find any relevant trade data/);
    expect(create).not.toHaveBeenCalled();
  });

  it("gives the model every record and the citation rule, and returns its trimmed answer", async () => {
    replyWith("  Total exports were $3,000 [cell:abc] [cell:def].  \n");

    const answer = await agent.synthesizeAnswer("total exports?", evidence, SHEET);

    expect(answer).toBe("Total exports were $3,000 [cell:abc] [cell:def].");
    const system = create.mock.calls[0][0].messages[0].content;
    expect(system).toContain("Transaction Record 1 (Row ID: row-1)");
    expect(system).toContain("Transaction Record 2 (Row ID: row-2)");
    expect(system).toContain("[cell:ID]");
    expect(system).toContain("Analyze ALL 2 provided transaction records");
  });

  it("caps the answer length", async () => {
    replyWith("ok");

    await agent.synthesizeAnswer("q", evidence, SHEET);

    expect(create.mock.calls[0][0].max_tokens).toBeLessThanOrEqual(2000);
  });

  it("reports empty content and provider failures", async () => {
    replyWith(null);
    await expect(agent.synthesizeAnswer("q", evidence, SHEET)).rejects.toThrow(/empty content/);

    create.mockRejectedValueOnce(new Error("timeout"));
    await expect(agent.synthesizeAnswer("q", evidence, SHEET)).rejects.toThrow("SynthesisAgent failed: timeout");
  });
});
