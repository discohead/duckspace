import React, { useState } from 'react';
import { useCatalogEntries, useColumnSchemas } from '../stores/hooks';
import type { CatalogEntry, ColumnSchemaRecord } from '@shared/types';

/** Type badge color mapping */
const typeBadgeStyles: Record<CatalogEntry['type'], React.CSSProperties> = {
  table: {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: '3px',
    fontSize: '10px',
    fontWeight: 500,
    backgroundColor: '#dbeafe',
    color: '#1d4ed8',
  },
  view: {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: '3px',
    fontSize: '10px',
    fontWeight: 500,
    backgroundColor: '#fef3c7',
    color: '#92400e',
  },
};

/** Inner component that renders column schemas for the selected entry */
const ColumnSchemaTable: React.FC<{ entry: CatalogEntry }> = ({ entry }) => {
  const columns = useColumnSchemas(entry.id);

  const handlePreview = (): void => {
    window.datspace.catalog.previewTable(entry.name);
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
      <h2
        style={{
          fontSize: '18px',
          fontWeight: 600,
          color: '#1f2937',
          marginBottom: '16px',
          marginTop: 0,
        }}
      >
        {entry.name}
      </h2>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Column', 'DuckDB Type', 'Arrow Type', 'Nullable'].map(
              (header) => (
                <th
                  key={header}
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#6b7280',
                    borderBottom: '2px solid #e5e7eb',
                    textTransform: 'uppercase',
                  }}
                >
                  {header}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {columns?.map((col: ColumnSchemaRecord) => (
            <tr key={col.id}>
              <td
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                {col.columnName}
              </td>
              <td
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                {col.columnType}
              </td>
              <td
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                {col.arrowType}
              </td>
              <td
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                <span
                  style={
                    col.nullable
                      ? {
                          padding: '1px 4px',
                          borderRadius: '2px',
                          fontSize: '10px',
                          backgroundColor: '#fef2f2',
                          color: '#dc2626',
                        }
                      : {
                          padding: '1px 4px',
                          borderRadius: '2px',
                          fontSize: '10px',
                          backgroundColor: '#f0fdf4',
                          color: '#16a34a',
                        }
                  }
                >
                  {col.nullable ? 'YES' : 'NO'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button
        onClick={handlePreview}
        style={{
          padding: '6px 16px',
          backgroundColor: '#3b82f6',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '13px',
          marginTop: '16px',
        }}
      >
        Preview
      </button>
    </div>
  );
};

const CatalogBrowser: React.FC = () => {
  const entries = useCatalogEntries();
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const selectedEntry = entries?.find(
    (e: CatalogEntry) => e.id === selectedEntryId,
  );

  // Empty state: no tables registered
  if (entries !== undefined && entries.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flex: 1,
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#6b7280',
          fontSize: '14px',
        }}
      >
        No tables registered. Execute CREATE TABLE or import data.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, height: '100%' }}>
      {/* Left panel - Table list */}
      <div
        style={{
          width: '280px',
          borderRight: '1px solid #e5e7eb',
          overflowY: 'auto',
          padding: 0,
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            fontWeight: 600,
            fontSize: '14px',
            borderBottom: '1px solid #e5e7eb',
            color: '#374151',
          }}
        >
          Tables
        </div>
        {entries?.map((entry: CatalogEntry) => {
          const isSelected = entry.id === selectedEntryId;
          return (
            <div
              key={entry.id}
              onClick={() => setSelectedEntryId(entry.id)}
              style={{
                padding: '10px 16px',
                cursor: 'pointer',
                borderBottom: '1px solid #f3f4f6',
                backgroundColor: isSelected ? '#eff6ff' : undefined,
                borderLeft: isSelected
                  ? '3px solid #3b82f6'
                  : '3px solid transparent',
              }}
            >
              <div
                style={{ fontWeight: 500, fontSize: '13px', color: '#1f2937' }}
              >
                {entry.name}{' '}
                <span style={typeBadgeStyles[entry.type]}>{entry.type}</span>
              </div>
              <div
                style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}
              >
                {entry.rowCount.toLocaleString()} rows &middot;{' '}
                {entry.columnCount} columns
              </div>
            </div>
          );
        })}
      </div>

      {/* Right panel - Table detail */}
      {selectedEntry ? (
        <ColumnSchemaTable entry={selectedEntry} />
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#6b7280',
            fontSize: '14px',
          }}
        >
          Select a table to view its schema
        </div>
      )}
    </div>
  );
};

export default CatalogBrowser;
