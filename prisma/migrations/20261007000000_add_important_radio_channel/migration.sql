ALTER TABLE "Channel" ADD COLUMN "isImportant" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Channel_one_important" ON "Channel" ("isImportant") WHERE "isImportant" = true;
