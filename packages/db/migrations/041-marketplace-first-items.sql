-- The first published catalogue items.
--
-- 039 built the shelf and left it empty on purpose — schema and boundary first.
-- An empty shelf cannot be judged, though: "no items yet" and "the query is
-- broken" render identically, which is the failure mode this codebase has now
-- paid for several times over. So the catalogue page ships with something on it.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED. `catalog_items` is platform content,
-- not tenant data, and 039 revoked insert on it from `nexus_app` precisely so
-- the application cannot author one while answering a customer. Authoring
-- therefore happens as the owner, which is what a migration is. Nothing here
-- is a business's material; nothing here could be, because the table has no
-- column to put it in.
--
-- WHAT IS DELIBERATELY NOT HERE. Nothing industry-specific enough to be a
-- guess about how a real business works. Every item below is either generic to
-- any business answering a phone, or a skeleton whose specifics a person has to
-- fill in. A catalogue that ships opinions about a law firm's intake, written
-- by nobody who works there, is worse than an empty one.
--
-- Idempotent on `slug`. Re-running updates the wording and bumps nothing:
-- `version` is only for payload changes an installed business has to opt into,
-- and re-applying a migration is not a new version of anything.

insert into catalog_items (slug, kind, title, summary, payload, suits_industry, language, published_at)
values
  (
    'out-of-hours-reply',
    'template',
    'Out-of-hours reply',
    'What a customer hears when they message outside working hours. Sets a time, rather than promising "soon".',
    jsonb_build_object(
      'body', 'Thanks for getting in touch. Nobody is at the desk right now — we read messages from {{open_time}} and someone will come back to you then.',
      'variables', jsonb_build_array('open_time'),
      'notes', 'A named hour is the whole point. "We will reply soon" gives the customer nothing to plan around and no way to know when to chase.'
    ),
    null,
    'en',
    now()
  ),
  (
    'holding-reply-while-checking',
    'template',
    'Holding reply while checking',
    'For a question that needs a person to look something up. Says what is happening and who is doing it.',
    jsonb_build_object(
      'body', 'Good question — I need to check that with {{team_or_person}} rather than guess. I will come back to you today.',
      'variables', jsonb_build_array('team_or_person'),
      'notes', 'Written to be honest about not knowing. An agent that invents an answer rather than pausing is the failure this template exists to make easy to avoid.'
    ),
    null,
    'en',
    now()
  ),
  (
    'first-contact-triage',
    'procedure',
    'Find out what they actually need, before answering',
    'Four steps for an opening message that does not say what it wants. Establishes the need and who is asking before anything is quoted.',
    jsonb_build_object(
      'intent_category', 'unknown',
      'steps', jsonb_build_array(
        jsonb_build_object('text', 'Ask what they are trying to get done, in their own words.'),
        jsonb_build_object('text', 'Ask whether this is for themselves or for a company.'),
        jsonb_build_object('text', 'Confirm back what you understood, in one sentence, before answering.'),
        jsonb_build_object('text', 'If it is outside what this business does, say so plainly rather than improvising.')
      )
    ),
    null,
    'en',
    now()
  ),
  (
    'appointment-intake',
    'procedure',
    'Take an appointment without double-booking',
    'The order to collect a booking in, so the diary is the thing that decides — not the conversation.',
    jsonb_build_object(
      'intent_category', 'appointment_booking',
      'steps', jsonb_build_array(
        jsonb_build_object('text', 'Establish what the appointment is for, so the right person is offered.'),
        jsonb_build_object('text', 'Offer only times the diary actually shows free.'),
        jsonb_build_object('text', 'Take the name and the number the customer wants to be reached on.'),
        jsonb_build_object('text', 'Read the confirmed time back before treating it as booked.')
      )
    ),
    null,
    'en',
    now()
  ),
  (
    'inbound-pitch-handling',
    'procedure',
    'Handle someone selling to you',
    'Half of measured traffic on this platform is people pitching TO the business. This is how to close that politely without a person reading it.',
    jsonb_build_object(
      'intent_category', 'inbound_pitch',
      'steps', jsonb_build_array(
        jsonb_build_object('text', 'Thank them, and say plainly that this number is for customers.'),
        jsonb_build_object('text', 'Point them to an email address if the business wants to receive pitches at all.'),
        jsonb_build_object('text', 'Do not offer a call, a callback, or a time.'),
        jsonb_build_object('text', 'Do not escalate to a colleague.')
      )
    ),
    null,
    'en',
    now()
  ),
  (
    'what-a-business-must-be-able-to-answer',
    'knowledge_pack',
    'The questions every business gets asked',
    'A skeleton, not content. Nine questions a customer asks within the first message or two — with the answers left blank, because only the business knows them.',
    jsonb_build_object(
      'documents', jsonb_build_array(
        jsonb_build_object('title', 'Opening hours', 'body', 'When are you open, including weekends and public holidays?'),
        jsonb_build_object('title', 'Where you are', 'body', 'The address, and whether customers can turn up without an appointment.'),
        jsonb_build_object('title', 'What you do', 'body', 'The services or products, in the words a customer would use rather than the internal names.'),
        jsonb_build_object('title', 'What you do not do', 'body', 'The requests that should be turned away, so the agent declines instead of improvising.'),
        jsonb_build_object('title', 'Prices', 'body', 'What is fixed, what is quoted, and what must never be quoted over a message.'),
        jsonb_build_object('title', 'How long things take', 'body', 'Lead times, turnaround, delivery.'),
        jsonb_build_object('title', 'Payment', 'body', 'What is accepted, and whether a deposit is required.'),
        jsonb_build_object('title', 'Returns, cancellations or withdrawal', 'body', 'The policy as it actually is, including the parts customers dislike.'),
        jsonb_build_object('title', 'Who to reach for what', 'body', 'Which colleague handles which kind of enquiry.')
      ),
      'notes', 'Every body above is a QUESTION, not an answer. Installing this gives a business a checklist of what its knowledge base is missing — filling it in is the work, and nobody else can do it.'
    ),
    null,
    'en',
    now()
  )
on conflict (slug) do update
  set title        = excluded.title,
      summary      = excluded.summary,
      payload      = excluded.payload,
      kind         = excluded.kind,
      published_at = coalesce(catalog_items.published_at, excluded.published_at),
      updated_at   = now();
