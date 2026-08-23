// src/app/page.tsx
import Link from "next/link";
import { BlockService } from "@/lib/services/BlockService";
import { SheetBlock } from "@/lib/types";
import { DEFAULT_ORG_ID } from "@/lib/constants";

async function getSheets(): Promise<SheetBlock[]> {
  const blockService = new BlockService();
  const orgId = DEFAULT_ORG_ID;
  try {
    const sheets = await blockService.getAllSheetsWithRowCount(orgId);
    return sheets;
  } catch (error) {
    console.error("Error fetching sheets:", error);
    return [];
  }
}

export default async function HomePage() {
  const sheets = await getSheets();

  return (
    <div className='min-h-screen bg-[#121212] text-gray-200'>
      <div className='container mx-auto p-6 sm:p-8'>
        <h1 className='text-3xl font-bold mb-8 text-center text-white'>
          Data Sheets
        </h1>

        {sheets.length === 0 ? (
          <p className='text-center text-gray-400'>
            No sheets found. You can create one via the API or seeding script.
          </p>
        ) : (
          <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6'>
            {sheets.map((sheet) => (
              <Link
                href={`/sheet/${sheet.id}`}
                key={sheet.id}
                className='block p-0'
              >
                <div className='bg-[#1e1e1e] border border-[#2d2d2d] rounded-lg hover:border-[#4d4d4d] transition-colors duration-200 overflow-hidden h-full flex flex-col'>
                  <div className='p-4 flex-grow'>
                    <h2 className='text-lg font-semibold mb-2 truncate text-white'>
                      {sheet.properties?.title ||
                        `Sheet ${sheet.id.slice(0, 8)}`}
                    </h2>
                    <p className='text-sm text-gray-400'>
                      ID: {sheet.id.substring(0, 8)}...
                    </p>
                  </div>
                  <div className='bg-[#252525] px-4 py-2 text-right text-xs text-gray-400 border-t border-[#2d2d2d]'>
                    {sheet.properties?.rowCount ?? "..."}{" "}
                    {sheet.properties?.rowCount === 1 ? "row" : "rows"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
