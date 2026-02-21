import { config } from "../config/config.ts";
import type { EmbeddingProvider } from "../storage/provider.ts";

interface OllamaEmbedResponse {
  embeddings: number[][];
}

/** Timeout for embedding requests (30 seconds) */
const EMBED_TIMEOUT_MS = 30_000;

/**
 * Generates embeddings via local Ollama server (nomic-embed-text, 768 dims).
 * Requires Ollama to be running locally with the embedding model pulled.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;

  private get baseUrl(): string {
    return config.ollama.baseUrl;
  }

  private get model(): string {
    return config.ollama.embeddingModel;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("Cannot generate embedding for empty or whitespace-only text");
    }
    const response = await this.callOllama(text);
    const embedding = response.embeddings[0];
    if (!embedding) {
      throw new Error("Ollama returned empty embeddings array");
    }
    return embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Validate all inputs upfront
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i] || !texts[i]!.trim()) {
        throw new Error(`Cannot generate embedding for empty text at index ${i}`);
      }
    }

    // Ollama /api/embed accepts an array of strings natively — single request
    const response = await this.callOllama(texts);
    if (response.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${response.embeddings.length} embeddings for ${texts.length} inputs`
      );
    }
    return response.embeddings;
  }

  private async callOllama(input: string | string[]): Promise<OllamaEmbedResponse> {
    const url = `${this.baseUrl}/api/embed`;
    const isBatch = Array.isArray(input);
    const timeoutMs = isBatch ? EMBED_TIMEOUT_MS * Math.min(input.length, 10) : EMBED_TIMEOUT_MS;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(
          `Ollama embedding request timed out after ${timeoutMs / 1000}s. ` +
          `The server may be overloaded or unresponsive.`
        );
      }
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
