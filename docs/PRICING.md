# Price vs distance

When a hospital is short and has to choose a supplier, the pharmacist sees what each safe option costs next to how far away it is. Price helps the pharmacist decide. It never lets unsafe stock through, and it never changes the matcher's ranking (nearest safe stock first, near-expiry batches used first).

## Price model (`backend/srv/lib/pricing.js`, all INR, synthetic)

```
medicine price per vial = Lot.unitPrice                       (optional batch price, e.g. from the hospital's software)
                        or Drug.unitCost × Hospital.pricingMultiplier
                        − NEAR_EXPIRY_DISCOUNT_PCT (10%) if the batch is inside the near-expiry window
                        and never above Drug.unitCost (the landed cost)
delivery quote          = base fee + ₹/km × road distance, by storage class (DELIVERY_RATES)
                          AMBIENT 150 + 12/km · COLD 350 + 22/km · FROZEN 500 + 30/km
total                   = medicine price × vials + delivery
price per vial          = total ÷ vials
```

**Why prices never go above the landed cost.** MediLink is hospitals lending to each other at cost, not a marketplace, and most of these cancer medicines are on the National List of Essential Medicines, with ceiling prices under the 2013 Drug Price Control Order. A tier above 1.00 or a batch price above `Drug.unitCost` is capped. (Not legal advice: check the current ceiling prices with your pharmacy or legal team before using real prices.)

**Synthetic price tiers** (`seed/generate.js`, `PRICING`): City Cancer 1.00, Sanjeevani 0.90 (institutional rate), Lakeside 0.95, Hebbal 0.97, Banashankari 1.00. In the demo, Banashankari is the nearest and Sanjeevani the cheapest, so the chart shows a real trade-off.

## Where it appears

| Place | What |
|---|---|
| Request page, while choosing a supplier | **Price vs distance** chart: one dot per lender (size = vials, copper = near-expiry stock), a dashed best-trade-off line, a landed-cost line and an "arrives in time up to here" line. Hover or focus a dot for the breakdown; tap it (or Enter) to ask that hospital, or split the order across up to three (below) |
| **Check plans with AI** | The plan check quotes each verified plan's cost and the cheaper backup ("Plan 2 … costs ₹32 less per vial") |
| Supplier's accept screen and loans | "Get paid the landed cost (₹…)" and the loan amount use the supplier's price, so the borrower owes what the chart showed |

## Choosing the supplier yourself

The requesting pharmacist decides; the matcher's plan is only a suggestion.

- **Any dot can be asked.** Tap a hospital on the chart, then **Ask <hospital>**.
- **Split an order.** If that hospital cannot give every vial, tap **Ask <hospital> + another hospital for the rest**, then tap a second dot (up to three hospitals). The basket shows who gives how many, each hospital's price and delivery, and the combined total and price per vial. **Start again** clears it.
- **Safety first.** Only hospitals that pass the 8 hard rules are on the chart, and the rules run again on live stock when you ask (`workflow.chooseSuppliers`). A hospital whose batch was flagged, promised or used meanwhile is refused in plain words and nothing is sent. A hospital that is no longer needed (the ones before it already cover everything) is refused too.
- **Same path afterwards.** Each supplier accepts its own part, the approver signs, and loans use each supplier's price. If a supplier declines, the usual fallback finds the rest.
- **On the record.** `SUPPLIERS_CHOSEN` in the audit chain: hospitals in order, vials, total cost, the matcher's first pick and whether the pharmacist chose differently. The choice is stored as a plan with engine `pharmacist-choice`.

API: `POST /me/actions/choose-suppliers {requestId, hospitals: "H5" | "H5,H2"}` (requesting pharmacist), or the OData action `RequestService.chooseSuppliers(request, hospitals)`.

## API

`GET /me/journeys/:requestId/prices` (requesting hospital's staff, admin):

```json
{
  "requestId": "…", "drug": { "name": "Carboplatin 450 mg", "storageClass": "AMBIENT" }, "qty": 16, "neededBy": "2026-11-11",
  "landedCost": 1850, "urgencyKm": 3275, "delivery": { "base": 150, "perKm": 12 }, "nearExpiryDiscountPct": 10,
  "points": [
    { "hospitalId": "H5", "hospitalName": "Banashankari Care Hospital", "pharma": "Carbokem / Sunrise Oncology Ltd",
      "distanceKm": 5.1, "etaMin": 34, "qty": 16, "unitPrice": 1711.25, "medicineCost": 27380, "deliveryCost": 211,
      "totalCost": 27591, "costPerUnit": 1724.44, "nearExpiry": true, "tags": ["Nearest"], "planRank": 1,
      "batches": [{ "batchNo": "SOL24B077", "qty": 12, "unitPrice": 1665, "nearExpiry": true }, …], "action": { "id": "choose-plan", … } },
    { "hospitalId": "H2", "hospitalName": "Sanjeevani Hospital", "distanceKm": 24.3, "costPerUnit": 1692.56, "tags": ["Lowest price"], … }
  ],
  "paretoFrontier": ["H5", "H2"], "ruledOut": 9, "currency": "INR", "synthetic": true
}
```

Only lots that pass the 8 hard rules appear (`matching.evaluate`; nothing is written). Live updates: the tracking WebSocket sends `prices { requestId, hospitalId }` to the requesting hospital after every re-ranking and every stock sync cycle, and the page reloads the chart.

## Data

New columns: `Hospitals.pricingMultiplier` (default 1.00) and `Lots.unitPrice` (optional; also accepted from stock feeds as `unitPrice` or `price`). An existing `db/medilink.sqlite` gets both on start-up, with the seed tiers for the synthetic hospitals (`srv/lib/db-upgrade.js`), so no reset is needed.

Tests: `backend/test/pricing.test.js`, `backend/test/choose-suppliers.test.js`.
