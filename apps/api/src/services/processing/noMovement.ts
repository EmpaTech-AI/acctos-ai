import type { EmptyStatement } from './NotificationService.js';

/**
 * Every statement in the batch parsed to no transactions, and each one's own summary
 * says nothing came in or went out. The files were read correctly; the account simply
 * had no activity (e.g. a deposit account sent instead of the current account).
 *
 * The message still starts "No transactions found", so the job is classed as a
 * client error like any other empty result.
 */
export class NoMovementError extends Error {
    constructor(public readonly statements: EmptyStatement[]) {
        super(`No transactions found: ${statements.length === 1 ? 'the statement shows' : `all ${statements.length} statements show`} no money in or out`);
    }
}

export interface EmptyFile {
    filename: string;
    statementTotals?: { moneyIn?: number; moneyOut?: number; openingBalance?: number; closingBalance?: number };
}

/**
 * The NoMovementError for a batch, or null when the empty result has another cause.
 * `emptyFiles` = the files that parsed to no transactions. Every file in the batch
 * must be among them, and each must declare £0 in and £0 out. A file without
 * declared totals proves nothing, so it rules the case out.
 */
export function noMovementError(fileCount: number, emptyFiles: EmptyFile[]): NoMovementError | null {
    const all = fileCount > 0 && emptyFiles.length === fileCount
        && emptyFiles.every(f => f.statementTotals?.moneyIn === 0 && f.statementTotals?.moneyOut === 0);
    if (!all) return null;
    return new NoMovementError(emptyFiles.map(f => ({
        filename:       f.filename,
        openingBalance: f.statementTotals?.openingBalance,
        closingBalance: f.statementTotals?.closingBalance,
    })));
}
