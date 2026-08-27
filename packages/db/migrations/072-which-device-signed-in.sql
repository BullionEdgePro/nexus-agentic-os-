-- "Last signed in" without saying from what.
--
-- ============================================================
-- WHAT WAS ALREADY THERE, AND WHAT WAS NOT
-- ============================================================
--
-- `employees.last_login_at` and `admins.last_login_at` have been written on
-- every sign-in for months. Nothing recorded WHAT signed in, and nothing showed
-- either fact on the person's own record.
--
-- A date on its own answers "is this account still in use". It cannot answer
-- the question somebody actually asks when they look: "was that me?" An account
-- last used on Tuesday from a phone nobody recognises is a different fact from
-- the same date on the laptop it is always used from, and until now those were
-- the same row.
--
-- ============================================================
-- ONE COLUMN, NOT A HISTORY TABLE
-- ============================================================
--
-- This records the LAST device, because that is what was asked for and it is
-- the smaller thing to be wrong about. A history of sign-ins is genuinely more
-- useful -- "somebody signed in from a new device last Tuesday" is the question
-- worth alerting on -- and it is a different feature with a retention decision
-- attached, which is the owner's to make rather than mine to assume.
--
-- Recorded as the parsed label rather than the raw user agent. The raw string
-- is a fingerprint precise enough to identify a person's exact browser build
-- across services, and "Chrome on Windows" answers the question that is being
-- asked. Bounded at the column so a spoofed header cannot write a novel into
-- the row.
--
-- NO IP ADDRESS, deliberately. "Where from" is a different question with a
-- different privacy weight, it was not asked for, and it is easier to add later
-- than to un-collect.

alter table employees add column if not exists last_login_device text;
alter table admins    add column if not exists last_login_device text;

comment on column employees.last_login_device is
  'Parsed label of the device used at last_login_at — e.g. "Chrome on Windows". Never the raw user agent.';
comment on column admins.last_login_device is
  'Parsed label of the device used at last_login_at — e.g. "Safari on iPhone". Never the raw user agent.';
