-- CreateTable
CREATE TABLE "pr_review" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'open',
    "url" TEXT NOT NULL DEFAULT '',
    "headSha" TEXT NOT NULL DEFAULT '',
    "baseRef" TEXT NOT NULL DEFAULT '',
    "headRef" TEXT NOT NULL DEFAULT '',
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "verdict" TEXT NOT NULL DEFAULT '',
    "risk" TEXT NOT NULL DEFAULT '',
    "goodEnough" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT NOT NULL DEFAULT '',
    "blastRadius" JSONB NOT NULL DEFAULT '{}',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pr_review_fullName_idx" ON "pr_review"("fullName");

-- CreateIndex
CREATE UNIQUE INDEX "pr_review_fullName_prNumber_key" ON "pr_review"("fullName", "prNumber");
