-- CreateTable
CREATE TABLE "crawl_run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "screenCount" INTEGER NOT NULL DEFAULT 0,
    "edges" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_screen" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "screenId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "authenticated" BOOLEAN NOT NULL DEFAULT false,
    "screenshotUrl" TEXT NOT NULL DEFAULT '',
    "interactiveCount" INTEGER NOT NULL DEFAULT 0,
    "artifacts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_screen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crawl_run_runId_key" ON "crawl_run"("runId");

-- CreateIndex
CREATE INDEX "crawl_run_userId_idx" ON "crawl_run"("userId");

-- CreateIndex
CREATE INDEX "crawl_screen_runId_idx" ON "crawl_screen"("runId");

-- AddForeignKey
ALTER TABLE "crawl_screen" ADD CONSTRAINT "crawl_screen_runId_fkey" FOREIGN KEY ("runId") REFERENCES "crawl_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
