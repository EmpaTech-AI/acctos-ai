export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type ProcessingStage = 'classify' | 'extract' | 'parse' | 'categorize' | 'output';

export interface JobSummary {
    moneyIn?:          number;
    moneyOut?:         number;
    openingBalance?:   number | null;
    closingBalance?:   number | null;
    balanceOk?:        boolean;
    declaredIn?:       number;
    declaredOut?:      number;
    declaredOk?:       boolean;
    catTotalIn?:       number;
    catTotalOut?:      number;
    catOk?:            boolean;
    vatTotal?:         number;
    vatSalesCount?:    number;
    vatSalesTotal?:    number;
    vatExpensesCount?: number;
    vatExpensesTotal?: number;
    driveUrl?:         string;
}

export interface FileSummary {
    filename: string;
    transactions: number;
    parsedIn: number;
    parsedOut: number;
    declaredIn?: number;
    declaredOut?: number;
    openingBalance?: number;
    closingBalance?: number;
}

export interface ProcessingJob {
    id: string;
    status: JobStatus;
    currentStage?: ProcessingStage;
    filename: string;
    bankType?: string;
    docType?: string;
    fileFormat?: string;
    transactionCount?: number;
    pageCount?: number;
    currentFile?: number;
    totalFiles?: number;
    duplicatesRemoved?: string[];
    error?: string;
    /** 'client' = bad/unsupported file; 'system' = our infrastructure/code failed */
    errorType?: 'client' | 'system';
    stageTiming?: Partial<Record<ProcessingStage, number>>;
    outputBuffer?: Buffer;
    summary?: JobSummary;
    createdAt: Date;
    completedAt?: Date;
}

class JobStore {
    private jobs = new Map<string, ProcessingJob>();

    create(id: string, filename: string): ProcessingJob {
        const job: ProcessingJob = { id, status: 'queued', filename, createdAt: new Date() };
        this.jobs.set(id, job);
        return job;
    }

    get(id: string): ProcessingJob | undefined {
        return this.jobs.get(id);
    }

    update(id: string, patch: Partial<ProcessingJob>): void {
        const job = this.jobs.get(id);
        if (job) Object.assign(job, patch);
    }

    cleanup(): void {
        const cutoff = Date.now() - 2 * 60 * 60 * 1000;
        for (const [id, job] of this.jobs) {
            if (job.createdAt.getTime() < cutoff) this.jobs.delete(id);
        }
    }
}

export const jobStore = new JobStore();

setInterval(() => jobStore.cleanup(), 30 * 60 * 1000);
