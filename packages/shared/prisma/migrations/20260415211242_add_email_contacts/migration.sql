-- CreateTable
CREATE TABLE "email_contacts" (
    "id" SERIAL NOT NULL,
    "inbox_id" TEXT NOT NULL,
    "email_address" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_contacts_inbox_id_email_address_idx" ON "email_contacts"("inbox_id", "email_address");

-- CreateIndex
CREATE UNIQUE INDEX "email_contacts_inbox_id_email_address_key" ON "email_contacts"("inbox_id", "email_address");
