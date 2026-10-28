-- Preview only. This is a NEW target schema, NOT a user-data export.
-- Run only on an empty, dedicated MySQL 8 database. No DROP/DELETE is used.
-- Credentials belong in the host's private environment, never in SQL or Git.
CREATE TABLE document_store (
  collection VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  doc_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  document JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (collection, doc_id)
) ENGINE=InnoDB;

CREATE TABLE migration_locks (
  lock_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (lock_name)
) ENGINE=InnoDB;
