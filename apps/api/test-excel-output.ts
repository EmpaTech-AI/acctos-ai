/**
 * Quick smoke test for ExcelOutputBuilder.
 * Generates test-output.xlsx with a few sample rows.
 *
 * Run from apps/api/:
 *   npx tsx test-excel-output.ts
 */

import { writeFileSync } from 'fs';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';
import type { CategorizedTransaction } from './src/services/processing/AssistantCategorizer.js';

const sample: CategorizedTransaction[] = [
    {
        DATE: '27/03/2026',
        'Type and Description': 'REEVES DRY CLEANER LONDON SW13',
        INCOME: '',
        SALARY: '', OTHER: '', INSURANCE: '', LOAN: '', CASH: '',
        TRAVEL: '', PHONE: '', CHARGES: '18.80', Bank_Transfer: '', HMRC: '', RENT: '', BILLS: '',
        Balance: '187.70',
    },
    {
        DATE: '27/03/2026',
        'Type and Description': 'AMAZON* RZ84J5LY4 LONDON',
        INCOME: '',
        SALARY: '', OTHER: '23.41', INSURANCE: '', LOAN: '', CASH: '',
        TRAVEL: '', PHONE: '', CHARGES: '', Bank_Transfer: '', HMRC: '', RENT: '', BILLS: '',
        Balance: '164.29',
    },
    {
        DATE: '28/03/2026',
        'Type and Description': 'J Wolfgramm-King & Warrington crescen',
        INCOME: '45.00',
        SALARY: '', OTHER: '', INSURANCE: '', LOAN: '', CASH: '',
        TRAVEL: '', PHONE: '', CHARGES: '', Bank_Transfer: '', HMRC: '', RENT: '', BILLS: '',
        Balance: '209.29',
    },
    {
        DATE: '28/03/2026',
        'Type and Description': 'COOMBES I E IZZY CLEANING',
        INCOME: '48.00',
        SALARY: '', OTHER: '', INSURANCE: '', LOAN: '', CASH: '',
        TRAVEL: '', PHONE: '', CHARGES: '', Bank_Transfer: '', HMRC: '', RENT: '', BILLS: '',
        Balance: '257.29',
    },
    {
        DATE: '28/03/2026',
        'Type and Description': 'NATIONAL LOTTERY WWW.NATIONAL-',
        INCOME: '',
        SALARY: '', OTHER: '', INSURANCE: '', LOAN: '', CASH: '',
        TRAVEL: '', PHONE: '', CHARGES: '5.00', Bank_Transfer: '', HMRC: '', RENT: '', BILLS: '',
        Balance: '252.29',
    },
];

const buf = buildPdfOutputExcel(sample);
writeFileSync('test-output.xlsx', buf);
console.log('Written: test-output.xlsx');
