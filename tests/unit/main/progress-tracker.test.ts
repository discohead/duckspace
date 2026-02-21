import { ProgressTracker } from '@main/ingestion/progress-tracker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Lifecycle: startJob
  // -----------------------------------------------------------------------

  describe('startJob', () => {
    it('creates a job with initial state', () => {
      tracker.startJob('job-1', 1_000_000);

      const state = tracker.getJobState('job-1');
      expect(state).toBeDefined();
      expect(state?.status).toBe('running');
      expect(state?.rowsProcessed).toBe(0);
      expect(state?.bytesProcessed).toBe(0);
      expect(state?.batchIndex).toBe(0);
      expect(state?.fileSizeBytes).toBe(1_000_000);
      expect(state?.estimatedTotalRows).toBeUndefined();
      expect(state?.cancelled).toBe(false);
    });

    it('creates a job without fileSizeBytes', () => {
      tracker.startJob('job-1');

      const state = tracker.getJobState('job-1');
      expect(state).toBeDefined();
      expect(state?.fileSizeBytes).toBeUndefined();
    });

    it('records the start time', () => {
      const now = Date.now();
      tracker.startJob('job-1', 500);

      const state = tracker.getJobState('job-1');
      expect(state?.startedAt).toBe(now);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: updateProgress
  // -----------------------------------------------------------------------

  describe('updateProgress', () => {
    it('updates rows, bytes, and batch index', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.updateProgress('job-1', 500, 50_000, 0);

      const state = tracker.getJobState('job-1');
      expect(state?.rowsProcessed).toBe(500);
      expect(state?.bytesProcessed).toBe(50_000);
      expect(state?.batchIndex).toBe(0);
    });

    it('extrapolates estimatedTotalRows from first batch', () => {
      tracker.startJob('job-1', 1_000_000);
      // 500 rows in 50,000 bytes out of 1,000,000 total bytes
      // estimated = (1_000_000 / 50_000) * 500 = 10_000
      tracker.updateProgress('job-1', 500, 50_000, 0);

      const state = tracker.getJobState('job-1');
      expect(state?.estimatedTotalRows).toBe(10_000);
    });

    it('updates estimatedTotalRows on subsequent batches', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.updateProgress('job-1', 500, 50_000, 0);
      tracker.updateProgress('job-1', 1200, 120_000, 1);

      const state = tracker.getJobState('job-1');
      // (1_000_000 / 120_000) * 1200 = 10_000
      expect(state?.estimatedTotalRows).toBe(10_000);
    });

    it('does not extrapolate when fileSizeBytes is undefined', () => {
      tracker.startJob('job-1');
      tracker.updateProgress('job-1', 500, 50_000, 0);

      const state = tracker.getJobState('job-1');
      expect(state?.estimatedTotalRows).toBeUndefined();
    });

    it('is a no-op for cancelled jobs', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.cancelJob('job-1');
      tracker.updateProgress('job-1', 500, 50_000, 0);

      const state = tracker.getJobState('job-1');
      expect(state?.rowsProcessed).toBe(0);
      expect(state?.bytesProcessed).toBe(0);
    });

    it('is a no-op for unknown jobIds', () => {
      // Should not throw
      tracker.updateProgress('nonexistent', 500, 50_000, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: completeJob
  // -----------------------------------------------------------------------

  describe('completeJob', () => {
    it('removes the job from active tracking', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.completeJob('job-1');

      expect(tracker.getJobState('job-1')).toBeUndefined();
    });

    it('is a no-op for unknown jobIds', () => {
      // Should not throw
      tracker.completeJob('nonexistent');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: failJob
  // -----------------------------------------------------------------------

  describe('failJob', () => {
    it('removes the job from active tracking', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.failJob('job-1');

      expect(tracker.getJobState('job-1')).toBeUndefined();
    });

    it('is a no-op for unknown jobIds', () => {
      // Should not throw
      tracker.failJob('nonexistent');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: cancelJob
  // -----------------------------------------------------------------------

  describe('cancelJob', () => {
    it('returns true for an active running job', () => {
      tracker.startJob('job-1', 1_000_000);

      expect(tracker.cancelJob('job-1')).toBe(true);
    });

    it('sets status to cancelled and cancelled flag to true', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.cancelJob('job-1');

      const state = tracker.getJobState('job-1');
      expect(state?.status).toBe('cancelled');
      expect(state?.cancelled).toBe(true);
    });

    it('returns false for already cancelled jobs', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.cancelJob('job-1');

      expect(tracker.cancelJob('job-1')).toBe(false);
    });

    it('returns false for unknown jobIds', () => {
      expect(tracker.cancelJob('nonexistent')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Estimation: estimateCompletion
  // -----------------------------------------------------------------------

  describe('estimateCompletion', () => {
    it('returns undefined for unknown jobIds', () => {
      expect(tracker.estimateCompletion('nonexistent')).toBeUndefined();
    });

    it('calculates percentage based on bytes processed vs file size', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.updateProgress('job-1', 500, 100_000, 0);

      const est = tracker.estimateCompletion('job-1');
      expect(est).toBeDefined();
      // 100_000 / 1_000_000 * 100 = 10%
      expect(est?.percentage).toBe(10);
    });

    it('caps percentage at 99% during active processing', () => {
      tracker.startJob('job-1', 1_000);
      tracker.updateProgress('job-1', 100, 999, 0);

      const est = tracker.estimateCompletion('job-1');
      // 999 / 1000 * 100 = 99.9 -> capped at 99
      expect(est?.percentage).toBe(99);
    });

    it('caps at 99% even when bytes exceed file size', () => {
      tracker.startJob('job-1', 1_000);
      tracker.updateProgress('job-1', 200, 1_500, 0);

      const est = tracker.estimateCompletion('job-1');
      expect(est?.percentage).toBe(99);
    });

    it('returns percentage undefined when fileSizeBytes is unknown', () => {
      tracker.startJob('job-1');
      tracker.updateProgress('job-1', 500, 50_000, 0);

      const est = tracker.estimateCompletion('job-1');
      expect(est).toBeDefined();
      expect(est?.percentage).toBeUndefined();
    });

    it('includes estimatedTotalRows when available', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.updateProgress('job-1', 500, 50_000, 0);

      const est = tracker.estimateCompletion('job-1');
      expect(est?.estimatedTotalRows).toBe(10_000);
    });

    it('reports elapsed time correctly', () => {
      tracker.startJob('job-1', 1_000_000);
      vi.advanceTimersByTime(5000);

      const est = tracker.estimateCompletion('job-1');
      expect(est?.elapsedMs).toBe(5000);
    });
  });

  // -----------------------------------------------------------------------
  // Queries: getJobState
  // -----------------------------------------------------------------------

  describe('getJobState', () => {
    it('returns a snapshot of the job state', () => {
      tracker.startJob('job-1', 500_000);
      tracker.updateProgress('job-1', 100, 10_000, 0);

      const state = tracker.getJobState('job-1');
      expect(state).toMatchObject({
        jobId: 'job-1',
        status: 'running',
        rowsProcessed: 100,
        bytesProcessed: 10_000,
        batchIndex: 0,
        fileSizeBytes: 500_000,
        cancelled: false,
      });
    });

    it('returns undefined for unknown jobIds', () => {
      expect(tracker.getJobState('nonexistent')).toBeUndefined();
    });

    it('returns an immutable snapshot (mutations do not affect tracker)', () => {
      tracker.startJob('job-1', 500_000);
      const state1 = tracker.getJobState('job-1')!;

      tracker.updateProgress('job-1', 200, 20_000, 1);
      const state2 = tracker.getJobState('job-1')!;

      // state1 should not have been mutated
      expect(state1.rowsProcessed).toBe(0);
      expect(state2.rowsProcessed).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Queries: getActiveJobs
  // -----------------------------------------------------------------------

  describe('getActiveJobs', () => {
    it('returns an empty map when no jobs are tracked', () => {
      const jobs = tracker.getActiveJobs();
      expect(jobs.size).toBe(0);
    });

    it('returns all running jobs', () => {
      tracker.startJob('job-1', 100);
      tracker.startJob('job-2', 200);

      const jobs = tracker.getActiveJobs();
      expect(jobs.size).toBe(2);
      expect(jobs.has('job-1')).toBe(true);
      expect(jobs.has('job-2')).toBe(true);
    });

    it('does not include completed jobs', () => {
      tracker.startJob('job-1', 100);
      tracker.startJob('job-2', 200);
      tracker.completeJob('job-1');

      const jobs = tracker.getActiveJobs();
      expect(jobs.size).toBe(1);
      expect(jobs.has('job-2')).toBe(true);
    });

    it('includes cancelled jobs (still tracked until complete/fail)', () => {
      tracker.startJob('job-1', 100);
      tracker.cancelJob('job-1');

      const jobs = tracker.getActiveJobs();
      expect(jobs.size).toBe(1);
      expect(jobs.get('job-1')?.status).toBe('cancelled');
    });
  });

  // -----------------------------------------------------------------------
  // Queries: isJobCancelled
  // -----------------------------------------------------------------------

  describe('isJobCancelled', () => {
    it('returns false before cancellation', () => {
      tracker.startJob('job-1', 100);
      expect(tracker.isJobCancelled('job-1')).toBe(false);
    });

    it('returns true after cancellation', () => {
      tracker.startJob('job-1', 100);
      tracker.cancelJob('job-1');
      expect(tracker.isJobCancelled('job-1')).toBe(true);
    });

    it('returns false for unknown jobIds', () => {
      expect(tracker.isJobCancelled('nonexistent')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases: Multiple concurrent jobs
  // -----------------------------------------------------------------------

  describe('concurrent jobs', () => {
    it('tracks multiple jobs independently', () => {
      tracker.startJob('job-1', 1_000_000);
      tracker.startJob('job-2', 2_000_000);

      tracker.updateProgress('job-1', 100, 10_000, 0);
      tracker.updateProgress('job-2', 200, 40_000, 0);

      const state1 = tracker.getJobState('job-1');
      const state2 = tracker.getJobState('job-2');

      expect(state1?.rowsProcessed).toBe(100);
      expect(state2?.rowsProcessed).toBe(200);
      expect(state1?.fileSizeBytes).toBe(1_000_000);
      expect(state2?.fileSizeBytes).toBe(2_000_000);
    });

    it('cancelling one job does not affect another', () => {
      tracker.startJob('job-1', 100);
      tracker.startJob('job-2', 200);

      tracker.cancelJob('job-1');

      expect(tracker.getJobState('job-1')?.status).toBe('cancelled');
      expect(tracker.getJobState('job-2')?.status).toBe('running');
    });

    it('completing one job does not affect another', () => {
      tracker.startJob('job-1', 100);
      tracker.startJob('job-2', 200);

      tracker.completeJob('job-1');

      expect(tracker.getJobState('job-1')).toBeUndefined();
      expect(tracker.getJobState('job-2')?.status).toBe('running');
    });
  });
});
