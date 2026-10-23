-- The first cron compared every station with a full read of empty_open each minute and
-- counted out-of-service stations (0 bikes and 0 docks) as empty. Start the spells over
-- under the new rules, and drop the short blips nobody was affected by.
DELETE FROM empty_open;
DELETE FROM snapshot;
DELETE FROM empty_events WHERE people = 0 AND end - start < 300000;
