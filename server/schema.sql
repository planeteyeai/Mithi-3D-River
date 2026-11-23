-- Mithi component history — deduped by project + component + date + kml type.
-- Fast latest lookups via composite indexes.

CREATE TABLE IF NOT EXISTS component_history (
  id              BIGSERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL DEFAULT 'mithi',
  component_type  TEXT NOT NULL,
  data_date       DATE NOT NULL,
  kml_type        TEXT NOT NULL DEFAULT 'default',
  fingerprint     TEXT NOT NULL,
  payload         JSONB NOT NULL,
  kml_refs        JSONB,
  source          TEXT NOT NULL DEFAULT 'jalnetra-live',
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same day + same component + same KML type → no duplicate row.
-- Named constraint so ON CONFLICT (project_id, component_type, data_date, kml_type) works.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_component_history_day_type'
  ) THEN
    ALTER TABLE component_history
      ADD CONSTRAINT uq_component_history_day_type
      UNIQUE (project_id, component_type, data_date, kml_type);
  END IF;
END $$;

-- Latest retrieval: ORDER BY data_date DESC, fetched_at DESC
CREATE INDEX IF NOT EXISTS idx_component_history_latest
  ON component_history (project_id, component_type, data_date DESC, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_component_history_fingerprint
  ON component_history (project_id, component_type, fingerprint);

COMMENT ON TABLE component_history IS
  'Cached JalNetra payloads (geology, bank-erosion, LULC, WQ suite, etc). Deduped per calendar day + kml_type.';

COMMENT ON COLUMN component_history.component_type IS
  'JalNetra id: lithology | bank-erosion | lulc | salinity | water-quality | water-depth | eutrophication | nitrogen | coliform | main-bod-cod | streams-bod-cod | vegetation-* | …';
