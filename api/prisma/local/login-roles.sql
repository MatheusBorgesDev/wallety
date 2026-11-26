-- Local and CI only. Creates the login roles used in docker-compose and in the tests, and
-- makes each one a member of the matching group role created by the migrations. The
-- passwords are local defaults, not secrets. Production login roles are created by hand;
-- see infra/README.md.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_api') THEN
    CREATE ROLE wallety_api LOGIN PASSWORD 'wallety_api';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_dispatcher') THEN
    CREATE ROLE wallety_dispatcher LOGIN PASSWORD 'wallety_dispatcher';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_purger') THEN
    CREATE ROLE wallety_purger LOGIN PASSWORD 'wallety_purger';
  END IF;
END;
$$;

GRANT wallety_app TO wallety_api;
GRANT wallety_dispatch TO wallety_dispatcher;
GRANT wallety_purge TO wallety_purger;
