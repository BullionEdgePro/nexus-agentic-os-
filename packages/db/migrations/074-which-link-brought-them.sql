-- Which staff member's link a customer arrived through.
--
-- ============================================================
-- THE PLAN THIS SERVES
-- ============================================================
--
-- The shared number is for automated inquiry: a customer messages it, the agent
-- answers. Staff publish links on their own socials and websites. A customer
-- who came through one of those links should end up talking to THAT person, and
-- the business should still hold the conversation.
--
-- The tag in the prefilled message carries the staff code. This column records
-- what it said, on the conversation, at the moment it was read.
--
-- ============================================================
-- WHY THIS IS NOT `employee_id`
-- ============================================================
--
-- `conversations.employee_id` already exists and means WHO IS HANDLING THIS —
-- an assignment, which moves when somebody hands over, goes on holiday or
-- leaves. This is a different fact: who the customer came to, which happened
-- once and never changes afterwards.
--
-- Keeping them in one column would mean that reassigning a conversation erases
-- the reason it exists, and the question "which of Aqib's posts is actually
-- producing work" becomes unanswerable the first time somebody covers for him.
-- Both columns are set on arrival; only one of them is allowed to move.
--
-- ============================================================
-- AND WHY OWNERSHIP OF THE CONTACT IS NOT TOUCHED HERE
-- ============================================================
--
-- A tag can only CLAIM a contact nobody owns. If the person is already in a
-- colleague's client book, arriving through a second staff member's link
-- attributes this CONVERSATION and leaves the book alone.
--
-- The alternative -- letting a link move a client between colleagues -- would
-- make somebody else's book editable by anybody who could get a customer to tap
-- a link, which is a theft the colleague never sees. The conflict is recorded
-- and shown rather than resolved silently, because two people believing they
-- own the same client is a thing for humans to sort out.

alter table conversations
  add column if not exists referred_by_employee_id uuid references employees(id) on delete set null,
  add column if not exists referred_at             timestamptz;

comment on column conversations.referred_by_employee_id is
  'The staff member whose published link this customer arrived through. Set once, on arrival, and never moved — '
  'unlike employee_id, which is the current assignment and is expected to change.';
comment on column conversations.referred_at is
  'When the referral tag was read. Distinct from opened_at: a conversation can be reopened, the referral happened once.';

-- Partial because referred conversations are the minority and the question
-- asked of this column is always "which came through a link", never "which did
-- not".
create index if not exists idx_conversations_referred_by
  on conversations(referred_by_employee_id, opened_at desc)
  where referred_by_employee_id is not null;
