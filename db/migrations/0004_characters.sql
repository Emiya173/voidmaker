CREATE TABLE character_sessions (
  character_id text NOT NULL,
  revision text NOT NULL,
  session_id uuid NOT NULL UNIQUE REFERENCES sessions(id),
  PRIMARY KEY (character_id, revision)
);
CREATE TABLE character_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  selected_id text NOT NULL
);
