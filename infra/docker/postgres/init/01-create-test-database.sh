#!/bin/sh
# Runs once, on first initialisation of an empty data volume.
# Creates a separate database for integration tests so they never touch development data.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v test_db="${WORKBOX_TEST_DB:-workbox_test}" <<'SQL'
SELECT format('CREATE DATABASE %I', :'test_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'test_db')\gexec
SQL
