using medilink as db from '../db/schema';

// =====================================================================
// Shared result types
// =====================================================================
type AffectedBooking {
  bookingId       : String;
  patientRefShort : String; // first 10 hex chars of the hashed ref; never a name
  scheduledDate   : Date;
  doseUnits       : Integer;
  uncoveredUnits  : Integer;
  intent          : String;
  curative        : Boolean;
}

type CoverRow {
  hospitalId        : String;
  hospitalName      : String;
  drugId            : String;
  genericName       : String;
  strength          : String;
  dosageForm        : String;
  storageClass      : String;
  windowDays        : Integer;
  status            : String;  // RED | GREEN | NONE
  belowMargin       : Boolean; // covered, but stock - demand < safety margin
  booked            : Integer;
  covered           : Integer;
  shortfall         : Integer;
  coverPct          : Decimal(5, 1);
  usableStock       : Integer;
  margin            : Integer;
  surplus           : Integer;
  patientsAffected  : Integer;
  firstAffectedDate : Date;
  nearExpiryQty     : Integer;
  lastSyncedAt      : Timestamp;
  feedStale         : Boolean;
  message           : String;
}

type RequestPrefill {
  drugId           : String;
  genericName      : String;
  strength         : String;
  dosageForm       : String;
  qty              : Integer;
  neededBy         : Date;
  allowBrandSwitch : Boolean;
  preferredBrand   : String;
}

type ShortfallCard {
  cover    : CoverRow;
  affected : many AffectedBooking;
  prefill  : RequestPrefill;
  synced   : String;
}

type NearExpiryLot {
  lotId        : String;
  drugId       : String;
  genericName  : String;
  strength     : String;
  brandName    : String;
  batchNo      : String;
  quantity     : Integer;
  expiryDate   : Date;
  daysToExpiry : Integer;
  surplus      : Integer;
}

type CityRow {
  drugId          : String;
  genericName     : String;
  strength        : String;
  hospitalsShort  : Integer;
  dosesShort      : Integer;
  dosesBooked     : Integer;
  citySurplus     : Integer;
  earliestNeed    : Date;
}

type ExclusionOut {
  lotId        : String;
  hospitalId   : String;
  hospitalName : String;
  batchNo      : String;
  rule         : Integer;
  ruleName     : String;
  code         : String;
  detail       : String;
}

type PlanLotOut { lotId : String; batchNo : String; brandName : String; qty : Integer; expiryDate : Date; daysToExpiry : Integer; nearExpiry : Boolean; }
type PlanLegOut { hospitalId : String; hospitalName : String; distanceKm : Decimal(8, 2); etaMin : Integer; qty : Integer; lots : many PlanLotOut; }
type PlanOut {
  rank         : Integer;
  totalQty     : Integer;
  transfers    : Integer;
  fullyCovers  : Boolean;
  score        : Decimal(12, 3);
  reason       : String;
  reasonSource : String;
  legs         : many PlanLegOut;
}
type RankResult {
  requestId  : UUID;
  qty        : Integer;
  neededBy   : Date;
  engine     : String;
  eligible   : Integer;
  plans      : many PlanOut;
  exclusions : many ExclusionOut;
}

type TransferOut {
  ID                    : UUID;
  status                : String;
  supplierId            : String;
  receiverId            : String;
  drugId                : String;
  qty                   : Integer;
  planRank              : Integer;
  requiresSecondSignoff : Boolean;
  riskReasons           : String;
  partnerId             : String;
  etaMin                : Integer;
  distanceKm            : Decimal(8, 2);
  supplierResponseDueAt : Timestamp;
  message               : String;
}

type SupplierReview {
  transfer               : TransferOut;
  lots                   : many PlanLotOut;
  coverBefore            : CoverRow;
  coverAfter             : CoverRow;
  ownBookingsStayCovered : Boolean;
  landedCostPerUnit      : Decimal(10, 2);
}

type VerifyResult { ok : Boolean; count : Integer; brokenAt : Integer; reason : String; head : String; }

type LicenceResult {
  hospitalId       : String;
  hospitalName     : String;
  address          : String;
  licenceNo        : String;
  licenceValidTill : Date;
  licenceValid     : Boolean;
  software         : String;
  softwareLabel    : String;
  message          : String;
  next             : String; // OAUTH_ALLOW | WAIT_FOR_IT | SAP_ADMIN | SHEET_UPLOAD | ALREADY_CONNECTED
  authorizeUrl     : String;
  pairingCode      : String;
  itSetupLink      : String;
  connected        : Boolean;
}

type IngestResult { hospitalId : String; source : String; lots : Integer; bookings : Integer; skipped : Integer; mode : String; note : String; }

// =====================================================================
// Cover board (FR-06, FR-09, FR-11..13, FR-28)
// =====================================================================
@path: 'cover'
@requires: ['pharmacist', 'approver', 'admin']
service CoverService {
  @readonly entity Hospitals as projection on db.Hospitals excluding { adminEmail, lots, bookings };
  @readonly entity Drugs as projection on db.Drugs;
  @readonly @restrict: [
    { grant: 'READ', to: ['pharmacist', 'approver'], where: 'hospital_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Lots as projection on db.Lots;
  @readonly @restrict: [
    { grant: 'READ', to: ['pharmacist', 'approver'], where: 'hospital_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Bookings as projection on db.Bookings;
  // read-only: alerts are acknowledged with POST /me/actions/ack-alert (a PATCH could move or rewrite a row)
  @readonly @restrict: [
    { grant: 'READ', to: ['pharmacist', 'approver'], where: 'hospital_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Notifications as projection on db.Notifications;

  /** Cover board for the user's hospital, red first. window = 7 | 14 | 21 */
  function board(window : Integer, hospital : String) returns array of CoverRow;
  /** Shortfall card; forces a re-sync of the hospital feed first (FR-06) */
  function shortfall(drug : String, window : Integer, hospital : String) returns ShortfallCard;
  function nearExpiry(days : Integer, hospital : String) returns array of NearExpiryLot;
  /** Aggregated, anonymised city view for distributors / state medical supplies body (FR-28) */
  function cityView(window : Integer) returns array of CityRow;
}

// =====================================================================
// Onboarding: licence number + Allow (FR-01..05). Plain REST: POST /onboarding/licence
// =====================================================================
@protocol: 'rest'
@path: '/onboarding'
@requires: ['pharmacist', 'admin']
service OnboardingService {
  action licence(licenceNo : String, software : String, itContact : String) returns LicenceResult;
  /** "Disconnect" button: revokes the token at the source instantly; consent revocation is logged */
  action revokeAccess(hospital : String) returns { hospitalId : String; revoked : Boolean; message : String; };
  function status(hospital : String) returns { hospitalId : String; connected : Boolean; software : String; lastSyncedAt : Timestamp; feedStale : Boolean; tokenStore : String; consents : many { provider : String; scopes : String; grantedBy : String; grantedAt : Timestamp; revokedAt : Timestamp; }; };
}

// =====================================================================
// Ingestion helpers (the token-authenticated POST /ingest is an Express route in server.js)
// =====================================================================
@protocol: 'rest'
@path: '/sync'
@requires: ['pharmacist', 'admin']
service SyncService {
  /** Sheet upload fallback (FR-04). csv = raw CSV text. confirm=false returns a mapping preview. */
  action uploadSheet(csv : LargeString, hospital : String, confirm : Boolean, mapping : LargeString) returns {
    hospitalId : String; mapping : LargeString; mappingSource : String; rows : Integer; unresolved : LargeString; preview : LargeString; ingested : IngestResult;
  };
  action syncNow(hospital : String) returns array of IngestResult;
  /** Stock-register photo (FR-04, LLM). confirm=false: read + preview only (nothing saved). confirm=true + previewId: save via ingest. */
  action uploadPhoto(imageBase64 : LargeString, mimeType : String, hospital : String, confirm : Boolean, previewId : UUID) returns {
    hospitalId : String; previewId : UUID; rows : Integer; preview : LargeString; dropped : LargeString; ingested : IngestResult;
  };
}

// =====================================================================
// Requests, hard rules and ranking (FR-14..17)
// =====================================================================
@path: 'requests'
@requires: ['pharmacist', 'admin']
service RequestService {
  @readonly @restrict: [
    { grant: 'READ', to: 'pharmacist', where: 'hospital_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Requests as projection on db.Requests;
  @readonly @restrict: [
    { grant: 'READ', to: 'pharmacist', where: 'request.hospital_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Plans as projection on db.Plans;
  @readonly @restrict: [
    { grant: 'READ', to: 'pharmacist', where: 'request.hospital_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Exclusions as projection on db.Exclusions;

  function prefill(drug : String, window : Integer) returns RequestPrefill;
  /** One-tap request: any omitted field is prefilled from the shortfall card. Ranks immediately. */
  action createRequest(drug : String, qty : Integer, neededBy : Date, allowBrandSwitch : Boolean, note : String, window : Integer) returns { request : UUID; status : String; qty : Integer; neededBy : Date; allowBrandSwitch : Boolean; preferredBrand : String; ranking : RankResult; };
  /** excludeRefused: skip suppliers that already declined, timed out or were rejected for this request ("Find a supplier again") */
  action rank(request : UUID, excludeRefused : Boolean) returns RankResult;
  action choosePlan(request : UUID, rank : Integer) returns array of TransferOut;
  action cancelRequest(request : UUID) returns { request : UUID; status : String; };
}

// =====================================================================
// Supplier review (FR-18, FR-19)
// =====================================================================
@path: 'supplier'
@requires: ['pharmacist', 'admin']
service SupplierService {
  @readonly @restrict: [
    { grant: 'READ', to: 'pharmacist', where: 'supplier_ID = $user.hospital or receiver_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Transfers as projection on db.Transfers;
  @readonly @restrict: [
    { grant: 'READ', to: 'pharmacist', where: 'transfer.supplier_ID = $user.hospital or transfer.receiver_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity TransferLots as projection on db.TransferLots;

  function review(transfer : UUID) returns SupplierReview;
  /** repaysLoan: this delivery repays an open loan the supplier owes the receiver (no new loan is recorded) */
  action accept(transfer : UUID, qty : Integer, repaymentMode : String, repaysLoan : UUID) returns TransferOut;
  action decline(transfer : UUID, reason : String, reasonCode : String) returns TransferOut;
}

// =====================================================================
// Approver sign-off (FR-20)
// =====================================================================
@path: 'approval'
@requires: ['approver', 'admin']
service ApprovalService {
  @readonly @restrict: [
    { grant: 'READ', to: 'approver', where: 'supplier_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  @cds.redirection.target: false // Approvals.transfer must reach every transfer, not only the pending ones in the inbox
  entity Inbox as projection on db.Transfers where status = 'PENDING_APPROVAL' or status = 'PENDING_SECOND_APPROVAL';
  @readonly @restrict: [
    { grant: 'READ', to: 'approver', where: 'transfer.supplier_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Approvals as projection on db.Approvals;

  action approveTransfer(transfer : UUID) returns TransferOut;
  action rejectTransfer(transfer : UUID, reason : String) returns TransferOut;
}

// =====================================================================
// BPA-compatible workflow API (SAP Build Process Automation calls these). REST: /workflow/*
// =====================================================================
@protocol: 'rest'
@path: '/workflow'
@requires: ['system', 'admin']
service WorkflowService {
  function context(transfer : UUID) returns LargeString; // JSON context for BPA forms
  action supplierDecision(transfer : UUID, decision : String, qty : Integer, repaymentMode : String, reason : String, actor : String) returns TransferOut;
  action approvalDecision(transfer : UUID, decision : String, reason : String, actor : String) returns TransferOut;
  action timeout(transfer : UUID) returns TransferOut;
}

// =====================================================================
// Delivery operations for MediLink admins (FR-21..24). Couriers have no account: they use /courier/* with their link.
// =====================================================================
@path: 'delivery'
@requires: ['admin']
service DeliveryService {
  @readonly entity Shipments as projection on db.Transfers where status = 'ASSIGNED' or status = 'IN_TRANSIT';

  action pickupScan(transfer : UUID, batchNo : String, sealId : String, loggerId : String) returns TransferOut;
  action telemetry(transfer : UUID, loggerId : String, lat : Double, long : Double, temperatureC : Double, sealStatus : String, ts : Timestamp) returns { accepted : Boolean; excursion : Boolean; transferId : UUID; };
  function activeShipments() returns array of { ID : UUID; status : String; loggerId : String; storageClass : String; minC : Decimal(5, 2); maxC : Decimal(5, 2); fromLat : Decimal(9, 6); fromLong : Decimal(9, 6); toLat : Decimal(9, 6); toLong : Decimal(9, 6); pickedUpAt : Timestamp; etaMin : Integer; via : LargeString; };
}

// =====================================================================
// Route control: manual "road flooded" toggle + weather check (FR-23)
// =====================================================================
@path: 'routes'
@requires: ['admin', 'pharmacist']
service RouteService {
  action setRouteClosed(transfer : UUID, closed : Boolean, note : String) returns { transferId : UUID; closed : Boolean; distanceKm : Decimal(8, 2); etaMin : Integer; note : String; open : Boolean; };
  action checkWeather() returns array of { transferId : UUID; maxPrecipMm : Decimal(6, 2); closed : Boolean; note : String; };
}

// =====================================================================
// Receipt (FR-25)
// =====================================================================
@path: 'receipt'
@requires: ['pharmacist', 'admin']
service ReceiptService {
  @readonly @restrict: [
    { grant: 'READ', to: 'pharmacist', where: 'receiver_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Incoming as projection on db.Transfers where status = 'IN_TRANSIT' or status = 'DELIVERED' or status = 'QUARANTINED';
  // live position + temperature: GET /me/journeys/{id}/tracking (receiver only; no city-wide ConditionLogs projection, audit F2)

  action arrivalScan(transfer : UUID, batchNo : String, sealIntact : Boolean, qtyReceived : Integer, decision : String) returns {
    transferId : UUID; status : String; proofOfCondition : String; checks : LargeString; lotIds : LargeString; coverStatus : String; message : String;
  };
}

// =====================================================================
// Lending ledger (FR-26)
// =====================================================================
@path: 'ledger'
@requires: ['pharmacist', 'approver', 'admin']
service LedgerService {
  @readonly @restrict: [
    { grant: 'READ', to: ['pharmacist', 'approver'], where: 'lender_ID = $user.hospital or borrower_ID = $user.hospital' },
    { grant: 'READ', to: 'admin' } ]
  entity Loans as projection on db.Ledger;

  action settleLoan(loan : UUID, mode : String, settlementTransfer : UUID, reference : String) returns { loanId : UUID; status : String; mode : String; amount : Decimal(12, 2); };
}

// =====================================================================
// Audit (FR-27). REST: GET /audit/verify
// =====================================================================
@protocol: 'rest'
@path: '/audit'
@requires: ['admin', 'approver']
service AuditService {
  @restrict: [{ grant: '*', to: 'admin' }] // payloads name other hospitals; approvers keep verify() only (writes still get 405)
  entity Entries as projection on db.AuditLog;
  function verify() returns VerifyResult;
}

// =====================================================================
// Trust feed (FR-15)
// =====================================================================
@path: 'trust'
@requires: ['admin']
service TrustService {
  entity Flags as projection on db.Flags;
  /** LLM-based CDSCO alert parser (behind LLM_PROVIDER / TRUST_FEED_LLM_ENABLED). pdfBase64 or text. */
  action parseAlert(pdfBase64 : LargeString, text : LargeString, source : String) returns { created : Integer; flags : LargeString; llm : String; };
  /** Manual flag / recall: adds a Flag, quarantines matching lots, cancels unpicked transfers. */
  action recall(batchNo : String, manufacturer : String, drug : String, reason : String, source : String) returns { flagId : UUID; lotsQuarantined : Integer; transfersCancelled : Integer; inTransitAlerts : Integer; };
}

// =====================================================================
// Admin: settings, directory, jobs
// =====================================================================
@path: 'admin'
@requires: ['admin']
service AdminService {
  entity Hospitals as projection on db.Hospitals;
  entity Licences as projection on db.Licences;
  entity DeliveryPartners as projection on db.DeliveryPartners;
  @readonly entity Transfers as projection on db.Transfers;
  @readonly entity Notifications as projection on db.Notifications;
  action setSafetyMargin(hospital : String, pct : Integer) returns { hospitalId : String; safetyMarginPct : Integer; };
  action runJobs() returns LargeString;
}

/** The approver (chief pharmacist) changes their own hospital's safety margin (Settings screen); reorder levels: POST /me/actions/set-reorder-level. */
@path: 'settings'
@requires: ['approver', 'admin']
service SettingsService {
  action setSafetyMargin(pct : Integer) returns { hospitalId : String; safetyMarginPct : Integer; };
}

// =====================================================================
// Live tracking push (WebSocket via @cap-js-community/websocket): ws://host/ws/tracking
// =====================================================================
@protocol: 'websocket'
@path: 'tracking'
@requires: 'authenticated-user'
service TrackingService {
  /** Live position / temperature / ETA after each fix: receiving hospital + admins; the supplier gets transferId, requestId, status. */
  event tracking { transferId : UUID; requestId : UUID; status : String; position : Map; temperature : Map; eta : Timestamp; etaText : String; remainingKm : Decimal(8, 2); }
  event excursion { transferId : UUID; temperatureC : Decimal(5, 2); range : String; message : String; quarantineSuggested : Boolean; hospitals : String; }
  event replan { transferId : UUID; distanceKm : Decimal(8, 2); etaMin : Integer; open : Boolean; note : String; }
  event status { transferId : UUID; status : String; message : String; }
  event alert { hospitalId : String; kind : String; severity : String; message : String; ref : String; notificationId : UUID; }
  /** Same journey shape as GET /me/home -> journeys[], built for the receiving socket's point of view. */
  event journey.updated { journeyId : String; perspective : String; journey : Map; }
  /** On connect each socket joins its own contexts (hospital / role); clients cannot join others. */
  action wsConnect();
  action wsContext(context : String, contexts : array of String, exit : Boolean, reset : Boolean);
}
