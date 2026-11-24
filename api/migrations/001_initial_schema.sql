-- 001: the five collections as relational tables (spec §3.2), plus sessions (§3.1).
-- Runs inside one transaction (api/src/migrate.ts); schema_migrations is created by the runner.
--
-- How a wire document maps onto a row (api/src/schema.ts does the translation):
--   - `_id.$oid` is the primary key, char(24): wire ids never change.
--   - Each known field has a typed column. NULL means "field absent", never "null": the front end
--     tells the two apart (D13), so a value that does not fit its column (an explicit null, a string
--     where a number belongs, an id that is not 24-hex) is kept in `extra` under its own name instead.
--   - `extra` (jsonb) also keeps every field the schema does not know (Q-p5-9 (c)): MongoLab stored
--     whatever was sent, and a PUT replaces the whole document.
--   - `seq` is the insertion order. The in-memory store answered in array order and a PUT kept a
--     document's place; ORDER BY seq does the same (an UPDATE never changes seq).
--   - List fields (teamMembers, sprintBacklog) are join tables with a position, so order and
--     duplicates survive. `has_*` tells an empty list from an absent one (D13: "Legacy Cleanup" has no
--     teamMembers at all, and the front end must still see it absent).
--
-- Numbers are double precision: they are JavaScript numbers on the wire, MongoDB stored them as
-- doubles, and the legacy forms never limited them to integers. Dates (sprint start/end) are text:
-- the wire carries strings, and a date column would rewrite or reject what the form sent.
--
-- DEV-p5-store-01: no foreign keys between documents. MongoDB never enforced references and the
-- front end relies on that: deleting a backlog item, sprint, user or project leaves the documents that
-- point at it unchanged (dangling), and the seed itself has a sprint that references a deleted backlog
-- item (D13). A foreign key would turn those deletes into errors (RESTRICT) or silent extra deletes
-- (CASCADE). The only foreign keys are from a join table to the document that owns the list.

CREATE SEQUENCE wire_id_counter START 1; -- new `_id`s: 'f' + 23 hex digits (AC-STUB-15)

CREATE TABLE users (
  id         char(24) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  seq        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  email      text,
  password   text, -- plain text for now, as in the stub; p5-security hashes it (S-p5-1)
  first_name text,
  last_name  text,
  admin      boolean,
  extra      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX users_email ON users (email);

CREATE TABLE projects (
  id               char(24) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  name             text,
  description      text,
  product_owner    char(24) CHECK (product_owner ~ '^[0-9a-f]{24}$'),
  scrum_master     char(24) CHECK (scrum_master ~ '^[0-9a-f]{24}$'),
  has_team_members boolean NOT NULL DEFAULT false,
  extra            jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE project_team_members (
  project_id char(24) NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  position   integer NOT NULL,
  user_id    char(24) NOT NULL CHECK (user_id ~ '^[0-9a-f]{24}$'), -- no FK: DEV-p5-store-01
  PRIMARY KEY (project_id, position)
);

CREATE TABLE backlog_items (
  id          char(24) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id  char(24) CHECK (project_id ~ '^[0-9a-f]{24}$'),
  name        text,
  description text,
  priority    double precision,
  estimation  double precision,
  extra       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX backlog_items_project_id ON backlog_items (project_id);

CREATE TABLE sprints (
  id                 char(24) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  seq                bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id         char(24) CHECK (project_id ~ '^[0-9a-f]{24}$'),
  name               text,
  capacity           double precision,
  start_on           text,
  end_on             text,
  has_sprint_backlog boolean NOT NULL DEFAULT false,
  extra              jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX sprints_project_id ON sprints (project_id);

CREATE TABLE sprint_backlog_items (
  sprint_id       char(24) NOT NULL REFERENCES sprints (id) ON DELETE CASCADE,
  position        integer NOT NULL,
  -- Deliberately NO foreign key to backlog_items (spec §3.2, D13, DEV-p5-store-01): a sprint keeps
  -- the id of a backlog item that was deleted, the seed contains one, and the sprint screens handle it.
  backlog_item_id char(24) NOT NULL CHECK (backlog_item_id ~ '^[0-9a-f]{24}$'),
  PRIMARY KEY (sprint_id, position)
);

CREATE TABLE tasks (
  id                      char(24) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{24}$'),
  seq                     bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id              char(24) CHECK (project_id ~ '^[0-9a-f]{24}$'),
  sprint_id               char(24) CHECK (sprint_id ~ '^[0-9a-f]{24}$'),
  product_backlog_item_id char(24) CHECK (product_backlog_item_id ~ '^[0-9a-f]{24}$'),
  name                    text,
  description             text,
  estimation              double precision,
  remaining               double precision,
  state                   text, -- no CHECK: the wire never restricted it, and a PUT must store what it got
  assigned_user_id        char(24) CHECK (assigned_user_id ~ '^[0-9a-f]{24}$'),
  extra                   jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX tasks_sprint_id ON tasks (sprint_id);
CREATE INDEX tasks_project_id ON tasks (project_id);

CREATE TABLE sessions (
  sid        text PRIMARY KEY,
  xsrf       text NOT NULL,
  user_id    char(24), -- no FK: a deleted user's session simply reads as anonymous, as in the stub
  created_at timestamptz NOT NULL DEFAULT now()
);
