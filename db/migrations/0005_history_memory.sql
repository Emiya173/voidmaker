CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  character_id text NOT NULL,
  character_revision text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chat_sessions(id,character_id,character_revision,title,created_at)
SELECT c.session_id,c.character_id,c.revision,'原有对话',s.created_at
FROM character_sessions c JOIN sessions s ON s.id=c.session_id;
CREATE INDEX chat_sessions_scope_idx ON chat_sessions(character_id,character_revision,created_at,id);
CREATE TABLE memories (
  id uuid PRIMARY KEY,
  character_id text NOT NULL,
  character_revision text NOT NULL,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual' CHECK (source='manual'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_scope_idx ON memories(character_id,character_revision,session_id);
