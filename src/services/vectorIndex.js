/**
 * vectorIndex.js
 *
 * Minimal vector store with cosine-similarity search.
 * Embeddings are generated via Ollama /api/embeddings.
 * Indexes persist to JSON files so they survive server restarts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://148.204.112.157:11434';
// Use a dedicated embedding model if available; falls back to the generation model.
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

/**
 * Request an embedding vector from Ollama.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedText(text) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embed error ${response.status}: ${body}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
    throw new Error('Ollama embedding response missing "embedding" field');
  }
  return data.embedding;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1].
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class VectorIndex {
  constructor() {
    /** @type {Array<{id: string, text: string, embedding: number[], metadata: object}>} */
    this.entries = [];
  }

  /**
   * Embed a text chunk and add it to the index.
   * @param {string} id     Unique identifier for this chunk.
   * @param {string} text   The text to embed.
   * @param {object} [metadata]
   */
  async add(id, text, metadata = {}) {
    const embedding = await embedText(text);
    this.entries.push({ id, text, embedding, metadata });
  }

  /**
   * Find the top-K most similar chunks to a query.
   * @param {string} queryText
   * @param {number} [topK=5]
   * @returns {Promise<Array<{id:string, text:string, metadata:object, score:number}>>}
   */
  async query(queryText, topK = 5) {
    if (this.entries.length === 0) return [];
    const qEmbed = await embedText(queryText);
    const scored = this.entries.map((e) => ({
      id: e.id,
      text: e.text,
      metadata: e.metadata,
      score: cosineSimilarity(qEmbed, e.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Persist the index to a JSON file.
   * @param {string} filePath Absolute path to the output file.
   */
  save(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ model: EMBED_MODEL, entries: this.entries }),
      'utf8'
    );
  }

  /**
   * Load a previously saved index from disk.
   * Returns false if the file doesn't exist or was built with a different model.
   * @param {string} filePath
   * @returns {boolean}
   */
  load(filePath) {
    if (!fs.existsSync(filePath)) return false;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return false;
    }
    // Invalidate if model changed
    if (data.model && data.model !== EMBED_MODEL) return false;
    this.entries = Array.isArray(data.entries) ? data.entries : [];
    return this.entries.length > 0;
  }

  clear() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }
}

module.exports = { VectorIndex, embedText, EMBED_MODEL };
