-- Preview only. Import the split-table SQL ZIP first to create its 37 data tables.
-- This file creates only the lock-support table used by Node transactions.
-- No records are dropped or modified. Never use this setup to switch production.
CREATE TABLE IF NOT EXISTS migration_locks (
  lock_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (lock_name)
) ENGINE=InnoDB;
