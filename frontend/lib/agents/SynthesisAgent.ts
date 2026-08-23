import OpenAI from "openai";
import { Evidence } from "@/lib/types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SYNTHESIS_MODEL = "gpt-4o";

export class SynthesisAgent {
  async synthesizeAnswer(
    userQuery: string,
    evidence: Evidence[],
    sheetContext: {
      sheetId: string;
      columnNames: string[];
      rowIds: string[];
      schema?: any;
    },
    conversationHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  ): Promise<string> {
    if (evidence.length === 0) {
      return "I couldn't find any relevant trade data in the sheet to answer your question.";
    }

    console.log(
      `Synthesizing answer for query: "${userQuery}" with ${evidence.length} evidence items (Comtrade)`
    );

    const evidenceContext = evidence
      .map(
        (e, index) =>
          `Transaction Record ${index + 1} (Row ID: ${e.rowId}):\n${
            e.content
          }\n--- Metadata: ${JSON.stringify(e.metadata)}\n---`
      )
      .join("\n\n");

    const sheetContextStr = `
Sheet Context (UN Comtrade Data):
- Sheet ID: ${sheetContext.sheetId}
- Key Column Names: ${sheetContext.columnNames.join(", ")}
  (Includes: reporterDesc, partnerDesc, flowDesc, cmdDesc, fobvalue, cifvalue, netWgt, qty, refYear, refMonth, reporterISO, partnerISO, cmdCode, flowCode, isAggregate)
- Total Rows Available in Sheet: ${sheetContext.rowIds.length}
- Number of Rows Retrieved for this Query: ${evidence.length}

Column Descriptions:
- reporterDesc/reporterISO: Reporting country name/ISO code.
- partnerDesc/partnerISO: Partner country name/ISO code ('World'/'WLD' for aggregates).
- flowDesc/flowCode: Trade direction ('Import'/'M', 'Export'/'X').
- cmdDesc/cmdCode: Commodity description/code ('TOTAL' for aggregates).
- fobvalue: Free On Board value (USD).
- cifvalue: Cost, Insurance, Freight value (USD).
- netWgt: Net weight (kg).
- qty: Quantity in specified unit (qtyUnitAbbr).
- refYear/refMonth: Time period of trade.
- isAggregate: True if the row is an aggregation, False if specific reported data.
`;

    const systemPrompt = `
You are an AI assistant specialized in analyzing UN Comtrade international trade data. Your task is to answer the user's query based *only* on the provided evidence (transaction records) and sheet context.

**General Guidelines:**
*   **Accuracy:** Base your answer strictly on the data in the 'Evidence' section. Do not make assumptions or use external knowledge.
*   **Specificity:** Refer to countries, commodities, and time periods as mentioned in the evidence. Use names (e.g., Australia) and codes (e.g., AUS, 1001) where available.
*   **Clarity:** Present findings clearly and concisely. State the time period (e.g., "In November 2023...") and the scope (e.g., "Based on the ${evidence.length} transaction records provided...").
*   **Value Types:** Clearly distinguish between FOB and CIF values when reporting financial data. Use FOB for exports unless CIF is specifically requested or the only value available. Use CIF for imports unless FOB is specifically requested or the only value available.
*   **Units:** Always include units for numeric values (e.g., USD for values, kg for weight, or the unit from 'qtyUnitAbbr' for quantity).
*   **Citations:** Use the [cell:ID] markers provided in the evidence when quoting specific values. Place the citation directly after the value it refers to. Example: "The FOB value was $1,234,567 [cell:uuid-123]."
*   **Aggregation:** Be mindful of the 'isAggregate' flag in the metadata. If the query asks for totals and aggregate rows (isAggregate: true) are present, use them. If asking for details or needing to calculate totals from specifics, focus on non-aggregate rows (isAggregate: false). If summarizing across multiple non-aggregate rows, state this (e.g., "Summing the values from the individual transactions...").

${sheetContextStr}

**CRITICAL FOR NUMERICAL ANALYSIS (Totals, Max/Min, Averages):**
*   You MUST correctly parse numeric values from the evidence strings (e.g., "$1,234,567 [cell:...]"). Ignore commas and currency symbols for calculations.
*   When calculating totals (e.g., total export value), sum the relevant numeric field (e.g., 'fobvalue') across ALL relevant evidence records. Check the 'isAggregate' flag – if a relevant aggregate record exists, prefer its value; otherwise, sum the non-aggregate records.
*   When finding maximums or minimums (e.g., highest value shipment, heaviest weight), compare the relevant numeric field across ALL relevant evidence records. State the value and provide context (e.g., which commodity, partner).
*   When calculating averages, divide the total sum by the number of relevant records.
*   ALWAYS state which records were included in the calculation.

**Evidence Format:**
Each 'Transaction Record' represents a row from the trade data table. It contains key identifiers (Reporter, Partner, Commodity, Flow, Period) followed by specific data points (like fobvalue, cifvalue, netWgt) with [cell:ID] citations. Metadata provides additional context like ISO codes and the 'isAggregate' flag.

**IMPORTANT: Analyze ALL ${evidence.length} provided transaction records carefully before answering.**

**Evidence:**
${evidenceContext}
`;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: userQuery }
    ];

    try {
      console.log("Sending request to Synthesis LLM (Comtrade)...");
      const response = await openai.chat.completions.create({
        model: SYNTHESIS_MODEL,
        messages: messages,
        temperature: 0.1,
        max_tokens: 1500
      });
      console.log("Received response from Synthesis LLM (Comtrade).");

      const answer = response.choices[0]?.message?.content;
      if (!answer) {
        throw new Error("Synthesis agent returned empty content.");
      }

      const finalAnswer = answer.trim();

      console.log("Synthesized Answer (Comtrade):", finalAnswer);
      return finalAnswer;
    } catch (error) {
      console.error("Error in SynthesisAgent (Comtrade):", error);

      throw new Error(
        `SynthesisAgent failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}
