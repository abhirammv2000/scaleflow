import { BlockService } from "@/lib/services/BlockService";
import { EmbeddingService } from "@/lib/services/EmbeddingService";
import { queryEmbeddings, PineconeMetadata } from "@/lib/vectorDb/pinecone";
import { Evidence, CellBlock, BlockTypeEnum } from "@/lib/types";
import { RetrievalPlan } from "./ReasoningAgent";
import { DEFAULT_ORG_ID } from "@/lib/constants";

const UUID_REGEX =
  /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

const formatEvidenceValue = (
  value: any,
  columnName: string | undefined
): string => {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "boolean") return String(value);

  if (
    columnName &&
    ["fobvalue", "cifvalue", "primaryValue"].includes(columnName)
  ) {
    const num = Number(value);
    return isNaN(num)
      ? String(value)
      : num.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
  if (columnName && ["netWgt", "qty"].includes(columnName)) {
    const num = Number(value);
    return isNaN(num) ? String(value) : num.toLocaleString("en-US");
  }

  return String(value);
};

export class RetrievalAgent {
  constructor(
    private blockService: BlockService,
    private embeddingService: EmbeddingService
  ) {}

  async retrieveEvidence(
    plan: RetrievalPlan[],
    sheetId: string
  ): Promise<Evidence[]> {
    const cellsByRow = new Map<string, CellBlock[]>();
    const retrievedCellIds = new Set<string>();

    console.log(
      `Starting retrieval with ${plan.length} plan steps for sheet ${sheetId}`
    );

    for (const step of plan) {
      console.log(
        `Retrieval Step: ${step.reasoning}`,
        JSON.stringify(step, null, 2)
      );
      let retrievedCellsForStep: CellBlock[] = [];

      try {
        if (step.type === "semantic" && step.query) {
          const queryEmbedding = await this.embeddingService.generateEmbedding(
            step.query
          );

          const vectorFilter: Partial<PineconeMetadata> = {
            sheetId,
            orgId: DEFAULT_ORG_ID
          };

          if (step.filters.reporterISO)
            vectorFilter.reporterISO = step.filters.reporterISO;
          if (step.filters.partnerISO)
            vectorFilter.partnerISO = step.filters.partnerISO;
          if (step.filters.cmdCode) vectorFilter.cmdCode = step.filters.cmdCode;
          if (step.filters.flowCode)
            vectorFilter.flowCode = step.filters.flowCode;
          if (step.filters.refYear) vectorFilter.refYear = step.filters.refYear;
          if (step.filters.refMonth)
            vectorFilter.refMonth = step.filters.refMonth;
          if (step.filters.isAggregate !== undefined)
            vectorFilter.isAggregate = step.filters.isAggregate;

          if (step.filters.columnIds && step.filters.columnIds.length > 0) {
            console.log(
              `Adding column filter for: ${step.filters.columnIds.join(", ")}`
            );

            // Just use the first column name as a filter for vector search
            vectorFilter.columnName = step.filters.columnIds[0];
          }

          console.log(
            "Pinecone vector filter:",
            JSON.stringify(vectorFilter, null, 2)
          );

          const vectorResults = await queryEmbeddings(
            queryEmbedding,
            vectorFilter,
            50
          );

          console.log(
            `Semantic search returned ${vectorResults.length} results`
          );

          // Process vector results into row IDs
          const rowIds = vectorResults
            .map((v) => v.id.replace(/^row_/, ""))
            .filter((id) => UUID_REGEX.test(id));

          console.log(
            `Extracted ${rowIds.length} valid row IDs from vector results`
          );

          if (rowIds.length === 0) {
            console.log(
              "No valid row IDs from vector search, using fallback..."
            );
            // Fallback to getting rows from the sheet directly
            const allRows = await this.blockService.getRowsBySheetId(sheetId);
            console.log(
              `Fallback retrieved ${allRows.length} total rows from sheet`
            );

            // Use a limited number to avoid processing too many
            const limitedRows = allRows.slice(0, 20);

            // Process each row to get its cells
            for (const row of limitedRows) {
              const cells = await this.blockService.getCellsByRowId(row.id);
              if (cells.length > 0) {
                console.log(`Adding ${cells.length} cells from row ${row.id}`);
                retrievedCellsForStep.push(...cells);
              }
            }
          } else {
            console.log(`Processing ${rowIds.length} rows from vector results`);
            // Process each identified row
            for (const rowId of rowIds) {
              try {
                const cells = await this.blockService.getCellsByRowId(rowId);
                if (cells.length > 0) {
                  console.log(`Adding ${cells.length} cells from row ${rowId}`);
                  retrievedCellsForStep.push(...cells);
                }
              } catch (rowError) {
                console.error(
                  `Error retrieving cells for row ${rowId}:`,
                  rowError
                );
              }
            }
          }
        } else if (step.type === "keyword" && step.keywords) {
          console.log(`Keyword search for: ${step.keywords.join(", ")}`);

          const searchParams: any = {
            sheetId,
            contentKeywords: step.keywords,
            limit: 100
          };

          if (step.filters.columnIds && step.filters.columnIds.length > 0) {
            searchParams.columnIds = step.filters.columnIds;
          }

          if (step.filters.rowIds && step.filters.rowIds.length > 0) {
            searchParams.rowIds = step.filters.rowIds;
          }

          retrievedCellsForStep = await this.blockService.findBlocks(
            searchParams
          );
          console.log(
            `Keyword search returned ${retrievedCellsForStep.length} cells`
          );
        } else if (step.type === "specific" && step.blockIds) {
          const validBlockIds = step.blockIds.filter((id) =>
            UUID_REGEX.test(id)
          );
          const invalidIds = step.blockIds.filter(
            (id) => !validBlockIds.includes(id)
          );

          if (invalidIds.length > 0) {
            console.warn(
              `Skipping invalid block IDs in 'specific' retrieval step: ${invalidIds.join(
                ", "
              )}`
            );
          }

          console.log(`Fetching specific blocks: ${validBlockIds.join(", ")}`);

          if (validBlockIds.length > 0) {
            const results = await Promise.all(
              validBlockIds.map((id) => this.blockService.getBlock(id))
            );
            retrievedCellsForStep = results.filter(
              (b) => b !== null && b.type === BlockTypeEnum.CELL
            ) as CellBlock[];
            console.log(
              `Retrieved ${retrievedCellsForStep.length} cells for specific block IDs`
            );
          } else {
            retrievedCellsForStep = [];
          }
        }

        console.log(
          `Step retrieved ${retrievedCellsForStep.length} cells total`
        );

        // If we got no cells and it's the only step, try a fallback approach
        if (retrievedCellsForStep.length === 0 && plan.length === 1) {
          console.log("No cells retrieved for step, trying fallback...");
          const allRows = await this.blockService.getRowsBySheetId(sheetId);
          const limitedRows = allRows.slice(0, 10); // Limit to 10 rows as fallback

          for (const row of limitedRows) {
            try {
              const cells = await this.blockService.getCellsByRowId(row.id);
              if (cells.length > 0) {
                console.log(
                  `Fallback adding ${cells.length} cells from row ${row.id}`
                );
                retrievedCellsForStep.push(...cells);
              }
            } catch (cellError) {
              console.error(
                `Error retrieving cells for fallback row ${row.id}:`,
                cellError
              );
            }
          }
          console.log(
            `Fallback retrieved ${retrievedCellsForStep.length} cells`
          );
        }

        // Process retrieved cells and organize them by row
        for (const cell of retrievedCellsForStep) {
          if (cell && cell.parent_id) {
            const rowId = cell.parent_id;
            if (!cellsByRow.has(rowId)) {
              cellsByRow.set(rowId, []);
            }
            if (
              !cellsByRow
                .get(rowId)
                ?.some((existing) => existing.id === cell.id)
            ) {
              cellsByRow.get(rowId)?.push(cell);
              retrievedCellIds.add(cell.id);
            }
          } else {
            console.warn(
              "Retrieved cell missing or missing parent_id:",
              cell?.id
            );
          }
        }
      } catch (error) {
        console.error(`Error during retrieval step (${step.type}):`, error);
      }
    }

    // Consolidate all cells by row into evidence objects
    const consolidatedEvidence: Evidence[] = [];
    const allRowIds = Array.from(cellsByRow.keys());

    console.log(`Consolidating evidence from ${allRowIds.length} unique rows`);

    for (const rowId of allRowIds) {
      const rowCells = cellsByRow.get(rowId) || [];
      if (rowCells.length === 0) continue;

      // Sort cells by column name for better readability
      rowCells.sort((a, b) => {
        const nameA = a.properties?.column?.name ?? "";
        const nameB = b.properties?.column?.name ?? "";
        return nameA.localeCompare(nameB);
      });

      // Helper to get property value from cells
      const getProp = (colName: string) =>
        rowCells.find((c) => c.properties?.column?.name === colName)?.properties
          ?.value;

      // Extract key data for the row
      const reporter =
        getProp("reporterDesc") || getProp("reporterISO") || "N/A";
      const partner = getProp("partnerDesc") || getProp("partnerISO") || "N/A";
      const commodity = getProp("cmdDesc") || getProp("cmdCode") || "N/A";
      const flow = getProp("flowDesc") || getProp("flowCode") || "N/A";
      const period = getProp("period") || "N/A";

      // Format the row data as evidence content
      let combinedContent = `Transaction Record (Row ID: ${rowId}, Period: ${period}):\n`;
      combinedContent += `Reporter: ${reporter}\n`;
      combinedContent += `Partner: ${partner}\n`;
      combinedContent += `Commodity: ${commodity}\n`;
      combinedContent += `Flow: ${flow}\n`;
      combinedContent += `--- Data Points ---\n`;

      // Build metadata for the evidence
      const metadataFields: Record<string, any> = {
        isRowData: true,
        reporterISO: getProp("reporterISO"),
        partnerISO: getProp("partnerISO"),
        cmdCode: getProp("cmdCode"),
        flowCode: getProp("flowCode"),
        refYear: getProp("refYear"),
        refMonth: getProp("refMonth"),
        isAggregate: getProp("isAggregate"),
        columnCount: rowCells.length,
        columns: rowCells.map((c) => c.properties?.column?.name)
      };

      // Flag rows with numeric data
      const numericColumns = ["fobvalue", "cifvalue", "netWgt", "qty"];
      metadataFields.hasNumericData = rowCells.some((c) =>
        numericColumns.includes(c.properties?.column?.name || "")
      );

      // Add each cell to the content with citation
      rowCells.forEach((cell) => {
        const colName = cell.properties?.column?.name || `Unknown Column`;
        const cellValue = cell.properties?.value;
        const formattedValue = formatEvidenceValue(cellValue, colName);

        combinedContent += `- ${colName}: ${formattedValue} [cell:${cell.id}]\n`;
      });

      // Add the consolidated evidence
      consolidatedEvidence.push({
        blockId: rowId,
        content: combinedContent.trim(),
        rowId: rowId,
        sheetId: sheetId,
        columnId: rowCells[0]?.properties?.column?.id,
        metadata: metadataFields
      });
    }

    // If we still have no evidence, create a basic placeholder
    if (consolidatedEvidence.length === 0) {
      console.log("No evidence consolidated, adding placeholder evidence");
      try {
        const rows = await this.blockService.getRowsBySheetId(sheetId);
        if (rows.length > 0) {
          const row = rows[0];
          const cells = await this.blockService.getCellsByRowId(row.id);

          if (cells.length > 0) {
            let content = `Sample Data Row (ID: ${row.id}):\n`;
            content += `Note: This is just a sample row as no specific data matching your query was found.\n`;
            content += `--- Data Points ---\n`;

            cells.forEach((cell) => {
              const colName = cell.properties?.column?.name || "Unknown";
              const value = cell.properties?.value;
              content += `- ${colName}: ${value || "N/A"} [cell:${cell.id}]\n`;
            });

            consolidatedEvidence.push({
              blockId: row.id,
              content: content.trim(),
              rowId: row.id,
              sheetId: sheetId,
              columnId: cells[0]?.properties?.column?.id,
              metadata: {
                isRowData: true,
                isFallbackSample: true,
                columnCount: cells.length
              }
            });
          }
        }
      } catch (fallbackError) {
        console.error("Error creating fallback evidence:", fallbackError);
      }
    }

    if (consolidatedEvidence.length > 0) {
      console.log("EVIDENCE SAMPLE (Comtrade):");
      console.log(consolidatedEvidence[0].content);
      console.log(
        "EVIDENCE METADATA SAMPLE:",
        consolidatedEvidence[0].metadata
      );
    } else {
      console.log("WARNING: No evidence was consolidated!");
    }

    console.log(
      `Returning ${consolidatedEvidence.length} consolidated evidence items`
    );
    return consolidatedEvidence;
  }
}
