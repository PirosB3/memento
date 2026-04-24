-- Enable pgcrypto for gen_random_bytes
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- AlterTable: add ordering_key nullable for backfill
ALTER TABLE "conversations" ADD COLUMN "ordering_key" UUID;

-- Backfill: derive a UUIDv7 per row from its timestamp so existing rows sort identically to id/timestamp
CREATE OR REPLACE FUNCTION pg_temp.uuidv7_from_ts(ts TIMESTAMPTZ) RETURNS UUID AS $$
DECLARE
  ms BIGINT;
  b  BYTEA;
BEGIN
  ms := (EXTRACT(EPOCH FROM ts) * 1000)::BIGINT;
  b  := substring(int8send(ms) FROM 3 FOR 6) || gen_random_bytes(10);
  b  := set_byte(b, 6, (get_byte(b, 6) & x'0F'::INT) | x'70'::INT);
  b  := set_byte(b, 8, (get_byte(b, 8) & x'3F'::INT) | x'80'::INT);
  RETURN encode(b, 'hex')::UUID;
END;
$$ LANGUAGE plpgsql;

UPDATE "conversations" SET "ordering_key" = pg_temp.uuidv7_from_ts("timestamp") WHERE "ordering_key" IS NULL;

-- AlterTable: enforce NOT NULL now that every row has a value
ALTER TABLE "conversations" ALTER COLUMN "ordering_key" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "conversations_ordering_key_key" ON "conversations"("ordering_key");
CREATE INDEX "conversations_task_id_ordering_key_idx" ON "conversations"("task_id", "ordering_key");

-- CreateTable
CREATE TABLE "turn_snapshots" (
    "task_id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turn_snapshots_pkey" PRIMARY KEY ("task_id")
);

-- AddForeignKey
ALTER TABLE "turn_snapshots" ADD CONSTRAINT "turn_snapshots_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE CASCADE ON UPDATE CASCADE;
