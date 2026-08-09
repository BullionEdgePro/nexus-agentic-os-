-- ============================================================
-- Migration 012 — Correct what the agents believe about themselves
-- ============================================================
--
-- Migration 008 corrected the record on `juris-prime`: it is document
-- attestation, notary and legal translation, not business licensing. The
-- licensing wording came from guessing at the tenant's name before anyone read
-- the site.
--
-- That correction reached the routing keywords, the tenant profile, the public
-- page and the operator console — every place a HUMAN reads. It did not reach
-- `agent_configs.system_prompt`, which is the only place the AI reads. So the
-- agent now receiving attestation enquiries introduces itself as a licensing
-- consultancy and offers to explain licence types.
--
-- The switchboard made this worse rather than exposing it: routing works
-- correctly, and delivers the customer to an agent with the wrong idea of what
-- business it is in. Nothing errors. The reply is fluent, on-brand, and about
-- the wrong service.
--
-- Idempotent: matches on organization slug, not on the current text.

-- ---------- Juris Prime — attestation, not licensing ----------
update agent_configs ac set
  name = 'Juris Prime Attestation Assistant',
  system_prompt =
    'You are the WhatsApp assistant for Juris Prime (truecopyattestions.com), a document attestation ' ||
    'service in Dubai. The services are: true copy attestation, certificate and document attestation, ' ||
    'MOFA and embassy attestation, apostille, notary services, and legal translation. ' ||
    'You do NOT handle business licensing, company formation or trade licences — that is a different ' ||
    'business in this group. If someone asks about those, say so plainly and offer to pass them to the ' ||
    'right team rather than answering. ' ||
    'Help clients understand which attestation their document needs and what to bring, and book ' ||
    'appointments. Never state specific fees, processing times, or guarantees of acceptance by any ' ||
    'authority unless they are in the provided knowledge base — escalate anything you are not certain of.',
  updated_at = now()
from organizations o
where o.id = ac.organization_id and o.slug = 'juris-prime';

-- ---------- Atif Ali Production — nothing to answer from ----------
--
-- Its website is unreachable (migration 008), so `search_knowledge` returns
-- nothing for this tenant no matter what is asked. The previous prompt invited
-- the agent to "help prospective clients understand service packages", which
-- with an empty knowledge base means describing packages from the model's own
-- priors — plausible, specific, and invented.
--
-- Rewritten to do the one thing it can do honestly: take the enquiry and get a
-- human to call back. This should be reverted to a normal service prompt the
-- moment the site is back and indexed.
update agent_configs ac set
  system_prompt =
    'You are the WhatsApp assistant for Atif Ali Production, a digital media production studio ' ||
    '(video production, filming, editing and branded content). ' ||
    'IMPORTANT: you currently have NO service catalogue, price list or portfolio available to you. ' ||
    'Do not describe packages, deliverables, turnaround times or prices — you would be inventing them. ' ||
    'Your job is to welcome the enquiry, ask what the client needs filmed or produced and roughly when, ' ||
    'and book a discovery call with the studio team. If asked anything you cannot answer from what the ' ||
    'client has told you, say the studio team will confirm the details directly.',
  updated_at = now()
from organizations o
where o.id = ac.organization_id and o.slug = 'atif-ali-production';

-- ============================================================
-- Every agent now shares a number with four others
-- ============================================================
--
-- Classification is deliberately conservative — it asks when unsure — but it is
-- keyword-based and will sometimes be wrong. When it is, the agent is the last
-- thing between a misrouted customer and a confident answer from the wrong
-- business. On this platform that is not a cosmetic error: the law firm and the
-- retail store operate under different governance policies, and an enquiry that
-- lands in the wrong place is answered under the wrong one.
--
-- Appended rather than rewritten so each tenant's own instructions stay intact,
-- and guarded so re-running does not stack duplicate copies.
update agent_configs set
  system_prompt = system_prompt ||
    E'\n\nYou share a WhatsApp number with four other businesses in this group, so an enquiry ' ||
    'occasionally reaches you by mistake. If a message is clearly meant for a different business, ' ||
    'do not attempt to answer it. Say briefly that it is handled by another team in the group and ' ||
    'ask the customer to confirm what they need, so they can be put through correctly.',
  updated_at = now()
where is_active = true
  and system_prompt not like '%share a WhatsApp number with four other businesses%';

-- ------------------------------------------------------------
-- Assert the correction actually landed
-- ------------------------------------------------------------
--
-- Not "did anything error" — this asserts the wrong belief is gone and the
-- right one is present. The whole reason this migration exists is that a
-- correction was applied in four places and silently missed a fifth.
do $$
declare
  stale int;
  shared int;
begin
  select count(*) into stale
    from agent_configs ac
    join organizations o on o.id = ac.organization_id
   where o.slug = 'juris-prime'
     and (ac.system_prompt ilike '%licensing consultancy%' or ac.name ilike '%licensing%');

  if stale > 0 then
    raise exception 'juris-prime still describes itself as licensing in % agent config(s)', stale;
  end if;

  select count(*) into shared
    from agent_configs
   where is_active = true
     and system_prompt like '%share a WhatsApp number with four other businesses%';

  if shared < 5 then
    raise exception 'Only % of 5 active agents know they are on a shared number', shared;
  end if;

  raise notice 'Agent prompts corrected: juris-prime is attestation, % agents aware of the shared number', shared;
end
$$;
