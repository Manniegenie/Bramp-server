const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { createEmbeddings } = require('./rag');

async function loadDocuments() {
  const docsDir = path.join(__dirname, '../data/docs');
  if (!fs.existsSync(docsDir)) return []; // handle empty docs folder

  const files = fs.readdirSync(docsDir);
  const docs = [];

  for (const file of files) {
    const filePath = path.join(docsDir, file);
    if (file.endsWith('.pdf')) {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      docs.push({ id: file, text: pdfData.text });
    } else if (file.endsWith('.txt')) {
      const text = fs.readFileSync(filePath, 'utf-8');
      docs.push({ id: file, text });
    }
  }

  return docs;
}

async function setupEmbeddings() {
  const docs = await loadDocuments();
  if (!docs.length) {
    console.log('⚠️ No documents found for embeddings.');
    return;
  }
  const embeddings = await createEmbeddings(docs);
  console.log('✅ Embeddings created:', embeddings.length);
}

setupEmbeddings();

module.exports = { loadDocuments, setupEmbeddings };
