import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const model = new Supabase.ai.Session("gte-small");

Deno.serve(async (req) => {
  try {
    const { text, texts } = await req.json();

    if (texts && Array.isArray(texts)) {
      // Batch embedding
      const embeddings = [];
      for (const t of texts) {
        const embedding = await model.run(t, {
          mean_pool: true,
          normalize: true,
        });
        embeddings.push(Array.from(embedding));
      }
      return Response.json({ embeddings });
    }

    if (text) {
      // Single embedding
      const embedding = await model.run(text, {
        mean_pool: true,
        normalize: true,
      });
      return Response.json({ embedding: Array.from(embedding) });
    }

    return Response.json(
      { error: "Provide 'text' (string) or 'texts' (string[]) in the request body" },
      { status: 400 }
    );
  } catch (err) {
    return Response.json(
      { error: err.message ?? "Failed to generate embedding" },
      { status: 500 }
    );
  }
});
