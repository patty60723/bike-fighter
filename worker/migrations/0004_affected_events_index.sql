-- /events lists spells where someone was affected (people > 0), newest first.
-- With only the (end) index, SQLite walks every spell nobody was affected by to find them;
-- this partial index holds just the affected ones, so the query reads about as many rows as it returns.
CREATE INDEX empty_events_affected ON empty_events (end) WHERE people > 0;
