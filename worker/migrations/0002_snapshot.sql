-- The merged station list, refreshed by the cron every minute, so /stations
-- doesn't have to wait on the two city servers.
CREATE TABLE snapshot (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  body    TEXT    NOT NULL,
  updated INTEGER NOT NULL
);
