/**
 * HSBC parser smoke-test.
 *
 * Пусни от apps/api/:
 *   npx tsx test-hsbc.ts                              <- вграден sample
 *   npx tsx test-hsbc.ts "columnIndex: 0, content:..." <- paste OCR текст
 */

import { parse } from './src/services/processing/parsers/hsbc.js';
import type { Cell } from './src/services/processing/parsers/shared.js';

// ── Вграден sample (първа страница от тестовия извлечение) ─────────────────
const SAMPLE = [
    'columnIndex: 0, content: Your Bank Account details',
    'columnIndex: 0, content: Date;columnIndex: 1, content: ;columnIndex: 2, content: Payment type and details;columnIndex: 3, content: £ Paid out;columnIndex: 4, content: £ Paid in;columnIndex: 5, content: £ Balance',
    'columnIndex: 0, content: A 26 Mar 25;columnIndex: 1, content: ;columnIndex: 2, content: BALANCE BROUGHT FORWARD;columnIndex: 3, content: .;columnIndex: 4, content: ;columnIndex: 5, content: 206.50',
    'columnIndex: 0, content: 27 Mar 25;columnIndex: 1, content: )));columnIndex: 2, content: REEVES DRY CLEANER',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: LONDON SW13;columnIndex: 3, content: 18.80',
    'columnIndex: 0, content: ;columnIndex: 1, content: VIS;columnIndex: 2, content: AMAZON* RZ84J5LY4',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: LONDON;columnIndex: 3, content: 23.41',
    'columnIndex: 0, content: ;columnIndex: 1, content: VIS;columnIndex: 2, content: INT\'L 0095344221',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: SKROUTZ',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: NEA IONIA',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: EUR 72.00 @ 1.1954',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: Visa Rate;columnIndex: 3, content: 60.23',
    'columnIndex: 0, content: ;columnIndex: 1, content: DR;columnIndex: 2, content: Non-Sterling',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: Transaction Fee;columnIndex: 3, content: 1.65;columnIndex: 4, content: ;columnIndex: 5, content: 102.41',
    'columnIndex: 0, content: 28 Mar 25;columnIndex: 1, content: CR;columnIndex: 2, content: J Wolfgramm-King &',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: Warrington crescen;columnIndex: 3, content: ;columnIndex: 4, content: 45.00',
    'columnIndex: 0, content: ;columnIndex: 1, content: CR;columnIndex: 2, content: COOMBES I E',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: IZZY CLEANING;columnIndex: 3, content: ;columnIndex: 4, content: 48.00',
    'columnIndex: 0, content: ;columnIndex: 1, content: CR;columnIndex: 2, content: MARTIN EMM',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: 48 REEDWORTH CLEAN;columnIndex: 3, content: ;columnIndex: 4, content: 40.50',
    'columnIndex: 0, content: ;columnIndex: 1, content: VIS;columnIndex: 2, content: NATIONAL LOTTERY',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: WWW.NATIONAL-;columnIndex: 3, content: 5.00',
    'columnIndex: 0, content: ;columnIndex: 1, content: ;columnIndex: 2, content: BALANCE CARRIED FORWARD;columnIndex: 4, content: ;columnIndex: 5, content: 208.41',
].join(';');

// ── 1. Вземи входен текст ──────────────────────────────────────────────────
const rawText: string = process.argv[2] || SAMPLE;

// ── 2. Make.com текст → Cell[] ─────────────────────────────────────────────
function textToCells(text: string): Cell[] {
    const cells: Cell[] = [];
    const re = /columnIndex:\s*(\d+),\s*content:\s*(.*?)(?=;columnIndex:|$)/g;
    let match: RegExpExecArray | null;
    let rowIndex = 0;
    let lastCol = -1;

    while ((match = re.exec(text)) !== null) {
        const col = parseInt(match[1], 10);
        const content = (match[2] || '').trim().replace(/^"|"$/g, '');

        if (col === 0 && lastCol !== -1) rowIndex++;
        lastCol = col;

        cells.push({ rowIndex, columnIndex: col, content });
    }
    return cells;
}

// ── 3. Парсиране ───────────────────────────────────────────────────────────
const cells = textToCells(rawText);
const maxRow = Math.max(...cells.map(c => c.rowIndex));
console.log(`Cells: ${cells.length}   rows: 0–${maxRow}\n`);

const result = parse(cells);

// ── 4. Таблица с резултати ─────────────────────────────────────────────────
const W = { date: 12, type: 7, desc: 45, out: 12, inn: 12 };
const sep = '─'.repeat(W.date + W.type + W.desc + W.out + W.inn + 10);

console.log(`Transactions: ${result.transactions.length}\n${sep}`);
console.log(
    'Date'.padEnd(W.date) + 'Type'.padEnd(W.type) +
    'Description'.padEnd(W.desc) + 'Out'.padEnd(W.out) +
    'In'.padEnd(W.inn) + 'Balance'
);
console.log(sep);

for (const tx of result.transactions) {
    const desc = (tx.description || '').replace(/\s+/g, ' ');
    console.log(
        (tx.date     || '').padEnd(W.date) +
        (tx.type     || '').padEnd(W.type) +
        desc.slice(0, W.desc - 2).padEnd(W.desc) +
        (tx.moneyOut || '').padEnd(W.out) +
        (tx.moneyIn  || '').padEnd(W.inn) +
        (tx.balance  || '')
    );
}
// ── 5. Totals ──────────────────────────────────────────────────────────────
const totalOut = result.transactions.reduce((s, tx) => s + (parseFloat(tx.moneyOut?.replace(/,/g,'') || '0') || 0), 0);
const totalIn  = result.transactions.reduce((s, tx) => s + (parseFloat(tx.moneyIn?.replace(/,/g,'')  || '0') || 0), 0);
const net      = totalIn - totalOut;

console.log(
    'TOTAL'.padEnd(W.date) + ''.padEnd(W.type) + ''.padEnd(W.desc) +
    totalOut.toFixed(2).padEnd(W.out) +
    totalIn.toFixed(2).padEnd(W.inn) +
    `net ${net >= 0 ? '+' : ''}${net.toFixed(2)}`
);
console.log(sep);

// ── 6. Предупреждения ──────────────────────────────────────────────────────
const noDate = result.transactions.filter(tx => !tx.date);
const noAmt  = result.transactions.filter(tx => !tx.moneyOut && !tx.moneyIn);

if (noDate.length) console.warn(`\n⚠  ${noDate.length} row(s) missing date`);
if (noAmt.length)  console.warn(`⚠  ${noAmt.length} row(s) missing moneyOut/In`);
if (!noDate.length && !noAmt.length) console.log('\n✓  All rows OK');
