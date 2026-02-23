import { createRouter } from "./routes.ts";
import { getStorageProvider, getEmbeddingProvider } from "../storage/provider.ts";

const PORT = parseInt(process.env.SESSIONGRAPH_API_PORT ?? "3272", 10);
const API_KEY = process.env.SESSIONGRAPH_API_KEY;

// Initialize providers
const storage = await getStorageProvider();
const embeddings = await getEmbeddingProvider();

const router = createRouter(storage, embeddings);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth check (if API_KEY is set)
    if (API_KEY) {
      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${API_KEY}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
      }
    }

    try {
      const response = await router(req);
      // Add CORS headers to response
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500, headers: corsHeaders });
    }
  },
});

console.log(`SessionGraph API server listening on http://localhost:${server.port}`);
if (!API_KEY) {
  console.log("Warning: SESSIONGRAPH_API_KEY not set — API is unauthenticated");
}
