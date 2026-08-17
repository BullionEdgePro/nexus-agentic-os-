-- The install-once rule migration 039 wrote down but did not keep.
--
-- 039 says, in its own comment: "Reinstalling something removed is allowed;
-- having it twice at once is not." The constraint underneath it was
--
--   unique (organization_id, catalog_item_id, installed_at)
--
-- which enforces nothing of the kind. `installed_at` defaults to now(), and
-- now() is the transaction timestamp — so two installs of the same pack by the
-- same business in two different requests carry two different timestamps and
-- both are accepted. The only case that constraint ever catches is two rows
-- written inside ONE transaction, which no code path does.
--
-- This is the failure pattern this system keeps producing: not an error, a
-- plausible normal state. A business installs the out-of-hours reply twice, the
-- catalogue page shows it twice, and when activation is eventually wired the
-- agent has two copies of the same instruction with no way to tell which one a
-- person looked at.
--
-- The fix is a partial unique index rather than a table constraint, because the
-- rule is conditional and a constraint cannot express a WHERE. Postgres will
-- not accept `unique (...) where removed_at is null` as a table constraint at
-- all; that shape only exists as an index.
--
-- Written before the install action, deliberately. An application-level "have
-- you already got this?" check is a race between two clicks, and this codebase
-- has already paid for the difference once — the re-engagement cooldown in 035
-- is an exclusion constraint for the same reason.

alter table catalog_installs drop constraint if exists catalog_install_once;

-- Removed installs are exempt: taking a pack out and putting it back is a thing
-- a business is allowed to do, and the removed row is the record that it once
-- ran. Nothing here deletes history.
create unique index if not exists catalog_installs_one_live_per_item
  on catalog_installs (organization_id, catalog_item_id)
  where removed_at is null;
