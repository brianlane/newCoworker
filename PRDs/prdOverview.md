### 📄 prd-overview.md

**Product Name:** New Coworker (v2.0)
**Core Mission:** Empower small businesses with privacy-first, autonomous "Digital Employees" that operate within their own dedicated, secure, local infrastructure.
**Strategic Vision:** Moving beyond the "chatbot" paradigm, our agents utilize deep reasoning, permanent file-based memory (Lossless), and local inference to act as a genuine extension of the business owner's intent. We solve the primary pain point of small business owners: the lack of time to manage the "chaos of the gap" between contract signing and deal closure. By automating the cognitive load—lead qualification, transaction coordination, and market analysis—our agents do not just respond; they act, update CRMs, and communicate across channels.
**Target Market:** Small businesses, starting with Real Estate agents.
**Core Differentiators:**
1. **Local-First Fortress:** Zero data egress for inference; full compliance with data privacy and HIPAA.
2. **Permanent Memory (DAG):** Agents build a hierarchical DAG of business facts, preventing the "forgetfulness" of standard LLMs.
3. **No-OpenRouter Dependency:** Full local operation prevents "ambiguous costs" and supply chain attacks.

-----

### 📄 prd-mvp-implementation.md

**Goal:** Deliver the first "Coworker" VPS instance for a real estate business executive.
**Gold Images:** Two separate images — one for Starter (KVM 2) and one for Standard (KVM 8).
**Phases:**

1. **Infrastructure Foundation:** Deploy Hostinger KVM 2 (Starter) or KVM 8 (Standard). Configure Ubuntu 24.04, harden SSH, and install Docker/Ollama.
2. **Agent Provisioning:** Use the tier-specific Gold Image (Rowboat + Ollama on the host) to spin up the agent environments. KVM 2 uses ZRAM for compressed swap.
3. **Soul Injection:** Upon account creation, gather information via the onboarding questionnaire, then inject `soul.md`, `identity.md`, and `memory.md` into the business account's Rowboat vault.
4. **Integration Layer:** Link Twilio and inworld.ai keys. Establish Cloudflare Tunnels to our Next.js dashboard.
5. **Memory Initialization:** Load initial business data into Rowboat's lossless memory system.
6. **Beta Testing:** "Human-in-the-loop" phase where agents draft responses for manual owner approval.

*Account creation for a business should be 100% automated*

-----

### 📄 prd-account-experience.md

**Account Onboarding Flow:**

1. **Discovery:** New Business account fills out a Next.js-based "Business Questionnaire/Account creation" form.
2. **Plan Selection:** Owner chooses Starter or Standard, plus billing period (24-month, 12-month, or 1-month). 24-month shows the lowest monthly rate with a 30-day money-back window.
3. **Auto-Provisioning:** Upon payment, the system triggers the Hostinger API to purchase/provision the VPS instance (KVM 2 for Starter, KVM 8 for Standard).
4. **Dashboard Activation:** The new user is provided a secure dashboard link and can access their dashboard anytime with their login credentials. They see their Coworker "Status" (Online/Offline), "Recent Tasks", "Sessions", "Agent Chat", "Usage", "Memory", and more.
5. **Management:** Owners can view usage statistics, monitor daily limits (Starter tier), and manage their agent's soul/identity configuration.

-----

### 📄 technical-architecture-prd.md

**The Stack:**

- **Agent Runtime:** Rowboat (open-source, multi-agent framework). Supports Conversational, Task, and Pipeline agent types. Markdown knowledge vault (soul.md / identity.md / memory.md).
- **Routing:** Rowboat uses Ollama’s OpenAI-compatible API on the host (`/v1`); no separate LLM gateway in the default stack.
- **Model Orchestration:** Ollama serves all inference locally.
- **Starter Tier (KVM 2) — Llama 3.2 3B:**
  - Single model (**`llama3.2:3b`**); standard KVM8 uses **`qwen3:4b-instruct`**.
  - ZRAM (4GB lz4): expands effective RAM from 8GB to ~11GB.
  - `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OMP_NUM_THREADS=2`.
- **Standard Tier (KVM 8) — CPU product default (single model):**
  - **Sole inference tag:** **`qwen3:4b-instruct`** for Rowboat → Ollama.
  - **Background pulls:** **`qwen3:4b-instruct`** (required), Llama 4 / Qwen 3.5 35B-A3B optional per `bootstrap.sh` (experiments).
  - **Model choice:** integration correctness runs selected `qwen3:4b-instruct` for kvm8 and `llama3.2:3b` for kvm2.
- **Voice:** inworld.ai TTS-1.5 Mini — all tiers. Sub-130ms P90 latency, $5/1M chars. WebSocket streaming for lowest latency voice with Twilio.
- **Inference Optimizations (both tiers):**
  - TurboQuant KV cache compression — **ACTIVE** via `OLLAMA_KV_CACHE_TYPE=q4_0`. Reduces active KV cache memory per conversation by ~75%. Critical for KVM 2: without it, long conversations contend harder with the 8 GiB host budget. With it, many simultaneous conversations can be held in the same footprint.
  - Flash Attention — **ACTIVE** via `OLLAMA_FLASH_ATTENTION=1`. Memory-efficient attention computation; prerequisite for Dynamic VRAM / Weight Streaming on the llama.cpp backend.
  - ComfyUI Dynamic VRAM + Weight Streaming: just-in-time NVMe weight loading. Enabled at the llama.cpp layer via Flash Attention.
- **Storage:** PostgreSQL (Supabase) for logs/metadata, subscriptions, daily usage tracking; Rowboat internal MongoDB for agent state.
- **Browsing:** Lightpanda Cloud WSS (Zig-based, low RAM overhead).

**Performance Targets:**

- SMS/Chat: Instant (60% idle capacity on KVM 2).
- Voice (inworld.ai offload): ~1.2s-1.8s end-to-end on KVM 2 (acceptable for Starter tier).
- Standard tier: <800ms TTFT for voice-critical models.

-----

### 📄 prd-non-functional-requirements.md

- **Security:** All VPS instances must have firewall rules allowing traffic only to verified Twilio/inworld.ai/Supabase endpoints.
- **Compliance:** System prompts must strictly include Fair Housing Act (FHA) compliance guardrails for all real estate agents. Compliance needs to be able to expand to other job fields.
- **Data Sovereignty:** All conversation transcripts are stored locally on the client's VPS. Only "Log metadata" (not raw sensitive text) is sent to the Vercel dashboard.
- **Resiliency:** Automated heartbeat check every 2 minutes; if an agent is unresponsive for 3 failed heartbeats then automate restart; if still failing, contact admin via webhook.

-----

### 📄 prd-functional-requirements.md

1. **Voice Gateway:** Bi-directional handling of calls via Twilio + inworld.ai Mini TTS.
2. **Smart Lead Triage:** Analyze inquiry intent within 3 seconds of connection.
3. **Task Delegation:** Automated updating of local spreadsheets (Google Sheets/Excel) and CRM entries (e.g., Follow Up Boss).
4. **Swarm Reasoning:** Ability to run multi-model checks for high-value deal amendments (Standard/Enterprise only).
5. **Notification Engine:** Trigger SMS/Email to business owner for task-completion updates.
6. **Usage Enforcement:** Starter tier enforces daily limits via `daily_usage` table: 60 min voice, 100 SMS, 10 calls. Standard/Enterprise are unlimited.

-----

### 📄 cash-flow-management-prd.md

**Pricing (Starter tier — loss leader):**
- 24-month: $9.99/mo (renews $16.99/mo). KVM 2 cost: $8.99/mo. Operating at a loss to attract customers.
- 12-month: $10.99/mo (renews $18.99/mo).
- 1-month: $15.99/mo (renews $26.99/mo).

**Pricing (Standard tier):**
- 24-month: $99/mo (renews $189/mo). KVM 8 cost: ~$25.99/mo. ~73% margin.
- 12-month: $109/mo (renews $209/mo).
- 1-month: $195/mo (renews $279/mo).

**Expenses per client:**
- VPS (Hostinger): $8.99/mo (KVM 2) or $25.99/mo (KVM 8).
- Twilio/inworld.ai: ~$5-20/mo (usage-dependent; inworld.ai Mini at $5/1M chars).
- Dashboard (Vercel/Supabase): Free Tier (Scalable).

**Commitment policy:** 30-day cancel window from initial purchase date for all plans.

*Enterprise tier: contact for custom pricing*

-----

### 📄 getting-started-checklist.md

- [ ] Sign up for Hostinger API Access.
- [ ] Create Supabase project (DB + Auth + Edge Functions).
- [ ] Build Docker Gold Images (Ubuntu + Ollama + Rowboat). Two images: KVM 2 (Starter) + KVM 8 (Standard).
- [ ] Configure inworld.ai API key and create default voice agent.
- [ ] Verify Lightpanda WSS connectivity.
- [ ] Setup Cloudflare Tunnel for secure remote management.
- [ ] Create 6 Stripe Price IDs (2 tiers × 3 periods).
- [ ] Create the first `soul.md` for a Real Estate client.

-----

### 📄 enhanced_competitive_analysis.md

- **Legacy Agency:** Human-only, high cost, inconsistent reply times.
- **ChatGPT/Claude Bots:** No persistent business memory, prone to data leakage, "generic" personality.
- **Our "Local Fortress" Advantage:** Total data privacy, "Human-level" context maintenance (DAG memory), and local speed that beats any API-based bot. Two-tier entry (loss-leader Starter at $9.99/mo) creates a wide funnel.

-----

### 📄 file-structure.md

```text
/agency-dashboard (Next.js/Vercel)
/client-provisioning (Supabase Edge Functions)
/vps-gold-image-starter (Hostinger KVM 2 — Rowboat + Llama 3.2 3B)
/vps-gold-image-standard (Hostinger KVM 8 — Rowboat + full model set)
    /ollama_models/
    /rowboat/
        /vault/ (soul.md, identity.md, memory.md)
        /memory/
```
