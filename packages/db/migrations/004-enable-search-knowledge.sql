-- ============================================================
-- Migration 004 — Enable search_knowledge for every tenant
-- ============================================================
--
-- Phase 2.1 shipped the whole knowledge base — schema, embeddings, retrieval,
-- and a registered `search_knowledge` tool — but no agent_configs row listed
-- that tool, and the switchboard resolves an agent's tools from that column.
-- So the feature deployed cleanly, passed its tests, reported healthy, and was
-- completely unreachable by any agent.
--
-- Same shape as the other incidents on this system (retired model, single-origin
-- CORS): not an error anywhere, just a capability that silently does nothing.
--
-- Idempotent: only appends where the tool is not already present.

update agent_configs
set tools = tools || '["search_knowledge"]'::jsonb
where not (tools @> '["search_knowledge"]'::jsonb);
