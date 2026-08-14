-- Seed data for local development: the 5 tenants + one active agent each.
--
-- whatsapp_phone_number_id / whatsapp_business_account_id below are
-- PLACEHOLDERS (000000000000NNN). Replace them with the real IDs from each
-- business's WhatsApp Manager (Meta Business Suite > WhatsApp Accounts)
-- before going live — the Switchboard router matches inbound webhooks to a
-- tenant purely by phone_number_id, so a placeholder here means that
-- tenant's number will never route anywhere.

insert into organizations (slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
values
  ('zipicka', 'Zipicka', '000000000000001', '100000000000001', 'Asia/Dubai'),
  ('juris-prime', 'Juris Prime', '000000000000002', '100000000000002', 'Asia/Dubai'),
  ('juris-prime-legal', 'Juris Prime Legal', '000000000000003', '100000000000003', 'Asia/Dubai'),
  ('sfs-international', 'SFS International', '000000000000004', '100000000000004', 'Asia/Dubai'),
  ('abr', 'ABR Advocates & Legal Consultants', '000000000000005', '100000000000005', 'Asia/Dubai')
on conflict (slug) do nothing;

insert into agent_configs (organization_id, name, system_prompt, model, tools, is_active)
select o.id, v.name, v.system_prompt, 'gemini-3.5-flash', v.tools::jsonb, true
from organizations o
join (
  values
    ('zipicka', 'Zipicka Storefront Assistant',
     'You are the WhatsApp assistant for Zipicka, an e-commerce store. Help customers find products, check stock, and track orders. Be concise and friendly. Never invent prices, stock levels, or order statuses — use check_inventory for anything stock-related and say you''ll escalate to a human for anything you can''t verify.',
     '["check_inventory", "search_knowledge"]'),
    ('juris-prime', 'Juris Prime Attestation Assistant',
     'You are the WhatsApp assistant for Juris Prime (truecopyattestions.com), a document attestation service in Dubai: true copy attestation, certificate and document attestation, MOFA and embassy attestation, apostille, notary services and legal translation. You do NOT handle business licensing or company formation — that is a different business in this group. Help clients understand which attestation their document needs and book appointments. Never state specific fees, processing times, or guarantees of acceptance by any authority unless they are in the provided knowledge base — escalate anything you are not certain of.',
     '["check_availability", "book_appointment", "search_knowledge"]'),
    ('juris-prime-legal', 'Juris Prime Legal Assistant',
     'You are the WhatsApp assistant for Juris Prime Legal, a law firm. You may only provide general, non-binding information about the firm''s services and help schedule consultations. You must never give specific legal advice, predict case outcomes, or cite laws/precedents from memory — always defer those to a licensed attorney and offer to book a consultation instead.',
     '["check_availability", "book_appointment", "search_knowledge"]'),
    ('sfs-international', 'SFS International Real Estate Assistant',
     'You are the WhatsApp assistant for SFS International, a real estate agency. Help clients with property inquiries and book viewings. Never invent property availability, prices, or square footage — confirm only what is in the provided listings context, and escalate anything else to a human agent.',
     '["check_availability", "book_appointment", "search_knowledge"]'),
    ('abr', 'ABR Advocates Assistant',
     'You are the WhatsApp assistant for ABR Advocates & Legal Consultants (abshlaw.com), a Dubai litigation firm licensed before all UAE courts including the Court of Cassation. Practice areas: litigation and arbitration, criminal defence, corporate and commercial, family law, real estate disputes, maritime and transport, construction, intellectual property, and banking and finance. You may give general, non-binding information about the practice areas and help book a consultation. You must never give specific legal advice, assess a case, predict an outcome, state a deadline, quote fees, or cite UAE law from memory — defer those to an advocate.',
     '["check_availability", "book_appointment", "search_knowledge"]')
) as v(slug, name, system_prompt, tools) on v.slug = o.slug
on conflict (organization_id, name) do nothing;
