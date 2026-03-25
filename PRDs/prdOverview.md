### 📄 prd-overview.md

**Product Name:** New Coworker(v1.0)
**Core Mission:** Empower small businesses with privacy-first, autonomous "Digital Employees" that operate within their own dedicated, secure, local infrastructure.
**Strategic Vision:** Moving beyond the "chatbot" paradigm, our agents utilize deep reasoning, permanent file-based memory (Lossless Claw), and local inference to act as a genuine extension of the business owner’s intent. We solve the primary pain point of small business owners: the lack of time to manage the "chaos of the gap" between contract signing and deal closure. By automating the cognitive load—lead qualification, transaction coordination, and market analysis—our agents do not just respond; they act, update CRMs, and communicate across channels.
**Target Market:** Small businesses, starting with Real Estate agents.
**Core Differentiators:** 1. **Local-First Fortress:** Zero data egress for inference; full compliance with data privacy and HIPAA.
2\. **Permanent Memory (DAG):** Agents build a hierarchical DAG of business facts, preventing the "forgetfulness" of standard LLMs.
3\. **No-OpenRouter Dependency:** Full local operation prevents "ambiguous costs" and supply chain attacks.

-----

### 📄 prd-mvp-implementation.md

**Goal:** Deliver the first "Coworker" VPS instance for real estate business executive.
**Phases:**

1.  **Infrastructure Foundation:** Deploy Hostinger KVM 8 instance. Configure Ubuntu 24.04, harden SSH, and install Docker/Ollama.
2.  **Agent Provisioning:** Use the "Gold Image" (OpenClaw + Bifrost) to spin up the agent environments.
3.  **Soul Injection:** Upon account creation, use a simple question bot configured with our open router account to gather information for md files. Then inject `soul.md`, `identity.md`, and `memory.md` into business account’s instance.
4.  **Integration Layer:** Link Twilio and ElevenLabs keys. Establish Cloudflare Tunnels to our Next.js dashboard.
5.  **Memory Initialization:** Load initial the business's account data into LanceDB.
6.  **Beta Testing:** "Human-in-the-loop" phase where agents draft responses for manual owner approval. Using safe-mode: communication with account owner and not the clients of the business account

*Account creation for a business should be 100% automated*
-----

### 📄 prd-account-experience.md

**Account Onboarding Flow:**

1.  **Discovery:** New Business account fills out a Next.js-based "Business Questionnaire/Account creation details then chats with our new coworker creation bot."
        Some cause and effect instances to show how a direction of a chat may need to flow if they say they are a real estate agent:
            Cause: Real estate agents texting regarding if their offer is getting accepted. Once my seller‘s offer has been accepted by my seller, other buyer’s agents keep it inquiring if it’s still available. 
            Effect: I’m sorry the home is under contract. We will hang onto your offer for backup purposes. 
            Cause: Leads come in from various sources 
            Effect: Ask when do they want to see the property on (address). Give my bio info. Then route lead to team member based on memory on team member.
            Cause: Multiple offers received on a listing
            Effect: (address) multiple offers received, offers will be reviewed on later date (date)
            Cause: Listing shown as seen on Aligned showings
            Effect: Showing agent for feedback: Re: (address) Do you have any feedback from your showing? Are you interested in making an offer? Are there any objections we need to overcome to be at the top of your list? Can we expect an offer? Let’s make a deal! I’m flexible & excellent to work with and you’ll have a seamless transaction! 
            Cause: Showing booked on Aligned showings
            Effect: (address) is available. Please use Aligned Showings to schedule your appointment. Please make an offer! I’m excellent to work with; flexible with extensions & deadlines & encourage all repairs on BINSR (unless it’s a Shortsale). I’m a total dealmaker & you’d have a seamless transaction! Please be sure to enter through the ARMLS lockbox even if the homeowner is home. 
            Cause: Greeting or Ending conversation with real estate client
            Effect: Use text signature = Thanks, Amy Laidlaw ~ HomeSmart 😊 
            
2.  **Auto-Provisioning:** Upon payment, the system triggers the Hostinger API to purchase/provision the KVM 8 instance.
3.  **Dashboard Activation:** The new user is provided a secure dashboard link and can access their dashboard anytime with their login creds. They see their Coworker "Status" (Online/Offline), "Recent Tasks", "Sessions", "Agent Chat", "Usage", "Memory", plus anything else you deem used from their fascade view.
4.  **Management:** Owners can click "View Memory" to see a human-readable list of what the Coworker has learned about their business. They can "Revoke/Edit" memories, creating a feedback loop of trust.

-----

### 📄 technical-architecture-prd.md

**The Stack:**

  * **Routing:** Bifrost (Go-based) handles traffic; no dependencies on external middleware (Do not use LiteLLM).
  * **Model Orchestration:** Ollama serves all inference.
  * **Reasoning Swarm:** \* *Drafting:* Qwen 3.5 7B.
      * *Verification:* Llama 4 Scout 9B.
  * **Storage:** PostgreSQL (Supabase) for logs/metadata; LanceDB for vector memory.
  * **Browsing:** Lightpanda Cloud WSS (Zig-based, low RAM overhead).

**Performance Targets:**

  * TTFT: \<800ms for voice-critical models.
  * Latency: \<1.5s end-to-end (Twilio -\> LLM -\> ElevenLabs).

-----

### 📄 prd-non-functional-requirements.md

  * **Security:** All VPS instances must have firewall rules allowing traffic *only* to verified Twilio/ElevenLabs/Supabase endpoints.
  * **Compliance:** System prompts must strictly include Fair Housing Act (FHA) compliance guardrails for all real estate agents. Compliance needs to be able to expand to other job fields.
  * **Data Sovereignty:** All conversation transcripts are stored locally on the client's VPS. Only "Log metadata" (not raw sensitive text) is sent to the Vercel dashboard.
  * **Resiliency:** Automated heartbeat check every 60 seconds; if an agent is unresponsive for 3 failed heartbeats then automate restart if still failing contact admin 

-----

### 📄 prd-functional-requirements.md

1.  **Voice Gateway:** Bi-directional handling of calls via Twilio.
2.  **Smart Lead Triage:** Analyze inquiry intent within 3 seconds of connection.
3.  **Task Delegation:** Automated updating of local spreadsheets (Google Sheets/Excel) and CRM entries (e.g., Follow Up Boss).
4.  **Swarm Reasoning:** Ability to run multi-model checks for high-value deal amendments.
5.  **Notification Engine:** Trigger SMS/Email to business owner for task-completion updates.

-----

### 📄 cash-flow-management-prd.md

  * **Revenue:** $499 setup fee (provisioning) + $299/mo (VPS hosting, maintenance, memory updates).
  * **Expenses:** \* VPS (Hostinger): $25/mo/client.
      * Twilio/ElevenLabs: $40-$80/mo (usage-dependent).
      * Dashboard (Vercel/Supabase): Free Tier (Scalable).
  * **Net Margin Target:** \~65% per client.

*Establish 3 tiers with the info above being the standard tier*
*Starter tier will be no setup fee but no maintenance or updates*
*Third tier will be for enterprise, it will include much more and contact for price*

-----

### 📄 getting-started-checklist.md

  - [ ] Sign up for Hostinger API Access.
  - [ ] Create Supabase project (DB + Auth + Edge Functions).
  - [ ] Build Docker "Gold Image" (Ubuntu + Ollama + Bifrost + OpenClaw).
  - [ ] Verify Lightpanda WSS connectivity.
  - [ ] Setup Cloudflare Tunnel for secure remote management.
  - [ ] Create the first `soul.md` for a Real Estate client.

-----

### 📄 enhanced\_competitive\_analysis.md

  * **Legacy Agency:** Human-only, high cost, inconsistent reply times.
  * **ChatGPT/Claude Bots:** No persistent business memory, prone to data leakage, "generic" personality.
  * **Our "Local Fortress" Advantage:** Total data privacy, "Human-level" context maintenance (DAG memory), and local speed that beats any API-based bot.

-----

### 📄 file-structure.md

```text
/agency-dashboard (Next.js/Vercel)
/client-provisioning (Supabase Edge Functions)
/vps-master-image (Hostinger)
    /ollama_models/
    /bifrost_router/
    /openclaw_gateway/
    /data/
        /clients/
            /[uuid]/
                /soul.md
                /identity.md
                /memory.md (LanceDB)
                /learning.md (Swarm logs)
```

-----

### 📄 feature-requirements-prd.md

1.  **Identity Injection:** Ability to swap business identity without redeploying the Docker container.
2.  **Emergency Escalation:** Logic to detect "irate caller" and immediately route the call to the business owner’s mobile number.
3.  **Browser Skills:** Integration with Lightpanda to verify MLS listing data before responding.

-----

### 📄 go-to-market-prd.md

  * **Phase 1 (Validation):** Onboard 3 Real Estate users in your local area. Document performance metrics (TTFT, lead qualification rate, ROI).
  * **Phase 2 (Automation):** Launch the "New Coworker" dashboard for owners.
  * **Phase 3 (Scaling):** Target Dental and HVAC niches, using the real estate case studies to prove ROI.

-----

### 📄 operational-plan-prd.md

  * **Monitoring:** Next.js dashboard polls Supabase for agent "Status."
  * **Support:** Ticket management linked to the `coworker_logs` table.
  * **Updates:** Automated pull requests to the VPS "Gold Image" and rolling redeployments across the agency.

-----

### 📄 technical-debt-management-prd.md

  * **Immediate:** Document every `soul.md` modification for reproducibility.
  * **Ongoing:** Automated log pruning in `memory.md` every 30 days to keep the LanceDB lightweight.
  * **Versioning:** Pin all software versions (Ollama, OpenClaw, Docker images) in the deployment script to prevent unexpected breaking changes.

-----

### 📄 prd-business-creation.md

  * **Entity:** Register as a Managed IT/Automation Agency.
  * **Legal:** Require all new users to sign a "Data Usage & AI Liability Waiver" (Standard for brokers).
  * **Partnership:** Establish a recurring credit-loading system for Twilio/ElevenLabs to ensure the "New Coworker" never runs out of "voice budget."

