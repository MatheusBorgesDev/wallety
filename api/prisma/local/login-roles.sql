-- Local and CI only. Creates the login role the API uses in docker-compose and makes it a
-- member of the wallety_app group role created by the migrations. The password is a local
-- default, not a secret. Production login roles are created by hand; see infra/README.md.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_api') THEN
    CREATE ROLE wallety_api LOGIN PASSWORD 'wallety_api';
  END IF;
END;
$$;

GRANT wallety_app TO wallety_api;
