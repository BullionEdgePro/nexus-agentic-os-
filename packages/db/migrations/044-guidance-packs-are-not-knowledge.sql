-- A pack a person reads is not a pack the agent answers from.
--
-- 041 published "The questions every business gets asked" as a knowledge_pack.
-- Its own note says the quiet part: "Every body above is a QUESTION, not an
-- answer." That is correct and useful — it is a checklist of what a business's
-- knowledge base is missing — and it is exactly the wrong thing to ingest.
--
-- Activating a knowledge pack chunks and embeds its documents into
-- `knowledge_chunks`, which is what retrieval searches on the live reply path.
-- Ingesting this one would put nine QUESTIONS into the pool the agent answers
-- FROM. Retrieval would happily return "Prices — what is fixed, what is quoted,
-- and what must never be quoted over a message?" as context for a customer
-- asking about prices. The agent would not state a false price; it would do the
-- honest thing and say a colleague will confirm. But it would do that having
-- burned its retrieval budget on a question, and the knowledge screen would
-- show nine indexed chunks that answer nothing — a knowledge base that looks
-- fuller than it is, which is this platform's signature failure wearing a new
-- coat.
--
-- So the distinction is made explicit and machine-readable rather than left to
-- whoever writes the next pack to notice. `guidance_only` marks a pack whose
-- documents are prompts for a person, and activation refuses it by name with a
-- sentence saying what it is instead.
--
-- Kept as a payload key rather than a new `kind`. The kinds are what a catalogue
-- item IS — a message, a method, material. Whether a pack is readable-by-people
-- or answerable-by-the-agent is a property of its contents, and a pack could
-- later carry both. A new kind would also mean a check-constraint change on a
-- table that five businesses read.
--
-- Version bumped to 2 because the payload changed, which is what the column is
-- for. Nobody has installed it — verified before writing this — so no business
-- is left trailing a version here.

update catalog_items
   set payload = payload || jsonb_build_object('guidance_only', true),
       version = 2,
       updated_at = now()
 where slug = 'what-a-business-must-be-able-to-answer'
   and not coalesce((payload ->> 'guidance_only')::boolean, false);
