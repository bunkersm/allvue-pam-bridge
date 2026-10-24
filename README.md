# Loan Event Bridge

Prototype that finds loan contract activity in the Loan System, sorts it into what the Investment Accounting System (IAS) needs, and produces IAS import files after review.

Everything runs in the browser. There is no server, and files you load stay on your machine.

## Run it

Open `index.html` in a browser. It starts with a fictional month-end (2026-10-29 → 2026-10-30): 26 events across two Loan System portfolios that feed five IAS portfolios.

Run the engine tests with Node 18 or later:

```
npm test
```

## How it works

### One event per facility

An event is a **facility** (tranche), not a facility in one Loan System portfolio, because a paydown or restructure happens once to the loan. The contract create and each global action are generated **once**; portfolio transactions are generated for every IAS portfolio holding the facility, each Loan System portfolio from its own holding. Each Loan System portfolio is still tied out to its IAS portfolios (the event's *Holdings by portfolio* table), and **a break in any one blocks the whole event**, since the global action is shared. The portfolios must agree on each contract's global amount, terms and dates. Monthly fees stay per portfolio.

### Dates

Each morning run processes one **business date** D (the previous business day):

| Input | As of |
|---|---|
| Loan System prior snapshot | End of the business day before D |
| IAS holdings | Same date as the Loan System prior snapshot |
| Loan System current snapshot | End of D |

Example: run on Tuesday 10/20 → business date Monday 10/19; Loan System prior and IAS holdings as of Friday 10/16. Detection stops if IAS's `AsOfDate` doesn't match the Loan System prior date or the current snapshot isn't later, and warns if the snapshots are more than 4 days apart.

### Paydown auto-approval

Month-end brings a lot of paydowns. A paydown with nothing else changing (on its own, or at an otherwise clean roll) is **approved automatically** when the units tie in every portfolio:

- IAS ties to the Loan System **before** the event,
- the redemptions the app will send leave IAS tied to the Loan System **after** it,
- each portfolio's paydown is within $1.00 of its share of the global paydown, and the global action redeems the whole global paydown.

Auto-approved paydowns show as **Auto-approved, units tie** in the Approved tile and go in the next IAS file with no click. The event's *Paydown tie-out* table shows the before/redeemed/after numbers. Anything flagged for review or an exception is never auto-approved. **Hold for review** takes one back out, and re-runs leave it held. On Setup you can turn this off, or send paydowns larger than a set percentage of the global amount to review.

### Effective dates

A split, combine or roll is dated on the **new contracts' start date**, and every message for it (global action and portfolio transactions) carries that date. The Loan System's convention is that the old contract ends on the day the new ones start. If the new contracts start on different days, or an old contract ends on a different day, the event goes to review. A paydown or draw with no new contracts is dated the business date.

### Contract lineage

The app keeps a table of which IAS contract each Loan System contract is, because tomorrow's events need it. Links are set automatically when an event is verified, auto-approved or approved (a roll keeps the same IAS contract; a split, combine or terms change links to the new IAS contract the app creates).

- **Contract links** in each event lets you type a link where the app can't set it: a **new purchase** (the trade feed creates the IAS contract) or an event **handled outside the app**. Every link typed by hand is in the audit log.
- **End of day: contract lineage** on the IAS files tab lists live contracts with no link, warns about events not yet finished, and downloads `LINEAGE_<date>.csv` in the lineage file layout. Links are saved in this browser; load the file as the contract lineage to carry them to another computer or browser.

### Trades

Buys, sells and new purchases are booked in IAS by the **trade feed**, not by this app. A position change with no change in the facility's global amount is a trade, and nothing is sent. A position that wasn't in the prior snapshot is a **new purchase**: nothing is sent, but an initial long or short first period goes to review with IAS's expected first pay date next to the Loan System's. A trade on the same day as a split, combine or terms change goes to review. The Trades view shows each facility's commitment, funded and unfunded after the trade, with the day's change, and totals across all trades.

1. **Detect.** For each Loan System portfolio and asset, compare the prior-day and current-day contract exports. Contracts that are gone are *expiring*; contracts that appeared are *new*; contracts with the same ID but a different amount or terms are *amended*.
2. **Classify.**

   | Loan System pattern | Event | Route |
   |---|---|---|
   | 1 → 1, same amount and terms, regular period | Rollover | Auto: verified, nothing sent to IAS |
   | 1 → 1, terms differ | Contract change | Review |
   | 1 → many | Contract split | Review |
   | many → 1 | Contract combine | Review |
   | many → many | Complex restructure | Review |
   | new contract, nothing expiring | Draw | Review |
   | lower funded total | Paydown (booked after any split or combine) | Auto-approved when units tie out, otherwise Review |
   | higher funded total on a Capitalize/Partial contract | Capitalized (PIK) interest | Review |
   | your position moves but the global amount doesn't | Trade, not a paydown or draw | Trade feed: nothing sent |
   | irregular period (stub/broken) | Flag | Review |

   **Exceptions** block approval: missing global amounts, unmapped asset or portfolio, IAS positions not tying to the Loan System before the event, funded + unfunded ≠ commitment, term loan draws, draws larger than unfunded, missing contract lineage.
3. **Allocate.** Each amount is split across the IAS portfolios mapped to the Loan System portfolio, pro rata on their current IAS position (funded + unfunded), with largest-remainder rounding so the parts tie to the Loan System amount to the cent.
4. **Review.** Approve or reject each event with a comment. Every decision goes to the audit log.
5. **IAS file.** Approved events go into a numbered import file. Import it through IAS's import browser, then record which events loaded or failed. Failed events return to review with the IAS error.

## Monthly fees

The **Monthly fees** tab replaces the manual monthly load of unfunded fee transactions.

1. Load the Loan System unfunded fee export (one row per facility, fee type and period).
2. Each fee is checked against rate × average unfunded × days ÷ 360 (or 365). It is **clean** within the larger of $1.00 or 0.1%.
3. **Review**: amount outside tolerance, negative (correction) or zero amounts, and IAS unfunded today differing from the Loan System's average unfunded by more than 10% (unfunded changed mid-period, so the split by fund may be off).
4. **Exceptions**: duplicate rows, fees on term loans, unmapped facilities, no IAS unfunded position.
5. Fees are split across IAS portfolios on their current **unfunded** position, to the cent.
6. **Approve all clean fees** in one click, review the rest individually, then create a fee file on **IAS files**.

The sample is a fictional October 2026 export with 13 rows: 7 clean, 3 for review, 3 exceptions.

Every event has a deterministic key (portfolio, asset, effective date, contract IDs), so re-running detection never creates duplicates and keeps decisions already made.

## Loan System contracts report

The Loan System prior and current slots take the **Loan System contracts report as-is** (one row per portfolio, facility and accrual). Headers are matched without brackets or case. The report has no as-of date, so the app reads it from the file name (e.g. `loan-system-contracts-report-2026-10-29.csv`) or from the date field on the Setup tab. Sample files are in `docs/samples/`.

| Report column | App field | Conversion |
|---|---|---|
| `portfolioId` | Loan System portfolio | Keys the portfolio map. `portfolioName` is shown in the app |
| `legalEntityName`, `instrumentName` | Issuer, instrument | Shown as the asset name (issuer over instrument); fees borrow them by facility ID |
| `primaryIdentifier` | Facility (asset) | Keys the tranche map; stored in IAS's alternative ID table |
| `referenceAccrualId` | Contract | Linked to IAS contracts through the lineage table |
| `accrualType` | Contract kind | Funded; Unfunded and Delayed Draw Unfunded → unfunded; Letter of Credit → counts toward the commitment only; % of Funded → ignored |
| `instrumentSubType` | Facility type | Term Loan TL, Revolver RC, Delayed Draw DDTL |
| `baseRateIndexName` | Base rate, tenor | `1M SOFR Term` → SOFR 1M; reset frequency comes from the tenor |
| `rateType`, `interestPaymentType` | Rate type, interest type | Float → Floating; Cash / Capitalize |
| `spread`, `spreadAdjustment` | Margin (bps) | Decimals × 10,000. The adjustment is added to the IAS spread when the Setup setting is on |
| `rateFloor`, `rateCeiling` | Floor, cap (%) | Decimals × 100 |
| `dayCount` | Day count | ACT/360, ACT/365 (Fixed), 30U/360. ACT/ACT has no IAS code yet |
| `numPaymentsPerYear` | Pay frequency | 12 monthly, 4 quarterly, 2 semi-annual, 1 annual; 52 has no IAS code yet |
| `beginDate`, `endDate` | Contract period | |
| `accrualAmount`, `globalAccrualAmount` | Position, global amount | Commitment = funded + unfunded + letters of credit per portfolio and facility |

## Input files

Load these on **Setup and data** as CSV. Header names must match.

| File | Columns |
|---|---|
| Loan System contracts (prior and current day) | `AsOfDate, LoanPortfolio, AssetID, AssetName, FacilityType, ContractID, ContractType, StartDate, EndDate, Amount, GlobalAmount, Commitment, RateType, InterestType, BaseRate, Tenor, MarginBps, FloorPct, PayFreq, ResetFreq, DayCount` |
| Portfolio map | `LoanPortfolio, IASPortfolio, Bank, BankName, CustodyAccount, CashBank` (the four `BNK()` fields, in order) |
| Tranche map | `AssetID, IASTrancheID, FacilityType, MaturityDate, IASCurrency` |
| IAS holdings | `AsOfDate, IASPortfolio, IASTrancheID, Funded, Unfunded` |
| Contract lineage | `LoanContractID, IASContractID` |
| Loan System unfunded fee export | `LoanPortfolio, AssetID, AssetName, FacilityType, FeeType, PeriodStart, PeriodEnd, FeeRateBps, AverageUnfunded, DayCount, Amount, LoanTransactionID` |

`Amount` is your position; `GlobalAmount` is the whole facility's amount for that contract. `RateType` is `Fixed` or `Floating`. `InterestType` is `Cash`, `Capitalize` or `Partial`. `FacilityType` is `TL`, `RC` or `DDTL`. `ContractType` is `Funded` or `Unfunded` (one unfunded row per RC/DDTL tranche). Dates may be `YYYY-MM-DD` or `M/D/YYYY`.

## IAS import file

Contract events produce an IAS message file (`IAS_IMPORT_<batch>.txt`) in IAS's import syntax, one message per line (single-line, newline-terminated), in load order:

1. **Create contract**: one `SMFBANKLOANTRANCHE(UPDATE, …)` per event, adding every new contract on the tranche as an `SMFBANKLOANCONTRACTREC`, following the IAS bank loan contract add build spec (minimal message, validated before it goes in the file; the spec's golden string is a test). New contracts take the Loan System contract ID.
2. For each step (combine, split, then paydown, draw or capitalized interest):
   - one **`BANKLOANACTION`** global action, with signed global units per contract (sources negative, targets positive). Types: 8 contract split, 9 contract combine; 6 contract redemption, 4 drawdown and 10 interest capitalization are assumed for paydowns, draws and PIK and need confirming. The transaction generate job stays off.
   - portfolio transactions, with `BNK()` from the portfolio map. The transaction number is left blank; IAS assigns it on `ADD`.
     - **`TaCONTRACTSPLIT`** per IAS portfolio (the source contract in `CONTRACTSECID`, targets in `CONTRACTALLOC`) or **`TaCONTRACTCOMBINE`** (the target in `CONTRACTSECID`, sources in `CONTRACTALLOC`), each with a `CCID`.
     - **`TaContractRedemption`** for paydowns: one per contract per IAS portfolio, accrued interest 0 (per the TACONTRACTREDEMPTION minimum message spec).
     - **`TaDrawDown`** for draws: one per IAS portfolio, `BLUNFUNDED` taking down the draw amount, `CONTRACTALLOC` to the contracts drawn into, trade, settle and delayed delivery date all the effective date (per the TADRAWDOWN minimum message spec).
     - *Capitalized (PIK) interest has no format yet, so it appears as an "after loading" checklist.*
   - No fund may redeem more than its funded IAS holding or draw more than its unfunded. A file warns about redemptions and drawdowns dated after today, which IAS rejects.

| Event | Steps |
|---|---|
| Clean rollover | Nothing |
| Rollover with paydown, draw or PIK, same terms | Global action on the existing IAS contract (+ manual portfolio transactions) |
| Terms change (1:1) | Create → split old → new → any paydown/draw |
| Split (1 → many) | Create each → split → any paydown/draw spread by size |
| Combine (many → 1) | Create → combine → any paydown/draw |
| Many → many | Create each → combine into the first new contract → split out to the others → any paydown/draw |
| Draw into a new contract | Create → draw |

IAS closes emptied contracts itself. The `TRDR()` block on splits (method `M`, the tranche maturity date, price 100) and `SETMTHD(11)` are copied from IAS's sample and should be confirmed. Security ID types are 3 for the facility (the IAS tranche ID) and 26 for contracts; see `IAS` in `src/engine.js`.

Fee files use `BatchID, Seq, FeeKey, TransactionType, FeeType, IASPortfolio, IASTrancheID, PeriodStart, PeriodEnd, Amount, LoanTransactionID` with transaction type `UNFUNDED_FEE`. Also a placeholder.

### Contract create mapping

| IAS field | From |
|---|---|
| Loan type | Facility type: TL 1, RC 2, DDTL 3 |
| Tranche and contract maturity | Tranche map `MaturityDate` |
| Currency | Tranche map `IASCurrency` |
| Coupon type | `RateType`: Floating V, Fixed F (fixed coupon = `MarginBps` / 100) |
| Coupon form | `InterestType`: Cash C, Capitalize or Partial P |
| Coupon and reset frequency | Pay and reset frequency: M, Q, S, A |
| Day count | ACT/360 D, ACT/365 C, 30/360 A |
| Accrual and reset month and day | The contract's pay date (end date, allowing for business-day rolls) |
| Base index | SOFR + tenor: SR1M, SR3M |
| Spread, minimum rate | Margin (bps), floor (%) |
| Everything else | Spec defaults (`IAS_CONTRACT_DEFAULTS` in `src/engine.js`) |

Open items from the spec, to confirm in an IAS test region before production:
1. Whether `SMFBANKLOANCONTRACT(REPLACE, …)` with only the new contracts leaves existing contracts on the tranche intact, or replaces the whole list. **If it replaces the list, existing contracts would be removed**; the builder already supports several contract records per tranche so they can be re-sent.
2. Whether loan type can be blank on UPDATE.
3. Float method `A`, pay date convention `3` and reset date convention `3`.
4. Whether IAS enforces CCID concurrency on tranche UPDATE (CCID is supported but off).
5. What accrual month to send for monthly contracts (the spec defines it for Q, S and A only; monthly is sent blank).

## Files

- `src/engine.js`: detection, classification, allocation, CSV and IAS file rows. No DOM, so it can move to a server job unchanged.
- `src/sample-data.js`: fictional month-end scenario.
- `src/app.js`, `src/styles.css`, `index.html`: the review UI.
- `tests/engine.test.js`: engine tests.

## Next steps

See [TODO.md](TODO.md) for the full list of open work and questions.


- Replace the Loan System column mapping with the real Loan System export headers.
- Replace the IAS layout with the real import message formats, one writer per message type.
- Add an IAS position extract for next-day reconciliation.
- Split fees on average daily unfunded per IAS portfolio once a position history is available.
- Add four-eyes approval (preparer and approver must differ) if required.
- Move state from browser storage to a shared database when more than one person uses it.
