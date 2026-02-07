import React, { useState, useEffect } from 'react';
import { useWorkerHealth, useRunningQueries, useAppState } from '../stores/hooks';
import type { WorkerHealthRecord } from '@shared/types';
import db from '../stores/db';

const statusColors: Record<WorkerHealthRecord['status'], string> = {
  ready: '#22c55e',
  busy: '#eab308',
  degraded: '#f97316',
  restarting: '#f97316',
  failed: '#ef4444',
};

const defaultColor = '#9ca3af';

function getStatusColor(status: WorkerHealthRecord['status'] | undefined): string {
  if (!status) return defaultColor;
  return statusColors[status] ?? defaultColor;
}

const StatusBar: React.FC = () => {
  const workerHealth = useWorkerHealth();
  const runningQueries = useRunningQueries();
  const recoveryTriggered = useAppState<boolean>('recovery_triggered');
  const [showRecoveryBanner, setShowRecoveryBanner] = useState(false);

  const status = workerHealth?.status;
  const activeCount = runningQueries?.length ?? 0;

  // T058: Show recovery banner when crash recovery was triggered
  useEffect(() => {
    if (recoveryTriggered) {
      setShowRecoveryBanner(true);
      const timer = setTimeout(() => {
        setShowRecoveryBanner(false);
        // Clear the flag
        db.app_state.put({
          id: 'recovery_triggered',
          value: false,
          updatedAt: new Date().toISOString(),
        });
      }, 8000);
      return () => clearTimeout(timer);
    }
  }, [recoveryTriggered]);

  return (
    <div style={{ position: 'relative' }}>
      {/* T058: Recovery notification banner */}
      {showRecoveryBanner && (
        <div style={{
          padding: '6px 16px',
          backgroundColor: '#fef3c7',
          borderTop: '1px solid #fcd34d',
          fontSize: '12px',
          color: '#92400e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>Previous session did not shut down cleanly. Recovery completed successfully.</span>
          <button
            onClick={() => setShowRecoveryBanner(false)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#92400e',
              fontSize: '14px',
              padding: '0 4px',
            }}
          >
            x
          </button>
        </div>
      )}

      {/* T058: Degraded/failed state warning */}
      {(status === 'degraded' || status === 'failed' || status === 'restarting') && (
        <div style={{
          padding: '6px 16px',
          backgroundColor: status === 'failed' ? '#fef2f2' : '#fff7ed',
          borderTop: `1px solid ${status === 'failed' ? '#fca5a5' : '#fdba74'}`,
          fontSize: '12px',
          color: status === 'failed' ? '#b91c1c' : '#c2410c',
        }}>
          {status === 'failed' && 'DuckDB engine has failed and cannot restart. Please restart the application.'}
          {status === 'degraded' && 'DuckDB engine is experiencing issues. Automatic recovery in progress.'}
          {status === 'restarting' && `DuckDB engine is restarting (attempt ${workerHealth?.restartCount ?? 0}).`}
        </div>
      )}

      {/* Main status bar */}
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 16px',
        borderTop: '1px solid #e5e7eb',
        backgroundColor: '#f9fafb',
        fontSize: '12px',
        height: '28px',
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            display: 'inline-block',
            marginRight: '6px',
            backgroundColor: getStatusColor(status),
          }} />
          <span>DuckDB: {status ?? 'loading'}</span>
          {activeCount > 0 && (
            <span style={{ marginLeft: '8px' }}>({activeCount} active)</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatusBar;
