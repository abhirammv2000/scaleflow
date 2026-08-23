import { NextRequest } from "next/server";
import { StreamingTextResponse } from "ai";
import { MatrixQAService } from "@/lib/services/QAService";
import { MatrixQARequest } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    // Parse the request body
    const body = (await request.json()) as MatrixQARequest;
    console.log("[MATRIX_QA_POST] Request body:", body);

    if (!body.sheetId) {
      console.error("[MATRIX_QA_POST] Missing query or sheetId");
      return new Response("Missing query or sheetId", { status: 400 });
    }

    // Create a new instance of MatrixQAService
    const qaService = new MatrixQAService();

    // Get the stream from the service
    const { stream, metadata } = await qaService.processStreamingQuery(body);

    // Return the streaming response with metadata
    return new StreamingTextResponse(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Metadata": JSON.stringify(metadata)
      }
    });
  } catch (error: any) {
    console.error("[MATRIX_QA_POST]", error);
    return new Response(`Internal Server Error: ${error.message}`, {
      status: 500
    });
  }
}
