/*
  Warnings:

  - A unique constraint covering the columns `[number]` on the table `tickets` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "number" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");
