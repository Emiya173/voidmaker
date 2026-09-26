CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_items (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  prompt text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','queued','running','awaiting_permission','cancelling','completed','failed','cancelled','interrupted')),
  attempt_id uuid,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_attempts (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','awaiting_permission','cancelling','completed','failed','cancelled','interrupted')),
  thread_id text,
  turn_id text,
  result text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE work_items ADD CONSTRAINT work_current_attempt FOREIGN KEY(attempt_id) REFERENCES work_attempts(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE work_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES work_attempts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_approvals (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES work_attempts(id) ON DELETE CASCADE,
  description text NOT NULL,
  decision text CHECK (decision IN ('accept','decline','expired')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE TABLE work_artifacts (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES work_attempts(id) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  kind text NOT NULL,
  UNIQUE(attempt_id, path)
);
CREATE INDEX work_queue ON work_items(status, updated_at);
CREATE INDEX work_attempt_history ON work_attempts(work_id, started_at);
CREATE INDEX work_event_history ON work_events(work_id, id);
CREATE INDEX work_approval_pending ON work_approvals(work_id) WHERE decision IS NULL;
CREATE INDEX work_artifact_history ON work_artifacts(work_id);
