# Competency Test: `test_column` Migration for the `events` Table

This document is one of my competency-test artifacts for Nostream. Its purpose is to demonstrate that I can work with the repository’s database migration workflow by creating a small, safe Knex migration, applying it, rolling it back, and verifying both directions.

For the competency test, I chose a minimal schema change: adding a nullable `TEXT` column named `test_column` to the `events` table.

This is intentionally simple because the goal of the test is not to redesign the schema, but to prove that I understand how Nostream handles database migrations and reversible schema changes.

---

## Why I Chose This Migration

I used a small additive change because it is the lowest-risk way to validate the migration workflow.

This change is safe because:

- existing rows remain valid without any backfill,
- existing insert and update paths continue to work because the new column is nullable,
- rollback is straightforward,
- and the result is easy to verify manually from PostgreSQL.

This makes it a good competency-test example: small enough to be safe, but still sufficient to demonstrate migration and rollback fluency.

---

## Migration Summary

The migration adds a nullable `TEXT` column named `test_column` to the `events` table.

### `up`

The `up` migration alters `events` and adds:

- `test_column` as `TEXT NULL`

### `down`

The `down` migration alters `events` and drops:

- `test_column`

Because the change is fully reversible, this migration can be tested cleanly in both directions.

---

## Why This Matters for the Proposal

This competency-test artifact is directly relevant to my main proposal.

The Local-First Sync & Performance Engine proposal includes database work for:

- NIP-50 full-text search support,
- new PostgreSQL indexes,
- and benchmark-driven schema evolution.

Before proposing those larger changes, I wanted to demonstrate that I can work comfortably with the existing migration workflow in the repository. This small migration is a proof point for that.

In other words, the test is simple by design, but the skill it demonstrates is directly useful for the actual project.

---

## How To Run

Apply the latest migration:

```bash id="v7d9x0"
NODE_OPTIONS="-r dotenv/config" npm run db:migrate
````

Roll back the most recent migration:

```bash id="qpe6hl"
NODE_OPTIONS="-r dotenv/config" npm run db:migrate:rollback
```

---

## Verification Steps

After running the migration, verify that the column exists.

### SQL check

```sql id="2u2j4f"
SELECT test_column FROM events LIMIT 1;
```

### `psql` schema inspection

```sql id="aoi8it"
\d events
```

After running rollback, verify that `test_column` no longer exists using the same checks.

This confirms both:

* the schema change applies correctly,
* and the rollback path restores the previous table shape.

---

## Recommended Reversibility Check

To confirm that the migration behaves cleanly in both directions, I used the following sequence:

1. run migrate,
2. run rollback,
3. run migrate again.

This is a simple but useful check because it proves that:

* the migration is not one-way,
* rollback does not leave the schema in a broken intermediate state,
* and reapplying the migration works as expected.

---

## What This Competency Test Demonstrates

This test demonstrates that I can:

* work with Nostream’s Knex-based migration setup,
* make a safe schema change,
* apply and roll back the migration correctly,
* verify the result directly in PostgreSQL,
* and reason about reversibility before proposing larger database changes.

That is directly relevant to the proposal because the NIP-50 part of the project depends on careful PostgreSQL schema work, migration safety, and benchmark-backed indexing changes.
