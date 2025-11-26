// AI/rag.js
const fs = require('fs');
const path = require('path');

const embeddingsFile = path.join(__dirname, '..', 'data', 'embeddings.json');

let OpenAI;
let openai = null;

/**
 * Lazy initialize OpenAI client and return it, or null if API key missing.
 */
function getOpenAIClient() {
  if (openai) return openai;
  try {
    OpenAI = require('openai');
  } catch (e) {
    // openai package not installed
    throw new Error('openai package is not installed. Run: npm install openai');
  }
  const key = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!key) return null;
  openai = new OpenAI({ apiKey: key });
  return openai;
}

/**
 * Simple character-based chunker to avoid sending huge inputs to the embeddings API.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function chunkText(text, maxChars = 3000) {
  if (!text) return [];
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      // try to avoid breaking mid-word by looking ahead up to 200 chars for a space
      const lookahead = clean.slice(end, Math.min(end + 200, clean.length));
      const spaceIndex = lookahead.indexOf(' ');
      if (spaceIndex !== -1) end += spaceIndex;
    }
    const part = clean.slice(start, end).trim();
    if (part) chunks.push(part);
    start = end;
  }
  return chunks;
}

/**
 * Create embeddings for a set of documents and save to local JSON.
 * Accepts docs: [{ id: string, text: string }]
 *
 * Options:
 *  - maxCharsPerChunk: number (default 3000)
 *  - batchSize: number of texts to send in a single embeddings request (default 10)
 *  - model: embedding model (default 'text-embedding-3-small')
 */
async function createEmbeddings(docs = [], opts = {}) {
  const {
    maxCharsPerChunk = 3000,
    batchSize = 10,
    model = 'text-embedding-3-small'
  } = opts;

  if (!Array.isArray(docs) || docs.length === 0) return [];

  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY not set. Set it in your environment to create embeddings.');

  // flatten docs into chunks
  const chunks = [];
  for (const doc of docs) {
    if (!doc || !doc.text) continue;
    const parts = chunkText(doc.text, maxCharsPerChunk);
    if (parts.length === 1) {
      chunks.push({ id: doc.id, text: parts[0] });
    } else {
      parts.forEach((p, i) => chunks.push({ id: `${doc.id}::chunk${i}`, text: p }));
    }
  }

  if (!chunks.length) return [];

  // ensure output directory exists
  const outDir = path.dirname(embeddingsFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const embeddings = [];

  // process in batches (the embeddings endpoint supports multiple inputs)
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const inputs = batch.map(c => c.text);

    try {
      const resp = await client.embeddings.create({
        model,
        input: inputs
      });

      const data = resp.data || [];
      for (let j = 0; j < data.length; j++) {
        const emb = data[j] && data[j].embedding;
        const meta = batch[j];
        if (emb && meta) {
          embeddings.push({ id: meta.id, text: meta.text, embedding: emb });
        } else {
          console.warn('Missing embedding or metadata for batch index', j);
        }
      }
      // gentle pause between batches
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      // batch failed (maybe token limits or rate limits). retry items individually.
      console.error('Embeddings batch failed:', err?.message || err);
      for (const item of batch) {
        try {
          const r2 = await client.embeddings.create({ model, input: item.text });
          const emb = r2.data && r2.data[0] && r2.data[0].embedding;
          if (emb) embeddings.push({ id: item.id, text: item.text, embedding: emb });
          await new Promise(r => setTimeout(r, 50));
        } catch (err2) {
          console.warn(`Failed to embed chunk ${item.id}:`, err2?.message || err2);
        }
      }
    }
  }

  try {
    fs.writeFileSync(embeddingsFile, JSON.stringify(embeddings, null, 2));
  } catch (e) {
    console.warn('Failed to write embeddings file:', e?.message || e);
  }

  return embeddings;
}

/**
 * Load embeddings from local JSON store. Returns [] if file missing or invalid.
 */
function loadEmbeddings() {
  if (!fs.existsSync(embeddingsFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(embeddingsFile, 'utf-8'));
  } catch (e) {
    console.warn('Failed to parse embeddings file, returning empty list.', e?.message || e);
    return [];
  }
}

/**
 * Cosine similarity with safety checks.
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Retrieve the most relevant documents for a query embedding.
 * Returns [] if no embeddings present.
 */
function retrieveRelevantDocs(queryEmbedding, topK = 3) {
  const docs = loadEmbeddings();
  if (!docs || !docs.length) return [];
  const scored = docs.map(d => ({ ...d, score: cosineSimilarity(queryEmbedding, d.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

module.exports = {
  createEmbeddings,
  loadEmbeddings,
  retrieveRelevantDocs,
  // helper so callers can check whether OpenAI is configured
  hasOpenAI: () => !!(process.env.OPENAI_API_KEY || process.env.OPENAI_KEY)
};
