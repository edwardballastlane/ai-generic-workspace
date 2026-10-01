const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '..', '..', '.claude', 'vector-store', 'sessions.json');
const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));

const badEntries = data.entries.filter(e => !e.embedding || e.embedding.length !== 768);

console.log(`Total entries: ${data.entries.length}`);
console.log(`Bad entries: ${badEntries.length}`);

if (badEntries.length > 0) {
  console.log('\nSample bad entry:');
  const sample = badEntries[0];
  console.log(`  ID: ${sample.id}`);
  console.log(`  Session: ${sample.session_id}`);
  console.log(`  Embedding length: ${sample.embedding ? sample.embedding.length : 'undefined'}`);
  console.log(`  Text length: ${sample.chunk_text.length}`);
}
