import { NextRequest, NextResponse } from "next/server";
import { BlockService } from "@/lib/services/BlockService";
import { EmbeddingService } from "@/lib/services/EmbeddingService";
import {
  upsertEmbeddings,
  PineconeVector,
  PineconeMetadata
} from "@/lib/vectorDb/pinecone";
import {
  BlockTypeEnum,
  CellBlock,
  ColumnBlock,
  RowBlock,
  SheetBlock
} from "@/lib/types";
import { DEFAULT_ORG_ID } from "@/lib/constants";

const reporters = [
  { code: 36, iso: "AUS", desc: "Australia" },
  { code: 842, iso: "USA", desc: "United States" },
  { code: 124, iso: "CAN", desc: "Canada" },
  { code: 826, iso: "GBR", desc: "United Kingdom" },
  { code: 276, iso: "DEU", desc: "Germany" }
];

const partners = [
  { code: 156, iso: "CHN", desc: "China" },
  { code: 392, iso: "JPN", desc: "Japan" },
  { code: 410, iso: "KOR", desc: "South Korea" },
  { code: 842, iso: "USA", desc: "United States" },
  { code: 276, iso: "DEU", desc: "Germany" },
  { code: 0, iso: "WLD", desc: "World" }
];

const commodities = [
  { code: "0101", desc: "Live horses, asses, mules and hinnies" },
  { code: "1001", desc: "Wheat and meslin" },
  { code: "2701", desc: "Coal; briquettes, ovoids and similar solid fuels" },
  { code: "7108", desc: "Gold (including gold plated with platinum)" },
  { code: "8517", desc: "Telephone sets, incl. smartphones" },
  { code: "TOTAL", desc: "All Commodities" }
];

const flows = [
  { code: "M", desc: "Import" },
  { code: "X", desc: "Export" }
];

const generateMockComtradeData = (numRows: number) => {
  const columns = [
    { name: "typeCode", type: "text" },
    { name: "freqCode", type: "text" },
    { name: "refPeriodId", type: "text" },
    { name: "refYear", type: "number" },
    { name: "refMonth", type: "number" },
    { name: "period", type: "text" },
    { name: "reporterCode", type: "number" },
    { name: "reporterISO", type: "text" },
    { name: "reporterDesc", type: "text" },
    { name: "flowCode", type: "text" },
    { name: "flowDesc", type: "text" },
    { name: "partnerCode", type: "number" },
    { name: "partnerISO", type: "text" },
    { name: "partnerDesc", type: "text" },
    { name: "classificationCode", type: "text" },
    { name: "cmdCode", type: "text" },
    { name: "cmdDesc", type: "text" },
    { name: "aggrLevel", type: "number" },
    { name: "qtyUnitCode", type: "number" },
    { name: "qtyUnitAbbr", type: "text" },
    { name: "qty", type: "number" },
    { name: "netWgt", type: "number" },
    { name: "cifvalue", type: "number" },
    { name: "fobvalue", type: "number" },
    { name: "primaryValue", type: "number" },
    { name: "isReported", type: "boolean" },
    { name: "isAggregate", type: "boolean" }
  ];

  const rows = [];
  const baseYear = 2023;
  const baseMonth = 11;

  for (let i = 0; i < numRows; i++) {
    const reporter = reporters[i % reporters.length];
    const partner = partners[i % partners.length];
    const commodity = commodities[i % commodities.length];
    const flow = flows[i % flows.length];
    const isAggregate = partner.code === 0 || commodity.code === "TOTAL";

    const qty = isAggregate ? 0 : Math.floor(Math.random() * 100000) + 100;
    const netWgt = isAggregate
      ? 0
      : Math.floor(qty * (Math.random() * 0.5 + 0.8));
    const fobValue = isAggregate
      ? Math.floor(Math.random() * 50000000) + 100000
      : Math.floor(qty * (Math.random() * 50 + 10));
    const cifValueFactor = flow.code === "M" ? 1.05 + Math.random() * 0.1 : 1.0;
    const cifValue = isAggregate
      ? Math.floor(fobValue * cifValueFactor)
      : Math.floor(fobValue * cifValueFactor);

    const rowData: { [key: string]: string | number | boolean | null } = {
      typeCode: "C",
      freqCode: "M",
      refPeriodId: `${baseYear}${String(baseMonth).padStart(2, "0")}01`,
      refYear: baseYear,
      refMonth: baseMonth,
      period: `${baseYear}${String(baseMonth).padStart(2, "0")}`,
      reporterCode: reporter.code,
      reporterISO: reporter.iso,
      reporterDesc: reporter.desc,
      flowCode: flow.code,
      flowDesc: flow.desc,
      partnerCode: partner.code,
      partnerISO: partner.iso,
      partnerDesc: partner.desc,
      classificationCode: "H6",
      cmdCode: commodity.code,
      cmdDesc: commodity.desc,
      aggrLevel: commodity.code === "TOTAL" ? 0 : commodity.code.length,
      qtyUnitCode: 8,
      qtyUnitAbbr: "kg",
      qty: qty,
      netWgt: Math.random() > 0.1 ? netWgt : null,
      cifvalue: Math.random() > 0.1 ? cifValue : null,
      fobvalue: fobValue,
      primaryValue: flow.code === "M" ? cifValue : fobValue,
      isReported: !isAggregate,
      isAggregate: isAggregate
    };

    columns.forEach((col) => {
      if (!(col.name in rowData)) {
        rowData[col.name] = null;
      }
    });

    rows.push(rowData);
  }

  return { columns, rows };
};

const formatValue = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
};

const formatQuantity = (
  value: number | null | undefined,
  unit: string | null | undefined
): string => {
  if (value === null || value === undefined) return "N/A";
  const unitStr = unit ? ` ${unit}` : "";
  return `${value.toLocaleString()}${unitStr}`;
};

const generateRowText = (rowData: any): string => {
  const flow = rowData["flowDesc"] || rowData["flowCode"];
  const reporter =
    rowData["reporterDesc"] || `Reporter ${rowData["reporterCode"]}`;
  const partner = rowData["partnerDesc"] || `Partner ${rowData["partnerCode"]}`;
  const commodity = rowData["cmdDesc"] || `Commodity ${rowData["cmdCode"]}`;
  const year = rowData["refYear"];
  const month = new Date(0, (rowData["refMonth"] || 1) - 1).toLocaleString(
    "default",
    { month: "long" }
  );

  let text = `Transaction record for ${month} ${year}: ${reporter} ${flow} of ${commodity}`;
  if (partner !== "World") {
    text += ` ${flow === "Import" ? "from" : "to"} ${partner}.`;
  } else {
    text += ` (aggregated across partners).`;
  }

  const fob = formatValue(rowData["fobvalue"]);
  const cif = formatValue(rowData["cifvalue"]);
  const weight = formatQuantity(rowData["netWgt"], "kg");
  const qty = formatQuantity(rowData["qty"], rowData["qtyUnitAbbr"]);

  text += ` FOB Value: ${fob}.`;
  if (rowData["cifvalue"] !== null) {
    text += ` CIF Value: ${cif}.`;
  }
  if (rowData["netWgt"] !== null) {
    text += ` Net Weight: ${weight}.`;
  }
  if (rowData["qty"] !== null && rowData["qtyUnitAbbr"] !== "kg") {
    text += ` Quantity: ${qty}.`;
  }
  text += ` Classification: ${rowData["classificationCode"]}. Aggregation Level: ${rowData["aggrLevel"]}.`;
  text += ` Reported: ${rowData["isReported"]}, Aggregate: ${rowData["isAggregate"]}.`;

  return text.trim();
};

const generateCellContextualText = (
  cellValue: string | number | boolean | null,
  columnName: string,
  rowData: any
): string => {
  if (cellValue === null || String(cellValue).trim() === "") return "";

  const flow = rowData["flowDesc"] || rowData["flowCode"];
  const reporter =
    rowData["reporterDesc"] || `Reporter ${rowData["reporterCode"]}`;
  const partner = rowData["partnerDesc"] || `Partner ${rowData["partnerCode"]}`;
  const commodity = rowData["cmdDesc"] || `Commodity ${rowData["cmdCode"]}`;
  const timePeriod = `${new Date(
    0,
    (rowData["refMonth"] || 1) - 1
  ).toLocaleString("default", { month: "short" })} ${rowData["refYear"]}`;
  const transactionBase = `For the ${timePeriod} ${flow} of ${commodity} ${
    flow === "Import" ? "from" : "to"
  } ${partner} by ${reporter}`;

  switch (columnName) {
    case "fobvalue":
      return `${transactionBase}, the Free On Board (FOB) value was ${formatValue(
        Number(cellValue)
      )}.`;
    case "cifvalue":
      return `${transactionBase}, the Cost, Insurance, and Freight (CIF) value was ${formatValue(
        Number(cellValue)
      )}.`;
    case "netWgt":
      return `${transactionBase}, the net weight was ${formatQuantity(
        Number(cellValue),
        "kg"
      )}.`;
    case "qty":
      return `${transactionBase}, the quantity reported was ${formatQuantity(
        Number(cellValue),
        rowData["qtyUnitAbbr"]
      )}.`;
    case "reporterDesc":
      return `The reporting country for this transaction (${commodity} ${
        flow === "Import" ? "from" : "to"
      } ${partner}) was ${cellValue} (${rowData["reporterISO"]}).`;
    case "partnerDesc":
      return `The partner country for this transaction (${commodity} ${flow} by ${reporter}) was ${cellValue} (${rowData["partnerISO"]}).`;
    case "cmdDesc":
      return `The commodity traded (${flow} by ${reporter} ${
        flow === "Import" ? "from" : "to"
      } ${partner}) was ${cellValue} (Code: ${rowData["cmdCode"]}).`;
    case "flowDesc":
      return `This record represents an ${cellValue} transaction (${commodity} between ${reporter} and ${partner}).`;
    default:
      return `${transactionBase}, the value for ${columnName} was ${cellValue}.`;
  }
};

export async function POST(request: NextRequest) {
  try {
    const requestBody = await request.json();

    const numRows = requestBody.numRows ?? 500;
    if (numRows > 5000) {
      return new NextResponse("Requested size too large", { status: 400 });
    }

    console.log(`Generating mock UN Comtrade data with ${numRows} rows...`);
    const blockService = new BlockService();
    const embeddingService = new EmbeddingService();
    const { columns: columnDefs, rows: rowData } =
      generateMockComtradeData(numRows);

    const sheet: Omit<
      SheetBlock,
      "id" | "created_at" | "updated_at" | "deleted_at"
    > = {
      type: BlockTypeEnum.SHEET,
      parent_id: null,
      organization_id: "rc_org_1",
      properties: {
        title: `UN Comtrade Mock ${new Date().toISOString()}`
      },
      content: [],
      created_by: "rc_user_1"
    };
    const createdSheet = await blockService.createBlock(sheet as any);
    const sheetId = createdSheet.id;
    console.log(`Created sheet with ID: ${sheetId}`);

    const createdColumns: ColumnBlock[] = [];
    for (let i = 0; i < columnDefs.length; i++) {
      const colDef = columnDefs[i];
      const column: Omit<
        ColumnBlock,
        "id" | "created_at" | "updated_at" | "deleted_at"
      > = {
        type: BlockTypeEnum.COLUMN,
        parent_id: sheetId,
        organization_id: "rc_org_1",
        properties: { name: colDef.name, type: colDef.type, position: i },
        content: null,
        created_by: "rc_user_1"
      };
      const createdCol = await blockService.createBlock(column as any);
      createdColumns.push(createdCol as ColumnBlock);
    }
    console.log(`Created ${createdColumns.length} columns`);

    const rowsData: {
      rowId: string;
      rowData: any;
      cells: {
        cellId: string;
        columnId: string;
        columnName: string;
        value: string | number | boolean | null;
      }[];
    }[] = [];

    let totalCellsCreated = 0;

    for (const data of rowData) {
      const rowName = `${data["reporterISO"]}-${data["partnerISO"]}-${data["cmdCode"]}-${data["period"]}`;
      const row: Omit<
        RowBlock,
        "id" | "created_at" | "updated_at" | "deleted_at"
      > = {
        type: BlockTypeEnum.ROW,
        parent_id: sheetId,
        organization_id: "rc_org_1",
        properties: { name: rowName },
        content: null,
        created_by: "rc_user_1"
      };
      const createdRow = await blockService.createBlock(row as any);
      const rowId = createdRow.id;

      const rowEntry: {
        rowId: string;
        rowData: any;
        cells: {
          cellId: string;
          columnId: string;
          columnName: string;
          value: string | number | boolean | null;
        }[];
      } = {
        rowId,
        rowData: { ...data },
        cells: []
      };

      for (const column of createdColumns) {
        const cellValue = data[column.properties.name];
        const cell: Omit<
          CellBlock,
          "id" | "created_at" | "updated_at" | "deleted_at"
        > = {
          type: BlockTypeEnum.CELL,
          parent_id: rowId,
          organization_id: "rc_org_1",
          properties: {
            value: cellValue,
            column: { id: column.id, name: column.properties.name }
          },
          content: null,
          created_by: "rc_user_1"
        };
        const createdCell = await blockService.createBlock(cell as any);
        totalCellsCreated++;

        rowEntry.cells.push({
          cellId: createdCell.id,
          columnId: column.id,
          columnName: column.properties.name,
          value: cellValue
        });
      }
      rowsData.push(rowEntry);
    }
    console.log(
      `Created ${rowsData.length} rows with ${totalCellsCreated} total cells`
    );

    console.log("Preparing embeddings with transaction context...");
    const cellsToEmbed: { text: string; metadata: PineconeMetadata }[] = [];
    const rowsToEmbed: { text: string; metadata: PineconeMetadata }[] = [];

    for (const row of rowsData) {
      const rowText = generateRowText(row.rowData);
      rowsToEmbed.push({
        text: rowText,
        metadata: {
          blockId: row.rowId,
          rowId: row.rowId,
          sheetId: sheetId,
          orgId: DEFAULT_ORG_ID,
          contentSnippet: rowText.substring(0, 150),
          isRowLevel: true,
          columnIds: row.cells.map((cell) => cell.columnId),

          reporterISO: String(row.rowData["reporterISO"] || ""),
          partnerISO: String(row.rowData["partnerISO"] || ""),
          cmdCode: String(row.rowData["cmdCode"] || ""),
          flowCode: String(row.rowData["flowCode"] || ""),
          refYear: Number(row.rowData["refYear"]),
          refMonth: Number(row.rowData["refMonth"]),
          isAggregate: Boolean(row.rowData["isAggregate"])
        }
      });

      for (const cell of row.cells) {
        const importantColumns = [
          "reporterDesc",
          "partnerDesc",
          "cmdDesc",
          "flowDesc",
          "fobvalue",
          "cifvalue",
          "netWgt",
          "qty"
        ];
        if (
          cell.value !== null &&
          String(cell.value).trim() !== "" &&
          importantColumns.includes(cell.columnName)
        ) {
          const contextualText = generateCellContextualText(
            cell.value,
            cell.columnName,
            row.rowData
          );

          if (contextualText) {
            cellsToEmbed.push({
              text: contextualText,
              metadata: {
                blockId: cell.cellId,
                rowId: row.rowId,
                columnIds: [cell.columnId],
                sheetId: sheetId,
                orgId: DEFAULT_ORG_ID,
                contentSnippet: contextualText.substring(0, 150),
                columnName: cell.columnName,
                isRowLevel: false,

                reporterISO: String(row.rowData["reporterISO"] || ""),
                partnerISO: String(row.rowData["partnerISO"] || ""),
                cmdCode: String(row.rowData["cmdCode"] || ""),
                flowCode: String(row.rowData["flowCode"] || ""),
                refYear: Number(row.rowData["refYear"]),
                refMonth: Number(row.rowData["refMonth"]),
                isAggregate: Boolean(row.rowData["isAggregate"])
              }
            });
          }
        }
      }
    }

    if (rowsToEmbed.length > 0) {
      console.log("Sample row embedding text:", rowsToEmbed[0].text);
      console.log("Sample row metadata:", rowsToEmbed[0].metadata);
    }
    if (cellsToEmbed.length > 0) {
      console.log("Sample cell embedding text:", cellsToEmbed[0].text);
      console.log("Sample cell metadata:", cellsToEmbed[0].metadata);
    }

    const BATCH_SIZE = 100;

    if (rowsToEmbed.length > 0) {
      console.log(`Generating embeddings for ${rowsToEmbed.length} rows...`);
      for (let i = 0; i < rowsToEmbed.length; i += BATCH_SIZE) {
        const batch = rowsToEmbed.slice(i, i + BATCH_SIZE);
        console.log(
          `Processing row embedding batch ${i / BATCH_SIZE + 1}/${Math.ceil(
            rowsToEmbed.length / BATCH_SIZE
          )}`
        );
        const embeddings = await embeddingService.generateEmbeddingsBatch(
          batch.map((r) => r.text)
        );
        const vectors: PineconeVector[] = batch
          .map((row, index) => ({
            id: `row_${row.metadata.rowId}`,
            values: embeddings[index],
            metadata: row.metadata
          }))
          .filter((v) => v.values && v.values.length > 0);

        if (vectors.length > 0) {
          console.log(`Upserting batch of ${vectors.length} row vectors...`);
          await upsertEmbeddings(vectors);
        }
      }
      console.log("Row embeddings upserted.");
    }

    if (cellsToEmbed.length > 0) {
      console.log(`Generating embeddings for ${cellsToEmbed.length} cells...`);
      for (let i = 0; i < cellsToEmbed.length; i += BATCH_SIZE) {
        const batch = cellsToEmbed.slice(i, i + BATCH_SIZE);
        console.log(
          `Processing cell embedding batch ${i / BATCH_SIZE + 1}/${Math.ceil(
            cellsToEmbed.length / BATCH_SIZE
          )}`
        );
        const embeddings = await embeddingService.generateEmbeddingsBatch(
          batch.map((c) => c.text)
        );
        const vectors: PineconeVector[] = batch
          .map((cell, index) => ({
            id: cell.metadata.blockId,
            values: embeddings[index],
            metadata: cell.metadata
          }))
          .filter((v) => v.values && v.values.length > 0);

        if (vectors.length > 0) {
          console.log(`Upserting batch of ${vectors.length} cell vectors...`);
          await upsertEmbeddings(vectors);
        }
      }
      console.log("Cell embeddings upserted.");
    }

    return NextResponse.json({
      message: `Successfully created mock UN Comtrade sheet ${sheetId} with ${numRows} rows and ${columnDefs.length} columns.`,
      sheetId: sheetId,
      embeddingsCreated: {
        rows: rowsToEmbed.length,
        cells: cellsToEmbed.length
      }
    });
  } catch (error: any) {
    console.error("[MOCK_DATA_POST_COMTRADE]", error);
    return new NextResponse(`Internal Server Error: ${error.message}`, {
      status: 500
    });
  }
}
