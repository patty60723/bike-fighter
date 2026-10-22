-- One row per batch of anger a device sent. `counted` = it passed every check
-- and the station really had no bikes (rent) or no docks (ret) at that moment.
CREATE TABLE angers (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  device  TEXT    NOT NULL,
  sid     TEXT    NOT NULL,
  type    TEXT    NOT NULL CHECK (type IN ('rent', 'ret')),
  clicks  INTEGER NOT NULL,
  level   INTEGER NOT NULL,
  counted INTEGER NOT NULL,
  avail   INTEGER,
  lat     REAL    NOT NULL,
  lng     REAL    NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX angers_station ON angers (sid, type, at);
CREATE INDEX angers_device  ON angers (device, at);

-- Stations that are empty (rent) or full (ret) right now, and since when.
CREATE TABLE empty_open (
  sid   TEXT    NOT NULL,
  type  TEXT    NOT NULL,
  name  TEXT    NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (sid, type)
);

-- Finished empty/full spells: how long they lasted and how many people were affected.
CREATE TABLE empty_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sid    TEXT    NOT NULL,
  type   TEXT    NOT NULL,
  name   TEXT    NOT NULL,
  start  INTEGER NOT NULL,
  end    INTEGER NOT NULL,
  people INTEGER NOT NULL,
  jump   INTEGER NOT NULL
);
CREATE INDEX empty_events_station ON empty_events (sid, type, end);
CREATE INDEX empty_events_end     ON empty_events (end);
