import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

const dir = process.argv[2];
if (!dir) { console.error('Usage: node run-batch-folder.mjs <folder>'); process.exit(1); }

const files = readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf.pdf') || (f.toLowerCase().endsWith('.pdf') && !f.toLowerCase().endsWith('.pdf.pdf')))
    .sort()
    .map(f => join(dir, f));

// If we have .pdf.pdf files, prefer those
const pdfPdf = files.filter(f => f.endsWith('.pdf.pdf'));
const chosen = pdfPdf.length > 0 ? pdfPdf : files;

console.log(`Running batch on ${chosen.length} files from: ${dir}`);
chosen.forEach(f => console.log('  ', f));

const result = spawnSync('npx', ['tsx', 'test-batch.ts', ...chosen], {
    stdio: 'inherit',
    shell: false,
    cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
});
process.exit(result.status ?? 1);
