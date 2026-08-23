// src/lib/services/BlockService.ts
import { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/db/supabase"; // Use the shared client
import {
  BlockTypeEnum,
  CellBlock,
  ColumnBlock,
  RowBlock,
  SheetBlock // Import SheetBlock
} from "@/lib/types";
import { Database } from "@/lib/types/supabase"; // Generated types

// Define BlockData based on generated Supabase types if available
type BlockData = Database["public"]["Tables"]["blocks"]["Row"];

export class BlockService {
  private supabase: SupabaseClient<Database>;

  // Allow injecting supabase client for testing, otherwise use default
  constructor(client: SupabaseClient<Database> = supabase) {
    this.supabase = client;
  }

  // --- getBlock, createBlock, updateBlockProperties remain the same ---
  async getBlock(id: string): Promise<BlockData | null> {
    const { data, error } = await this.supabase
      .from("blocks")
      .select("*")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) {
      console.error(`Error fetching block ${id}:`, error);
      throw error;
    }
    return data;
  }

  async createBlock(
    block: Omit<
      BlockData,
      "id" | "created_at" | "updated_at" | "deleted_at"
    > & { id?: string }
  ): Promise<BlockData> {
    const now = new Date().toISOString();
    const blockToInsert = {
      ...block,
      created_at: now,
      updated_at: now,
      deleted_at: null
    };

    if (block.id) {
      blockToInsert.id = block.id;
    }

    const { data, error } = await this.supabase
      .from("blocks")
      .insert(blockToInsert)
      .select()
      .single();

    if (error) {
      console.error("Error creating block:", error);
      throw error;
    }
    return data;
  }

  async updateBlockProperties(
    id: string,
    properties: Record<string, any>
  ): Promise<BlockData | null> {
    const { data, error } = await this.supabase.rpc("update_block_properties", {
      p_block_id: id,
      p_properties: properties
    });

    if (error) {
      console.error(`Error updating properties for block ${id}:`, error);
      throw error;
    }
    // The RPC returns an array, we expect a single block or null
    const result = data?.[0] || null;

    // Fetch the block again to ensure we return the full, updated object
    // as the RPC might only return specific fields depending on its definition
    if (result && result.id) {
      return this.getBlock(result.id);
    }
    return null; // Return null if the RPC didn't return a valid block ID
  }

  // --- getCellByColumnAndRow, getColumnsBySheetId remain the same ---
  async getCellByColumnAndRow(
    rowId: string,
    columnId: string
  ): Promise<CellBlock | null> {
    const { data, error } = await this.supabase
      .from("blocks")
      .select("*")
      .eq("type", BlockTypeEnum.CELL)
      .eq("parent_id", rowId)
      .eq("properties->column->>id", columnId) // Query JSONB property
      .is("deleted_at", null)
      .maybeSingle();

    if (error) {
      console.error(
        `Error fetching cell for row ${rowId}, col ${columnId}:`,
        error
      );
      throw error;
    }
    return data as CellBlock | null; // Cast needed
  }

  async getColumnsBySheetId(sheetId: string): Promise<ColumnBlock[]> {
    const { data, error } = await this.supabase
      .from("blocks")
      .select("*")
      .eq("parent_id", sheetId)
      .eq("type", BlockTypeEnum.COLUMN)
      .is("deleted_at", null)
      .order("properties->>position"); // Order by position if stored

    if (error) {
      console.error(`Error fetching columns for sheet ${sheetId}:`, error);
      throw error;
    }
    return (data || []) as ColumnBlock[]; // Cast needed
  }

  // --- getRowsBySheetId, getCellsByRowId remain the same ---
  async getRowsBySheetId(sheetId: string): Promise<RowBlock[]> {
    const { data, error } = await this.supabase
      .from("blocks")
      .select("*")
      .eq("parent_id", sheetId)
      .eq("type", BlockTypeEnum.ROW)
      .is("deleted_at", null);

    if (error) {
      console.error(`Error fetching rows for sheet ${sheetId}:`, error);
      throw error;
    }
    // Ensure correct casting
    return (data || []) as RowBlock[];
  }

  async getCellsByRowId(rowId: string): Promise<CellBlock[]> {
    const { data, error } = await this.supabase
      .from("blocks")
      .select("*")
      .eq("parent_id", rowId)
      .eq("type", BlockTypeEnum.CELL)
      .is("deleted_at", null);

    if (error) {
      console.error(`Error fetching cells for row ${rowId}:`, error);
      throw error;
    }
    return (data || []) as CellBlock[]; // Cast needed
  }

  // *** UPDATED findBlocks Method ***
  async findBlocks(params: {
    sheetId: string;
    rowIds?: (string | "*")[];
    columnIds?: string[]; // Column names, not UUIDs
    contentKeywords?: string[];
    limit?: number;
  }): Promise<CellBlock[]> {
    console.log("calling findBlocks with params:", params);

    // Start building the query
    let query = this.supabase
      .from("blocks")
      .select("*")
      .eq("type", BlockTypeEnum.CELL) // Base filter 1: Must be a cell
      .is("deleted_at", null); // Base filter 2: Must not be deleted

    let actualRowIdsToFilter: string[] | null = null;

    // --- Logic to determine the actual row IDs to filter by ---
    if (params.rowIds && params.rowIds.length > 0) {
      const containsWildcard = params.rowIds.includes("*");
      const specificRowIds = params.rowIds.filter(
        (id) => id !== "*" && typeof id === "string"
      ) as string[];

      if (containsWildcard && specificRowIds.length === 0) {
        console.log("rowIds contains only '*', fetching all rows for sheet.");
        const rows = await this.getRowsBySheetId(params.sheetId);
        actualRowIdsToFilter = rows.map((r) => r.id);
      } else if (specificRowIds.length > 0) {
        console.log("Filtering by specific rowIds:", specificRowIds);
        actualRowIdsToFilter = specificRowIds;
      } else {
        console.warn(
          "rowIds was provided but empty after filtering '*', fetching all rows."
        );
        const rows = await this.getRowsBySheetId(params.sheetId);
        actualRowIdsToFilter = rows.map((r) => r.id);
      }
    } else {
      console.log("No rowIds provided, fetching all rows for sheet.");
      const rows = await this.getRowsBySheetId(params.sheetId);
      actualRowIdsToFilter = rows.map((r) => r.id);
    }

    // Apply the parent_id filter (ANDed with base filters)
    if (actualRowIdsToFilter && actualRowIdsToFilter.length > 0) {
      console.log("Applying filter for parent_id IN:", actualRowIdsToFilter);
      query = query.in("parent_id", actualRowIdsToFilter);
    } else {
      // If no rows belong to the sheet, no cells can match.
      console.log("No relevant rows found for the sheet, returning empty.");
      return [];
    }

    // *** FIX: Create a flat array of OR conditions ***
    const orConditions: string[] = [];

    // Add column filter conditions if provided
    if (params.columnIds && params.columnIds.length > 0) {
      console.log("Preparing column filter for:", params.columnIds);

      // Add each column name as a separate condition
      params.columnIds.forEach((columnName) => {
        // Ensure columnName is properly escaped if it contains special characters
        // For simplicity, assuming basic names here. Use proper escaping if needed.
        orConditions.push(`properties->column->>name.eq.${columnName}`);
      });
    }

    // Add keyword filter conditions if provided
    if (params.contentKeywords && params.contentKeywords.length > 0) {
      console.log("Preparing keyword filters for:", params.contentKeywords);

      // Add each keyword as a separate condition
      params.contentKeywords.forEach((kw) => {
        // Escape keyword for ILIKE if necessary
        const escapedKw = kw.replace(/%/g, "\\%").replace(/_/g, "\\_");
        orConditions.push(`properties->>value.ilike.%${escapedKw}%`);
      });
    }

    // *** FIX: Apply the OR conditions as a single comma-separated string ***
    if (orConditions.length > 0) {
      const orFilterString = orConditions.join(",");
      console.log("Applying OR filters:", orFilterString);
      query = query.or(orFilterString);
    }

    // Apply limit
    if (params.limit) {
      console.log("Applying limit:", params.limit);
      query = query.limit(params.limit);
    }

    console.log("Executing Supabase query structure:", query);

    // Execute the query and print detailed results/errors
    const { data, error } = await query;

    if (error) {
      console.error("Error finding blocks during query execution:", error);
      console.error(
        "Supabase error details:",
        error.message,
        error.details,
        error.hint,
        error.code
      );
      throw error;
    }

    console.log("Queried data count in findBlocks:", data?.length ?? 0);
    if (data && data.length > 0) {
      console.log("Sample cell data:", {
        id: data[0].id,
        parent_id: data[0].parent_id,
        type: data[0].type,
        // Show a preview of properties to help debug
        properties: data[0].properties
          ? JSON.stringify(data[0].properties).substring(0, 100) + "..."
          : null
      });
    } else {
      console.log("No matching cells found. This could be because:");
      console.log("1. There are no cells with the specified keywords");
      console.log(
        "2. Column names might not match - expected:",
        params.columnIds
      );
      console.log(
        "3. Row IDs might not match - expected:",
        actualRowIdsToFilter
      );
    }

    return (data || []) as CellBlock[];
  }

  // *** NEW Method: Get all sheets with row counts ***
  async getAllSheetsWithRowCount(
    organizationId: string
  ): Promise<SheetBlock[]> {
    // 1. Fetch all SHEETS for the organization
    const { data: sheetsData, error: sheetsError } = await this.supabase
      .from("blocks")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("type", BlockTypeEnum.SHEET)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (sheetsError) {
      console.error(
        `Error fetching sheets for org ${organizationId}:`,
        sheetsError
      );
      throw sheetsError;
    }

    if (!sheetsData) {
      return [];
    }

    // 2. For each sheet, fetch its row count
    const sheetsWithRowCount = await Promise.all(
      sheetsData.map(async (sheet) => {
        const { count, error: countError } = await this.supabase
          .from("blocks")
          .select("id", { count: "exact", head: true }) // Efficiently count
          .eq("parent_id", sheet.id)
          .eq("type", BlockTypeEnum.ROW)
          .is("deleted_at", null);

        if (countError) {
          console.error(
            `Error fetching row count for sheet ${sheet.id}:`,
            countError
          );
          // Assign a default or indicator if count fails
          (sheet.properties as any).rowCount = "N/A";
        } else {
          (sheet.properties as any).rowCount = count ?? 0;
        }
        return sheet;
      })
    );

    return sheetsWithRowCount as unknown as SheetBlock[];
  }

  // Add other methods like softDeleteBlock, updateCell etc. adapting from the reference if needed
}
