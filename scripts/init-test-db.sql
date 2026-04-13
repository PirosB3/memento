-- Creates the test database alongside the dev database.
-- This file is mounted into the PostgreSQL container's docker-entrypoint-initdb.d/
-- and runs automatically on first container initialization.
CREATE DATABASE summon_test;
