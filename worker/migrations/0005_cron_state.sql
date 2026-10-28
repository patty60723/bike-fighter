-- Cut the cron's D1 writes (v1.4).
--
-- Each open/close of a spell used to cost a row in empty_open (+ its primary-key index) and,
-- on close, a row in empty_events (+ three indexes + the AUTOINCREMENT counter): about 3-8 rows
-- written per change, and with ~3,500 stations flipping between 0 and 1 all day that was most
-- of the free plan's 100,000 rows written per day.
--
-- Now the open spells live in the snapshot row the cron already rewrites every minute
-- (`open`, a JSON object "sid:type" -> [since, name]), so opening or closing a spell costs no
-- extra row. `usage` holds today's (UTC) estimated D1 usage, so the cron can slow itself down
-- before the daily limit.
ALTER TABLE snapshot ADD COLUMN open  TEXT;
ALTER TABLE snapshot ADD COLUMN usage TEXT;

-- Finished spells from now on. WITHOUT ROWID with the primary key the per-station history needs,
-- so one finished spell is one row written (two when someone was affected, for the partial index).
-- empty_events keeps the spells logged before this migration and is no longer written to.
CREATE TABLE spells (
  sid    TEXT    NOT NULL,
  type   TEXT    NOT NULL,
  end    INTEGER NOT NULL,
  start  INTEGER NOT NULL,
  name   TEXT    NOT NULL,
  people INTEGER NOT NULL,
  jump   INTEGER NOT NULL,
  PRIMARY KEY (sid, type, end)
) WITHOUT ROWID;
CREATE INDEX spells_affected ON spells (end) WHERE people > 0;
