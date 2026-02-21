/**
 * Per-job progress tracking with completion estimation for local data ingestion.
 *
 * Tracks active ingestion jobs, supports cancellation, and provides first-batch
 * extrapolation for estimated total rows and completion percentage.
 */

// ---------------------------------------------------------------------------
// JobState Interface
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of an ingestion job's progress state.
 *
 * Returned by {@link ProgressTracker.getJobState} and
 * {@link ProgressTracker.getActiveJobs}.
 */
export interface JobState {
  /** UUID of the ingestion job */
  readonly jobId: string;
  /** Current lifecycle status */
  readonly status: 'running' | 'cancelled' | 'completed' | 'failed';
  /** Cumulative rows imported so far */
  readonly rowsProcessed: number;
  /** Cumulative bytes of data received */
  readonly bytesProcessed: number;
  /** Number of Arrow IPC batches received */
  readonly batchIndex: number;
  /** Source file size for progress estimation (undefined if unknown) */
  readonly fileSizeBytes: number | undefined;
  /** Estimated total rows extrapolated from first batch (undefined until first update) */
  readonly estimatedTotalRows: number | undefined;
  /** Timestamp (ms since epoch) when the job was started */
  readonly startedAt: number;
  /** Whether the job has been cancelled */
  readonly cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Internal Mutable State
// ---------------------------------------------------------------------------

/**
 * Mutable internal representation of a tracked job.
 * Converted to a readonly {@link JobState} snapshot for public consumption.
 */
interface MutableJobState {
  jobId: string;
  status: 'running' | 'cancelled' | 'completed' | 'failed';
  rowsProcessed: number;
  bytesProcessed: number;
  batchIndex: number;
  fileSizeBytes: number | undefined;
  estimatedTotalRows: number | undefined;
  startedAt: number;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Completion Estimation Result
// ---------------------------------------------------------------------------

/**
 * Result of a progress estimation for an active ingestion job.
 * Returned by {@link ProgressTracker.estimateCompletion}.
 */
export interface CompletionEstimate {
  /** Completion percentage (0–99 while running, 100 only on completion). Undefined if file size is unknown. */
  readonly percentage: number | undefined;
  /** Estimated total rows extrapolated from first-batch data (undefined until first batch arrives) */
  readonly estimatedTotalRows: number | undefined;
  /** Elapsed time in milliseconds since job start */
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// ProgressTracker Class
// ---------------------------------------------------------------------------

/**
 * Tracks progress, cancellation, and completion estimation for active ingestion jobs.
 *
 * Uses first-batch extrapolation to estimate total rows and completion percentage
 * when the source file size is known. Progress percentage is capped at 99% during
 * active processing and only reaches 100% when {@link completeJob} is called.
 *
 * @example
 * ```typescript
 * const tracker = new ProgressTracker();
 * tracker.startJob('job-1', 1_000_000);
 * tracker.updateProgress('job-1', 500, 50_000, 0);
 * const est = tracker.estimateCompletion('job-1');
 * // est?.percentage ~ 5, est?.estimatedTotalRows ~ 10_000
 * tracker.completeJob('job-1');
 * ```
 */
export class ProgressTracker {
  /** Internal map of active job states keyed by job ID. */
  private readonly jobs = new Map<string, MutableJobState>();

  /**
   * Register a new ingestion job for tracking.
   *
   * @param jobId - Unique identifier for the job.
   * @param fileSizeBytes - Size of the source file in bytes, used for progress estimation.
   *   Pass `undefined` if the file size is not known.
   */
  startJob(jobId: string, fileSizeBytes?: number): void {
    this.jobs.set(jobId, {
      jobId,
      status: 'running',
      rowsProcessed: 0,
      bytesProcessed: 0,
      batchIndex: 0,
      fileSizeBytes: fileSizeBytes ?? undefined,
      estimatedTotalRows: undefined,
      startedAt: Date.now(),
      cancelled: false,
    });
  }

  /**
   * Update progress for an active job.
   *
   * After the first batch (when `bytesProcessed > 0` and `fileSizeBytes` is known),
   * the estimated total rows are extrapolated from the ratio of file size to bytes
   * processed.
   *
   * @param jobId - The job to update.
   * @param rowsProcessed - Cumulative rows imported so far.
   * @param bytesProcessed - Cumulative bytes of data received.
   * @param batchIndex - Current batch index (0-based).
   */
  updateProgress(
    jobId: string,
    rowsProcessed: number,
    bytesProcessed: number,
    batchIndex: number,
  ): void {
    const job = this.jobs.get(jobId);
    if (job?.status !== 'running') {
      return;
    }

    job.rowsProcessed = rowsProcessed;
    job.bytesProcessed = bytesProcessed;
    job.batchIndex = batchIndex;

    // First-batch extrapolation for estimated total rows
    if (bytesProcessed > 0 && job.fileSizeBytes !== undefined) {
      job.estimatedTotalRows = Math.round((job.fileSizeBytes / bytesProcessed) * rowsProcessed);
    }
  }

  /**
   * Estimate completion progress for an active job.
   *
   * Percentage is computed as `(bytesProcessed / fileSizeBytes) * 100`, capped at 99%
   * during active processing. Returns `undefined` if the job is not found or not active.
   *
   * @param jobId - The job to estimate.
   * @returns Completion estimate, or `undefined` if the job is not tracked.
   */
  estimateCompletion(jobId: string): CompletionEstimate | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return undefined;
    }

    const elapsedMs = Date.now() - job.startedAt;

    let percentage: number | undefined;
    if (job.status === 'completed') {
      percentage = 100;
    } else if (job.fileSizeBytes !== undefined && job.fileSizeBytes > 0) {
      percentage = Math.min(99, (job.bytesProcessed / job.fileSizeBytes) * 100);
    }

    return {
      percentage,
      estimatedTotalRows: job.estimatedTotalRows,
      elapsedMs,
    };
  }

  /**
   * Mark a job as cancelled.
   *
   * Sets the cancellation flag and updates the job status. Does not remove
   * the job from tracking — call {@link completeJob} or {@link failJob} after
   * cancellation processing completes.
   *
   * @param jobId - The job to cancel.
   * @returns `true` if the job existed and was in a cancellable state, `false` otherwise.
   */
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return false;
    }

    if (job.status !== 'running') {
      return false;
    }

    job.cancelled = true;
    job.status = 'cancelled';
    return true;
  }

  /**
   * Check whether a job has been marked for cancellation.
   *
   * @param jobId - The job to check.
   * @returns `true` if the job exists and has been cancelled, `false` otherwise.
   */
  isJobCancelled(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return false;
    }
    return job.cancelled;
  }

  /**
   * Mark a job as completed and remove it from active tracking.
   *
   * Note: The job is removed from the internal map immediately, so
   * `getJobState(jobId)` will return `undefined` after this call —
   * the 'completed' status is unobservable via the public API.
   *
   * @param jobId - The job to complete.
   */
  completeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return;
    }

    job.status = 'completed';
    this.jobs.delete(jobId);
  }

  /**
   * Mark a job as failed and remove it from active tracking.
   *
   * @param jobId - The job to mark as failed.
   */
  failJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return;
    }

    job.status = 'failed';
    this.jobs.delete(jobId);
  }

  /**
   * Return a readonly snapshot of a job's current state.
   *
   * @param jobId - The job to query.
   * @returns The job state snapshot, or `undefined` if not tracked.
   */
  getJobState(jobId: string): JobState | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return undefined;
    }

    return {
      jobId: job.jobId,
      status: job.status,
      rowsProcessed: job.rowsProcessed,
      bytesProcessed: job.bytesProcessed,
      batchIndex: job.batchIndex,
      fileSizeBytes: job.fileSizeBytes,
      estimatedTotalRows: job.estimatedTotalRows,
      startedAt: job.startedAt,
      cancelled: job.cancelled,
    };
  }

  /**
   * Return all actively tracked jobs as a readonly map of snapshots.
   *
   * @returns A map of job ID to {@link JobState} for all active jobs.
   */
  getActiveJobs(): ReadonlyMap<string, JobState> {
    const result = new Map<string, JobState>();
    for (const [id, job] of this.jobs) {
      result.set(id, {
        jobId: job.jobId,
        status: job.status,
        rowsProcessed: job.rowsProcessed,
        bytesProcessed: job.bytesProcessed,
        batchIndex: job.batchIndex,
        fileSizeBytes: job.fileSizeBytes,
        estimatedTotalRows: job.estimatedTotalRows,
        startedAt: job.startedAt,
        cancelled: job.cancelled,
      });
    }
    return result;
  }
}
