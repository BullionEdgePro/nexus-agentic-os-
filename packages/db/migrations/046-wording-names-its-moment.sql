-- Catalogue wording now says which moment it is for.
--
-- 041 published two templates with a `body` and nothing to say WHERE that body
-- belongs. That was honest at the time — there was no home for authored wording
-- at all, and activation refused them for exactly that reason. 045 built the
-- home, so a template can finally be filed, and filing needs a moment.
--
-- WHY THE WORDING CHANGED AS WELL AS THE PAYLOAD SHAPE. The two items were
-- written against an imagined vocabulary — "out of hours", "checking with a
-- colleague" — rather than the two moments this platform actually detects and
-- already speaks at:
--
--   handing_over      a colleague is taking over. Somebody IS on shift, so this
--                     may promise a person.
--   no_one_available  nobody is on shift. This one must NOT promise anyone —
--                     the agent stays live and keeps answering, because a
--                     customer told help is coming and then cut off from the
--                     only thing replying to them is the worst state this
--                     platform can produce (see FALLBACK_REPLY_NO_STAFF).
--
-- "Out-of-hours reply" mapped onto the second of those, and its old body broke
-- the rule that moment exists to keep: "someone will come back to you then"
-- promises a person precisely when there is nobody. Shipping it unchanged would
-- have put a catalogue item on the shelf whose whole purpose was to reintroduce
-- an incident this platform has already had. So it is rewritten to ask rather
-- than promise, and keeps the `{{open_time}}` blank — a business that wants to
-- name its hours can, and until someone fills it in the phrase cannot be
-- switched on at all.
--
-- Version bumped on both, because the payload changed and that is what the
-- column is for. Neither is installed anywhere — checked before writing this.

update catalog_items
   set payload = jsonb_build_object(
         'moment', 'handing_over',
         'body', 'Thanks for your message — I want to make sure you get an accurate answer, so I''m asking a colleague to pick this up. They''ll follow up shortly.',
         'notes', 'Sent when the agent steps back and somebody is on shift to take over. It may promise a person, because one exists. Say who, if the business would rather be specific — "one of our solicitors" reads very differently from "a specialist".'
       ),
       title = 'When a colleague is taking over',
       summary = 'What a customer hears the moment the agent stops answering and hands to a person. The platform default says "a specialist from our team", which suits a retailer better than a law firm.',
       version = 2,
       updated_at = now()
 where slug = 'holding-reply-while-checking';

update catalog_items
   set payload = jsonb_build_object(
         'moment', 'no_one_available',
         'body', 'Thanks for getting in touch. Nobody is at the desk right now, so I''ll keep helping where I can — we read messages from {{open_time}}. Could you tell me a little more about what you need?',
         'notes', 'This one must NOT promise that somebody will follow up. It is sent precisely when nobody is on shift, and a promise here is the failure that left a conversation abandoned for eleven days. Fill in {{open_time}} — it is sent to the customer exactly as written, and the phrase cannot be switched on while a placeholder remains.'
       ),
       title = 'When nobody is available to take over',
       summary = 'The same moment with an empty rota. Sets an hour rather than promising a person, and keeps the agent answering.',
       version = 2,
       updated_at = now()
 where slug = 'out-of-hours-reply';
