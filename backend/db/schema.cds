// =====================================================================
// MediLink data model (PRD section 11)
// All seed data shipped with this repo is SYNTHETIC (see db/data/README).
// =====================================================================
namespace medilink;

using { cuid, managed } from '@sap/cds/common';

// ---------- Enums ----------
type StorageClass   : String(10) enum { AMBIENT; COLD; FROZEN; }
type FlagReason     : String(10) enum { SPURIOUS; NSQ; RECALL; }
type ConnectionType : String(15) enum { SAP_SANDBOX; MEDISOFT; CONNECTOR; SHEET; NONE; }
type PartyType      : String(10) enum { HOSPITAL; PARTNER; }
type Intent         : String(12) enum { CURATIVE; ADJUVANT; NEOADJUVANT; PALLIATIVE; }
type RepaymentMode  : String(12) enum { IN_KIND; LANDED_COST; }
type LedgerStatus   : String(10) enum { OPEN; SETTLED; CANCELLED; }
type CoverStatus    : String(6)  enum { RED; GREEN; NONE; }
type RequestStatus  : String(12) enum { OPEN; MATCHED; IN_PROGRESS; FULFILLED; NO_MATCH; CANCELLED; }
type TransferStatus : String(24) enum {
  PENDING_SUPPLIER;          // waiting for supplying pharmacist
  PENDING_APPROVAL;          // supplier accepted, waiting for approver
  PENDING_SECOND_APPROVAL;   // risk rules fired, second sign-off needed
  APPROVED;                  // approved, partner not yet assigned
  ASSIGNED;                  // partner assigned, waiting for pickup
  IN_TRANSIT;                // picked up
  DELIVERED;                 // received, proof of condition passed and accepted
  QUARANTINED;               // received but quarantined
  DECLINED;                  // supplier declined
  TIMED_OUT;                 // supplier silent past the response window
  REJECTED;                  // approver rejected
  CANCELLED;
}
type Decision       : String(10) enum { APPROVE; REJECT; }

// ---------- Directory ----------
entity Hospitals : managed {
  key ID               : String(10);
      licenceNo        : String(30) @mandatory;
      name             : String(120);
      address          : String(200);
      lat              : Decimal(9, 6);
      long             : Decimal(9, 6);
      licenceValidTill : Date;
      software         : ConnectionType;
      safetyMarginPct  : Integer default 20;
      coverWindowDays  : Integer default 14;
      connected        : Boolean default false;
      lastSyncedAt     : Timestamp;
      feedStale        : Boolean default false;
      adminEmail       : String(120);
      licenceCheckedAt : Timestamp; // onboarding step 1 done (licence looked up and valid)
      synthetic        : Boolean default true;
      lots             : Association to many Lots on lots.hospital = $self;
      bookings         : Association to many Bookings on bookings.hospital = $self;
}

entity Drugs {
  key ID           : String(20);
      genericName  : String(80);
      strength     : String(40);
      dosageForm   : String(40);
      criticalFlag : Boolean default true;
      storageClass : StorageClass;
      nlemSection  : String(20);
      unitCost     : Decimal(10, 2); // landed cost per unit, INR (synthetic)
}

/** Batch passport */
entity Lots : managed {
  key ID           : String(40);
      hospital     : Association to Hospitals @mandatory;
      drug         : Association to Drugs @mandatory;
      brandName    : String(80);
      manufacturer : String(120);
      batchNo      : String(40);
      quantity     : Integer;
      expiryDate   : Date;
      storageClass : StorageClass;
      sealed       : Boolean default true;
      quarantined  : Boolean default false;
      source       : String(20); // SEED | SAP_SANDBOX | MEDISOFT | CONNECTOR | SHEET | TRANSFER
      lastSynced   : Timestamp;
}

entity Bookings {
  key ID            : String(60);
      hospital      : Association to Hospitals @mandatory;
      patientRef    : String(64) @assert.format: '^[a-f0-9]{64}$'; // SHA-256, hashed at source
      drug          : Association to Drugs @mandatory;
      doseUnits     : Integer;
      scheduledDate : Date;
      intent        : Intent;
      source        : String(20);
}

entity Flags : cuid, managed {
  batchNo      : String(40);
  manufacturer : String(120);
  drug         : Association to Drugs;
  genericName  : String(80); // as printed on the alert, for unmatched drugs
  reason       : FlagReason;
  source       : String(200);
  date         : Date;
  active       : Boolean default true;
  synthetic    : Boolean default true;
}

entity Licences {
  key ID          : String(20);
      partyId     : String(10);
      partyType   : PartyType;
      licenceNo   : String(30);
      licenceType : String(40);
      validTill   : Date;
}

entity DeliveryPartners {
  key ID                 : String(10);
      name               : String(120);
      licenceNo          : String(30);
      coldChainCertified : Boolean default false;
      storageClasses     : String(40); // comma separated, e.g. "AMBIENT,COLD"
      active             : Boolean default true;
      lat                : Decimal(9, 6);
      long               : Decimal(9, 6);
}

entity Consents : cuid {
  hospital  : Association to Hospitals;
  provider  : String(20);
  scopes    : String(200);
  grantedBy : String(120);
  grantedAt : Timestamp;
  revokedAt : Timestamp;
}

// ---------- Requests and matching ----------
entity Requests : cuid, managed {
  hospital         : Association to Hospitals;
  drug             : Association to Drugs;
  qty              : Integer;
  neededBy         : Date;
  allowBrandSwitch : Boolean default false;
  preferredBrand   : String(80);
  note             : String(500);
  status           : RequestStatus default 'OPEN';
  plans            : Composition of many Plans on plans.request = $self;
  exclusions       : Composition of many Exclusions on exclusions.request = $self;
  transfers        : Association to many Transfers on transfers.request = $self;
}

entity Plans : cuid {
  request   : Association to Requests;
  rank      : Integer;
  legs      : LargeString; // JSON [{hospitalId, lots:[{lotId, qty}], distanceKm, etaMin}]
  totalQty  : Integer;
  transfers : Integer;
  score     : Decimal(12, 3);
  reason    : String(1000);
  engine    : String(30);
  createdAt : Timestamp;
}

entity Exclusions : cuid {
  request  : Association to Requests;
  lot      : Association to Lots;
  hospital : Association to Hospitals;
  rule     : Integer;
  code     : String(40);
  detail   : String(300);
}

entity Transfers : cuid, managed {
  request               : Association to Requests;
  supplier              : Association to Hospitals; // "from"
  receiver              : Association to Hospitals; // "to"
  drug                  : Association to Drugs;
  qty                   : Integer;
  status                : TransferStatus default 'PENDING_SUPPLIER';
  planRank              : Integer;
  lots                  : Composition of many TransferLots on lots.transfer = $self;
  approvals             : Composition of many Approvals on approvals.transfer = $self;
  partner               : Association to DeliveryPartners;
  distanceKm            : Decimal(8, 2);
  etaMin                : Integer;
  eta                   : Timestamp;
  supplierResponseDueAt : Timestamp;
  repaymentMode         : RepaymentMode;
  declineReason         : String(300);
  requiresSecondSignoff : Boolean default false;
  riskReasons           : String(300);
  sealId                : String(40);
  loggerId              : String(40);
  pickedUpAt            : Timestamp;
  deliveredAt           : Timestamp;
  routeClosed           : Boolean default false;
  routeNote             : String(300);
  excursion             : Boolean default false;
  quarantineSuggested   : Boolean default false;
  proofOfCondition      : String(4); // PASS | FAIL
  proofDetail           : LargeString;
  qtyReceived           : Integer;
  transferNote          : String(1000); // handling note for partner + receiver, written on approval
  workflowInstanceId    : String(80);
  conditionLogs         : Association to many ConditionLogs on conditionLogs.transfer = $self;
}

entity TransferLots : cuid {
  transfer : Association to Transfers;
  lot      : Association to Lots;
  batchNo  : String(40);
  qty      : Integer;
}

entity Approvals : cuid {
  transfer  : Association to Transfers;
  level     : Integer;
  approver  : String(120);
  decision  : Decision;
  reason    : String(300);
  decidedAt : Timestamp;
}

entity ConditionLogs : cuid {
  transfer     : Association to Transfers;
  loggedAt     : Timestamp;
  lat          : Decimal(9, 6);
  long         : Decimal(9, 6);
  temperatureC : Decimal(5, 2);
  sealStatus   : String(10); // INTACT | BROKEN
  excursion    : Boolean default false;
}

entity RoadClosures : cuid, managed {
  name     : String(120);
  lat      : Decimal(9, 6);
  long     : Decimal(9, 6);
  radiusKm : Decimal(6, 2);
  source   : String(20); // MANUAL | OPEN_METEO
  active   : Boolean default true;
  transfer : Association to Transfers; // closure raised for a specific shipment (manual toggle / weather)
}

// ---------- Ledger and audit ----------
entity Ledger : managed {
  key ID             : UUID; // loan_id
      lender         : Association to Hospitals;
      borrower       : Association to Hospitals;
      drug           : Association to Drugs;
      qty            : Integer;
      landedCost     : Decimal(12, 2);
      repaymentMode  : RepaymentMode;
      status         : LedgerStatus default 'OPEN';
      transfer       : Association to Transfers;
      settledAt      : Timestamp;
      settlementRef  : String(120);
}

/** Append-only, hash-chained. Never updated or deleted (enforced in srv/lib/audit.js). */
entity AuditLog {
  key seq      : Integer;
      actor    : String(120);
      action   : String(40);
      payload  : LargeString; // canonical JSON
      loggedAt : String(30);  // ISO-8601 string, hashed verbatim
      hash     : String(64);
      prevHash : String(64);
}

// ---------- Integration support ----------
entity CoverSnapshots {
  key hospital_ID : String(10);
  key drug_ID     : String(20);
  key windowDays  : Integer;
      booked      : Integer;
      covered     : Integer;
      shortfall   : Integer;
      status      : CoverStatus;
      computedAt  : Timestamp;
}

entity Notifications : cuid {
  hospital  : Association to Hospitals;
  kind      : String(30); // SHORTFALL | EXCURSION | STALE_FEED | LICENCE_EXPIRY | ROUTE | FALLBACK
  severity  : String(10);
  message   : String(500);
  ref       : String(80);
  dueDate   : Date; // when the problem bites (shortfall: first affected booking) -> alert lead time
  createdAt : Timestamp;
  read      : Boolean default false;
}

/** Experience layer: one row per Idempotency-Key (hashed with the user), so a double tap runs an action once. */
entity IdempotencyKeys {
  key keyHash    : String(64);
      actionId   : String(40);
      httpStatus : Integer;
      response   : LargeString;
      createdAt  : Timestamp;
}

/** Stock-register photo read by the LLM, held until the pharmacist confirms it (nothing is saved before). */
entity PhotoPreviews {
  key ID          : UUID;
      hospital_ID : String(10);
      rows        : LargeString;
      createdAt   : Timestamp;
      usedAt      : Timestamp;
}

/** Encrypted local token store (development). In hybrid/production tokens live in the Destination service. */
entity TokenVault {
  key hospital_ID : String(10);
  key provider    : String(20);
      ciphertext  : LargeString;
      updatedAt   : Timestamp;
}

entity OAuthStates {
  key state       : String(64);
      hospital_ID : String(10);
      userId      : String(120);
      expiresAt   : Timestamp;
}

entity PairingCodes {
  key codeHash    : String(64);
      hospital_ID : String(10);
      expiresAt   : Timestamp;
      usedAt      : Timestamp;
}

entity ConnectorTokens {
  key tokenHash   : String(64);
      hospital_ID : String(10);
      createdAt   : Timestamp;
      revokedAt   : Timestamp;
}

/** SAP sandbox material number -> MediLink drug (synthetic mapping) */
entity MaterialMappings {
  key material    : String(40);
      drug_ID     : String(20);
      hospital_ID : String(10);
      brandName   : String(80);
      manufacturer: String(120);
}
