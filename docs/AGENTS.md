# Agentic AI in MediLink

**Rule:** agents propose, rules verify, humans approve.

The agents sit on top of the existing MediLink engine. They never get past the 8 hard rules or approve a transfer, and they never write to stock on their own. Everything works with `LLM_PROVIDER=none`: each agent then runs on rules only, with the same tools and data. Switch on SAP AI Core (`LLM_PROVIDER=aicore`) or any OpenAI-compatible model and the model plans the tool calls and writes the text, inside the same guardrails.

Code: `backend/srv/lib/agents/`. Tests: `backend/test/agents.test.js` (19 tests, fake LLM, no credentials).

## What was built (from "Agentic AI in MediLink: where to add it", steps 1, 4, 5 and 7)

| Step | Agent | File | Trigger | Output | Who decides |
|---|---|---|---|---|---|
| 7 | Pharmacist copilot | `copilot.js` | Home → **Ask MediLink** (`ask-copilot`) | Answer + sources + confidence (or one clarifying question) | Read-only, nothing to decide |
| 4 | Planner + compliance + critic | `planner.js` | Choose-supplier task → **Check plans with AI** (`review-plans`) | Recommended plan, "why this plan", trade-offs, failed plans with reasons | Pharmacist taps "Ask …" (`choose-plan`) |
| 5 | Logistics watchtower | `watchtower.js` | Temperature excursion or broken seal (`delivery.telemetry`), no open road or late ETA (`delivery.replan`, which also runs after Open-Meteo rain closures and manual "Road closed" reports) | **AI suggestion** card with options; drafted incident report | Receiving pharmacist: **Approve** or **Dismiss** |
| 1 | Intake helper | `intake.js` | Stock → **Paste a stock list** (`intake-text`) | Rows mapped to the medicine master, rejected lines with reasons, one clarifying question | Pharmacist: **Save these rows** (`confirm-photo`) |

Steps 2, 3, 6, 8 and 9 (forecasting, surplus matchmaking outreach, approval co-pilot, trust-feed triage, network learning) are the roadmap. The existing photo reader (`photo.js`) and trust-feed parser (`trust.js`) already use the LLM the same way.

## How one agent run works (`runner.js`)

```
question / event
   │
   ▼
LLM on?  ── no ──► rules path: intent router or fixed thresholds → same tools → template text
   │yes
   ▼
model replies JSON: {"tool": name, "args": {...}}  or  {"final": {...}}
   │
   ├─ tool on this agent's whitelist? no → error back to model (logged)
   ├─ run the read-only tool (scoped to the user's hospital) → result back to model
   ├─ audit: AGENT_TOOL {run, step, tool, args, ok}
   └─ step cap AGENT_MAX_STEPS → then fall back to the rules path
   │
   ▼
guard: every number in the answer must appear in the tool results → otherwise the rules answer is used
   │
   ▼
AgentRuns row + audit AGENT_RUN
```

## Tools (`tools.js`, all read-only)

| Tool | Reuses | Returns |
|---|---|---|
| `cover_outlook(days)` | cover engine (`coverdb.board`) | medicines short within N days: shortfall, booked, usable stock, first short date, patient **count** |
| `expiring_lots(days)` | `coverdb.nearExpiry` | batches expiring within N days, with surplus that could be offered |
| `find_lenders(drug, maxKm, qty)` | `matching.evaluate`: the 8 hard rules | hospitals that can lend now, vials, km, minutes; number of lots the rules ruled out |
| `stock_of(drug)` | Lots | our batches of a medicine |
| `open_deliveries()` | Transfers | open deliveries: status, ETA, temperature problem, road closed |

No tool returns a patient reference: prompts carry counts only. The test checks that no 64-character hash ever reaches the model.

## Guardrails, and where they are enforced

| Guardrail | Enforced in |
|---|---|
| Humans approve every transfer, flag and dispatch | Agents only write `AgentProposals`; `approve-proposal` runs **one existing action** as the approving user, through that action's own role check and input validation (`proposals.js`) |
| Narrow, read-only tools; no free-form database writes | Whitelist per agent (`tools.pick`); unknown tools are refused and logged |
| The LLM never picks a plan the rules rejected | `planner.js`: a pick outside the verified set is overridden, and the explanation says so |
| No invented numbers or batches | `runner.numbersGrounded` (copilot, planner); `notes.factsPreserved` (incident report rewording); intake keeps a row only if its batch is in the pasted text |
| Dates and quantities validated in code, not by the model | `intake.validate`: medicine in master (name + strength), real future expiry, whole-number quantity |
| Ask when unsure | Copilot returns `question` + `confidence: low`; intake asks one clarifying question (for example which strength) |
| Every proposal, tool call and decision is logged | Hash-chained audit: `AGENT_TOOL`, `AGENT_RUN`, `AGENT_PROPOSED`, `AGENT_PROPOSAL_APPROVED/REJECTED`, `INCIDENT_REPORT` |
| Off switch | `AGENTS_ENABLED=false`: no AI buttons, no suggestions, the existing flow is unchanged |

## Data

Two new tables (`db/schema.cds`): `AgentRuns` (agent, hospital, mode llm/rules, steps, output) and `AgentProposals` (kind, title, detail, draft report, action to run on approval, status, who decided). On start-up the server adds them to an existing `db/medilink.sqlite` (`agents/schema.js`), so no reset is needed.

## API

| Call | Who |
|---|---|
| `POST /me/actions/ask-copilot {question}` | pharmacist, approver |
| `POST /me/actions/review-plans {requestId}` | requesting pharmacist |
| `POST /me/actions/intake-text {stockText}` → `confirm-photo {previewId}` | pharmacist |
| `POST /me/actions/approve-proposal {proposalId, note?}` / `reject-proposal` | pharmacist, approver (own hospital), admin |
| `POST /me/actions/agent-recheck-route {transferId}` (run on approval of a no-open-road suggestion) | pharmacist, admin |
| `GET /me/agents` | recent runs and suggestions for my hospital (admin: all) |

Home tasks carry agent suggestions as `kind: "agent_proposal"` (with `report` when there is a draft incident report). The choose-supplier task carries `agentAction` ("Check plans with AI").

## Demo script (2 minutes, `LLM_PROVIDER=none`)

1. Sign in as `lata` / `demo`. In **Ask MediLink**, tap "Which drugs will run short in the next 10 days?". Answer, source and "Sure · MediLink rules".
2. Ask "Who can lend carboplatin within 15 km?". Only hospitals that pass the 8 safety rules are named.
3. The simulator (or a courier link) sends a hot reading for the trastuzumab delivery. An **AI suggestion** appears: hold for a quality check, with a draft incident report. **Approve**: the report is filed in the audit chain and both pharmacies are told.
4. Sign in as `asha`, connect MediSoft, send the carboplatin request, tap **Check plans with AI**: "why this plan", what was checked, then **Ask Banashankari…**.
5. Stock → **Paste a stock list**: paste a few lines from a message. Unclear lines are explained, one question is asked, and you save the rest.

With SAP AI Core keyed, the same screens say "AI model" instead of "MediLink rules".

## Building it on SAP (free tier)

- **SAP AI Core generative AI hub** is the model behind `LLM_PROVIDER=aicore` (already wired in `llm.js`, `@sap-ai-sdk/foundation-models`).
- **SAP Build Process Automation**: approvals can already run there (`APPROVAL_MODE=bpa`); agent proposals could be routed the same way.
- **Joule Studio / Joule agents** need SAP entitlements the Hackfest practice system may not include, so they are not built here. The tool list above maps one-to-one to Joule skills if they become available.
