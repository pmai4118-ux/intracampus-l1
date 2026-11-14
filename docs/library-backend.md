# Library backend and SQLite

This document describes the durable database foundation for the Library module. The backend is a single-instance demo service; SQLite is not a shared multi-writer store for multiple replicas.

## Database lifecycle

The default database is `backend/data/library.sqlite`. Set `LIBRARY_DB_PATH` to use another persistent path. Opening the database enables foreign keys on that connection, sets a 5-second busy timeout, enables WAL for file databases, and uses `synchronous=FULL`.

Schema changes use SQLite `user_version`. Each migration batch obtains `BEGIN IMMEDIATE` before reading the applied version, applies schema and version updates in one transaction, then commits. Concurrent starters serialize through SQLite's writer lock. A failed migration rolls back the schema and version together. There is no destructive down migration for populated data; introduce forward migrations instead.

`LibraryRepository.backupTo(path)` uses Node 24's online SQLite backup API, so it includes committed data consistently while WAL is active. To restore, stop the backend, preserve the current database and its WAL files, replace the configured database with the backup, then restart and check `/healthz` and the schema version. Keep backups outside Git and restrict access to them because they contain wallet-linked borrowing history.

## Relational model

```mermaid
erDiagram
  accounts ||--o{ borrow_requests : owns
  books ||--o{ book_copies : has
  books ||--o{ borrow_requests : requested
  book_copies ||--o{ borrow_requests : allocated
  borrow_requests ||--o| loans : creates
  borrow_requests ||--o{ chain_events : proves
  loans ||--o| settlements : settles
  accounts ||--o{ auth_challenges : signs
  accounts ||--o{ auth_sessions : authenticates
  loans ||--o{ account_holds : blocks
  loans ||--o{ settlement_intents : audits
```

Amounts are canonical unsigned decimal strings in wei. Database checks reject nondecimal text; application validation enforces the `uint256` range. Books and demo accounts are seed-owned: wallet/role and sealed deposit/replacement terms cannot be changed through SQL updates. Copy status and loan/request history are mutable projections updated from verified evidence.

The database enforces these invariants even when a caller bypasses repository methods:

- A request can hold a physical copy only while its state is active; a partial unique index allows one active allocation per copy.
- A loan's request, book, account and copy must match the same request row. The loan ID equals its request ID, and a partial unique index allows one active loan per copy.
- Each request creates at most one loan, each loan has at most one final settlement, and each verified event is unique by `(chainId, contractAddress, txHash, logIndex)`.
- Foreign keys are enabled for every connection. Seed terms, account wallet/role and verified chain events are immutable.

## Demo seed

`pnpm --filter @intracampus/backend seed:library` reads a private JSON file selected by `LIBRARY_SEED_FILE` and writes to `LIBRARY_DB_PATH`. The seed file contains catalog metadata, physical copy IDs/barcodes, and synthetic wallet addresses with `STUDENT` or `LIBRARIAN` roles. It must not contain private keys, signatures, student names, or student IDs.

Before writing, the command requires a valid Library deployment manifest and verifies that the seed contains the exact deployed book ID set, sealed deposit and replacement price for every book, and the one librarian wallet configured in escrow. Deposit must be exactly `50000000000000000000` wei (50 CAMPUS). Local Anvil deployment manifests require `LIBRARY_ALLOW_LOCAL_ANVIL=true`; the default is fail closed. Running the same seed version/content is a no-op. A different seed is rejected rather than silently replacing financial terms or demo identities.

Example shape (values are illustrative and must match the deployment manifest):

```json
{
  "version": 1,
  "books": [
    {
      "bookId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "title": "Demo title",
      "author": "Demo author",
      "isbn": null,
      "depositWei": "50000000000000000000",
      "replacementPriceWei": "30000000000000000000",
      "copies": [{ "copyId": "copy-001", "barcode": "LIB-001" }]
    }
  ],
  "accounts": [
    { "wallet": "0x1111111111111111111111111111111111111111", "role": "STUDENT" },
    { "wallet": "0x3333333333333333333333333333333333333333", "role": "LIBRARIAN" }
  ]
}
```

## Identity and privacy

The demo allowlist is stored in `accounts`; role comes from that row and is never accepted from the browser. Challenge messages are persisted exactly as issued so verification checks the signed message, configured origin and chain. A successful verify consumes the challenge and creates a session in the same write transaction. Challenge nonce replay is prevented by a unique constraint and conditional consume. Session cookies contain a random opaque token; SQLite stores only its SHA-256 hash. Disabling an account revokes its sessions in the same transaction, and every session lookup also checks that the account remains enabled.

Rate-limit subjects are stored only as SHA-256 hashes, not raw client addresses. Do not log challenge messages, nonce, signatures, raw session cookies, private keys, or database rows. Wallet addresses and borrowing history remain demo data and should not be populated with real student identities.

### Auth HTTP settings and cookie flow

Auth configuration is independent of invoice/grant configuration so missing Library auth settings return `503 CONFIGURATION_ERROR` from `/api/auth/*` without disabling unrelated APIs. There are no production defaults.

| Environment variable | Meaning |
| --- | --- |
| `LIBRARY_AUTH_ORIGIN` | Exact trusted application origin; the server derives the EIP-4361 domain from this value and never trusts `Host` or forwarded-host headers. |
| `LIBRARY_CHALLENGE_TTL_SECONDS`, `LIBRARY_SESSION_TTL_SECONDS` | Positive integer TTLs whose expiry remains within the JavaScript date range used for auth timestamps. If the current time makes a configured TTL exceed that range, the auth route fails closed with `503 CONFIGURATION_ERROR`. |
| `LIBRARY_CHALLENGE_RATE_LIMIT_MAX_REQUESTS`, `LIBRARY_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS` | Positive request count and fixed-window seconds for challenge attempts. |
| `LIBRARY_VERIFY_RATE_LIMIT_MAX_REQUESTS`, `LIBRARY_VERIFY_RATE_LIMIT_WINDOW_SECONDS` | Positive request count and fixed-window seconds for verify attempts. |
| `LIBRARY_ALLOW_INSECURE_LOCALHOST` | Must be exactly `true` to allow HTTP on `localhost`, `127.0.0.1`, or `::1`; it never enables non-loopback HTTP. |

Production uses HTTPS and the host-only `__Host-library_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`, with no `Domain`). Explicit local HTTP uses `library_session` without `Secure` only after the loopback opt-in. `POST /api/auth/challenge`, `POST /api/auth/verify`, and `POST /api/auth/logout` require an `Origin` exactly matching `LIBRARY_AUTH_ORIGIN`. Challenge and verify are JSON-only and share the 8192-byte Library parser limit. A throttled attempt returns `429 RATE_LIMITED`, `retryable: true`, and `Retry-After` seconds until its fixed window resets.

The browser flow is: request a challenge with its wallet, sign the exact message in the wallet, submit only the challenge ID and signature, keep the session cookie out of JavaScript, call `/api/auth/session` with that cookie, and POST logout to revoke it. Verify responses contain the allowlisted account and expiry but never the raw session token; only the `Set-Cookie` header carries that token.
