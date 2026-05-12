/**
 * vectorIndex.js
 *
 * Minimal vector store with cosine-similarity search.
 * Embeddings are generated via llama.cpp OpenAI-compatible /v1/embeddings.
 * Indexes persist to JSON files so they survive server restarts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LLM_BASE_URL = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://148.204.112.157:8080';
// Prefer a dedicated embedding model to avoid relying on a chat/instruct model.
const EMBED_MODEL =
  process.env.LLM_EMBED_MODEL ||
  process.env.OLLAMA_EMBED_MODEL ||
  'nomic-embed-text';
const DEFAULT_LLM_MODEL =
  process.env.LLM_MODEL ||
  process.env.OLLAMA_MODEL ||
  'bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M';
const FALLBACK_EMBED_MODEL = DEFAULT_LLM_MODEL;

function buildEmbedConfigHint() {
  return (
    `Verifica que el modelo de embeddings exista en ${LLM_BASE_URL} y configura ` +
    `LLM_EMBED_MODEL (o OLLAMA_EMBED_MODEL) con un modelo disponible.`
  );
}

function looksLikeModelNotFoundError(status, bodyText) {
  if (status !== 400) return false;
  const text = String(bodyText || '').toLowerCase();
  return text.includes('not found') && text.includes('model');
}

function looksLikePoolingCompatibilityError(status, bodyText) {
  if (status !== 400) return false;
  const text = String(bodyText || '').toLowerCase();
  return text.includes('pooling type') && text.includes('not oai compatible');
}

async function requestEmbedding(modelName, text) {
  const response = await fetch(`${LLM_BASE_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, input: text }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      bodyText: rawText,
      data: null,
    };
  }

  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    data = null;
  }

  return {
    ok: true,
    status: response.status,
    bodyText: rawText,
    data,
  };
}

async function requestEmbeddingNative(modelName, text) {
  const response = await fetch(`${LLM_BASE_URL}/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, content: text }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      bodyText: rawText,
      data: null,
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(rawText);
  } catch (_) {
    payload = null;
  }

  // llama.cpp native format is usually: [{ index: 0, embedding: [[...]] }]
  let embedding = null;
  if (Array.isArray(payload) && payload[0] && Array.isArray(payload[0].embedding)) {
    const first = payload[0].embedding;
    if (Array.isArray(first[0])) {
      embedding = first[0];
    } else {
      embedding = first;
    }
  }

  return {
    ok: true,
    status: response.status,
    bodyText: rawText,
    data: embedding ? { embedding } : null,
  };
}

async function fetchFirstAvailableModelId() {
  try {
    const response = await fetch(`${LLM_BASE_URL}/v1/models`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const models = Array.isArray(data && data.data) ? data.data : [];
    for (const model of models) {
      const id = String((model && model.id) || '').trim();
      if (id) return id;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Request an embedding vector from llama.cpp (OpenAI-compatible).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedText(text) {
  // Truncate to avoid exceeding the embedding endpoint's batch size (512 tokens).
  // ~4 chars/token is a safe heuristic; default 1800 chars ≈ 450 tokens.
  const maxEmbedChars = Math.max(100, parseInt(process.env.LLM_EMBED_MAX_CHARS, 10) || 1800);
  const safeText = text.length > maxEmbedChars ? text.slice(0, maxEmbedChars) : text;

  let selectedModel = EMBED_MODEL;
  const triedModels = new Set([selectedModel]);
  let result = await requestEmbedding(selectedModel, safeText);

  const canTryFallback = Boolean(FALLBACK_EMBED_MODEL) && FALLBACK_EMBED_MODEL !== EMBED_MODEL;

  if (!result.ok && canTryFallback && looksLikeModelNotFoundError(result.status, result.bodyText)) {
    selectedModel = FALLBACK_EMBED_MODEL;
    triedModels.add(selectedModel);
    console.warn(
      `[vectorIndex] Embedding model "${EMBED_MODEL}" no disponible; usando fallback "${selectedModel}".`
    );
    result = await requestEmbedding(selectedModel, safeText);
  }

  if (!result.ok && looksLikeModelNotFoundError(result.status, result.bodyText)) {
    const discoveredModel = await fetchFirstAvailableModelId();
    if (discoveredModel && !triedModels.has(discoveredModel)) {
      selectedModel = discoveredModel;
      triedModels.add(selectedModel);
      console.warn(
        `[vectorIndex] Modelo de embedding no encontrado; usando modelo detectado en /v1/models: "${selectedModel}".`
      );
      result = await requestEmbedding(selectedModel, safeText);
    }
  }

  if (!result.ok && looksLikePoolingCompatibilityError(result.status, result.bodyText)) {
    console.warn(
      `[vectorIndex] /v1/embeddings no compatible por pooling para "${selectedModel}"; usando fallback nativo /embedding.`
    );
    result = await requestEmbeddingNative(selectedModel, safeText);
  }

  if (!result.ok) {
    throw new Error(
      `LLM embed error ${result.status} (model=${selectedModel}, endpoint=${LLM_BASE_URL}/v1/embeddings): ${result.bodyText}. ` +
      buildEmbedConfigHint()
    );
  }

  const data = result.data || {};
  // OpenAI-compatible: { data: [{ embedding: [...] }] }
  if (Array.isArray(data.data) && data.data[0] && Array.isArray(data.data[0].embedding)) {
    return data.data[0].embedding;
  }

  // Legacy compatibility: { embedding: [...] }
  if (Array.isArray(data.embedding) && data.embedding.length > 0) {
    return data.embedding;
  }

  throw new Error(
    `Embedding response missing vector data (model=${selectedModel}, endpoint=${LLM_BASE_URL}/v1/embeddings). ` +
    buildEmbedConfigHint()
  );
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
