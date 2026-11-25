# Infrastructure

The API runs as a container on Google Cloud Run, with PostgreSQL on Neon. Deployment is a job of the
CI workflow: it runs only for pushes to `main`, after every check passed.

## One-time setup

`gcp-setup.sh <PROJECT_ID>` prepares a Google Cloud project. It can be run again safely. It creates:

- an Artifact Registry repository for the images;
- a runtime service account for the API and a deploy service account for GitHub Actions;
- Workload Identity Federation restricted to the `main` branch of this repository, so no long-lived key exists;
- two empty secrets for the database connection strings;
- the Cloud Run service, public, with a placeholder image.

The values it prints are stored as GitHub Actions repository variables. None of them is a secret.

## Database roles

The migrations create two group roles that cannot log in:

| Role | May do |
|---|---|
| `wallety_app` | Read and insert. Update on sandboxes, users and accounts. No update or delete on transfers and ledger entries: the ledger is append-only for the API |
| `wallety_purge` | Read and delete, for the cleanup job |

Each environment creates its own login roles as members of these. In production, run once as the database
owner, with a generated password:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wallety_app') THEN
    CREATE ROLE wallety_app NOLOGIN;
  END IF;
END;
$$;

CREATE ROLE wallety_api LOGIN PASSWORD '<generated password>' IN ROLE wallety_app;
```

## Secrets

Both live in Secret Manager and nowhere else.

| Secret | Value | Read by |
|---|---|---|
| `wallety-database-url` | Connection string of the `wallety_api` login | The API, at runtime |
| `wallety-migration-database-url` | Connection string of the database owner | The deploy job, to apply migrations before a release |

## What a deploy does

1. Builds the image and pushes it to Artifact Registry, tagged with the commit.
2. Applies pending migrations as the database owner.
3. Releases a new Cloud Run revision that runs as the runtime service account.
4. Calls `GET /health` on the public URL and fails the job if the API cannot reach the database.
