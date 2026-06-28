-- AlterTable
ALTER TABLE "repo_requirements" ADD COLUMN "files" JSONB NOT NULL DEFAULT '[]';
