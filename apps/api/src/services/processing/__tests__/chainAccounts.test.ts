/**
 * The missing-statement check treats each account as its own chain.
 *
 * Origin: a batch of fifteen statements from two accounts, four from one bank and
 * eleven from another. Chained together, the two places where the order switched
 * from one bank to the other read as missing statements, and the one statement
 * that really was missing (one month of the second account) was reported with the
 * wrong files and the wrong amount.
 *
 * File names and amounts below are made up.
 */

import { describe, it, expect } from 'vitest';
import { computeChainVerification } from '../Verification.js';
import type { FileSummary } from '../JobStore.js';

function file(account: string | undefined, filename: string, periodStart: number, opening: number, moneyIn: number, moneyOut: number): FileSummary {
    return {
        filename, transactions: 1, parsedIn: moneyIn, parsedOut: moneyOut,
        declaredIn: moneyIn, declaredOut: moneyOut,
        openingBalance: opening, closingBalance: Math.round((opening + moneyIn - moneyOut) * 100) / 100,
        periodStart, account,
    };
}

const totals = (files: FileSummary[]) => [
    files.reduce((s, f) => s + f.parsedIn, 0),
    files.reduce((s, f) => s + f.parsedOut, 0),
] as const;

// Account A: 0 → 100 → 100 → 80.      Account B: 1,000 → 1,200 → 900 → (890 missing) → 850
const A = [
    file('bank-a', 'A May.pdf', 20260512, 0, 1000, 900),
    file('bank-a', 'A Jun.pdf', 20260612, 100, 900, 900),
    file('bank-a', 'A Jul.pdf', 20260712, 100, 900, 920),
];
const B_JAN = file('bank-b', 'B January.pdf',  20260101, 1000, 500, 300);
const B_FEB = file('bank-b', 'B February.pdf', 20260201, 1200, 0, 300);
const B_MAR = file('bank-b', 'B March.pdf',    20260301, 900, 0, 10);
const B_APR = file('bank-b', 'B April.pdf',    20260401, 890, 0, 40);

describe('computeChainVerification – more than one account in a batch', () => {
    it('finds no gap when each account is complete, whatever order the files came in', () => {
        const files = [B_FEB, A[2], B_JAN, A[0], B_MAR, A[1], B_APR];
        const chain = computeChainVerification(files, ...totals(files))!;

        expect(chain.gaps).toEqual([]);
        expect(chain.ok).toBe(true);
        // the batch opens with the sum of the accounts' openings and closes with the sum of their closings
        expect(chain.chainOpeningBalance).toBe(1000);
        expect(chain.chainClosingBalance).toBe(930);
    });

    it('reports a statement missing from one account, and only that', () => {
        const files = [A[0], A[1], A[2], B_JAN, B_FEB, B_APR];       // B March is missing
        const chain = computeChainVerification(files, ...totals(files))!;

        expect(chain.ok).toBe(false);
        expect(chain.gaps).toEqual([{
            afterFile: 'B February.pdf', beforeFile: 'B April.pdf',
            expectedOpen: 900, actualOpen: 890, diff: -10,
        }]);
        expect(chain.diff).toBe(-10);       // the missing month's net movement
    });

    it('gives the same answer as before for a batch of one account', () => {
        const files = [B_FEB, B_JAN, B_APR];
        const untagged = files.map(f => ({ ...f, account: undefined }));

        expect(computeChainVerification(files, ...totals(files)))
            .toEqual(computeChainVerification(untagged, ...totals(untagged)));
        expect(computeChainVerification(files, ...totals(files))!.gaps).toHaveLength(1);
    });
});
