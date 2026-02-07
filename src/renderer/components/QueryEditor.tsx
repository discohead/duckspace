import React, { useState, useEffect, useCallback } from 'react';
import { useActiveTab } from '../stores/hooks';
import db from '../stores/db';
import type { QueryStatusEvent, Tab, QueryTabState } from '@shared/types';

/** Debounce timer ref for saving SQL to Dexie. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export default function QueryEditor() {
  const activeTab = useActiveTab();

  const [sql, setSql] = useState('');
  const [queryId, setQueryId] = useState<string | null>(null);
  const [status, setStatus] = useState<QueryStatusEvent | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );

  // Sync SQL from active tab state when tab changes
  useEffect(() => {
    if (activeTab && activeTab.type === 'query') {
      const tabState = activeTab.state as QueryTabState;
      setSql(tabState.sql ?? '');
    }
  }, [activeTab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce-save SQL to Dexie when local state changes
  const debounceSaveSql = useCallback(
    (value: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (activeTab) {
          db.tabs.update(activeTab.id, {
            'state.sql': value,
          } as Partial<Tab>);
        }
      }, 250);
    },
    [activeTab?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const handleSqlChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setSql(value);
      debounceSaveSql(value);
    },
    [debounceSaveSql],
  );

  // Subscribe to query status updates
  useEffect(() => {
    const unsubscribe = window.datspace.query.onStatus(
      (statusEvent: QueryStatusEvent) => {
        if (queryId && statusEvent.queryId === queryId) {
          setStatus(statusEvent);
        }
      },
    );
    return unsubscribe;
  }, [queryId]);

  // Subscribe to query data when executing
  useEffect(() => {
    if (!queryId || !isExecuting) return;

    const unsubscribe = window.datspace.query.onData(queryId, (batch) => {
      // Fire custom event so ResultGrid can listen
      window.dispatchEvent(
        new CustomEvent('datspace:arrow-batch', {
          detail: batch,
        }),
      );

      // When stream ends (last batch), update Dexie record
      if (batch.isLast) {
        setIsExecuting(false);
        setQueryId(null);
        db.queries.update(queryId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
      }
    });

    return unsubscribe;
  }, [queryId, isExecuting]);

  const handleExecute = useCallback(async () => {
    if (!activeTab || !sql.trim()) return;

    setError(null);
    setStatus(null);
    setIsExecuting(true);

    try {
      const result = await window.datspace.query.execute(sql);
      setQueryId(result.queryId);

      // Create Dexie query record (T044)
      await db.queries.add({
        id: result.queryId,
        tabId: activeTab.id,
        sql,
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      setIsExecuting(false);
      const ipcError = err as { code?: string; message?: string };
      setError({
        code: ipcError.code ?? 'E9999',
        message: ipcError.message ?? 'Unknown error executing query',
      });
    }
  }, [activeTab, sql]);

  const handleCancel = useCallback(async () => {
    if (!queryId) return;

    try {
      await window.datspace.query.cancel(queryId);
      setIsExecuting(false);
      await db.queries.update(queryId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      setQueryId(null);
    } catch (err: unknown) {
      const ipcError = err as { code?: string; message?: string };
      setError({
        code: ipcError.code ?? 'E9999',
        message: ipcError.message ?? 'Failed to cancel query',
      });
    }
  }, [queryId]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: 16,
        gap: 12,
      }}
    >
      <textarea
        value={sql}
        onChange={handleSqlChange}
        placeholder="Enter SQL query..."
        style={{
          flex: 1,
          minHeight: 120,
          fontFamily: 'monospace',
          fontSize: 14,
          padding: 12,
          border: '1px solid #d1d5db',
          borderRadius: 6,
          resize: 'vertical',
        }}
      />

      {/* Toolbar row */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <button
          onClick={handleExecute}
          disabled={isExecuting || !sql.trim()}
          style={{
            padding: '6px 16px',
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: isExecuting || !sql.trim() ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            opacity: isExecuting || !sql.trim() ? 0.6 : 1,
          }}
        >
          Execute
        </button>

        {isExecuting && (
          <button
            onClick={handleCancel}
            style={{
              padding: '6px 16px',
              backgroundColor: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
        )}

        {/* Status display */}
        {status && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            {status.phase} &mdash; {status.elapsedMs}ms
            {status.batchesStreamed > 0 &&
              ` | ${status.batchesStreamed} batch${status.batchesStreamed !== 1 ? 'es' : ''} streamed`}
          </span>
        )}
      </div>

      {/* Error panel */}
      {error && (
        <div
          style={{
            padding: 12,
            backgroundColor: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: 6,
            color: '#b91c1c',
            fontSize: 13,
          }}
        >
          <strong>[{error.code}]</strong> {error.message}
        </div>
      )}
    </div>
  );
}
