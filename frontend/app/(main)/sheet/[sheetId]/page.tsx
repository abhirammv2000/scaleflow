import { notFound } from "next/navigation";
import { BlockService } from "@/lib/services/BlockService";
import { SheetPageClient } from "./SheetPageClient";
import { CellBlock, RowBlock, ColumnBlock, SheetBlock } from "@/lib/types";
import { DEFAULT_ORG_ID } from "@/lib/constants";

interface SheetData {
  sheet: SheetBlock;
  columns: ColumnBlock[];
  rows: RowBlock[];
  cells: CellBlock[][];
}

async function getSheetData(
  sheetId: string,
  orgId: string
): Promise<SheetData | null> {
  const blockService = new BlockService();
  try {
    const [sheetResult, columnsResult, rowsResult] = await Promise.all([
      blockService.getBlock(sheetId),
      blockService.getColumnsBySheetId(sheetId),
      blockService.getRowsBySheetId(sheetId)
    ]);

    const sheet = sheetResult as unknown as SheetBlock;
    if (!sheet || sheet.type !== "SHEET" || sheet.organization_id !== orgId) {
      console.warn(
        `Sheet not found or invalid: ${sheetId}, Org: ${orgId}`,
        sheet
      );
      return null;
    }

    const columns = columnsResult as ColumnBlock[];
    const rows = rowsResult as RowBlock[];

    const cellPromises = rows.map((row: RowBlock) =>
      blockService.getCellsByRowId(row.id)
    );
    const cellsByRowArrays = await Promise.all(cellPromises);

    const sortedColumns = [...columns].sort(
      (a, b) => (a.properties?.position ?? 0) - (b.properties?.position ?? 0)
    );

    const cellsByRowMap = new Map<string, Map<string, CellBlock>>();
    rows.forEach((row, index) => {
      const rowCells = cellsByRowArrays[index] || [];
      const cellMap = new Map<string, CellBlock>();
      rowCells.forEach((cell: CellBlock) => {
        if (cell.properties?.column?.id) {
          cellMap.set(cell.properties.column.id, cell);
        }
      });
      cellsByRowMap.set(row.id, cellMap);
    });

    const gridCells: CellBlock[][] = rows.map((row) => {
      const rowCellMap = cellsByRowMap.get(row.id);
      if (!rowCellMap) return [];
      return sortedColumns.map((col) => rowCellMap.get(col.id) as CellBlock);
    });

    return { sheet, columns: sortedColumns, rows, cells: gridCells };
  } catch (error) {
    console.error(`Error fetching data for sheet ${sheetId}:`, error);
    throw error;
  }
}

export default async function SheetPage({
  params
}: {
  params: Promise<{ sheetId: string }>;
}) {
  const { sheetId } = await params;
  const orgId = DEFAULT_ORG_ID;

  try {
    // Fetch data server-side
    const sheetData = await getSheetData(sheetId, orgId);

    if (!sheetData) {
      notFound();
    }

    // Pass data to client component
    return <SheetPageClient sheetData={sheetData} sheetId={sheetId} />;
  } catch (error) {
    // You can handle errors in different ways server-side
    console.error("Server error fetching sheet data:", error);

    return (
      <div className='flex justify-center items-center min-h-screen bg-[#121212] text-red-400'>
        Error loading sheet data. Please try again later.
      </div>
    );

  }
}
