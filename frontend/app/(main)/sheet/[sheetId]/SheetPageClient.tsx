"use client";

import { useState, useCallback } from "react";
import { SheetGrid } from "@/components/sheet/SheetGrid";
import { QAChatInterface } from "@/components/qa/QAChatInterface";
import { CellBlock, RowBlock, ColumnBlock, SheetBlock } from "@/lib/types";

interface SheetData {
  sheet: SheetBlock;
  columns: ColumnBlock[];
  rows: RowBlock[];
  cells: CellBlock[][];
}

interface SheetPageClientProps {
  sheetData: SheetData;
  sheetId: string;
}

export function SheetPageClient({ sheetData, sheetId }: SheetPageClientProps) {
  const [highlightedCell, setHighlightedCell] = useState<string | null>(null);

  const handleCitationClick = useCallback((blockId: string) => {
    setHighlightedCell(blockId);

    setTimeout(() => {
      const element = document.getElementById(`cell-${blockId}`);
      if (element) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center"
        });
        element.classList.add("flash-highlight");
        setTimeout(() => {
          element.classList.remove("flash-highlight");
        }, 1500);
      }
    }, 100);
  }, []);

  const { sheet, columns, rows, cells } = sheetData;

  return (
    <div className='flex flex-col h-screen overflow-hidden bg-[#121212] text-gray-200'>
      {/* Header with title */}
      <div className='p-4 border-b border-[#2d2d2d] bg-[#1a1a1a]'>
        <h2 className='text-xl font-semibold text-white'>
          {sheet.properties?.title.split(" ").slice(0, 2).join(" ") || "Sheet"}
        </h2>
      </div>

      {/* Main content area with fixed height */}
      <div className='flex-grow grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 h-[calc(100vh-64px)] overflow-hidden'>
        {/* Data grid, so citation clicks have something to scroll to and highlight */}
        <div className='h-full overflow-hidden'>
          <SheetGrid
            columns={columns}
            rows={rows}
            cells={cells}
            highlightedCell={highlightedCell}
          />
        </div>

        {/* QA Chat with fixed height */}
        <div className='h-full overflow-hidden'>
          <QAChatInterface
            sheetId={sheetId}
            onCitationClick={handleCitationClick}
          />
        </div>
      </div>
    </div>
  );
}
