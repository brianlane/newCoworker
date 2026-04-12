/** Fixed UUID + API key; seeded into Mongo (`rowboat` DB) per upstream Rowboat at vps/integration/real/rowboat-git-ref. */
export const INTEGRATION_ROWBOAT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const INTEGRATION_ROWBOAT_API_KEY = "integration_rowboat_api_key_test";

/** Hard-route Ollama probes ask for 3–5 sentences; 512 max_tokens can exceed CPU inference + HTTP stability on long runs. */
export const WARM_VOICE_HARD_MAX_TOKENS = 200;
