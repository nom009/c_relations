-- EPC Task Graph API: Azure SQL スキーマ（参照用）。
-- API は初回利用時に同じ DDL を冪等に自動実行する（src/store/schema.ts）。変更時は両方を更新すること。

IF OBJECT_ID(N'dbo.projects', N'U') IS NULL
CREATE TABLE dbo.projects (
  id NVARCHAR(64) NOT NULL CONSTRAINT PK_projects PRIMARY KEY,
  name NVARCHAR(MAX) NOT NULL,
  description NVARCHAR(MAX) NOT NULL,
  dataDate NVARCHAR(32) NOT NULL,
  calendarId NVARCHAR(MAX) NOT NULL,
  schemaVersion INT NOT NULL,
  version INT NOT NULL,
  metaVersion INT NOT NULL,
  calendars NVARCHAR(MAX) NOT NULL,
  savedViews NVARCHAR(MAX) NOT NULL,
  createdAt NVARCHAR(MAX) NOT NULL,
  updatedAt NVARCHAR(64) NOT NULL,
  updatedBy NVARCHAR(320) NOT NULL
)
GO

IF OBJECT_ID(N'dbo.tasks', N'U') IS NULL
CREATE TABLE dbo.tasks (
  projectId NVARCHAR(64) NOT NULL,
  id NVARCHAR(64) NOT NULL,
  data NVARCHAR(MAX) NOT NULL,
  rev INT NOT NULL,
  changedVersion INT NOT NULL,
  CONSTRAINT PK_tasks PRIMARY KEY (projectId, id),
  INDEX ix_tasks_changed NONCLUSTERED (projectId, changedVersion)
)
GO

IF OBJECT_ID(N'dbo.dependencies', N'U') IS NULL
CREATE TABLE dbo.dependencies (
  projectId NVARCHAR(64) NOT NULL,
  id NVARCHAR(64) NOT NULL,
  data NVARCHAR(MAX) NOT NULL,
  rev INT NOT NULL,
  changedVersion INT NOT NULL,
  CONSTRAINT PK_dependencies PRIMARY KEY (projectId, id),
  INDEX ix_dependencies_changed NONCLUSTERED (projectId, changedVersion)
)
GO

IF OBJECT_ID(N'dbo.tombstones', N'U') IS NULL
CREATE TABLE dbo.tombstones (
  projectId NVARCHAR(64) NOT NULL,
  entity CHAR(4) NOT NULL,
  id NVARCHAR(64) NOT NULL,
  version INT NOT NULL,
  CONSTRAINT PK_tombstones PRIMARY KEY (projectId, entity, id),
  INDEX ix_tombstones_version NONCLUSTERED (projectId, version)
)
GO

IF OBJECT_ID(N'dbo.members', N'U') IS NULL
CREATE TABLE dbo.members (
  projectId NVARCHAR(64) NOT NULL,
  email NVARCHAR(320) NOT NULL,
  role NVARCHAR(16) NOT NULL,
  userId NVARCHAR(128) NULL,
  name NVARCHAR(MAX) NULL,
  addedAt NVARCHAR(64) NOT NULL,
  addedBy NVARCHAR(320) NOT NULL,
  CONSTRAINT PK_members PRIMARY KEY (projectId, email),
  INDEX ix_members_email NONCLUSTERED (email)
)
GO

IF OBJECT_ID(N'dbo.user_view_state', N'U') IS NULL
CREATE TABLE dbo.user_view_state (
  projectId NVARCHAR(64) NOT NULL,
  userId NVARCHAR(128) NOT NULL,
  viewState NVARCHAR(MAX) NOT NULL,
  CONSTRAINT PK_user_view_state PRIMARY KEY (projectId, userId)
)
GO

IF OBJECT_ID(N'dbo.snapshots', N'U') IS NULL
CREATE TABLE dbo.snapshots (
  seq INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_snapshots PRIMARY KEY,
  projectId NVARCHAR(64) NOT NULL,
  createdAt NVARCHAR(64) NOT NULL,
  label NVARCHAR(64) NOT NULL,
  taskCount INT NOT NULL,
  doc NVARCHAR(MAX) NOT NULL,
  INDEX ix_snapshots_project NONCLUSTERED (projectId, seq)
)
GO
