import { BlockService } from "./BlockService";
import { EmbeddingService } from "./EmbeddingService";
import { ReasoningAgent, RetrievalPlan } from "@/lib/agents/ReasoningAgent";
import { RetrievalAgent } from "@/lib/agents/RetrievalAgent";
import { SynthesisAgent } from "@/lib/agents/SynthesisAgent";
import { MatrixQARequest, MatrixQAResponse, Evidence } from "@/lib/types";
import { v4 as uuidv4 } from "uuid";
import { ChatOpenAI } from "@langchain/openai";
import { LangChainStream } from "ai";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";

interface ConversationState {
  messages: any[];
  schema?: SchemaInfo;
  lastQuery?: string;
  lastAnswer?: string;
}

interface SchemaInfo {
  columnTypes: Record<string, string>;

  potentialKeyColumns: string[];
  valueColumns: string[];
  identifierColumns: string[];
}

const conversationStore: Record<string, ConversationState> = {};

export class MatrixQAService {
  private blockService: BlockService;
  private embeddingService: EmbeddingService;
  private reasoningAgent: ReasoningAgent;
  private retrievalAgent: RetrievalAgent;
  private synthesisAgent: SynthesisAgent;

  constructor() {
    this.blockService = new BlockService();
    this.embeddingService = new EmbeddingService();
    this.reasoningAgent = new ReasoningAgent();
    this.retrievalAgent = new RetrievalAgent(
      this.blockService,
      this.embeddingService
    );
    this.synthesisAgent = new SynthesisAgent();
  }

  async processQuery(): Promise<MatrixQAResponse> {
    throw new Error(
      "Non-streaming processQuery not fully updated for Comtrade."
    );
  }

  async processStreamingQuery(
    request: MatrixQARequest
  ): Promise<{ stream: ReadableStream<any>; metadata: any }> {
    const { messages, sheetId } = request;
    const conversationId = request.conversationId || uuidv4();
    const steps: string[] = [];
    let citations: MatrixQAResponse["citations"] = [];

    if (!conversationStore[conversationId]) {
      conversationStore[conversationId] = { messages: [] };
    }
    const conversationState = conversationStore[conversationId];
    const history = conversationState.messages;

    try {
      steps.push("Analyzing Comtrade table structure...");
      const columns = await this.blockService.getColumnsBySheetId(sheetId);
      const rows = await this.blockService.getRowsBySheetId(sheetId);

      if (rows.length === 0) {
        throw new Error(
          "Comtrade sheet contains no rows. Cannot process query."
        );
      }

      let schemaInfo: SchemaInfo;
      if (conversationState.schema) {
        schemaInfo = conversationState.schema;
        steps.push(
          "Using previously analyzed Comtrade schema from conversation history."
        );
      } else {
        const sampleSize = Math.min(10, rows.length);
        const sampleRows = rows.slice(0, sampleSize);
        steps.push(
          `Analyzing Comtrade schema using ${sampleSize} sample rows...`
        );

        schemaInfo = {
          columnTypes: {},
          potentialKeyColumns: [],
          valueColumns: [],
          identifierColumns: []
        };

        const numericComtradeCols = [
          "fobvalue",
          "cifvalue",
          "netWgt",
          "qty",
          "refYear",
          "refMonth",
          "reporterCode",
          "partnerCode",
          "aggrLevel"
        ];
        const idComtradeCols = [
          "reporterISO",
          "reporterDesc",
          "partnerISO",
          "partnerDesc",
          "cmdCode",
          "cmdDesc",
          "flowCode",
          "flowDesc",
          "period",
          "classificationCode"
        ];
        const boolComtradeCols = ["isReported", "isAggregate"];

        for (const column of columns) {
          const columnName = column.properties?.name || column.id;
          const sampleValues = [];
          for (const row of sampleRows) {
            try {
              const cell = await this.blockService.getCellByColumnAndRow(
                row.id,
                column.id
              );
              sampleValues.push(cell?.properties?.value);
            } catch {
              sampleValues.push(null);
            }
          }

          const nonNullValues = sampleValues.filter(
            (v) => v !== null && v !== undefined && String(v).trim() !== ""
          );
          let inferredType = "unknown";
          if (nonNullValues.length > 0) {
            inferredType = this.inferDataType(nonNullValues);
          }
          schemaInfo.columnTypes[columnName] = inferredType;

          if (
            numericComtradeCols.includes(columnName) &&
            inferredType === "number"
          ) {
            schemaInfo.valueColumns.push(columnName);
          }
          if (idComtradeCols.includes(columnName)) {
            schemaInfo.identifierColumns.push(columnName);
          }
          if (
            boolComtradeCols.includes(columnName) &&
            inferredType === "boolean"
          ) {
          }

          if (
            [
              "reporterISO",
              "partnerISO",
              "cmdCode",
              "flowCode",
              "period"
            ].includes(columnName)
          ) {
            schemaInfo.potentialKeyColumns.push(columnName);
          }
        }
        conversationState.schema = schemaInfo;
      }
      steps.push(
        `Comtrade schema analysis complete: ${columns.length} columns identified.`
      );
      console.log("Inferred Schema Info:", schemaInfo);

      const sheetContext = {
        sheetId,
        columnNames: columns.map((c) => c.properties?.name || c.id),
        rowIds: rows.map((r) => r.id),
        schema: schemaInfo
      };

      steps.push("Planning Comtrade data retrieval...");
      const currentQuery = messages[messages.length - 1].content;
      const { plan, thoughts } = await this.reasoningAgent.planRetrieval(
        currentQuery,
        sheetContext,
        history
      );
      steps.push(...thoughts.map((t) => `Reasoning: ${t}`));
      steps.push(`Plan generated with ${plan.length} steps.`);

      if (plan.length === 0) {
        steps.push(
          "No retrieval plan generated. Attempting synthesis based on query and schema alone."
        );
      }

      steps.push("Retrieving Comtrade evidence...");
      let evidence: Evidence[] = [];
      if (plan.length > 0) {
        evidence = await this.retrievalAgent.retrieveEvidence(plan, sheetId);
      }
      steps.push(
        `Retrieved ${evidence.length} initial evidence pieces (transactions).`
      );

      const finalEvidence = [...evidence];
      steps.push("Proceeding to synthesis with retrieved evidence.");

      citations = this.extractCitationsFromEvidence(finalEvidence);
      steps.push(
        `Found ${citations.length} potential citation points in evidence.`
      );

      const evidenceContext = finalEvidence
        .map(
          (e, index) =>
            `Transaction Record ${index + 1} (Row ID: ${
              e.blockId
            }):\n${e.content.trim()}\n--- Metadata: ${JSON.stringify(
              e.metadata
            )}\n---`
        )
        .join("\n\n");

      steps.push("Synthesizing answer from Comtrade data...");
      const { stream, handlers } = LangChainStream();

      const model = new ChatOpenAI({
        modelName: "gpt-4o",
        temperature: 0.1,
        streaming: true
      });

      const synthesisPrompt = PromptTemplate.fromTemplate(`
          Synthesize an answer based on the user query, conversation history, and the provided UN Comtrade evidence.

          **Conversation History:**
          {history}

          **Evidence Context:**
          {evidenceContext}

          **User Query:**
          {query}

          **Answer:**
        `);

      const chain = RunnableSequence.from([
        {
          query: (input: { query: string }) => input.query,
          evidenceContext: () => evidenceContext,
          history: () =>
            history.map((msg) => `${msg.role}: ${msg.content}`).join("\n") ||
            "No history."
        },
        synthesisPrompt,
        model,
        new StringOutputParser()
      ]);

      chain
        .invoke({ query: currentQuery }, { callbacks: [handlers] })
        .then(async (fullResponse) => {
          try {
            history.push({ role: "user", content: currentQuery });
            history.push({ role: "assistant", content: fullResponse });
            conversationState.lastQuery = currentQuery;
            conversationState.lastAnswer = fullResponse;
            console.log(
              `Conversation ${conversationId} history updated post-stream (Comtrade).`
            );
          } catch (histError) {
            console.error(
              "Error updating conversation history post-stream:",
              histError
            );
          }
        })
        .catch((error) => {
          console.error("Error during streaming synthesis invoke:", error);
          try {
            handlers.handleLLMError(error as Error, "");
          } catch (handlerError) {
            console.error("Error handling LLM error in handler:", handlerError);
          }
        });

      console.log("FINAL STEPS before return:", steps);
      console.log("FINAL CITATIONS before return:", citations);
      return {
        stream,
        metadata: {
          citations,
          conversationId,
          steps
        }
      };
    } catch (error: any) {
      console.error(
        "Error in MatrixQAService (processStreamingQuery - Comtrade):",
        error
      );
      const errorStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            `Error processing Comtrade request: ${
              error.message || "Unknown error"
            }`
          );
          controller.close();
        }
      });
      return {
        stream: errorStream,
        metadata: {
          error: error.message,
          conversationId,
          steps: [...steps, `Error: ${error.message}`],
          citations: []
        }
      };
    }
  }

  private async synthesizeWithFeedbackWrapper(
    query: string,
    evidence: Evidence[],
    history: any[],
    schema: SchemaInfo,
    sheetContext: any
  ): Promise<{
    answer: string;
    needsMoreInfo: boolean;
    followupPlan?: RetrievalPlan[];
  }> {
    console.warn(
      "synthesizeWithFeedbackWrapper needs adaptation for Comtrade data analysis."
    );

    const answer = await this.synthesisAgent.synthesizeAnswer(
      query,
      evidence,
      sheetContext,
      history
    );
    return { answer, needsMoreInfo: false };
  }

  private extractCitationsFromEvidence(
    evidence: Evidence[]
  ): MatrixQAResponse["citations"] {
    const citations: MatrixQAResponse["citations"] = [];
    const processedIds = new Set<string>();

    for (const e of evidence) {
      const cellMatches = Array.from(
        e.content.matchAll(/(.*?)\s*\[cell:([a-fA-F0-9-]+)\]/g)
      );

      for (const match of cellMatches) {
        const cellId = match[2];
        if (!processedIds.has(cellId)) {
          processedIds.add(cellId);
          let contentSnippet =
            match[1]?.trim().split("\n").pop() || "Referenced data";
          if (contentSnippet.length > 100) {
            contentSnippet = "..." + contentSnippet.slice(-97);
          }
          citations.push({
            blockId: cellId,
            contentSnippet: contentSnippet || "Referenced data"
          });
        }
      }

      if (cellMatches.length === 0) {
        const genericMatches = Array.from(
          e.content.matchAll(/\[cell:([a-fA-F0-9-]+)\]/g)
        );
        genericMatches.forEach((gMatch) => {
          const cellId = gMatch[1];
          if (!processedIds.has(cellId)) {
            processedIds.add(cellId);
            citations.push({
              blockId: cellId,
              contentSnippet: "Referenced data"
            });
          }
        });
      }
    }
    return citations;
  }

  private inferDataType(values: any[]): string {
    const nonNullValues = values.filter(
      (v) => v !== null && v !== undefined && String(v).trim() !== ""
    );
    if (nonNullValues.length === 0) return "unknown";

    let numCount = 0;
    let dateCount = 0;
    let boolCount = 0;
    let textCount = 0;

    nonNullValues.forEach((v) => {
      const strValue = String(v).trim();
      if (!isNaN(Number(strValue)) || /^\$?[\d,]+(\.\d+)?$/.test(strValue)) {
        numCount++;
      } else if (
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(
          strValue
        ) ||
        (!isNaN(Date.parse(strValue)) && !/^\d+$/.test(strValue))
      ) {
        dateCount++;
      } else if (["true", "false"].includes(strValue.toLowerCase())) {
        boolCount++;
      } else {
        textCount++;
      }
    });

    if (numCount > textCount && numCount >= dateCount && numCount >= boolCount)
      return "number";
    if (dateCount > textCount && dateCount > numCount && dateCount >= boolCount)
      return "date";
    if (boolCount > textCount && boolCount > numCount && boolCount > dateCount)
      return "boolean";
    return "text";
  }

  private extractCitations(
    answer: string,
    evidence: Evidence[]
  ): MatrixQAResponse["citations"] {
    const citationRegex = /\[cell:([a-fA-F0-9-]+)\]/g;
    const citations: MatrixQAResponse["citations"] = [];
    const citedCells = new Set<string>();
    const evidenceMap = new Map<string, string>();

    evidence.forEach((e) => {
      const cellMatches = Array.from(
        e.content.matchAll(/\[cell:([a-fA-F0-9-]+)\]/g)
      );
      cellMatches.forEach((match) => {
        const cellId = match[1];
        if (!evidenceMap.has(cellId)) {
          evidenceMap.set(cellId, e.content);
        }
      });

      if (e.blockId && !evidenceMap.has(e.blockId)) {
        evidenceMap.set(e.blockId, e.content);
      }
    });

    let match;
    while ((match = citationRegex.exec(answer)) !== null) {
      const cellId = match[1];
      if (!citedCells.has(cellId)) {
        citedCells.add(cellId);

        const relatedEvidenceContent = evidenceMap.get(cellId);
        let contentSnippet = "Referenced data";

        if (relatedEvidenceContent) {
          const lines = relatedEvidenceContent.split("\n");
          const lineWithCitation = lines.find((line) =>
            line.includes(`[cell:${cellId}]`)
          );

          if (lineWithCitation) {
            const snippetMatch = lineWithCitation.match(
              /^-?\s*([^:]+):\s*(.*?)\s*\[cell:/
            );
            if (snippetMatch && snippetMatch[2]?.trim()) {
              contentSnippet = `${snippetMatch[1].trim()}: ${snippetMatch[2].trim()}`;
            } else {
              contentSnippet =
                lineWithCitation.split("[cell:")[0].trim() || contentSnippet;
            }
            if (contentSnippet.length > 100) {
              contentSnippet = "..." + contentSnippet.slice(-97);
            }
          } else {
            contentSnippet = relatedEvidenceContent.substring(0, 70) + "...";
          }
        }

        citations.push({
          blockId: cellId,
          contentSnippet: contentSnippet
        });
      }
    }
    return citations;
  }
}
