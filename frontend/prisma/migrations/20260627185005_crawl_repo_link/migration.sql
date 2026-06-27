/*
  Warnings:

  - Added the required column `fullName` to the `crawl_run` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "crawl_run_userId_idx";

-- AlterTable
ALTER TABLE "crawl_run" ADD COLUMN     "fullName" TEXT NOT NULL,
ADD COLUMN     "routes" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "crawl_run_userId_fullName_idx" ON "crawl_run"("userId", "fullName");
