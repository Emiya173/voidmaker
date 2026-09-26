CREATE TABLE desktop_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  policy jsonb NOT NULL,
  grants jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE desktop_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  source text CHECK(source IN ('window','media','region')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Only permission/action metadata belongs here. Raw screenshots and window/media text stay ephemeral.
