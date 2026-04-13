-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "compacted_prefix" JSONB,
ADD COLUMN     "compacted_summary" TEXT,
ADD COLUMN     "compacted_through_id" INTEGER;
