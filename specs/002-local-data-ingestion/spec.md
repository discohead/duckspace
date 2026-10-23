# Feature Specification: Local Data Ingestion

**Feature Branch**: `002-local-data-ingestion`
**Created**: 2026-02-07
**Status**: Draft
**Input**: User description: "Phase 2: Local Data -- Enable local file ingestion, metadata catalog, and basic data grid visualization."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import a Local File (Priority: P1)

A user has a data file on their computer (CSV, Parquet, or JSON) that they want to analyze. They open Duckspace and import the file either by using a file picker dialog, dragging the file onto the application window, or dropping it into a designated import area. The system detects the file format, parses it, registers it for querying, and shows the imported table in the data catalog sidebar.

**Why this priority**: File import is the foundational interaction -- without it, no other data features work. A user must be able to get data into the system before they can browse, query, or visualize it.

**Independent Test**: Can be fully tested by importing a single CSV file and verifying it appears in the catalog with the correct column names and row count.

**Acceptance Scenarios**:

1. **Given** no data has been imported, **When** the user opens the file picker and selects a CSV file, **Then** the file is parsed, a new entry appears in the data catalog with the file's name, column count, and row count.
2. **Given** the application is open, **When** the user drags a Parquet file onto the application window, **Then** the file is registered and appears in the data catalog within 30 seconds for files under 100 MB, and within 3 seconds for files under 10 MB.
3. **Given** a JSON file with an array of records, **When** the user imports the file, **Then** the system infers column types and creates a queryable table.
4. **Given** a file with an unsupported extension (e.g., `.pdf`), **When** the user attempts to import it, **Then** the system displays a clear error message listing supported formats.
5. **Given** a CSV file with encoding issues or malformed rows, **When** the user imports the file, **Then** the system imports as many valid rows as possible and reports the number of skipped/failed rows.

---

### User Story 2 - Browse Data in a Grid (Priority: P1)

After importing a file, the user wants to explore the data visually. They click on an entry in the data catalog and see the contents displayed in an interactive data grid. The grid supports sorting columns, filtering rows, resizing columns, and scrolling through large datasets without performance degradation.

**Why this priority**: Data grid exploration is the primary value proposition for Phase 2. Users need to see their data immediately after import -- this is the core "aha moment" of the application.

**Independent Test**: Can be fully tested by importing a file, clicking it in the catalog, and verifying the grid displays correct data with working sort and filter controls.

**Acceptance Scenarios**:

1. **Given** a table with 1,000 rows is registered in the catalog, **When** the user clicks on it, **Then** the data grid opens in a new tab showing the first page of rows with all columns visible.
2. **Given** the data grid is displaying a table, **When** the user clicks a column header, **Then** the rows are sorted by that column (ascending on first click, descending on second click).
3. **Given** a table with 1 million rows, **When** the user scrolls through the grid, **Then** new rows load seamlessly without visible lag or blank regions (virtual scrolling).
4. **Given** the data grid is open, **When** the user applies a filter on a column, **Then** only matching rows are displayed and the row count updates to reflect the filtered result.
5. **Given** a table with numeric and text columns, **When** the grid renders, **Then** numeric columns are right-aligned and text columns are left-aligned with appropriate formatting.

---

### User Story 3 - View Column Statistics (Priority: P2)

After importing data, the user wants to understand data quality and distributions. They select a table in the catalog and view a summary panel showing per-column statistics: data type, null count, distinct values, and for numeric columns: min, max, mean, and median. For categorical columns, the top most-frequent values are shown.

**Why this priority**: Column statistics provide essential data profiling that users need before writing queries or building visualizations. It surfaces data quality issues (nulls, unexpected types) early.

**Independent Test**: Can be fully tested by importing a CSV with mixed column types and verifying each column shows appropriate statistics.

**Acceptance Scenarios**:

1. **Given** a table has been imported, **When** the user opens the table detail view, **Then** each column displays its data type, null count, and null percentage.
2. **Given** a numeric column exists, **When** the user views its statistics, **Then** min, max, mean, median, and standard deviation are displayed.
3. **Given** a text column with fewer than 100 distinct values, **When** the user views its statistics, **Then** the top 10 most frequent values and their counts are displayed.
4. **Given** a table with 10 million rows, **When** statistics are computed, **Then** results appear within 10 seconds and the application remains responsive during computation.

---

### User Story 4 - Watch a Folder for Automatic Ingestion (Priority: P2)

The user has a folder where data files are regularly added (e.g., daily exports from another tool). They configure Duckspace to watch this folder. When new files appear, they are automatically ingested. When existing files are modified, the catalog reflects the update. When files are deleted, the catalog marks them as removed.

**Why this priority**: Folder watching enables continuous data workflows without manual re-import. It is a differentiating feature for power users who deal with recurring data drops.

**Independent Test**: Can be fully tested by adding a watch directory in settings, dropping a CSV file into it, and verifying automatic ingestion without user interaction.

**Acceptance Scenarios**:

1. **Given** the user has configured a watch directory, **When** a new CSV file is added to that directory, **Then** the file is automatically ingested and appears in the catalog within 10 seconds.
2. **Given** a watched file has already been ingested, **When** the file is modified on disk, **Then** the catalog entry is marked as "stale" and the user is prompted to re-ingest or it re-ingests automatically (based on settings).
3. **Given** a watched file has been ingested, **When** the file is deleted from disk, **Then** the catalog entry is marked as "removed" and the user can confirm removal of the associated table.
4. **Given** the user configures a watch directory with a file type filter (e.g., only `.parquet`), **When** a `.csv` file is added to that directory, **Then** the file is ignored and no catalog entry is created.
5. **Given** a watch directory contains 50 existing files when first configured, **When** the initial scan completes, **Then** all supported files are ingested with a progress indicator showing overall progress.

---

### User Story 5 - Manage Data Sources in Catalog (Priority: P3)

The user wants to organize and manage their imported data sources. They can view all sources in the catalog sidebar, see their status (active, stale, error, removed), tag sources for organization, remove sources they no longer need, and retry failed imports.

**Why this priority**: Catalog management is essential for ongoing use but not required for the initial import-and-explore flow. It becomes important as the number of data sources grows.

**Independent Test**: Can be fully tested by importing multiple files, tagging them, removing one, and verifying the catalog reflects all changes.

**Acceptance Scenarios**:

1. **Given** multiple data sources exist, **When** the user views the catalog sidebar, **Then** all sources are listed with their name, format, row count, and status indicator.
2. **Given** a data source has status "error", **When** the user clicks the retry button, **Then** the system re-attempts ingestion and updates the status accordingly.
3. **Given** a data source exists, **When** the user removes it, **Then** the catalog entry is deleted and the associated table is dropped from the query engine.
4. **Given** multiple data sources exist, **When** the user assigns tags to sources, **Then** the catalog can be filtered by tag.

---

### Edge Cases

- What happens when the user imports a file that is currently being written to by another application? The system should wait for the file to stabilize (no writes for 2 seconds) before parsing, or report a clear "file in use" message.
- What happens when a CSV file has no header row? The system should detect headerless files and generate synthetic column names (col_1, col_2, etc.) with an option for the user to designate a header row.
- What happens when a JSON file contains deeply nested objects? Nested structures should be flattened to a configurable depth (default: 2 levels) with dot-notation column naming (e.g., `address.city`).
- What happens when two files produce tables with the same name? The system should auto-generate a unique name (e.g., appending a numeric suffix) and allow the user to rename.
- What happens when the user imports a file larger than available memory? The system should use streaming parsing and report progress. For files exceeding practical limits, the system should fall back to a lazy view that reads directly from the file on query.
- What happens when a watched directory is on a removable drive that is ejected? The system should detect the disconnection, mark all sources from that directory as "unavailable", and resume watching when the drive is reconnected.
- What happens when importing an Excel file with multiple sheets? The system imports the first sheet by default and records the sheet name in data source metadata. A sheet selection dialog is deferred to a future phase.
- What happens when a file has mixed types in a single column (e.g., numbers and strings)? The system should fall back to treating the column as text type and note this in the column statistics.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support importing local files in CSV, TSV, Parquet, JSON, JSONL, XLSX, and Arrow IPC formats.
- **FR-002**: System MUST support three file discovery methods: native file picker dialog, drag-and-drop onto the application window, and folder watching.
- **FR-003**: System MUST automatically detect file format based on file extension and validate using file content (magic bytes) when possible.
- **FR-004**: System MUST infer column names and data types from file content. Type inference sample size defaults to 20,480 rows (developer-configurable via `IngestFileOptions.sampleSize`; no user-facing UI in Phase 2).
- **FR-005**: System MUST display imported data in an interactive grid with column sorting, row filtering, column resizing, and virtual scrolling for large datasets.
- **FR-006**: System MUST compute and display per-column statistics including: data type, row count, null count/percentage, distinct value count, and (for numeric columns) min, max, mean, median, and standard deviation.
- **FR-007**: System MUST display top-N most frequent values for categorical columns (default: top 10).
- **FR-008**: System MUST support configuring one or more watch directories that automatically discover and ingest new or modified files.
- **FR-009**: System MUST maintain a metadata catalog of all imported data sources with name, format, path, row count, column count, status, and timestamps.
- **FR-010**: System MUST track data source lifecycle status: importing (ingestion in progress), active (registered and current), stale (source file modified), error (import failed), and removed (source file deleted).
- **FR-011**: System MUST allow users to remove data sources from the catalog, which drops the associated queryable table.
- **FR-012**: System MUST allow users to retry failed imports.
- **FR-013**: System MUST allow users to assign and filter by tags on data sources.
- **FR-014**: System MUST report ingestion progress for long-running imports, including rows processed and elapsed time.
- **FR-015**: System MUST allow users to cancel an in-progress import.
- **FR-016**: System MUST handle partial import failures gracefully -- individual file failures in a batch import must not block other files.
- **FR-017**: System MUST support delimiter auto-detection for CSV/TSV files (comma, tab, pipe, semicolon).
- **FR-018**: System MUST support encoding detection for text-based files (UTF-8 and Latin-1). Additional encodings (e.g., Shift-JIS, Big5) are deferred per Assumptions.

### Key Entities

- **Data Source**: A registered data file with its metadata (name, path, format, status, timestamps, tags). The primary unit of organization in the catalog.
- **Table Metadata**: Schema information for an imported table, including column names, data types, nullability, and sample values. Linked to a Data Source.
- **Column Statistics**: Per-column statistical summaries (null rate, distinct count, min/max/mean for numerics, top-N for categoricals). Linked to Table Metadata.
- **Watch Directory**: A configured folder path with settings for recursive scanning, auto-ingestion, file type filters, and exclude patterns.
- **Ingestion Job**: A single file import operation with progress tracking, cancellation support, and error reporting. May be triggered manually or by a Watch Directory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can import a 100 MB CSV file and see it in the data catalog within 30 seconds on a standard laptop.
- **SC-002**: Users can scroll through a 10-million-row dataset in the data grid at 60 frames per second with no visible blank regions during normal scrolling.
- **SC-003**: Column statistics for a 1-million-row table are computed and displayed within 5 seconds.
- **SC-004**: 95% of import attempts for valid files (files that open without errors in their canonical viewer/parser) in supported formats succeed on the first try without user intervention.
- **SC-005**: Folder watch detects new files and completes ingestion within 10 seconds of the file being fully written.
- **SC-006**: Users can sort and filter a 1-million-row table in the data grid and see updated results within 2 seconds.
- **SC-007**: The application remains responsive (UI does not freeze) during all import and statistics computation operations.
- **SC-008**: Users can successfully import and explore data from all five core formats (CSV, Parquet, JSON, XLSX, Arrow IPC) through a consistent workflow.

## Assumptions

- **Phase 1 foundation**: The Electron shell, worker thread architecture, Arrow IPC data plane, and basic query execution infrastructure from Phase 1 are complete and operational.
- **Single-user, local-only**: All data operations are local file system operations. No network access, cloud storage, or multi-user scenarios are in scope.
- **macOS primary target**: The application targets macOS as the primary platform. File system watching uses native macOS file system events for efficiency.
- **Data size expectations**: The typical user works with files ranging from 1 KB to 10 GB. Files exceeding available system memory are handled via lazy views or streaming, not full in-memory loading.
- **Excel scope**: XLSX support covers basic tabular data. Complex Excel features (formulas, macros, charts, conditional formatting) are out of scope -- only cell values are imported.
- **Encoding scope**: UTF-8 and Latin-1 encoding detection covers the majority of user files. Support for additional encodings (e.g., Shift-JIS, Big5) is deferred.
- **Embedding generation**: Schema embedding generation (for AI search) is mentioned in design documents but is deferred to a later phase focused on AI integration. This specification covers metadata catalog and statistics only.
- **Dashboard composition**: Full dashboard creation with multiple visualization panels, cross-filtering, and layout management is deferred to a later phase. Phase 2 provides a single data grid view per imported table.

## Scope Boundaries

**In Scope:**
- File import via picker, drag-and-drop, and folder watch
- CSV, TSV, Parquet, JSON, JSONL, XLSX, and Arrow IPC format support
- Data catalog sidebar with source listing and status
- Interactive data grid with sort, filter, and virtual scrolling
- Column statistics computation and display
- Watch directory configuration and automatic ingestion
- Source management (remove, retry, tag)
- Import progress reporting and cancellation

**Out of Scope:**
- Remote data sources (HTTP, S3, databases) -- deferred to Remote Connectors phase
- AI-powered schema search and embedding generation -- deferred to AI Integration phase
- Dashboard composition with multiple panels and cross-filtering -- deferred to Dashboard phase
- Data export (CSV, Parquet, etc.) -- deferred to Publishing phase
- Query editor for writing custom SQL -- deferred to Query Editor phase
- Chart visualizations (line, bar, scatter, etc.) -- deferred to Visualization phase
