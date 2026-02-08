import type React from 'react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useIngestionJobs } from '../stores/hooks';

/**
 * Displays progress indicators for active ingestion jobs.
 * Renders as a banner at the bottom of the window showing job status, progress bars,
 * and cancel buttons. Returns null when no jobs are active.
 */
export function IngestionProgress(): ReactElement | null {
  const activeJobs = useIngestionJobs();

  // Filter to running/queued jobs
  const runningJobs = activeJobs?.filter((j) => j.status === 'queued' || j.status === 'running');

  // QA-019: Track which jobs have a pending cancel request
  const [cancellingJobs, setCancellingJobs] = useState<ReadonlySet<string>>(new Set());

  if (!runningJobs || runningJobs.length === 0) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (startedAt: string): string => {
    const elapsed = Date.now() - new Date(startedAt).getTime();
    const seconds = Math.floor(elapsed / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  const getFileName = (filePath: string): string => {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1] ?? filePath;
  };

  const handleCancel = (jobId: string): void => {
    setCancellingJobs((prev) => new Set([...prev, jobId]));
    void window.datspace.ingestion.cancelJob(jobId);
  };

  return (
    <div style={styles.container}>
      {runningJobs.map((job) => {
        const percentage =
          job.estimatedTotalRows && job.estimatedTotalRows > 0
            ? Math.min(99, Math.round((job.rowsProcessed / job.estimatedTotalRows) * 100))
            : undefined;

        return (
          <div key={job.id} style={styles.jobRow}>
            <span style={styles.fileName}>{getFileName(job.filePath)}</span>
            <div
              style={styles.progressBar}
              role="progressbar"
              aria-valuenow={percentage}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Importing ${getFileName(job.filePath)}`}
            >
              <div
                style={{
                  ...styles.progressFill,
                  width: percentage !== undefined ? `${percentage}%` : '100%',
                  animation:
                    percentage === undefined ? 'indeterminate 1.5s infinite linear' : undefined,
                }}
              />
            </div>
            {percentage !== undefined && <span style={styles.percentage}>{percentage}%</span>}
            <span style={styles.stats}>
              {job.rowsProcessed.toLocaleString()} rows | {formatBytes(job.bytesProcessed)} |{' '}
              {formatDuration(job.startedAt)}
            </span>
            <button
              type="button"
              style={styles.cancelButton}
              disabled={cancellingJobs.has(job.id)}
              onClick={() => {
                handleCancel(job.id);
              }}
              title="Cancel import"
            >
              {cancellingJobs.has(job.id) ? 'Cancelling...' : 'Cancel'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  container: {
    position: 'fixed' as const,
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    maxWidth: 600,
    width: '90%',
  },
  jobRow: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: 8,
    padding: '8px 12px',
    backgroundColor: '#1f2937',
    color: '#f9fafb',
    borderRadius: 8,
    fontSize: 13,
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  },
  fileName: {
    fontWeight: 600,
    maxWidth: 120,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  progressBar: {
    flex: 1,
    height: 6,
    backgroundColor: '#374151',
    borderRadius: 3,
    overflow: 'hidden' as const,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  percentage: {
    minWidth: 36,
    textAlign: 'right' as const,
    fontSize: 12,
    color: '#9ca3af',
  },
  stats: {
    fontSize: 11,
    color: '#9ca3af',
    whiteSpace: 'nowrap' as const,
  },
  cancelButton: {
    padding: '2px 8px',
    fontSize: 11,
    border: '1px solid #4b5563',
    borderRadius: 4,
    backgroundColor: 'transparent',
    color: '#ef4444',
    cursor: 'pointer',
  },
} satisfies Record<string, React.CSSProperties>;
