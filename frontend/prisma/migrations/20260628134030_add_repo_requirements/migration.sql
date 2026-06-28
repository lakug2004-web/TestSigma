-- CreateTable
CREATE TABLE "repo_requirements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'url',
    "requirementCount" INTEGER NOT NULL DEFAULT 0,
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "excerpt" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repo_requirements_fullName_idx" ON "repo_requirements"("fullName");

-- CreateIndex
CREATE UNIQUE INDEX "repo_requirements_userId_fullName_key" ON "repo_requirements"("userId", "fullName");
