export type LibraryMigration = { version: number; sql: string };

// Version 1 is deliberately additive and has no destructive down migration.
export const libraryMigrations: readonly LibraryMigration[] = [{
  version: 1,
  sql: `
    CREATE TABLE accounts (
      account_id INTEGER PRIMARY KEY,
      wallet TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('STUDENT', 'LIBRARIAN')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TRIGGER trg_library_account_identity_immutable
      BEFORE UPDATE OF wallet, role ON accounts
      BEGIN SELECT RAISE(ABORT, 'LIBRARY_ACCOUNT_IDENTITY_IMMUTABLE'); END;

    CREATE TABLE books (
      book_id TEXT PRIMARY KEY,
      isbn TEXT,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      author TEXT NOT NULL CHECK (length(trim(author)) > 0),
      replacement_price_wei TEXT NOT NULL CHECK (replacement_price_wei <> '' AND replacement_price_wei NOT GLOB '*[^0-9]*'),
      deposit_wei TEXT NOT NULL CHECK (deposit_wei <> '' AND deposit_wei NOT GLOB '*[^0-9]*'),
      seed_version INTEGER NOT NULL CHECK (seed_version >= 1),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TRIGGER trg_library_book_terms_immutable
      BEFORE UPDATE OF book_id, deposit_wei, replacement_price_wei, seed_version ON books
      BEGIN SELECT RAISE(ABORT, 'LIBRARY_BOOK_TERMS_IMMUTABLE'); END;

    CREATE TABLE book_copies (
      copy_id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(book_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      barcode TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'PENDING_APPROVAL', 'ON_LOAN', 'RETURN_REVIEW', 'MAINTENANCE', 'LOST')),
      created_at INTEGER NOT NULL,
      UNIQUE (copy_id, book_id)
    ) STRICT;
    CREATE INDEX ix_library_copies_book_status ON book_copies(book_id, status, barcode);

    CREATE TABLE borrow_requests (
      request_id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      book_id TEXT NOT NULL REFERENCES books(book_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      copy_id TEXT REFERENCES book_copies(copy_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('AWAITING_DEPOSIT', 'PENDING_APPROVAL', 'REJECTED_NO_COPY', 'REJECTED', 'EXPIRED_REFUND_DUE', 'APPROVED', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING', 'RETURNED', 'LOST_SHORTFALL_DUE', 'LOST_SETTLED')),
      refund_status TEXT NOT NULL CHECK (refund_status IN ('NONE', 'REFUND_DUE', 'REFUNDED')),
      deposit_wei TEXT CHECK (deposit_wei IS NULL OR (deposit_wei <> '' AND deposit_wei NOT GLOB '*[^0-9]*')),
      approval_deadline INTEGER,
      chain_id INTEGER CHECK (chain_id IS NULL OR chain_id = 20261),
      contract_address TEXT,
      deposit_tx_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (account_id, idempotency_key),
      FOREIGN KEY (copy_id, book_id) REFERENCES book_copies(copy_id, book_id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) STRICT;
    CREATE UNIQUE INDEX uq_library_request_copy_book_account ON borrow_requests(request_id, book_id, account_id, copy_id);
    CREATE UNIQUE INDEX uq_library_active_copy_allocation ON borrow_requests(copy_id)
      WHERE copy_id IS NOT NULL AND status IN ('PENDING_APPROVAL', 'APPROVED', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING', 'LOST_SHORTFALL_DUE');
    CREATE INDEX ix_library_requests_queue ON borrow_requests(status, approval_deadline, created_at);
    CREATE INDEX ix_library_requests_account ON borrow_requests(account_id, created_at DESC);

    CREATE TABLE loans (
      loan_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES borrow_requests(request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      book_id TEXT NOT NULL REFERENCES books(book_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      copy_id TEXT NOT NULL REFERENCES book_copies(copy_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING', 'RETURNED', 'LOST_SHORTFALL_DUE', 'LOST_SETTLED')),
      deposit_wei TEXT NOT NULL CHECK (deposit_wei <> '' AND deposit_wei NOT GLOB '*[^0-9]*'),
      replacement_price_wei TEXT NOT NULL CHECK (replacement_price_wei <> '' AND replacement_price_wei NOT GLOB '*[^0-9]*'),
      policy_json TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      return_requested_at INTEGER,
      return_received_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (loan_id = request_id),
      FOREIGN KEY (request_id, book_id, account_id, copy_id)
        REFERENCES borrow_requests(request_id, book_id, account_id, copy_id) ON UPDATE RESTRICT ON DELETE RESTRICT
    ) STRICT;
    CREATE UNIQUE INDEX uq_library_active_loan_copy ON loans(copy_id)
      WHERE status IN ('ACTIVE', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING', 'LOST_SHORTFALL_DUE');
    CREATE INDEX ix_library_loans_account ON loans(account_id, status, due_at);

    CREATE TABLE chain_events (
      event_id INTEGER PRIMARY KEY,
      chain_id INTEGER NOT NULL CHECK (chain_id = 20261),
      contract_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL CHECK (log_index >= 0),
      block_number INTEGER NOT NULL CHECK (block_number >= 0),
      block_hash TEXT NOT NULL,
      event_name TEXT NOT NULL,
      request_id TEXT NOT NULL REFERENCES borrow_requests(request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      UNIQUE (chain_id, contract_address, tx_hash, log_index)
    ) STRICT;
    CREATE INDEX ix_library_events_request ON chain_events(request_id, block_number, log_index);
    CREATE TRIGGER trg_library_chain_events_no_update
      BEFORE UPDATE ON chain_events
      BEGIN SELECT RAISE(ABORT, 'LIBRARY_CHAIN_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER trg_library_chain_events_no_delete
      BEFORE DELETE ON chain_events
      BEGIN SELECT RAISE(ABORT, 'LIBRARY_CHAIN_EVENT_IMMUTABLE'); END;

    CREATE TABLE settlements (
      settlement_id INTEGER PRIMARY KEY,
      loan_id TEXT NOT NULL UNIQUE REFERENCES loans(loan_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      outcome TEXT NOT NULL CHECK (outcome IN ('RETURNED', 'LOST')),
      reason TEXT NOT NULL,
      retained_wei TEXT NOT NULL CHECK (retained_wei <> '' AND retained_wei NOT GLOB '*[^0-9]*'),
      refund_wei TEXT NOT NULL CHECK (refund_wei <> '' AND refund_wei NOT GLOB '*[^0-9]*'),
      shortfall_wei TEXT NOT NULL CHECK (shortfall_wei <> '' AND shortfall_wei NOT GLOB '*[^0-9]*'),
      librarian_account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      tx_hash TEXT,
      event_id INTEGER UNIQUE REFERENCES chain_events(event_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE account_holds (
      hold_id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      loan_id TEXT NOT NULL REFERENCES loans(loan_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      hold_type TEXT NOT NULL CHECK (hold_type IN ('OVERDUE', 'LOST_SHORTFALL')),
      started_at INTEGER NOT NULL,
      released_at INTEGER,
      UNIQUE (account_id, loan_id, hold_type)
    ) STRICT;
    CREATE INDEX ix_library_active_holds ON account_holds(account_id, started_at) WHERE released_at IS NULL;

    CREATE TABLE settlement_intents (
      intent_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES borrow_requests(request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      loan_id TEXT NOT NULL REFERENCES loans(loan_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      librarian_account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      outcome TEXT NOT NULL CHECK (outcome IN ('RETURNED', 'LOST')),
      condition TEXT CHECK (condition IS NULL OR condition IN ('GOOD', 'DAMAGED')),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      repair_requested_wei TEXT CHECK (repair_requested_wei IS NULL OR (repair_requested_wei <> '' AND repair_requested_wei NOT GLOB '*[^0-9]*')),
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE audit_log (
      audit_id INTEGER PRIMARY KEY,
      actor_account_id INTEGER REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      actor_role TEXT CHECK (actor_role IS NULL OR actor_role IN ('STUDENT', 'LIBRARIAN')),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX ix_library_audit_target ON audit_log(target_type, target_id, created_at);

    CREATE TABLE library_seed_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      seed_version INTEGER NOT NULL CHECK (seed_version >= 1),
      seed_hash TEXT NOT NULL CHECK (length(seed_hash) = 64),
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TRIGGER trg_library_seed_state_no_update
      BEFORE UPDATE ON library_seed_state
      BEGIN SELECT RAISE(ABORT, 'LIBRARY_SEED_STATE_IMMUTABLE'); END;
    CREATE TRIGGER trg_library_seed_state_no_delete
      BEFORE DELETE ON library_seed_state
      BEGIN SELECT RAISE(ABORT, 'LIBRARY_SEED_STATE_IMMUTABLE'); END;

    CREATE TABLE auth_challenges (
      challenge_id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      nonce TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
      consumed_at INTEGER
    ) STRICT;
    CREATE INDEX ix_library_challenges_expiry ON auth_challenges(expires_at, consumed_at);

    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
      revoked_at INTEGER
    ) STRICT;
    CREATE INDEX ix_library_sessions_account ON auth_sessions(account_id, expires_at, revoked_at);
    CREATE INDEX ix_library_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX ix_library_sessions_revoked ON auth_sessions(revoked_at) WHERE revoked_at IS NOT NULL;

    CREATE TABLE auth_rate_limits (
      scope TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL CHECK (request_count >= 0),
      PRIMARY KEY (scope, subject_hash, window_started_at)
    ) STRICT;
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE library_reconcile_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cursor_block INTEGER NOT NULL CHECK (cursor_block >= 0),
      checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
      health TEXT NOT NULL CHECK (health IN ('HEALTHY', 'REORG_DETECTED')),
      error_code TEXT
    ) STRICT;
    INSERT INTO library_reconcile_state(singleton, cursor_block, checked_at, health, error_code)
      VALUES (1, 0, 0, 'HEALTHY', NULL);

    CREATE TABLE library_transactions (
      request_id TEXT NOT NULL REFERENCES borrow_requests(request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('deposit', 'approve', 'reject', 'refund', 'confirmReturn', 'return', 'settle', 'payShortfall')),
      tx_hash TEXT NOT NULL CHECK (length(tx_hash) = 66),
      submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REVERTED')),
      block_number INTEGER CHECK (block_number IS NULL OR block_number >= 0),
      block_hash TEXT CHECK (block_hash IS NULL OR length(block_hash) = 66),
      log_index INTEGER CHECK (log_index IS NULL OR log_index >= 0),
      event_name TEXT,
      PRIMARY KEY (request_id, action),
      UNIQUE (tx_hash),
      CHECK ((status = 'SUBMITTED' AND block_number IS NULL AND block_hash IS NULL AND log_index IS NULL AND event_name IS NULL)
        OR (status IN ('CONFIRMED', 'REVERTED') AND block_number IS NOT NULL AND block_hash IS NOT NULL))
    ) STRICT;
    CREATE INDEX ix_library_transactions_hash ON library_transactions(tx_hash);

    CREATE TABLE library_event_canonicality (
      event_id INTEGER PRIMARY KEY REFERENCES chain_events(event_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('CANONICAL', 'ORPHANED')),
      checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
      observed_block_hash TEXT NOT NULL CHECK (length(observed_block_hash) = 66)
    ) STRICT;
    CREATE INDEX ix_library_event_canonicality_status ON library_event_canonicality(status, checked_at);
    INSERT INTO library_event_canonicality(event_id, status, checked_at, observed_block_hash)
      SELECT event_id, 'CANONICAL', occurred_at, block_hash FROM chain_events;
    INSERT INTO library_transactions(request_id, action, tx_hash, submitted_at, status, block_number, block_hash, log_index, event_name)
      SELECT e.request_id, 'deposit', e.tx_hash, e.occurred_at, 'CONFIRMED', e.block_number, e.block_hash, e.log_index, e.event_name
      FROM chain_events e WHERE e.event_name = 'DepositReceived';
  `,
}, {
  version: 3,
  sql: `
    ALTER TABLE library_reconcile_state
      ADD COLUMN canonicality_cursor_event_id INTEGER NOT NULL DEFAULT 0 CHECK (canonicality_cursor_event_id >= 0);
  `,
}, {
  version: 4,
  sql: `
    ALTER TABLE library_transactions
      ADD COLUMN settlement_intent_id TEXT REFERENCES settlement_intents(intent_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
    ALTER TABLE settlements
      ADD COLUMN settlement_intent_id TEXT REFERENCES settlement_intents(intent_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
  `,
}, {
  version: 5,
  sql: `
    ALTER TABLE library_reconcile_state
      ADD COLUMN pending_transaction_cursor TEXT NOT NULL DEFAULT ''
        CHECK (pending_transaction_cursor = '' OR length(pending_transaction_cursor) = 66);

    CREATE TABLE library_transaction_attempts (
      tx_hash TEXT PRIMARY KEY CHECK (length(tx_hash) = 66),
      request_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('deposit', 'approve', 'reject', 'refund', 'confirmReturn', 'return', 'settle', 'payShortfall')),
      submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REVERTED')),
      block_number INTEGER CHECK (block_number IS NULL OR block_number >= 0),
      block_hash TEXT CHECK (block_hash IS NULL OR length(block_hash) = 66),
      log_index INTEGER CHECK (log_index IS NULL OR log_index >= 0),
      event_name TEXT,
      settlement_intent_id TEXT REFERENCES settlement_intents(intent_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (request_id, action) REFERENCES library_transactions(request_id, action) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK ((status = 'SUBMITTED' AND block_number IS NULL AND block_hash IS NULL AND log_index IS NULL AND event_name IS NULL)
        OR (status IN ('CONFIRMED', 'REVERTED') AND block_number IS NOT NULL AND block_hash IS NOT NULL))
    ) STRICT;
    CREATE INDEX ix_library_transaction_attempts_action
      ON library_transaction_attempts(request_id, action, submitted_at, tx_hash);
    CREATE INDEX ix_library_transaction_attempts_pending
      ON library_transaction_attempts(status, tx_hash);
    INSERT INTO library_transaction_attempts(tx_hash, request_id, action, submitted_at, status, block_number,
      block_hash, log_index, event_name, settlement_intent_id)
      SELECT tx_hash, request_id, action, submitted_at, status, block_number, block_hash, log_index, event_name, settlement_intent_id
      FROM library_transactions;
  `,
}];
