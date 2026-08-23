import OpenAI from "openai";
import { z } from "zod";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const REASONING_MODEL = "gpt-4o";

const FilterSchema = z.object({
  rowIds: z.array(z.union([z.string().uuid(), z.literal("*")])).optional(),
  columnIds: z.array(z.string()).optional(),
  reporterISO: z.string().optional(),
  partnerISO: z.string().optional(),
  cmdCode: z.string().optional(),
  flowCode: z.string().optional(),
  refYear: z.number().int().optional(),
  refMonth: z.number().int().optional(),
  isAggregate: z.boolean().optional()
});

const RetrievalPlanSchema = z
  .object({
    type: z.enum(["semantic", "keyword", "specific"]),
    query: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    blockIds: z.array(z.string().uuid()).optional(),
    filters: FilterSchema,
    reasoning: z.string()
  })
  .refine(
    (data) => {
      if (data.type === "specific")
        return data.blockIds && data.blockIds.length > 0;
      if (data.type === "semantic")
        return typeof data.query === "string" && data.query.trim().length > 0;
      if (data.type === "keyword")
        return data.keywords && data.keywords.length > 0;
      return true;
    },
    {
      message:
        "Invalid combination of 'type' and required fields (query/keywords/blockIds)"
    }
  );

const AgentResponseSchema = z.object({
  thoughts: z.array(z.string()),
  plan: z.array(RetrievalPlanSchema)
});

export interface RetrievalPlan {
  type: "semantic" | "keyword" | "specific";
  query?: string;
  keywords?: string[];
  blockIds?: string[];
  filters: {
    rowIds?: (string | "*")[];
    columnIds?: string[];

    reporterISO?: string;
    partnerISO?: string;
    cmdCode?: string;
    flowCode?: string;
    refYear?: number;
    refMonth?: number;
    isAggregate?: boolean;
  };
  reasoning: string;
}

export class ReasoningAgent {
  async planRetrieval(
    userQuery: string,
    sheetContext: {
      sheetId: string;
      columnNames: string[];
      rowIds: string[];
    },
    conversationHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  ): Promise<{ plan: RetrievalPlan[]; thoughts: string[] }> {
    console.log(
      "Reasoning Agent Plan Retrieval (Comtrade):",
      userQuery,
      sheetContext
    );

    const systemPrompt = `
You are an expert reasoning agent analyzing user queries about UN Comtrade international trade data stored in a table (sheet).
Your goal is to break down the user's query into a structured plan of steps to retrieve the necessary information using available methods.
Output *only* a valid JSON object containing "thoughts" (reasoning steps) and "plan" (retrieval steps).

**Sheet Context (UN Comtrade Data):**
- Sheet ID: ${sheetContext.sheetId}
- Key Column Names: ${sheetContext.columnNames.join(", ")}
  (Includes: reporterDesc, partnerDesc, flowDesc, cmdDesc, fobvalue, cifvalue, netWgt, qty, refYear, refMonth, reporterISO, partnerISO, cmdCode, flowCode, isAggregate)
- Available Rows: ${
      sheetContext.rowIds.length > 0
        ? `${sheetContext.rowIds.length} transaction records available`
        : "No records available"
    }
${
  sheetContext.rowIds.length > 0
    ? `(Sample Row ID: ${sheetContext.rowIds[0]})`
    : ""
}

**Understanding the Data:**
- Each row represents a single trade transaction (import/export) for a specific commodity between a reporting country and a partner country (or 'World' for aggregates) during a specific month/year.
- **reporterDesc/reporterISO:** The country reporting the trade.
- **partnerDesc/partnerISO:** The partner country in the trade. 'World' (ISO: WLD, Code: 0) means aggregated data.
- **flowDesc/flowCode:** Direction of trade ('Import'/'M' or 'Export'/'X').
- **cmdDesc/cmdCode:** The commodity traded (often using Harmonized System codes). 'TOTAL' means aggregated across commodities.
- **fobvalue:** Value of goods Free On Board (USD). Primary value for Exports.
- **cifvalue:** Value including Cost, Insurance, Freight (USD). Primary value for Imports. Often slightly higher than FOB.
- **netWgt:** Net weight of the goods (usually in kg).
- **qty:** Quantity in a specific unit (defined by qtyUnitAbbr).
- **refYear/refMonth:** The year and month the trade occurred.
- **isAggregate:** Boolean flag indicating if the row is an aggregation (True) or a specific reported transaction (False). Queries about specific details should usually filter for isAggregate: false. Queries about totals might use isAggregate: true or sum up non-aggregate rows.

**Planning Retrieval:**
- Analyze the user query to identify key entities (countries, commodities), time periods, trade flow (import/export), and desired metrics (value, weight, quantity, count).
- Determine the best retrieval type ('semantic', 'keyword', 'specific').
- Specify necessary filters in the 'filters' object for *each* plan step.

**Available Retrieval Methods & Filters:**
Each object in the 'plan' array MUST have 'type', 'filters', and 'reasoning'.

**Filters Object ('filters'):**
- Contains optional fields: 'rowIds', 'columnIds', 'reporterISO', 'partnerISO', 'cmdCode', 'flowCode', 'refYear', 'refMonth', 'isAggregate'.
- **Use ISO codes (e.g., 'AUS', 'CHN') or commodity codes (e.g., '1001', 'TOTAL') for filtering where possible.**
- 'columnIds': Specify column *names* (e.g., "fobvalue", "reporterDesc") to retrieve specific data points. Often needed for aggregation queries (e.g., retrieve "fobvalue" to sum exports).
- 'rowIds':
    - Use ["*"] to search across ALL rows unless specific transaction IDs are known. This is common for aggregation or trend analysis.
- **Comtrade Specific Filters (used by semantic search):**
    - 'reporterISO': Filter by reporting country ISO code (e.g., "AUS").
    - 'partnerISO': Filter by partner country ISO code (e.g., "CHN", "WLD").
    - 'cmdCode': Filter by commodity code (e.g., "2701", "TOTAL").
    - 'flowCode': Filter by trade flow ('M' or 'X').
    - 'refYear': Filter by year (e.g., 2023).
    - 'refMonth': Filter by month (e.g., 11 for November).
    - 'isAggregate': Filter by aggregate status (true or false).

**Retrieval Types:**
1.  'semantic': Finds conceptually similar data.
    - Use for: General queries about trade patterns, finding data related to specific countries/commodities/time periods.
    - Requires: 'query' (string).
    - **Crucial:** Include relevant Comtrade filters ('reporterISO', 'partnerISO', etc.) in the 'filters' object to narrow the semantic search effectively.
2.  'keyword': Finds exact term matches within cell text content.
    - Use for: Searching for specific codes, country names, or values *if* they are expected to be directly in the text. Less common for Comtrade analysis than semantic search with filters.
    - Requires: 'keywords' (array of strings).
    - Optional: 'filters' (rowIds, columnIds).
3.  'specific': Retrieves blocks by known UUIDs (rarely needed for initial queries).
    - Requires: 'blockIds' (array of valid UUID strings).

**Query Examples:**

*   **"What were Australia's total exports (FOB value) in Nov 2023?"**
    *   Thought: Need FOB values for all Australian exports in Nov 2023. Could be aggregate or sum of specifics. Let's get specific non-aggregate rows first.
    *   Plan Step 1:
        {
          "type": "semantic",
          "query": "Australia exports November 2023 FOB value",
          "filters": {
            "rowIds": ["*"],
            "reporterISO": "AUS",
            "flowCode": "X",
            "refYear": 2023,
            "refMonth": 11,
            "isAggregate": false, 
            "columnIds": ["fobvalue", "reporterDesc", "partnerDesc", "cmdDesc"] 
          },
          "reasoning": "Retrieve individual export transactions for Australia in Nov 2023 to sum their FOB values."
        }
    *   (Alternative) Plan Step 1:
        {
          "type": "semantic",
          "query": "Australia total exports November 2023",
          "filters": {
            "rowIds": ["*"],
            "reporterISO": "AUS",
            "partnerISO": "WLD", 
            "cmdCode": "TOTAL", 
            "flowCode": "X",
            "refYear": 2023,
            "refMonth": 11,
            "isAggregate": true, 
            "columnIds": ["fobvalue", "reporterDesc"]
          },
          "reasoning": "Retrieve the pre-aggregated total export row for Australia in Nov 2023."
        }


*   **"Show me imports of Wheat (1001) by Germany in Nov 2023."**
    *   Thought: Need specific commodity imports for Germany.
    *   Plan Step 1:
        {
          "type": "semantic",
          "query": "Germany imports of Wheat commodity 1001 November 2023",
          "filters": {
            "rowIds": ["*"],
            "reporterISO": "DEU", 
            "cmdCode": "1001",
            "flowCode": "M",
            "refYear": 2023,
            "refMonth": 11,
            "isAggregate": false, 
            "columnIds": ["cifvalue", "fobvalue", "netWgt", "partnerDesc"] 
          },
          "reasoning": "Retrieve specific import transactions for Wheat (1001) by Germany in Nov 2023 from all partners."
        }

*   **"What was the heaviest single export shipment by Canada in Nov 2023?"**
     *   Thought: Need net weights for all Canadian exports to find the max.
     *   Plan Step 1:
        {
            "type": "semantic",
            "query": "Canada export shipment weights November 2023",
            "filters": {
                "rowIds": ["*"],
                "reporterISO": "CAN",
                "flowCode": "X",
                "refYear": 2023,
                "refMonth": 11,
                "isAggregate": false,
                "columnIds": ["netWgt", "partnerDesc", "cmdDesc"] 
            },
            "reasoning": "Retrieve net weights for all individual Canadian export transactions in Nov 2023 to find the maximum."
        }


Output Format Reminder: Respond ONLY with the JSON object { "thoughts": [...], "plan": [...] }.
`;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: userQuery }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: REASONING_MODEL,
        messages: messages,
        response_format: { type: "json_object" },
        temperature: 0.1
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("Reasoning agent returned empty content.");
      }

      console.log("Reasoning Agent Raw Response:", content);

      let parsedContent;
      try {
        parsedContent = JSON.parse(content);
      } catch (parseError) {
        console.error("Reasoning Agent JSON Parsing Error:", parseError);
        console.error("Problematic Content:", content);
        throw new Error(
          `Reasoning agent output was not valid JSON: ${
            parseError instanceof Error ? parseError.message : parseError
          }`
        );
      }

      const validationResult = AgentResponseSchema.safeParse(parsedContent);

      if (!validationResult.success) {
        console.error(
          "Reasoning Agent Output Validation Error:",
          validationResult.error.errors
        );
        console.error(
          "Problematic Parsed Content:",
          JSON.stringify(parsedContent, null, 2)
        );
        throw new Error(
          `Reasoning agent output failed validation: ${validationResult.error.message}`
        );
      }

      console.log(
        "Reasoning Agent Validated Data:",
        JSON.stringify(validationResult.data, null, 2)
      );
      return validationResult.data;
    } catch (error) {
      console.error("Error in ReasoningAgent:", error);
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during reasoning.";
      if (
        error instanceof Error &&
        error.message.startsWith("Reasoning agent")
      ) {
        throw error;
      }
      throw new Error(`ReasoningAgent failed: ${message}`);
    }
  }
}
