---
"nostream": minor
---

Add NIP-50 Full-Text Search support: PostgreSQL `tsvector`/`tsquery`-based full-text indexing on event content, `search` filter field on `REQ` and `COUNT` messages, ranked results via `ts_rank`, unsupported search extensions ignored gracefully, NIP-50 toggleable via relay configuration, NIP-11 relay information document updated to advertise NIP-50, integration tests, and migration lifecycle verification.
