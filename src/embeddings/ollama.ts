import { config } from "../config/config.ts";
import type { EmbeddingProvider } from "../storage/provider.ts";

interface OllamaEmbedResponse {
  embeddings: number[][];
}

/**
 * Generates embeddings via local Ollama server (all-minilm, 384 dims).
 * Requires Ollama to be running locally with the embedding model pulled.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;

  private get baseUrl(): string {
    return config.ollama.baseUrl;
  }

  private get model(): string {
    return config.ollama.embeddingModel;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.callOllama(text);
    const embedding = response.embeddings[0];
    if (!embedding) {
      throw new Error("Ollama returned empty embeddings array");
    }
    return embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allEmbeddings: number[][] = [];
    for (const text of texts) {
      const response = await this.callOllama(text);
      const embedding = response.embeddings[0];
      if (!embedding) {
        throw new Error("Ollama returned empty embeddings array");
      }
      allEmbeddings.push(embedding);
    }
    return allEmbeddings;
  }

  private async callOllama(input: string): Promise<OllamaEmbedResponse> {
    const url = `${this.baseUrl}/api/embed`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Ollama is not running. Start it with 'ollama serve' or install from https://ollama.com (${message})`
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (
        response.status === 404 ||
        body.toLowerCase().includes("not found")
      ) {
        throw new Error(
          `Ollama model '${this.model}' not found. Pull it with 'ollama pull ${this.model}'`
        );
      }
      throw new Error(
        `Ollama API error (${response.status}): ${body}`
      );
    }

    return (await response.json()) as OllamaEmbedResponse;
  }
}
