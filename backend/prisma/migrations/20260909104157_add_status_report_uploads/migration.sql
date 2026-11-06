-- CreateTable
CREATE TABLE "status_report_uploads" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "type" "StatusReportType" NOT NULL,
    "report_date" TIMESTAMP(3) NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "stored_path" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_report_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_report_uploads_org_id_type_idx" ON "status_report_uploads"("org_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "status_report_uploads_org_id_type_report_date_key" ON "status_report_uploads"("org_id", "type", "report_date");

-- AddForeignKey
ALTER TABLE "status_report_uploads" ADD CONSTRAINT "status_report_uploads_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_report_uploads" ADD CONSTRAINT "status_report_uploads_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
