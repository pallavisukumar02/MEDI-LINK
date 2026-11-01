**MediLink**

Product Requirements Document

*Critical-drug shortfall detection and safe inter-hospital transfer,
built on SAP CAP and SQLite using free services only*

| **Field**       | **Value**                                                                                                                             |
|-----------------|---------------------------------------------------------------------------------------------------------------------------------------|
| Event           | SAP Hackfest 2026 · Theme: Resilient Supply Chains · Bengaluru                                                                        |
| Version         | 1.1 (supersedes 1.0 of 31 October 2026)                                                                                               |
| Date            | 1 November 2026                                                                                                                       |
| Status          | Approved for build                                                                                                                    |
| Scope           | Prototype (P0) and pilot (P1) requirements                                                                                            |
| Cost constraint | Free services only: open-source software (SAP CAP, SQLite, OR-Tools), free public APIs, any free or low-cost Node.js + Python host; optional SAP services on free plans only |

## Changes in 1.1

| **Area**          | **1.0**                                   | **1.1**                                                                                                             | **Sections**    |
|-------------------|-------------------------------------------|---------------------------------------------------------------------------------------------------------------------|-----------------|
| Hosting           | SAP BTP, Cloud Foundry                    | Any Node.js + Python host; no SAP BTP account needed                                                                | 13, 14, 18      |
| Database          | SAP HANA Cloud                            | One SQLite file on a persistent disk, with backups                                                                  | 11, 12, 13      |
| Login             | XSUAA                                     | MediLink accounts; only pharmacy staff and the MediLink admin sign in                                               | 12, 13, FR-30   |
| Hospital tokens   | BTP Destination service                   | Encrypted (AES-256-GCM) in the MediLink database                                                                    | 5, 12           |
| SAP services      | Required platform                         | Optional integrations, off by default: SAP AI Core, SAP Build Process Automation, SAP Alert Notification, SAP Business Accelerator Hub sandbox | 13, 14, 15 |
| Delivery partner  | Signs in to a Partner app                 | Opens a per-delivery courier link; no account                                                                       | 4, 6, 7, 10, FR-31 |
| Tracking          | GPS + temperature pushed to the receiver  | Food-delivery-style live tracking: map, route, rider position, live ETA, steps, temperature                         | 6, 7, FR-32     |
| Monitoring        | Shortfall alerts, near-expiry list        | Stock and expiry monitoring with alerts to the hospital's own pharmacy staff                                       | 7, 10, 11, FR-29 |
| User apps         | SAP UI5 / Fiori elements                  | MediLink web app (HTML/JS on the `/me` experience API) + courier page                                               | 13, 14          |

# 1. Executive summary

MediLink tells a hospital, days in advance, which booked treatments its
stock cannot cover, then finds the nearest licensed hospital with
genuine surplus and moves verified, sealed stock through a cold-chain
delivery partner. Every step is approved by a human and recorded in a
tamper-evident audit log.

The pharmacist needs no technical knowledge: they onboard with their
drug licence number and one "Allow" tap, and after that send requests in
one tap from a prefilled screen.

## Five differentiators

| **Differentiator**           | **What it means**                                                                                                                  |
|------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| Scheduled-demand cover       | The shortage trigger is booked patients, not an average usage rate: "31 patients booked in the next 14 days cannot be covered".    |
| Batch passport + trust check | Brand, manufacturer, batch, expiry and storage condition travel with every lot. Flagged, recalled or spurious lots can never move. |
| Proof of condition           | Temperature trace and seal status attach to every delivery so the receiving pharmacist can verify the drug stayed in range.        |
| Lending ledger               | Donors are repaid in kind or at landed cost, which answers why a hospital would give up stock.                                     |
| One-number onboarding        | Pharmacist enters only their drug licence number and taps Allow. No links, no SAP knowledge, no CSV uploads.                       |

# 2. Problem statement

Bengaluru hospitals discover critical-drug shortages only when shelves
are nearly empty, while usable stock sits unevenly across the city.
Chemotherapy runs on fixed 2–3 week cycles, so a delay of a few days can
disturb a treatment plan. No shared, batch-level view shows which
hospital holds what, how many booked treatments it must cover, how long
stock will last, and whether surplus can be moved safely and legally.
Pharmacists fill the gap with phone calls and WhatsApp messages, and
disruptions such as floods make it worse.

## Evidence

- **Shortage (June 2026):** a shortage of platinum chemotherapy drugs
  (cisplatin, carboplatin, oxaliplatin) affected treatment schedules
  across India, including some Bengaluru hospitals, while one public
  cancer hospital still held stock but was unsure how long it would
  last. This is the uneven-distribution problem MediLink targets.

- **Counterfeit risk (September 2026):** a Bengaluru Police SIT and the
  Drugs Control Department allege a network supplied fake or repackaged
  cancer drugs and ICU injections to more than 90 hospitals and clinics.
  Investigators have not said these hospitals knowingly bought or used
  them. This shows unverified stock is itself a risk.

- **Floods:** a Bengaluru-area government hospital was inundated with
  patients and doctors stranded for hours, and the 2022 floods submerged
  roads across the city, disrupting supply routes.

## What MediLink does not solve

Matching does not create supply during a national shortage. It reduces
local stockouts caused by uneven distribution, prioritises scarce stock
by scheduled need, sends an early demand signal upstream to distributors
and the state medical supplies body, and reduces expiry waste in normal
times.

# 3. Goals, non-goals and success metrics

## Goals

1.  Detect a shortfall as soon as booked doses exceed safe stock, not
    when shelves empty.

2.  Move only genuine, sealed, in-date, licensed stock; never a flagged
    lot.

3.  Make onboarding and requesting simple enough for a pharmacist with
    no technical knowledge.

4.  Give the receiving hospital proof the drug stayed in its storage
    range.

5.  Make giving stock fair for donors through repayment.

6.  Run the entire prototype on free services.

## Non-goals

- Creating supply during a national shortage.

- Deciding which patient is treated; that stays a clinical decision.

- Replacing the hospital's pharmacy, billing or scheduling system.

- Selling drugs to patients or retail pharmacies.

## Success metrics (pilot targets, to validate with partner hospitals)

| **Metric**                                                   | **Target**                         |
|--------------------------------------------------------------|------------------------------------|
| Lead time between shortfall alert and first affected booking | 7 days or more for scheduled drugs |
| Request to supplier acceptance                               | Median under 2 hours               |
| Flagged, expired or unlicensed lots moved                    | 0                                  |
| Deliveries with a complete temperature trace                 | 100%                               |
| Booked doses delayed by stockout at pilot hospitals          | Lower than 3-month baseline        |
| Pharmacist onboarding time                                   | Under 2 minutes                    |
| Near-expiry stock written off                                | Lower than baseline                |

# 4. Users and personas

| **Persona**                              | **Context**                           | **Needs**                                     | **Pain today**                      |
|------------------------------------------|---------------------------------------|-----------------------------------------------|-------------------------------------|
| Requesting pharmacist                    | Runs oncology pharmacy; not technical | See gaps, low stock and expiring lots early; get stock in one tap; watch it arrive | Finds shortages late; calls around  |
| Supplying pharmacist                     | Holds surplus; protects own patients  | Proof own bookings stay covered; repayment    | Giving stock feels risky and unpaid |
| Approver (chief pharmacist / oncologist) | Accountable for safety                | Clear reason per plan; quick sign-off         | Informal transfers with no record   |
| Delivery partner                         | Licensed cold-chain carrier; no MediLink account | One link per delivery: pickup scans, live location, road-closed report | No standard handover                |
| Hospital IT / software vendor            | Maintains pharmacy system             | One-time, read-only, safe connection          | Custom integrations per partner     |

Clinical decisions stay with clinicians: MediLink shows which booked
patients are affected first but never decides who is treated.

Only pharmacy staff (pharmacists and approvers) and the MediLink admin
sign in. The delivery partner never gets an account: each delivery
comes with its own courier link (FR-31).

# 5. Onboarding: licence number + Allow

The pharmacist onboards in under a minute with one number they already
know and one tap.

1.  **Enter drug licence number** (printed on the licence displayed in
    the pharmacy).

2.  MediLink looks it up in its hospital directory: finds the hospital,
    confirms the licence is valid, and recognises the pharmacy software.
    Screen: "City Cancer Hospital, Jayanagar · Licence valid till 2028 ·
    Your stock is in MediSoft HIS."

3.  **Tap "Allow MediLink to read stock and chemo bookings".** The
    hospital software's usual login opens in a popup; the pharmacist
    signs in as they do daily; a permission screen lists exactly what is
    shared (stock and batch details, chemo schedule, no patient names).

4.  On Allow, the hospital software issues MediLink a read-only access
    token (OAuth 2.0 authorization code flow with PKCE). MediLink stores
    it encrypted in its own database and syncs every 15 minutes.

5.  **Done.** "Your board will be ready in a few minutes." A Disconnect
    button revokes access at any time. Every consent is written to the
    audit log.

## Behind the Allow button

| **Hospital situation**             | **Who does the work**                                | **How**                                                                                                         |
|------------------------------------|------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| Runs SAP or a partnered HIS vendor | Vendor or hospital SAP admin, once                   | MediLink registered once as an OAuth app per vendor; every hospital on it then gets one-tap                     |
| In-house database                  | Hospital IT                                          | MediLink auto-sends IT a setup link for a small read-only connector; pharmacist sees "Waiting for your IT team" |
| Software not recognised            | Pharmacist picks from a dropdown or "Ask my IT team" | Routes to one of the paths above                                                                                |
| Nothing digital                    | Pharmacist                                           | Upload daily stock sheet or a photo of the register; the LLM extracts it for review                             |

An expired or unknown licence stops onboarding with a clear message. The
licence number therefore does double duty: it identifies the hospital
and proves it is licensed before it can ever send or receive stock.

# 6. End-to-end user flow

The requesting pharmacist touches only steps 1, 3 and 8. Everything else
is automatic or handled by the supplier, approver and delivery partner.

| **Step**                          | **Actor**                       | **Input**                                     | **Output**                                                         | **SAP / tech**                              |
|-----------------------------------|---------------------------------|-----------------------------------------------|--------------------------------------------------------------------|---------------------------------------------|
| 1\. Onboard                       | Pharmacist                      | Licence number; Allow tap                     | Hospital connected; consent logged                                 | CAP, SQLite, encrypted token store          |
| 2\. Auto-sync and monitor         | MediLink                        | Stock, batches, bookings from hospital system | Coverage % per drug; surplus per hospital; "last synced" time; low-stock and expiry alerts | CAP scheduled job, SQLite                   |
| 3\. Shortfall alert and request   | Pharmacist                      | Tap red row; confirm prefilled request        | "16 of 40 doses short, 9 patients affected first"; request created | MediLink web app; in-app + email alerts (optional SAP Alert Notification) |
| 4\. Trust check, hard rules, rank | MediLink                        | Request + all lots city-wide                  | Ranked eligible plans with a reason each                           | CAP rules + OR-Tools service                |
| 5\. Supplier accepts              | Supplying pharmacist + approver | Accept/decline, quantity, repayment; approve  | Transfer approved; loan logged; fallback if declined               | CAP workflow (optional SAP Build Process Automation) |
| 6\. Cold-chain pickup             | Delivery partner (courier link) | Scan batch, seal, temperature logger          | Custody recorded                                                   | Courier page (phone browser), CAP           |
| 7\. Live tracking                 | Receiver (watching)             | None                                          | Map with route, rider position, live ETA and temperature; excursion alert; re-plan if road closes | CAP WebSocket, live map, OpenRouteService, Open-Meteo |
| 8\. Arrival, verify, ledger       | Receiving pharmacist            | Scan batch, seal check, quantity              | Proof-of-condition pass/fail; coverage turns green; ledger entry   | CAP, hash-chained audit log in SQLite       |

# 7. User stories

1.  As a pharmacist, I enter my drug licence number and tap Allow, so my
    hospital is connected without technical steps.

2.  As a pharmacist, I see which critical drugs cannot cover booked
    doses in the next 14 days, so I act before patients are delayed.

3.  As a pharmacist, I open a shortfall and see which booked patients
    are affected first, so the clinician can prioritise.

4.  As a pharmacist, I send a prefilled request in one tap, so I do not
    retype anything.

5.  As a pharmacist, I see ranked plans with a plain-language reason
    each, so I trust the choice.

6.  As a supplying pharmacist, I see my own bookings stay covered after
    giving, so I can accept safely.

7.  As a supplying pharmacist, I choose repayment in kind or at landed
    cost, so giving is fair.

8.  As an approver, I approve from my inbox, with a second sign-off
    required for risky transfers.

9.  As a delivery partner, I open the link sent for this delivery, scan
    batch, seal and logger at pickup and share my live location, so
    custody is recorded without a MediLink account.

10. As a receiving pharmacist, I track the shipment live on a map with
    the rider's position, ETA and temperature, and verify seal and trace
    on arrival.

11. As any user, I can never be offered a flagged, recalled, expired or
    unlicensed lot.

12. As a hospital admin, I can disconnect MediLink at any time.

13. As a pharmacist, I am alerted when a drug falls below its reorder
    level or runs out, and when a lot nears expiry (90/60/30/7 days) or
    expires, so I reorder, use, transfer or remove it in time.

14. As a pharmacist, I choose the email address that receives my
    hospital's alerts, so they reach my pharmacy and no other hospital.

# 8. Functional requirements

P0 = required for the Hackfest prototype demo; P1 = required for pilot;
P2 = later.

| **ID** | **Area**   | **Requirement**                                                                                                | **Priority** |
|--------|------------|----------------------------------------------------------------------------------------------------------------|--------------|
| FR-01  | Onboarding | Onboard with drug licence number only; resolve hospital, licence validity and pharmacy software from directory | P0           |
| FR-02  | Onboarding | Expired or unknown licence blocks onboarding with a plain message                                              | P0           |
| FR-03  | Onboarding | "Allow" runs OAuth 2.0 consent in hospital software; read-only scopes: stock/batches, chemo schedule           | P0           |
| FR-04  | Onboarding | Fallbacks: software dropdown, IT handoff link, sheet/photo upload                                              | P1           |
| FR-05  | Onboarding | Disconnect revokes token instantly; consent and revocation logged                                              | P0           |
| FR-06  | Sync       | Pull stock and bookings every 15 min and on opening a shortfall; show last-synced time                         | P0           |
| FR-07  | Sync       | Grey out a hospital whose feed is silent over 1 hour and alert its admin                                       | P1           |
| FR-08  | Monitoring | Batch passport per lot: generic, brand, manufacturer, batch, expiry, storage class, sealed                     | P0           |
| FR-09  | Monitoring | Expiry watch: lots expiring within 60 days listed and offered first as surplus                                 | P1           |
| FR-10  | Monitoring | Licence watch: renewal reminder 30 days before expiry for hospitals and partners                               | P1           |
| FR-11  | Cover      | Scheduled-demand cover per drug: sealed in-date stock vs booked doses over 7/14/21 days                        | P0           |
| FR-12  | Cover      | Cover board sorted red first; alert on new shortfall                                                           | P0           |
| FR-13  | Cover      | Shortfall card lists affected bookings with curative intent flagged; no treatment decisions                    | P0           |
| FR-14  | Request    | One-tap request prefilled with drug, quantity, needed-by date; brand-substitution toggle                       | P0           |
| FR-15  | Trust      | Flag table fed by CDSCO drug alerts and recalls; flagged batches never eligible                                | P0           |
| FR-16  | Matching   | Apply all 8 hard rules (section 9) before ranking                                                              | P0           |
| FR-17  | Matching   | OR-Tools ranks passing plans: nearest, fewest transfers, near-expiry preferred; reason text per plan           | P0           |
| FR-18  | Supplier   | Supplier sees post-transfer cover of own bookings; accepts/declines, sets quantity and repayment               | P0           |
| FR-19  | Supplier   | Decline or 30 minutes of silence routes to next ranked supplier automatically                                  | P1           |
| FR-20  | Approval   | Approver sign-off; second sign-off when risk rules trigger (cold chain, near expiry, long route)               | P0           |
| FR-21  | Delivery   | Partner assigned only if licensed and cold-chain certified for the lot's storage class                         | P0           |
| FR-22  | Delivery   | Pickup scan: batch, seal, temperature logger ID                                                                | P0           |
| FR-23  | Tracking   | Live GPS + temperature to receiver; re-plan if route closes                                                    | P0           |
| FR-24  | Tracking   | Temperature excursion alerts both hospitals and suggests quarantine                                            | P0           |
| FR-25  | Receipt    | Arrival scan, seal check, quantity, proof-of-condition pass/fail; coverage updates                             | P0           |
| FR-26  | Ledger     | Loan recorded on acceptance; settled in kind or at landed cost                                                 | P0           |
| FR-27  | Audit      | Hash-chained log of consents, requests, approvals, custody and receipt, with verify-chain check                | P0           |
| FR-28  | Upstream   | City view of aggregated, anonymised shortfalls for distributors and state medical supplies body                | P1           |
| FR-29  | Monitoring | Stock and expiry monitoring: reorder level per hospital and drug; low-stock and out-of-stock alerts; expiry alerts at 90/60/30/7 days and on expiry; deduplicated, acknowledgeable, resolved automatically when fixed; in-app and as one email digest to the hospital's own pharmacy staff | P0 |
| FR-30  | Access     | Pharmacist-only portal: only pharmacy staff (pharmacist, approver) and the MediLink admin sign in; delivery partners have no accounts | P0 |
| FR-31  | Delivery   | Per-delivery courier link: secret, scoped to one delivery, expiring, revocable; emailed to the partner's dispatch address and shareable by the supplier; phone page for the pickup scan, live GPS and "road closed"; no sign-in | P0 |
| FR-32  | Tracking   | Live tracking for the receiving hospital, food-delivery style (Swiggy/Zomato): map with route and rider position, live ETA, delivery steps, temperature | P0 |

# 9. Hard rules and trust check

A candidate lot must pass every rule before OR-Tools ranks it. Any
failure excludes it, and the reason is logged.

| **\#** | **Rule**                        | **Check**                                                                                     |
|--------|---------------------------------|-----------------------------------------------------------------------------------------------|
| 1      | Genuine surplus                 | Offered quantity ≤ supplier stock − own booked demand in window − safety margin (default 20%) |
| 2      | Trust check                     | Batch and manufacturer not on any flag (spurious, not of standard quality, recall)            |
| 3      | Sealed and unopened             | sealed = true on the lot                                                                      |
| 4      | Expiry safely after planned use | Expiry date \> needed-by date + buffer                                                        |
| 5      | Storage respected               | Storage class matches; cold-chain partner available for 2–8 °C lots                           |
| 6      | Licensed parties                | Supplier, receiver and delivery partner licences valid on transfer date                       |
| 7      | Same medicine                   | Same generic, strength and dosage form; different brand only if the request allows it         |
| 8      | Road open, on time              | Route open and ETA before needed-by date                                                      |

OR-Tools then selects the best combination among passing plans: nearest
first, fewest transfers, and near-expiry surplus preferred to cut waste.

## Core calculations

- **Shortfall** = booked doses in window − sealed, in-date stock
  expiring after each dose date.

- **Surplus** = stock − own booked demand in window − safety margin.
  Only surplus is ever offered to others.

# 10. User input fields, screen by screen

After onboarding, users type almost nothing: most inputs are taps,
prefilled values or scans.

| **Screen**            | **Who**              | **Field**            | **Type**                                    | **Required**      |
|-----------------------|----------------------|----------------------|---------------------------------------------|-------------------|
| Onboarding            | Pharmacist           | Drug licence number  | Text                                        | Yes               |
| Onboarding            | Pharmacist           | Allow access         | Button + hospital-software login popup      | Yes               |
| Onboarding (fallback) | Pharmacist           | Pharmacy software    | Dropdown incl. "Ask my IT team"             | If not recognised |
| Onboarding (fallback) | Pharmacist           | IT contact           | Phone or email                              | For IT handoff    |
| Cover board           | Pharmacist           | Look-ahead window    | Toggle 7/14/21 days (default 14)            | No                |
| Shortfall card        | Pharmacist           | Open shortfall       | Tap red row or alert                        | Yes               |
| Request               | Pharmacist           | Drug, strength, form | Prefilled                                   | Yes               |
| Request               | Pharmacist           | Quantity needed      | Number, prefilled with shortfall            | Yes               |
| Request               | Pharmacist           | Needed-by date       | Date, prefilled from first affected booking | Yes               |
| Request               | Pharmacist           | Accept another brand | Yes/No (same generic + strength)            | Yes               |
| Request               | Pharmacist           | Note                 | Text                                        | No                |
| Plan choice           | Pharmacist           | Pick plan            | Tap one ranked plan                         | Yes               |
| Supplier review       | Supplying pharmacist | Accept / Decline     | Buttons                                     | Yes               |
| Supplier review       | Supplying pharmacist | Quantity offered     | Number, prefilled; can lower                | Yes               |
| Supplier review       | Supplying pharmacist | Decline reason       | Dropdown + text                             | On decline        |
| Supplier review       | Supplying pharmacist | Repayment preference | In kind / landed cost                       | Yes               |
| Approval              | Approver             | Approve / Reject     | Buttons                                     | Yes               |
| Approval              | Approver             | Reject reason        | Text                                        | On reject         |
| Pickup (courier link) | Delivery partner     | Batch + seal scan    | Barcode                                     | Yes               |
| Pickup (courier link) | Delivery partner     | Logger ID            | Barcode                                     | Yes               |
| Trip (courier link)   | Delivery partner     | Share live location  | Browser location permission                 | Yes, during trip  |
| Trip (courier link)   | Delivery partner     | Road closed          | Button + optional note                      | No                |
| Live tracking         | Receiving pharmacist | (none: map, ETA, steps, temperature) | –                           | –                 |
| Arrival               | Receiving pharmacist | Batch scan           | Barcode                                     | Yes               |
| Arrival               | Receiving pharmacist | Seal intact          | Yes/No                                      | Yes               |
| Arrival               | Receiving pharmacist | Quantity received    | Number, prefilled                           | Yes               |
| Arrival               | Receiving pharmacist | Accept / Quarantine  | Buttons (quarantine suggested on excursion) | Yes               |
| Ledger                | Either pharmacist    | Settle loan          | In kind (link delivery) / mark paid         | When repaying     |
| Stock & expiry        | Pharmacist, approver | Acknowledge alert    | Button                                      | No                |
| Settings              | Approver             | Safety margin        | Percent, default 20%                        | Set once          |
| Stock & expiry        | Pharmacist, approver | Reorder level        | Number per drug (default per medicine)      | No                |
| Settings              | Any signed-in user   | Alert email          | Email (empty = no email)                    | No                |
| Delivery (supplier)   | Supplying pharmacist | Share courier link   | Copy / share button                         | If the courier did not get the email |

# 11. Data model (SQLite, defined in SAP CAP CDS)

These fields arrive automatically from hospital systems after Allow, or
are maintained by MediLink. Nobody types them.

| **Entity**           | **Key fields**                                                                                                        | **Source**                              |
|----------------------|-----------------------------------------------------------------------------------------------------------------------|-----------------------------------------|
| Hospital             | licence_no, name, address, lat, long, licence_valid_till, software, safety_margin                                     | Directory + onboarding                  |
| Drug                 | drug_id, generic_name, strength, dosage_form, critical_flag, reorder_level                                            | National List of Essential Medicines    |
| Lot (batch passport) | lot_id, hospital, drug, brand_name, manufacturer, batch_no, quantity, expiry_date, storage_class, sealed, last_synced | Hospital pharmacy system                |
| Booking              | booking_id, hospital, patient_ref (SHA-256 hashed at source), drug, dose_units, scheduled_date, intent                | Hospital scheduling system              |
| Flag                 | batch_no, manufacturer, drug, reason (spurious / NSQ / recall), source, date                                          | CDSCO drug alerts (LLM-parsed), recalls |
| Licence              | party_id, party_type, licence_no, licence_type, valid_till                                                            | Directory (synthetic in prototype)      |
| Consent              | hospital, scopes, granted_by, granted_at, revoked_at                                                                  | MediLink                                |
| Request              | request_id, hospital, drug, qty, needed_by, allow_brand_switch, note, status                                          | MediLink                                |
| Transfer             | transfer_id, request, from, to, lots, qty, status, approvals, eta, partner, repays_loan                               | MediLink                                |
| ConditionLog         | transfer, timestamp, lat, long, accuracy_m, temperature_c (logger only), seal_status                                  | Delivery partner (courier link, logger) |
| Ledger               | loan_id, lender, borrower, drug, qty, landed_cost, repayment_mode, status                                             | MediLink                                |
| AuditLog             | seq, actor, action, payload, timestamp, hash, prev_hash                                                               | MediLink (hash-chained)                 |
| User                 | username, password_hash, role (pharmacist / approver / admin), hospital, email, disabled                              | MediLink admin                          |
| StockThreshold       | hospital, drug, reorder_level (else the drug's default reorder_level)                                                 | Pharmacist / approver                   |
| Notification         | hospital, kind (out of stock, low stock, expiring, expired, shortfall, …), tier, ref (drug / lot), dedupe_key, acked_at, resolved_at | MediLink                   |
| CourierLink          | transfer, token_hash, encrypted token, expires_at, revoked_at                                                         | MediLink (one live link per delivery)   |

# 12. Non-functional requirements

| **Area**    | **Requirement**                                                                                                    |
|-------------|--------------------------------------------------------------------------------------------------------------------|
| Privacy     | No patient names leave the hospital; patient refs hashed at source; only counts and intent shared across hospitals |
| Access      | Read-only access to hospital systems; least-privilege OAuth scopes (PKCE); role-based access with MediLink accounts (pharmacist, approver, admin); couriers act only through their delivery's link |
| Security    | Hospital tokens encrypted (AES-256-GCM) in the MediLink database; TLS everywhere (HTTPS at the host); no hospital-system credentials typed into MediLink; rate limits on sign-in and costly calls |
| Durability  | One SQLite file on a persistent disk; continuous or daily online backup with a tested restore                      |
| Integrity   | Audit log append-only and hash-chained; every rule exclusion logged with reason                                    |
| Freshness   | Data no older than 15 minutes; forced re-sync before any plan is shown                                             |
| Performance | Cover board loads under 2 s; plans ranked under 10 s for 50 hospitals                                              |
| Reliability | Matching works without the LLM; LLM only parses documents and writes explanations                                  |
| Usability   | Pharmacist flows need no training; inputs prefilled; scans work from a phone camera                                |
| Compliance  | Transfers only between licensed parties via licensed carrier; Indian rules to be verified (section 19)             |
| Cost        | Prototype runs on open-source software and free APIs; optional SAP services on free plans only; never a paid plan  |

# 13. Architecture

All hospital data lands in one SAP CAP service backed by a single
SQLite file. It runs on any Node.js host; matching is a separate Python
service next to it. Approvals, alerts and explanations are built in,
and SAP services can be switched on as optional integrations. Pharmacy
staff use the MediLink web app; couriers use a per-delivery link.

| **Layer**                     | **Components**                                                                              | **Responsibility**                                                        |
|-------------------------------|---------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| Hospital sources              | SAP S/4HANA (OData) · Partner HIS (OAuth REST) · In-house DB connector · Sheet/photo upload | Provide stock, batches and bookings, read-only                            |
| External feeds                | Courier link (GPS) + temperature logger · OpenRouteService · Open-Meteo · CDSCO alert PDFs  | Tracking, routing, weather risk, trust flags                              |
| Core (any Node.js host)       | CAP Node.js service + SQLite file on a persistent disk                                      | Cover calculation, hard rules, stock and expiry monitoring, ledger, audit log, ingestion, OAuth client |
| Matching                      | Python app with Google OR-Tools (same machine or any Python host)                           | Rank eligible transfer plans                                              |
| Workflow                      | Built into CAP (optional: SAP Build Process Automation)                                     | Supplier accept, approver sign-off, 30-min fallback timer                 |
| AI (optional)                 | Off by default; SAP AI Core generative AI hub or any OpenAI-compatible API                  | Parse alert PDFs and stock-register photos; write "why this plan" text    |
| Accounts and alerts           | MediLink accounts · encrypted token store · in-app + email (SMTP) alerts (optional: SAP Alert Notification) | Sign-in and roles, stored hospital tokens, alerts            |
| User apps                     | MediLink web app (pharmacists, approvers, admin) · courier page (per-delivery link)         | All human interaction, phone barcode scans, live map                     |

## Data flow

1.  Hospital system → (OAuth token / connector / OData) → CAP /ingest →
    SQLite tables.

2.  CAP scheduled job recomputes cover every 15 minutes → in-app and
    email alert on a new shortfall.

3.  After every sync, stock and expiry checks → low-stock, out-of-stock
    and expiry alerts to that hospital's pharmacists.

4.  Request → CAP applies hard rules → eligible lots sent to OR-Tools
    service → ranked plans returned with reasons (template, or the
    optional LLM).

5.  Plan chosen → CAP workflow (or SAP Build Process Automation) →
    supplier accept → approver sign-off → transfer created → courier
    link sent to the delivery partner.

6.  Courier link: pickup scans, then GPS/temperature POSTs → CAP →
    WebSocket push to the receiver's live map → excursion alert if out
    of range.

7.  Arrival scan → proof of condition → coverage update → ledger and
    audit entries.

# 14. SAP software used

MediLink is built on SAP CAP (open source) and needs no SAP BTP account
to run. The other SAP services are optional integrations: off by
default, switched on by environment variables, each on its own free-plan
SAP service instance. MediLink works fully without them, using its
built-in fallback.

| **SAP software**                                   | **Used for**                                                | **In MediLink**                    | **Switched on by**                  | **Fallback when off**                         |
|----------------------------------------------------|-------------------------------------------------------------|------------------------------------|-------------------------------------|-----------------------------------------------|
| SAP Cloud Application Programming Model (CAP)      | Backend, OData services, cover view, rules, ingestion       | Required (open-source framework)   | –                                   | –                                             |
| SAP AI Core, generative AI hub                     | Photo reading, alert parsing, note and plan wording         | Optional integration               | `LLM_PROVIDER=aicore`               | Templates; photo reading and alert parsing off (or any OpenAI-compatible API) |
| SAP Build Process Automation                       | Supplier accept, approver sign-off, 30-min fallback         | Optional integration               | `APPROVAL_MODE=bpa`                 | Built-in CAP workflow and timer               |
| SAP Alert Notification service                     | Every alert to SAP Alert Notification channels              | Optional integration               | `ALERT_NOTIFICATION_URL` (+ client id, secret) | In-app alerts + email over SMTP      |
| SAP Business Accelerator Hub (S/4HANA Cloud sandbox) | Stock and batch APIs for the "SAP hospital"               | Optional integration               | `SAP_API_HUB_KEY`                   | Offline copy of the sandbox data              |

## Deliberately not used

- SAP BTP platform services (removed in 1.1): Cloud Foundry runtime,
  SAP HANA Cloud, XSUAA, Destination service, Connectivity service and
  Cloud Connector, app router, SAP Build Work Zone. MediLink runs on
  any host with SQLite and its own accounts instead.

- SAP UI5 / Fiori elements and SAP Business Application Studio: the
  MediLink web app is plain HTML/JS on the `/me` experience API.

- SAP Integration Suite and SAP Event Mesh: replaced by direct REST
  calls and a CAP WebSocket push to stay on free software; named as
  production upgrades.

- SAP Integrated Business Planning, SAP Transportation Management, SAP
  Business Network: referenced only as the production mapping for
  planning, routing and partner visibility.

# 15. APIs

| **Purpose**                | **API**                                                                                   | **Cost**   | **Notes**                         |
|----------------------------|-------------------------------------------------------------------------------------------|------------|-----------------------------------|
| SAP-based hospital stock   | SAP Business Accelerator Hub sandbox: S/4HANA Cloud material stock and batch APIs (OData) | Free       | API key header                    |
| Partnered HIS ("Allow")    | Mock "MediSoft HIS" built by team: Node.js OAuth 2.0 server + REST endpoints              | Free       | Simulates vendor consent flow     |
| In-house hospital database | MediLink connector (Python, SQLAlchemy) pushing to CAP /ingest with hospital token        | Free       | SQLite file for demo; any SQLAlchemy database |
| MediLink internal          | CAP OData v4 services: Lots, Bookings, Cover, Requests, Transfers, Ledger, Audit; `/me` experience API; WebSocket | Free | |
| Matching                   | OR-Tools service REST endpoint POST /rank                                                 | Free       | Google OR-Tools (open source)     |
| Distance and drive time    | OpenRouteService (free key) or OSRM on OpenStreetMap                                      | Free       | Used for nearest + ETA rule       |
| Rain / flood risk          | Open-Meteo forecast API (no key)                                                          | Free       | Plus manual "route closed" toggle |
| Delivery partner telemetry | Courier link page (browser geolocation) POSTing GPS to CAP; simulator plays the courier in the demo | Free | One deliberate excursion in demo |
| Live map                   | Leaflet (open source) with OpenStreetMap-based tiles                                      | Free       | Respect the tile provider's usage policy |
| LLM (optional)             | SAP AI Core generative AI hub, or any OpenAI-compatible chat API                          | Free trial / free tier | Off by default; templates without it |
| Notifications              | In-app + email over any SMTP server; optional SAP Alert Notification service API          | Free       | Email off until SMTP is set       |

# 16. LLM usage

The LLM never decides a match or overrides a hard rule. It only reads
documents and writes explanations, so the app keeps working if LLM
access lapses.

1.  Parse CDSCO monthly drug-alert PDFs into structured Flag rows
    (batch, manufacturer, drug, reason).

2.  Map unusual column names during onboarding fallbacks ("ExpDt" →
    expiry_date) for admin confirmation.

3.  Read photos of stock registers for clinics with no system, for
    pharmacist review before saving.

4.  Write the one-line "why this plan" explanation and draft transfer
    notes.

# 17. Data sources

| **Data**                              | **Real-world source**                     | **Prototype source**                              | **Cost** |
|---------------------------------------|-------------------------------------------|---------------------------------------------------|----------|
| Drug master (generic, strength, form) | National List of Essential Medicines      | Seeded from NLEM                                  | Free     |
| Spurious / NSQ flags                  | CDSCO monthly drug alerts                 | Real alerts parsed by LLM + 1–2 hand-made recalls | Free     |
| Hospital stock + batch passports      | Hospital pharmacy system / SAP            | Synthetic (Python Faker), clearly labelled        | Free     |
| Booked chemo cycles                   | Hospital scheduling system                | Synthetic, pseudonymised                          | Free     |
| Pharmacy and partner licences         | State drug controller records             | Synthetic register incl. one expired licence      | Free     |
| Hospital locations                    | OpenStreetMap                             | Real coordinates; stock numbers fictional         | Free     |
| Roads and drive times                 | OpenStreetMap via OpenRouteService / OSRM | Live API                                          | Free     |
| Weather / flood risk                  | Open-Meteo                                | Live API + manual toggle                          | Free     |
| Temperature + GPS                     | Delivery partner loggers                  | Simulated script                                  | Free     |
| Shortage and counterfeit context      | News reports                              | Cited in pitch only, never app data               | Free     |

## Demo seed set

- 5 hospitals: one on the SAP sandbox (SAP path), one on mock MediSoft
  HIS (Allow path), one via the database connector (SQLite file; database path),
  one on sheet upload, one donor with near-expiry surplus.

- One flagged lot, one expired licence, one near-expiry surplus, one
  temperature excursion, one road closure so every rule visibly fires.

# 18. Release plan, build order and demo

| **Release**        | **Scope**                                                                                                    | **Data**                               | **Exit criteria**                         |
|--------------------|--------------------------------------------------------------------------------------------------------------|----------------------------------------|-------------------------------------------|
| Hackfest prototype | All P0 requirements; 5 hospitals; SAP sandbox, mock HIS OAuth, DB connector, sheet upload; simulated courier via courier links | Synthetic, labelled; real CDSCO alerts | 3-minute demo runs end to end |
| Pilot              | P0 + P1; 2–3 hospitals + 1 licensed distributor; real read-only connections; licensed cold-chain carrier     | Real, pseudonymised                    | Legal sign-off; 3 months of metrics       |
| Scale              | Upstream city view; more HIS vendors                                                                         | Aggregated, anonymised                 | Vendor partnerships; production hosting with backups |

## Build order

1.  SQLite schema (CAP CDS) + synthetic seed data.

2.  CAP service with cover view and shortfall calculation; cover board
    (demoable on its own).

3.  Licence-number onboarding + mock MediSoft HIS OAuth Allow flow.

4.  SAP sandbox hospital and laptop-connector hospital feeding the same
    board.

5.  Prefilled request screen + hard-rule filter + OR-Tools ranking with
    reasons.

6.  Supplier accept, approver sign-off, 30-min fallback (built into
    CAP; optional SAP Build Process Automation).

7.  Courier link + simulated courier: GPS + temperature with one
    excursion; WebSocket tracking; live map for the receiver.

8.  Arrival scan, proof-of-condition badge, ledger entry, hash-chained
    audit log with verify button.

9.  Stock and expiry monitoring with alerts to each hospital's pharmacy
    staff.

10. Optional LLM (SAP AI Core or OpenAI-compatible): CDSCO alert parsing
    and "why this plan" text.

11. Full dry run 24 h before; reset the demo database
    (`npm run db:reset`) before presenting.

## 3-minute demo script

1.  Onboard live: type a licence number, tap Allow, sign in to
    "MediSoft", watch the board fill. Try the expired licence: refused.

2.  Carboplatin is red: 16 of 40 booked doses uncovered, 9 patients
    affected first.

3.  Tap Request (prefilled). The flagged lot and unlicensed site drop
    out; the nearest eligible hospital ranks first with its reason.

4.  Switch to supplier: own bookings stay covered; accept; choose
    repayment in kind. Approver signs.

5.  Trigger "road flooded": the route re-plans on the receiver's live
    map. A temperature spike on another shipment raises a quarantine
    alert.

6.  Arrival scan: proof of condition passes, coverage turns green,
    ledger shows the loan, audit chain verifies.

7.  Close on the city view: aggregated shortfalls as an early warning
    for distributors and the state medical supplies body.

# 19. Risks, dependencies and open questions

| **Risk / dependency**                                                 | **Impact**                | **Mitigation**                                                             |
|-----------------------------------------------------------------------|---------------------------|----------------------------------------------------------------------------|
| Legality of hospital-to-hospital transfer in India (not yet verified) | Could block pilot         | Route through a licensed distributor as carrier; legal review before pilot |
| HIS vendors lack OAuth APIs                                           | One-tap Allow unavailable | Connector and upload fallbacks; partner with largest vendors first         |
| National shortage: no surplus anywhere                                | Matching finds nothing    | Position honestly: prioritisation, upstream signal, waste reduction        |
| Generative AI hub access is trial-limited                             | LLM features may lapse    | LLM non-critical; app runs without it                                      |
| SQLite file lost (host without a persistent disk, disk failure)       | Data loss                 | Persistent volume; continuous or daily online backup; restore drill        |
| One SQLite file = one app process                                     | No horizontal scaling     | Enough for pilot scale; move rate-limit counters to shared storage before running several processes |
| Free plans of the optional SAP services differ by account             | Integration unavailable   | Check on day 1; MediLink runs fully on its built-in fallbacks              |
| Courier's browser stops sharing location (no HTTPS, background tab, no signal) | Gaps on the live map | HTTPS hosting; courier keeps the page open; proof of condition checks trace gaps on arrival |
| Data quality in hospital systems                                      | Wrong cover numbers       | Mapping review at onboarding; stale-feed warnings                          |

## Open questions

- Has the June 2026 platinum shortage eased? Verify before citing it as
  ongoing.

- Which Indian licence types and Schedule H conditions apply to
  inter-hospital transfers?

- Who sets the safety margin and second-sign-off thresholds at each
  hospital?

- What landed-cost formula settles the ledger?

- Confirm generative AI hub trial availability and dates on the team
  account (only if the optional SAP AI Core integration is used).

- Who at each hospital maintains reorder levels and the alert email
  addresses?

- Counterfeit case wording: always say "allegedly".

# 20. Sources

- [South First: chemotherapy drug shortage (June
  2026)](https://thesouthfirst.com/health/cancer-care-hit-across-india-as-shortage-of-keychemotherapy-drugs-disrupts-treatment-schedules/)

- [The News Minute: counterfeit cancer drugs in Bengaluru (Sep
  2026)](https://www.thenewsminute.com/karnataka/bengaluru-fake-cancer-drugs-sold-to-hospitals-at-discount-pharmacy-owner-arrested)

- [The Logical Indian: counterfeit case, what is and is not
  known](https://thelogicalindian.com/?p=127132)

- [Deccan Herald: hospital flooding, Bengaluru
  Rural](https://www.deccanherald.com/india/karnataka/bengaluru/ndrf-team-rescues-30-patients-2024371)

- [Al Jazeera: Bengaluru floods
  (2022)](https://aljazeeranews.edgeone.app/news/2022/9/6/indias-tech-hub-bengaluruflooded-after-days-of-torrential-rains)

- [SAP Learning: Hackfest 2026 practice
  system](https://learning.sap.com/practice-systems/hackfest-2026)

- [SAP BTP free tier
  guide](https://sap-skills.pages.dev/learn/sap-btp-free-tier/)

- [SAP AI Core & AI Launchpad free
  tier](https://blogs.sap.com/2022/10/20/sap-ai-core-sap-ai-launchpad-free-tier-is-out-now/)

- [SAP generative AI hub
  trial](https://www.sap.com/products/artificial-intelligence/generative-ai-hub-trial.html)

- [SAP Build Process Automation free tier
  setup](https://developers.sap.com/tutorials/spa-subscribe-booster)
