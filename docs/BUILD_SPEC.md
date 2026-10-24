# Loan Event Bridge: Build Specification

A complete specification for building Loan Event Bridge from scratch. It describes what the app must do, the rules it applies, the exact IAS message formats, the screens, and the tests that prove it works.

**For the builder:** read the whole document before writing code. Build in the order in [§0](#0-build-order-and-definition-of-done). The app is done when every acceptance test in [§16](#16-acceptance-tests) passes. Where this spec and your own judgement differ, follow the spec; where the spec is silent, choose the simplest behaviour that keeps money exact and flag the choice in the README.

---

## Contents

0. [Build order and definition of done](#0-build-order-and-definition-of-done)
1. [Purpose and scope](#1-purpose-and-scope)
2. [Glossary](#2-glossary)
3. [Architecture and technical constraints](#3-architecture-and-technical-constraints)
4. [Run model and dates](#4-run-model-and-dates)
5. [Input files](#5-input-files)
6. [Event detection](#6-event-detection)
7. [Checks and routing](#7-checks-and-routing)
8. [Allocation to IAS portfolios](#8-allocation-to-ias-portfolios)
9. [IAS plan: what each event becomes](#9-ias-plan-what-each-event-becomes)
10. [IAS message formats](#10-ias-message-formats)
11. [Contract create: mapping and validation](#11-contract-create-mapping-and-validation)
12. [Monthly fees](#12-monthly-fees)
13. [Workflow, IAS files and audit](#13-workflow-ias-files-and-audit)
14. [Screens](#14-screens)
15. [Sample data](#15-sample-data)
16. [Acceptance tests](#16-acceptance-tests)
17. [Assumptions and open items](#17-assumptions-and-open-items)
18. [Out of scope](#18-out-of-scope)

---

## 0. Build order and definition of done

1. **Engine** (`src/engine.js`): pure functions, no DOM. CSV, money, dates, normalizing inputs, the Loan System report converter, event detection, checks, allocation, the IAS plan, the IAS message builder, contract create validation, fees, file building. Write its tests as you go.
2. **Sample data** (`src/sample-data.js`): generates every input file in the app's own layouts ([§15](#15-sample-data)).
3. **Tests** (`tests/engine.test.js`, Node's built-in `node:test`): every test in [§16](#16-acceptance-tests).
4. **UI** (`index.html`, `src/app.js`, `src/styles.css`): the screens in [§14](#14-screens).
5. **README**: how to run, file layouts, rules, open items.

**Done means:** `npm test` passes; opening `index.html` from disk shows the sample month-end with the counts in [§15](#15-sample-data); a reviewer can approve events, create an IAS file, record a load result and see it in the audit log, with no console errors, at desktop and phone widths, in light and dark themes.

---

## 1. Purpose and scope

The firm holds syndicated bank loans. **Loan System** records loan activity at contract level: every interest period is a new contract with its own ID. **IAS** is the book of record and models a loan as a facility tranche with contracts that carry accrual terms (rate type, base index, spread, floor, frequencies, day count). IAS accrues interest from those terms, so it does not need a new contract each period.

Loan Event Bridge compares two Loan System snapshots, works out what happened to each loan, decides what IAS needs, splits it across IAS portfolios, lets a person review and approve it, and writes an IAS import file. A person loads the file through IAS's import browser and records the result.

In scope:
- Contract events: rollovers, contract changes (new terms), splits, combines, many-to-many restructures, paydowns, draws, capitalized (PIK) interest, repayments.
- Recognising trades and new purchases, which a separate **trade feed** books in IAS, and leaving them alone.
- Monthly unfunded fee transactions (commitment and ticking fees).
- Review, approval, IAS file creation, load results, audit log.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Facility / tranche / asset | One loan tranche. Keyed by the Loan System `primaryIdentifier` (app field `AssetID`). Maps to one IAS tranche security ID. |
| Contract (Loan System "accrual") | One interest period on a facility. Keyed by the Loan System `referenceAccrualId` (app field `ContractID`). |
| Loan System portfolio | A portfolio in the Loan System. Feeds one or more IAS portfolios (one-to-many, never many-to-one). |
| IAS portfolio | A portfolio in IAS. Holds positions in IAS tranches. |
| Position / units | Your holding, in currency units to the cent. |
| Global amount | The whole facility's amount for a contract, across all lenders. The same for every portfolio. |
| Funded / unfunded / LC | Drawn amount / undrawn commitment (revolvers and delayed draws) / letters of credit. Commitment = funded + unfunded + LC. |
| Lineage | Which IAS contract each Loan System contract represents. Carried forward each period. |
| Business date (D) | The day being processed. The run happens the next morning. |
| Event | One facility's change between the two snapshots. |
| Trade feed | The firm's existing process that books buys and sells in IAS. Not part of this app. |

Facility types: `TL` term loan, `RC` revolver, `DDTL` delayed draw term loan.

---

## 3. Architecture and technical constraints

- **Static browser app.** One `index.html` that loads `src/engine.js`, `src/sample-data.js`, `src/app.js` and `src/styles.css`. It must work when opened directly from disk (`file://`). No build step, no server, no framework, no external JavaScript libraries. Google Fonts is optional and must have system font fallbacks.
- **Engine is pure.** `engine.js` exports its functions through a UMD wrapper so it works as `window.Engine` in the browser and via `require()` in Node. No DOM access in the engine.
- **Money is integer cents** everywhere inside the app. Parse with `toCents()`, format with `formatMoney()` (thousands separators, two decimals) or `fromCents()` (plain, two decimals). Never add floating-point currency.
- **Allocation is exact.** Splitting an amount across portfolios uses largest-remainder rounding with BigInt arithmetic ([§8](#8-allocation-to-ias-portfolios)), so parts always add back to the total to the cent.
- **State** is one object saved to `localStorage` under a versioned key (e.g. `loan-event-bridge:v9`). Bump the version when stored shapes change; on a missing or old key, start fresh from the sample. Wrap every storage call in try/catch; the app must work without storage.
- **Files stay local.** Uploaded files are read with `FileReader` and never sent anywhere.
- **Tests** use Node 18+ `node:test` and `assert/strict`. `package.json` has `"test": "node --test"`.
- **Never** put real security IDs, portfolio names, bank details or positions in code, samples or tests. Use made-up values.

---

## 4. Run model and dates

Each morning run processes one business date **D**:

| Input | As of |
|---|---|
| Loan System prior snapshot | End of the business day before D |
| IAS holdings | **The same date as the Loan System prior snapshot** |
| Loan System current snapshot | End of D |

Example: run on Tuesday 10/20 → business date Monday 10/19 → Loan System prior and IAS holdings as of Friday 10/16, Loan System current as of 10/19.

Because IAS and Loan System prior describe the same moment, they tie exactly, and every difference between the two Loan System snapshots happened on D.

**Date checks** (`checkRunDates`), run before detection:
- Each file must have exactly one `AsOfDate`. Missing → error. More than one → error.
- Loan System current must be later than Loan System prior → else error.
- IAS holdings `AsOfDate` must equal Loan System prior's → else error: "IAS holdings are as of X but the Loan System prior snapshot is as of Y. They must be the same date."
- More than 4 calendar days between the snapshots → warning ("check that no business day was skipped").

Errors stop detection and are shown on the queue screen. Warnings are shown but don't stop it.

The **business date** shown in the app is the Loan System current date. IAS messages carry the event's effective date ([§6.6](#66-effective-date-and-event-key)).

---

## 5. Input files

All files are CSV with a header row. The parser must handle quoted fields, escaped quotes (`""`), CRLF or LF line ends and a UTF-8 BOM, and ignore blank lines. Dates may be `YYYY-MM-DD` or `M/D/YYYY`; normalize to `YYYY-MM-DD`. Amounts may contain `,`, `$` and parentheses for negatives.

On upload, check required columns. If any are missing, load nothing and name the missing columns.

### 5.1 Loan System contracts (prior and current)

Both Loan System slots accept **either** the Loan System contracts report as-is ([§5.2](#52-loan-system-contracts-report-conversion)) **or** the app's own layout:

`AsOfDate, LoanPortfolio, AssetID, AssetName, FacilityType, ContractID, ContractType, StartDate, EndDate, Amount, GlobalAmount, Commitment, RateType, InterestType, BaseRate, Tenor, MarginBps, FloorPct, PayFreq, ResetFreq, DayCount`

Optional columns: `PortfolioName`, `IssuerName`, `SpreadAdjBps`, `CapPct`, `AllInRate`.

One row per Loan System portfolio, facility and contract. Field meanings:

| Field | Meaning |
|---|---|
| `ContractType` | `Funded`, `Unfunded`, `LC` or `Other`. Unfunded rows hold the undrawn commitment (one per RC/DDTL facility per portfolio). `LC` counts toward the commitment only. `Other` rows are ignored. |
| `Amount` | Your position in this contract (or unfunded / LC amount). |
| `GlobalAmount` | The facility's global amount for this contract. |
| `Commitment` | Your total commitment in the facility for this portfolio (same on every row of the facility in the portfolio). |
| `RateType` | `Floating` or `Fixed`. |
| `InterestType` | `Cash`, `Capitalize` or `Partial` (PIK). |
| `BaseRate`, `Tenor` | e.g. `SOFR`, `1M` / `3M` / `6M` / `12M`. |
| `MarginBps` | Spread in basis points. For fixed-rate contracts, the coupon in bps. |
| `FloorPct`, `CapPct` | Floor and cap in percent. |
| `PayFreq`, `ResetFreq` | `Monthly`, `Quarterly`, `Semi-Annual`, `Annual`. |
| `DayCount` | `ACT/360`, `ACT/365`, `30/360`, or other text (which has no IAS code). |
| `SpreadAdjBps` | Base rate adjustment in bps. When the "add spread adjustment" setting is on (default), the engine adds it to `MarginBps`, because IAS can't hold an adjustment separately. |

**Contract terms** (compared to detect a terms change): `rateType, interestType, baseRate, tenor, marginBps (incl. adjustment when on), floorPct, payFreq, resetFreq, dayCount`.

### 5.2 Loan System contracts report conversion

The report's headers are matched **ignoring square brackets, spaces and case** (`[portfolioId]`, `portfolioID` and `portfolioid` are the same). A file is recognised as the report if it has a `referenceAccrualId` column.

Required report columns: `portfolioId, instrumentId, primaryIdentifier, referenceAccrualId, accrualType, instrumentSubType, baseRateIndexName, rateType, interestPaymentType, spread, spreadAdjustment, rateFloor, dayCount, numPaymentsPerYear, beginDate, endDate, accrualAmount, globalAccrualAmount`.

Optional: `portfolioName, legalEntityId, legalEntityName, instrumentName, positionId, baseRate, rateCeiling, allInRate, instrumentOriginalGlobalAmount`.

The report has no as-of date. Take it from the file name (first `20YY-MM-DD` or `20YYMMDD` match) or, failing that, from a date field next to the upload. If neither is set, refuse the file.

Conversion (`fromLoanReport(rows, { asOfDate }) → { rows, notes }`):

| App field | From | Rule |
|---|---|---|
| `LoanPortfolio` | `portfolioId` | |
| `PortfolioName` | `portfolioName` | Display only |
| `AssetID` | `primaryIdentifier` | Facility key. IAS stores it in its alternative ID table. |
| `AssetName` | `instrumentName` (else `primaryIdentifier`) | Display |
| `IssuerName` | `legalEntityName` | Display |
| `FacilityType` | `instrumentSubType` | `Term Loan` TL, `Revolver` RC, `Delayed Draw` DDTL. Do **not** fall back to `instrumentType`. |
| `ContractID` | `referenceAccrualId` | |
| `ContractType` | `accrualType` | `Funded` → Funded; `Unfunded` and `Delayed Draw Unfunded` → Unfunded; `Letter of Credit` → LC; `% of Funded` → Other |
| `StartDate`, `EndDate` | `beginDate`, `endDate` | |
| `Amount`, `GlobalAmount` | `accrualAmount`, `globalAccrualAmount` | |
| `Commitment` | computed | Sum of Funded + Unfunded + LC amounts per portfolio and facility |
| `RateType` | `rateType` | `Float`/`Floating` → Floating, `Fixed` → Fixed |
| `InterestType` | `interestPaymentType` | As given (`Cash`, `Capitalize`) |
| `BaseRate`, `Tenor` | `baseRateIndexName` | `1M SOFR Term` → SOFR / 1M. Other names: tenor from the first `NM`, base = name without tenor and the word "Term", upper case (`Prime` → PRIME, no tenor). Blank for fixed. |
| `MarginBps` | `spread` | decimal × 10,000 (0.05 → 500) |
| `SpreadAdjBps` | `spreadAdjustment` | decimal × 10,000 (0.0025 → 25) |
| `FloorPct`, `CapPct` | `rateFloor`, `rateCeiling` | decimal × 100 (0.01 → 1) |
| `PayFreq` | `numPaymentsPerYear` | 12 Monthly, 4 Quarterly, 2 Semi-Annual, 1 Annual, 52 Weekly |
| `ResetFreq` | tenor | 1M Monthly, 3M Quarterly, 6M Semi-Annual, 12M Annual; else the pay frequency |
| `DayCount` | `dayCount` | `ACT/360`; `ACT/365 (Fixed)` → ACT/365; `30U/360` → 30/360; others kept as given |

Rate terms are only filled on Funded rows. Round converted bps and percents to 3 decimals. Collect unrecognised `accrualType` and `instrumentSubType` values into `notes` and show them after loading.

Converting a report and the equivalent app-layout file must produce **identical events and IAS messages** (a test).

### 5.3 Tranche map

`AssetID, IASTrancheID, FacilityType, MaturityDate, IASCurrency`

`IASTrancheID` is the facility's IAS security ID, used as `SecID(3, …)`. `MaturityDate` and `IASCurrency` (numeric IAS currency code, e.g. `1`) are used by the contract create and splits.

### 5.4 Portfolio map

`LoanPortfolio, IASPortfolio, Bank, BankName, CustodyAccount, CashBank`

One row per IAS portfolio. The last four are the `BNK()` fields of IAS portfolio messages, in that order.

### 5.5 IAS holdings

`AsOfDate, IASPortfolio, IASTrancheID, Funded, Unfunded`

Position per IAS portfolio and tranche, as of the Loan System prior date. Used for the tie-out and as the allocation basis.

### 5.6 Contract lineage

`LoanContractID, IASContractID`

The working lineage is kept in state and updated as events are approved ([§13](#13-workflow-ias-files-and-audit)). Uploading a lineage file replaces it. People can also link contracts by hand (**Contract links**, [§13.2](#132-actions)), and the end-of-day lineage file ([§13.5](#135-end-of-day-lineage-file)) is in this same layout, so it loads straight back in.

### 5.7 Fee export

`LoanPortfolio, AssetID, AssetName, FacilityType, FeeType, PeriodStart, PeriodEnd, FeeRateBps, AverageUnfunded, DayCount, Amount, LoanTransactionID`

`PeriodEnd` is the last accrual day (inclusive).

---

## 6. Event detection

`detectEvents({ asOfDate, prior, current, trancheMap, portfolioMap, accounts, iasPositions, lineage, autoApprove })` returns a list of events, sorted by route (exception, review, auto_approve, auto, trade) and then by display name. `autoApprove` is `{ paydowns: true, maxPct: null }` by default ([§7.1](#71-paydown-auto-approval)).

### 6.1 One event per facility

Group rows by `AssetID`, then by `LoanPortfolio` within each facility. **An event is a facility**, not a facility in one portfolio, because a paydown or restructure happens once to the loan. The contract create and global actions are generated once per event; portfolio transactions cover every IAS portfolio holding the facility.

**Facility view.** For each side (prior, current), aggregate across portfolios: one row per contract with `amount` = sum of the portfolios' amounts, terms and dates from the first row, `globalAmount` from the first row. Unfunded and LC are summed. Commitment = sum of each portfolio's commitment. If portfolios disagree on a contract's global amount, terms or dates, raise an exception ("The Loan System portfolios holding this facility disagree on …").

**Portfolio view.** Keep each Loan System portfolio's own rows for its tie-out, trades and portfolio messages.

### 6.2 Contract changes

Given prior and current funded rows (facility or portfolio):
- **expired**: in prior, not in current (by `ContractID`)
- **added**: in current, not in prior
- **amended**: in both, with a different amount or different terms
- **unchanged**: in both, same amount and terms

A facility with no expired, added or amended contracts, no commitment change and no portfolio position change produces no event.

### 6.3 Event type

| Facility pattern | Type |
|---|---|
| Nothing expired or added; an amended contract changed terms | `CONTRACT_CHANGE` (mid-period) |
| Nothing expired or added; funded down / up / unchanged | `PAYDOWN` / `DRAW` / `COMMITMENT_CHANGE` |
| 1 expired → 1 added, same terms | `ROLLOVER` |
| 1 → 1, terms differ | `CONTRACT_CHANGE` |
| 1 → many | `SPLIT` |
| many → 1 | `COMBINE` |
| 0 → some | `DRAW` (into new contracts) |
| some → 0 | `REPAYMENT` |
| many → many | `COMPLEX` |
| No prior rows at all for the facility | `NEW_POSITION` |
| Trades only, no restructure, nothing booked | `TRADE` |
| `DRAW` with no new contracts on a capitalizing contract | `CAPITALIZE` |

Labels: Rollover, Contract change, Contract split, Contract combine, Complex restructure, Paydown, Repayment, Draw, Commitment change, Capitalized interest, Trade, New purchase.

### 6.4 Trades and new purchases

Trades are booked in IAS by the trade feed. The app recognises them and books nothing for them.

For each Loan System portfolio, `delta` = funded after − funded before. With `globalBefore`, `globalAfter`, `globalDelta` from the facility's funded rows:
- **Facility new** (no prior rows anywhere): type `NEW_POSITION`; nothing booked.
- **Portfolio new** (no prior rows in this portfolio, but the facility existed): `tradeDelta` = its funded after (a new holding).
- **Global unchanged** (`globalDelta === 0`, global amounts present, facility still has current rows): `tradeDelta` = `delta` (a buy or sell).
- Otherwise `tradeDelta` = 0.

`bookedDelta` per portfolio = `delta − tradeDelta`; facility `bookedDelta` = their sum (or the full funded change for a new facility). The facility is a trade if any portfolio has `tradeDelta ≠ 0`. If it's a trade, not a restructure (`CONTRACT_CHANGE`, `SPLIT`, `COMBINE`, `COMPLEX`) and nothing is booked, the type is `TRADE`.

When global amounts are unchanged, amended contracts' amount changes are treated as trades (amount change zeroed for planning).

### 6.5 Legs and capitalization

- **Capitalizing**: `bookedDelta > 0` and an expiring or amended contract's interest type is one of `CAPITALIZE, CAPITALIZED, PIK, PARTIAL, PARTIAL PIK` (case-insensitive). The increase is capitalized interest, not a draw.
- **Legs**: when contracts roll (something expired and something added) and the facility isn't new: `bookedDelta < 0` → `PAYDOWN` leg; `> 0` → `CAPITALIZE` or `DRAW` leg.

### 6.6 Effective date and event key

- **Effective date**: the earliest start date of the added contracts; if none, the business date. A split, combine or roll is therefore dated on the **new contracts' start date**, and the global action and every portfolio transaction for the event (trade date, settle date, CCID date, delayed delivery date) carry that one date. The contract create carries each contract's own start and end dates.
- **Date checks** (review): the new contracts start on different dates ("The new contracts start on different dates (D1, D2). All IAS messages for this event are dated D1, the earliest…"); or an expiring contract's end date isn't the effective date ("Contract X ends E, but the new contracts start D… check for a gap or overlap in accrual"). The Loan System convention is that an expiring contract's end date equals its successor's start date.
- **Event key** (stable, so re-running detection never duplicates):
  `AssetID|EffectiveDate|<expired IDs sorted, joined with +, or ->>'>'<added IDs sorted or ->` and, if any contracts were amended, `|~<amended IDs sorted>`.
  Example: `A1007|2026-10-30|418211>418212+418213`.

### 6.7 Initial long and short first periods

For each added contract with a known tenor, days = end − start. Regular ranges: 1M 27–33, 3M 88–94, 6M 179–186, 12M 362–368 days.
- Outside the range on a **new position**, longer → review: "Initial long: the first contract X runs N days (start to end) on a 1M tenor. On its monthly schedule IAS will expect the first interest payment on P; Loan System's first payment is E. Apply the IAS fix for initial long periods."
  `P` = `firstScheduledPayDate`: step back from the end date one tenor at a time (same day of month, clamped to month end) while still after the start date.
- New position, shorter → review: "Initial short: …"
- Otherwise outside the range → review: "New contract X runs N days … check for a stub or broken period."

---

## 7. Checks and routing

Checks add flags at three levels: **exception** (blocks approval), **review**, **info**. Portfolio-level messages are prefixed with the portfolio's display name.

**Exceptions**
- Facility not in the tranche map.
- A Loan System portfolio has no IAS portfolios in the portfolio map.
- Portfolios disagree on a contract's global amount, terms or dates.
- Per portfolio: funded + unfunded + LC ≠ commitment.
- Facility type not TL, RC or DDTL.
- Term loan with an unfunded amount.
- Term loan funded amount went up (booked, not a trade, not capitalizing, not new).
- Draw (booked) larger than the prior unfunded amount (not TL, not capitalizing, not new).
- A funded contract with a non-zero amount but no global amount.
- An expiring or amended contract with no IAS contract in the lineage.
- Per portfolio (unless it's a new holding): no IAS positions in the tranche although Loan System shows a holding; IAS funded ≠ Loan System funded before; IAS unfunded ≠ Loan System unfunded before.
- A portfolio that holds contracts before and after whose expired/added contract IDs differ from the facility's.
- An IAS portfolio would redeem more than its funded IAS holding, or draw more than its unfunded.
- An IAS portfolio used in portfolio messages has no bank or custody account.
- Contract create validation errors ([§11](#11-contract-create-mapping-and-validation)).
- A portfolio's plan steps can't be lined up with the facility's.

**Review**
- Capitalized interest: "Funded amount went up by X on a contract that capitalizes interest…"
- Commitment changed (not a trade, not new): revolver ("confirm permanent reduction or upsize") or other. Silent for a term loan whose commitment moves with par (paydown, or capitalization); info for a DDTL whose commitment fell by the paydown.
- `COMMITMENT_CHANGE`: not generated as IAS messages; book directly.
- New contract with an unexpected rate type (not Fixed/Floating), a floating contract with no base rate, an unexpected interest type.
- Period length checks ([§6.7](#67-initial-long-and-short-first-periods)).
- A trade on the same day as a restructure (per portfolio).
- `COMPLEX`: "booked as a combine into the first new contract, then a split out to the others".
- `REPAYMENT` with no current rows: "If it was repaid, approve. If it was sold or transferred, the trade feed books it: reject."
- Global amount changed, but a portfolio's change isn't its share of it (tolerance: larger of 500 cents or 0.01% of the expected change).
- Date checks from [§6.6](#66-effective-date-and-event-key).

**Info**
- New position (trade feed books it; link the IAS contract later).
- A portfolio trade with no restructure.
- Other contracts on the tranche also changed.
- Split/complex with a paydown or draw: spread across new contracts by size.
- Capitalized interest portfolio transactions are manual (no message format yet).
- Contract create warnings.
- A paydown that would otherwise route to review but fails the auto-approval tie-out: "Not auto-approved: <reasons>".

**Route**
1. Any exception → `exception`.
2. Else any review flag → `review`.
3. Else `TRADE` or `NEW_POSITION` → `trade`.
4. Else `ROLLOVER` with no legs and no amended contracts → `auto` (clean, nothing to send).
5. Else a paydown that passes the tie-out in [§7.1](#71-paydown-auto-approval) → `auto_approve` (approved without a person; its messages go in the next file).
6. Else `review`.

### 7.1 Paydown auto-approval

Month-end brings many paydowns; when the units tie out they don't need a person.

**Eligible**: not a trade; no amended contract with term changes; type `PAYDOWN` (amount-only amendments allowed, e.g. a mid-period paydown) or `ROLLOVER` whose only leg is `PAYDOWN`; tranche mapped; no exception or review flags.

**Tie-out** (`tiePaydown`, returned as `event.paydownTieOut = { ok, reasons, pct, globalPaydown, globalRedeemed, rows }`), per Loan System portfolio:
- IAS funded before = Loan System funded before.
- IAS funded before − the redemptions sent for its IAS portfolios = Loan System funded after.
- Its funded change is within `AUTO_PAYDOWN_SHARE_TOLERANCE` (100 cents) of its share of the global change, `round(globalDelta × fundedBefore / globalBefore)`.

And for the facility: the global action's redeemed units = the fall in the global amount. Settings: `paydowns: false` turns it off; `maxPct` sends paydowns over that percentage of the global amount before the event to review. Each failure adds a sentence to `reasons`.


---

## 8. Allocation to IAS portfolios

**Largest-remainder allocation** (`allocate(amountCents, [{ key, weight }])`): weights are integer cents. Using BigInt, each part = floor(|amount| × weight / total); hand out the leftover cents one at a time to the largest remainders (ties → earlier key); apply the sign. Return `null` if there are no weights or the total weight is 0. The parts always sum exactly to the amount.

Example: `allocate(100, [A:1, B:1, C:1])` → `{ A: 34, B: 33, C: 33 }`.

**Basis**: for each Loan System portfolio, its IAS portfolios' holdings in the tranche, weight = funded + unfunded. IAS portfolios with weight 0 get nothing.

**Each Loan System portfolio is allocated from its own plan** ([§9](#9-ias-plan-what-each-event-becomes)) using its own basis.

**Splits from one source contract into several targets** are allocated together so both directions tie: allocate the total (each IAS portfolio's holding of the source); allocate every target except the last independently; the last target gets each IAS portfolio's holding minus what the other targets took. Each IAS portfolio's pieces then add back to its holding, and each target adds back to its amount.

---

## 9. IAS plan: what each event becomes

`buildPlan` produces:
- `creates`: new IAS contracts to create (each takes the Loan System contract ID as its IAS contract ID, unless IAS already uses that ID for the old contract, in which case `<ID>-<YYYYMMDD>`),
- `steps`: an ordered list of `{ action, lines }`, each line `{ messageType, fromId, toId, amount, globalAmount, note }`,
- `lineage`: Loan System contract → IAS contract updates.

IAS closes emptied contracts itself, so there are no close messages. Paydowns, draws and capitalized interest are booked **after** any split or combine.

| Event | Plan |
|---|---|
| Clean `ROLLOVER` | Nothing. Lineage: new Loan System contract → the old IAS contract. |
| `ROLLOVER` with a leg (same terms) | Leg on the existing IAS contract. Lineage as above. |
| `CONTRACT_CHANGE` (1→1) | Create the new contract → `CONTRACT_SPLIT` old → new, full old amount → leg on the new contract. |
| `SPLIT` (1→n) | Create each new contract → `CONTRACT_SPLIT` from the old contract to each new one (amount = new amount minus its share of the leg) → leg spread over the new contracts by size. |
| `COMBINE` (n→1) | Create the new contract → `CONTRACT_COMBINE` each old contract (its full amount) into the new one → leg on the new contract. |
| `COMPLEX` (n→m) | Create each new contract → `CONTRACT_COMBINE` all old contracts into the **first** new contract → `CONTRACT_SPLIT` from it to each other new contract → leg spread over all new contracts. |
| `DRAW` into new contracts | Create each → `DRAW` into each. |
| `REPAYMENT` | `PAYDOWN` each expired contract in full. |
| Mid-period amended contract | Terms changed: create a new contract and split 1:1 into it. Then `PAYDOWN` or `DRAW`/`CAPITALIZE` for its amount change. |
| `TRADE`, `NEW_POSITION` | Nothing sent (a `TRADE` that is a 1→1 roll still updates lineage). |

Legs spread over several contracts are allocated with `allocate` by contract amount (positions) and by global amount (global units). The plan is built **once for the facility** (for creates, global actions and lineage, using global amounts) and **once per Loan System portfolio** (for portfolio transactions, using that portfolio's own contracts and booked change).

**Message order** for an event:
1. One contract create for all the facility's new contracts (step 1, if any).
2. For each facility step, in order: one global action, then that step's portfolio transactions for every Loan System portfolio, lining each portfolio's steps up with the facility's by action in order.

---

## 10. IAS message formats

### 10.1 Grammar

- `KEYWORD(arg1,arg2,…)`: positional, comma-separated. Submessages are written inline.
- Blank field: nothing between commas (`a,,c`). A literal single space is a value where shown (`a, ,c`).
- No spaces around commas or parentheses.
- Dates `YYYYMMDD`. Units and amounts 6 decimals (`1500000.000000`).
- Build every message as a tree of nodes `{ keyword, args }` and serialize recursively (`null`/`undefined` → blank). **Never build messages with string templates.** Check parentheses balance before writing.
- **The IAS file has one message per line**, each newline-terminated, no blank lines.
- The transaction number (second field of portfolio messages) is **blank**: IAS assigns it on `ADD`.
- Security ID types: `3` = facility tranche (`IASTrancheID`), `26` = contract. A contract allocation record may carry its own ID type.

### 10.2 Global action: `BANKLOANACTION`

`BANKLOANACTION(Add,,SecID(3,<tranche>),<date>,<type>,,BANKLOANACTIONCONTRACTALLOC(BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,<contract>),<signed global units>),…))`

One per step per event, with net signed global units per contract: sources negative, targets positive; paydown negative on the contract; draw and capitalization positive. Omit contracts that net to zero; omit the message if nothing remains.

Types: split `8`, combine `9`, paydown (contract redemption) `6`, draw (drawdown) `4`, capitalization `10`.

### 10.3 Contract split: `TaCONTRACTSPLIT`

`TaCONTRACTSPLIT(ADD,,SecID(3,<tranche>),CONTRACTSECID(26,<source>),<date>,<date>,<IAS portfolio>,BNK(<Bank>,<BankName>,<CustodyAccount>,CASHBANK(<CashBank>)),<units exchanged>,0.000000,,CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,<target>),<units>),…),SETMTHD(11),TRDR(M,<tranche maturity YYYYMMDD>,100.0000000,0.000000000000000,,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,,),CCID(<ccid>,<date>,0))`

One per IAS portfolio per source contract. Units exchanged = sum of the allocation records. Skip zero records and zero messages.

### 10.4 Contract combine: `TaCONTRACTCOMBINE`

`TaCONTRACTCOMBINE(ADD,,SecID(3,<tranche>),CONTRACTSECID(26,<target>),<date>,<date>,<IAS portfolio>,BNK(…),<units exchanged>,CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,<source>),<units>),…),CCID(<ccid>,<date>,0))`

One per IAS portfolio per target contract.

### 10.5 Paydown: `TaContractRedemption`

`TaContractRedemption(ADD,,SecID(3,<tranche>),CONTRACTSECID(26,<contract>),<date>,<IAS portfolio>,BNK(…),<units>,<units>,0.000000)`

One per IAS portfolio per contract. Note: Portfolio comes **before** `BNK()`. Accrued interest `0.000000`.

### 10.6 Draw: `TaDrawDown`

`TaDrawDown(ADD,,SecID(3,<tranche>),<date>,<date>,,BNK(…),<IAS portfolio>,<units>,<units>,BLUNFUNDED(UNFUNDEDUNITS(<units>),BLUNFUNDEDTKDN(F)),CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,<contract>),<units>),…),DELAYEDDELIVERYDATE(<date>))`

One per IAS portfolio, allocated to the contracts drawn into. Trade date = settle date = delayed delivery date = effective date. Blank broker. `BNK()` comes **before** Portfolio.

### 10.7 Capitalized interest

No IAS format yet. Portfolio transactions are **manual**: left out of the file and listed as an "after loading" checklist ("Capitalized interest of X on contract Y for IAS portfolio Z (tranche), effective D."). The global action (type 10) *is* in the file.

### 10.8 CCID

`CCID(<batchId>-<4-digit sequence>,<date>,0)` on split and combine messages, the sequence counting every message in the file. In previews, use `TBD`.

### 10.9 Contract create

See [§11](#11-contract-create-mapping-and-validation).

---

## 11. Contract create: mapping and validation

One `SMFBANKLOANTRANCHE` UPDATE per event, adding every new contract as a `SMFBANKLOANCONTRACTREC`:

`SMFBANKLOANTRANCHE(UPDATE,SecID(3,{tranche_id}),,{loan_type},{tranche_maturity},{currency},SMFBANKLOANCONTRACT(REPLACE,SMFBANKLOANCONTRACTREC(REPLACE,SecID(26,{contract_id}),{strip},{payment_type},{contract_maturity},,COUPONDATA({coupon_type},{coupon_rate},{coupon_form},{coupon_freq},{day_count},{accrual_month},{accrual_day},{dated_type},,,{delay},HOLIDAYS({holiday_schedule},{pay_date_conv}),FLOATDATA({base_index},{float_method},{reset_freq},{reset_month},{reset_day},COMPOUNDFACTORS({spread_bps},{multiplier}),{max_rate},{min_rate},0,0,LOCKOUTINFORMATION({lockout_days},{lookback_days}),RESETDATECONV({reset_date_conv}),RESETHOLIDAYSCHEDULE({reset_holiday_schedule}))),ISSUENAME({issue_name}))[,SMFBANKLOANCONTRACTREC(…)…]))`

- `coupon_rate` is blank for floating; 6 decimals for fixed. `FLOATDATA` is omitted for fixed.
- `spread_bps`, `multiplier`, `max_rate`, `min_rate`, `coupon_rate`: 6 decimals.
- `ISSUENAME()` only if an issue name is given. Optional `CCID(user,date,time)` at tranche level, off by default.
- Never emit: `ACCTDATA, OPERDATA, CALLDATA, CONTRACTSIZE, ISSUESYMBOL, OIDDATE, OIDPRICE, SINKFUNDDATA, MANDCONV, ACCRUALLAG, BORROWERID, OPTIONTODEFER, NONADMITTEDINCOMEIND, UNCOLLECTABLEINCOMEIND, BALLOONPAYMENTPERCENTATORIGINATION, OPTIONALNONCASHINCOMEIND, SERBNDTREATMENT, PIKDATA, ACCRUALDATA, SCHDINTDATA, PIKFIXEDRATEDATA, VARACCRUALDATA, COMPOUNDFREQ, COMPOUNDMETHOD, COMPOUNDMONTH, COMPOUNDDAY, INTERPOLATEINITIALRATE, VRROUNDING, ALTRATECALCMETHOD, DAYLAGWEIGHTMETHOD, ADJUSTACCRUALFORMATURITY`.

**Defaults**: strip `' '` (a literal space), payment_type `B`, coupon_form `C`, day_count `D`, dated_type `T`, delay `0`, holiday_schedule `US`, pay_date_conv `3`, float_method `A`, multiplier `1`, max_rate `0`, lockout_days `0`, lookback_days `2`, reset_date_conv `3`, reset_holiday_schedule `US`.

**Mapping from a Loan System contract:**

| Field | From |
|---|---|
| `tranche_id`, `tranche_maturity`, `currency` | Tranche map |
| `contract_maturity` | Tranche maturity |
| `loan_type` | TL 1, RC 2, DDTL 3 |
| `contract_id` | New IAS contract ID |
| `coupon_type` | Fixed F, Floating V |
| `coupon_rate` | Fixed only: `MarginBps / 100` |
| `coupon_form` | Cash C; Capitalize, Capitalized, PIK, Partial, Partial PIK → P |
| `coupon_freq`, `reset_freq` | Monthly M, Quarterly Q, Semi-Annual S, Annual A, At Maturity B |
| `day_count` | ACT/360 D, ACT/365 C, 30/360 A |
| `accrual_month`, `reset_month` | From the pay month (contract end date month): Q → 19 + (month−1) mod 3; S → 13 + (month−1) mod 6; A → month; otherwise blank |
| `accrual_day`, `reset_day` | max(day of start date, day of end date); blank when frequency is B or T |
| `base_index` | SOFR + tenor → `SR1M`, `SR3M`, … (floating only) |
| `spread_bps`, `min_rate`, `max_rate` | `MarginBps`, `FloorPct`, `CapPct` (or 0) |

**Validation** (errors block the message and make the event an exception; warnings are info):
1. Required: tranche_id, contract_id, tranche_maturity, contract_maturity, currency, coupon_type, coupon_freq, dated_type (a space counts as present).
2. Maturities are real `YYYYMMDD` dates.
3. contract_maturity ≤ tranche_maturity.
4. loan_type in {1, 2, 3}.
5. payment_type in {B, S}; numeric 66 → B and 83 → S with a warning.
6. Floating: coupon_rate blank; base_index, float_method, reset_freq, spread_bps, multiplier, max_rate, min_rate, lockout_days, lookback_days, reset_date_conv, reset_holiday_schedule present. A missing base index reads "No IAS base index for base rate X".
7. Fixed: coupon_rate present and ≥ 0.
8. accrual_day blank when coupon_freq is B or T, else 1–31.
9. accrual_month: Q → 19/20/21, S → 13–18, A → 1–12.
10. dated_type in {T, N, space}; dated date blank when T or space.
11. delay, spread_bps, min_rate, max_rate not negative.
12. coupon_freq in {M, Q, S, A, B}; day_count in {D, C, A}; floating reset_freq in {M, Q, S, A}. Otherwise "No IAS … code for X" (e.g. Weekly, ACT/ACT).
13. Partial PIK → warning (sent as coupon form P).
14. No contract ID created twice in one IAS file (checked when building the file).
15. Balanced parentheses.

---

## 12. Monthly fees

Fees are per Loan System portfolio (no global action). `checkFees({ fees, trancheMap, portfolioMap, iasPositions })`:

- **Fee key**: `FEE|LoanPortfolio|AssetID|FEETYPE (upper case)|PeriodStart|PeriodEnd`. A repeat key in the same export → exception ("Same facility, fee type and period as row N"), and the key gets `|row<N>` so keys stay unique.
- **Expected fee**: days = PeriodEnd − PeriodStart + 1; basis 365 if the day count contains 365, else 360; expected = round(AverageUnfunded × FeeRateBps / 10,000 × days / basis) in cents. Example: 5,000,000.00 at 50 bps, 31 days, ACT/360 → 2,152.78.
- **Exceptions**: facility not in the tranche map; portfolio not in the portfolio map; fee on a term loan; period end before start; no IAS unfunded position to split on.
- **Review**: negative amount (correction); zero amount; |amount − expected| > max(100 cents, 0.1% of expected); IAS unfunded today differs from the fee's average unfunded by more than 10%.
- **Allocation**: across the Loan System portfolio's IAS portfolios by their **unfunded** position (largest remainder).
- **Route**: exception / review / clean. Clean fees start as "Clean, ready to approve" and can be approved all at once.
- **Fee file** (CSV): `BatchID, Seq, FeeKey, TransactionType, FeeType, IASPortfolio, IASTrancheID, PeriodStart, PeriodEnd, Amount, LoanTransactionID`, transaction type `UNFUNDED_FEE`, one row per IAS portfolio. This layout is a placeholder.

---

## 13. Workflow, IAS files and audit

### 13.1 Statuses

| Status | Label | Group | Set by |
|---|---|---|---|
| `verified` | Clean, no IAS action | Clean | Detection (route auto) |
| `trade_feed` | Booked by trade feed | Trades | Detection (route trade) |
| `pending` | Needs review | Needs review | Detection (route review) |
| `exception` | Exception | Exceptions | Detection |
| `ready` | Clean, ready to approve | Clean | Fee check |
| `approved` | Approved | Approved | Person |
| `auto_approved` | Auto-approved, units tie | Approved | Detection (route auto_approve) |
| `in_batch` | In IAS file | Awaiting import | Creating a file |
| `loaded` | Loaded in IAS | Done | Recording a load |
| `failed` | Import failed | Needs review | Recording a load |
| `closed` | Approved, nothing to send | Done | Approving an event with no file messages |
| `rejected` | Rejected | Done | Person (comment required) |
| `manual` | Handled outside the app | Done | Person (comment required) |

Statuses `pending`, `exception`, `ready`, `trade_feed` and `auto_approved` are system-set: re-running detection recalculates them. Any other status is a person's decision and survives a re-run (the event key matches), as does a status with `hold: true` (set by **Hold for review**). An auto-approval that no longer qualifies on a re-run removes the lineage updates it applied. Both `approved` and `auto_approved` events go in the next file. Each new auto-approval is written to the audit log by "Auto-approval".

### 13.2 Actions

- **Approve** (pending or ready): requires the user's name. → `approved` if the event has file messages, else `closed`. Applies lineage updates.
- **Reject**: comment required.
- **Mark as handled outside the app** (exception or failed): comment required.
- **Hold for review** (auto_approved): requires the user's name. → pending with `hold: true`, so re-runs don't auto-approve it again. Removes its lineage updates.
- **Undo approval**: back to pending (fees: back to ready if clean). Removes the lineage updates it applied.
- **Re-approve after a failed import**: → approved.
- **Approve all clean fees**: every `ready` fee → approved.
- Detection applies lineage updates for `verified`, `trade_feed` and `auto_approved` events.
- **Link a contract** (event drawer, *Contract links*): lists the event's live contracts (added, amended, unchanged) with their IAS link. A text box and a Link/Update button appear unless the app sets that link itself (a `pending`/`ready` event whose approval will set it, or a link set by an approval). The box always shows for `manual` and `trade_feed` events, so new purchases and events handled outside the app can be linked. Requires the user's name. Writes `lineage[loanContractId] = iasContractId` and logs "Linked contract" or "Changed contract link" with `old → new`.

### 13.3 IAS files

- **Create contract event file**: all approved events → `buildIasFile(events, { batchId, today })`. ID `B<YYYYMMDD>-NN` (business date, sequence per day), file `IAS_IMPORT_<id>.txt`, one message per line. Manual messages go into a "before loading" (contract creates, if ever manual) or "after loading" checklist. **Errors** (duplicate contract IDs) stop file creation. **Warnings**: a redemption or drawdown dated after today (IAS rejects future-dated ones).
- **Create fee file**: all approved fees → ID `F<YYYYMMDD>-NN`, `IAS_FEES_<id>.csv`.
- Events go to `in_batch` with the batch ID.
- **Record import result**: for each item, Loaded or Failed (a failed item needs the IAS import browser error). Failed items → `failed` and back into review; the rest → `loaded`. Batch status: all loaded, or some failed.
- Each file can be copied (clipboard) and downloaded. Downloads may be blocked in hosted previews; copying must always work, with a select-the-text fallback.

### 13.4 Audit log

Every detection run (with counts), fee check, approval, rejection, manual handling, undo, file creation, load result, file upload and setting change: time, user, action, item label, comment. Newest first. Clicking an entry for an event or fee opens it.


### 13.5 End-of-day lineage file

`lineageExport({ lineage, current, liveOnly = true })` returns `{ rows, unlinked, expired, liveCount }`:
- **Live contracts** are the distinct funded contract IDs in the current snapshot.
- `rows`: `{ LoanContractID, IASContractID }` for each linked live contract (with `liveOnly: false`, every link), sorted by contract ID. Tomorrow's prior snapshot is today's current one, so expired links aren't needed.
- `unlinked`: live contracts with no link (`contractId, assetId, assetName, issuerName`).
- `expired`: how many links are for contracts no longer live.

The IAS files tab shows an **End of day: contract lineage** panel: link counts; a review flag if events are still pending, in exception, approved, auto-approved, in a file or failed; a table of unlinked live contracts with today's event status (click to open the event); an "include links for expired contracts" option; **Download `LINEAGE_<YYYYMMDD>.csv`** (business date; logged as "Exported contract lineage") and **Copy file contents**; and a preview. The file is in the lineage layout, so loading it as the lineage input restores the links on another computer or browser.

---

## 14. Screens

Utilitarian, readable operations tool. Light and dark themes (system preference), keyboard focus visible, works at phone width without horizontal page scroll (wide tables scroll inside their container). Money and IDs in a monospace face with tabular numbers.

**Top bar**: app name "Loan Event Bridge", subtitle "Loan System activity into IAS", tabs (Event queue, Monthly fees, IAS files, Setup and data, Audit log) with counts of items needing attention, and a "Working as" name field.

**Event queue**
- Run panel: business date, Loan System dates compared, IAS holdings date, data source, last detection; buttons Re-run detection and Load files. Date-check errors and warnings shown as flags.
- Tiles that double as filters: Needs review, Exceptions, Clean rollovers, Trades, Approved, Awaiting import, Done (and "Show all events").
- Search box (issuer, instrument, facility ID, contract IDs, portfolio names).
- Table: Status chip; Event (type plus leg tags, failed import error); Asset (issuer over instrument, facility ID · type); **Held in** (Loan System portfolio name, or "N Loan System portfolios", and the IAS portfolio count); Effective date; Loan System contracts (expired → added, amended); Funded change; IAS messages (file messages only); Checks (issue count, coloured by severity, or "Passed").

**Event panel** (slides in from the right; Escape closes)
- Header: type · facility type · "held in N Loan System portfolios"; issuer as title; instrument and facility ID; status chip; leg tags; effective date.
- Plain-language summary of what happened.
- Checks (exception / review / note).
- Loan System contracts table (Expiring / New / Before / After / Unchanged rows): Loan System contract, IAS contract (lineage, or pending new ID), period, days (highlight irregular), amount, global, rate, interest, tenor, margin, floor, pay, reset, day count; highlight cells that differ from the expiring contract.
- Facility totals, all portfolios: funded, unfunded, commitment, global funded with your share, IAS tranche.
- **Holdings by portfolio**: Loan System portfolio (name, ID, any trade), funded before, funded after, unfunded before, IAS portfolios, IAS funded before, tie-out (Ties / Off by X / New holding); total row when more than one.
- Allocation to IAS portfolios: one table per Loan System portfolio (IAS position before; each line split by IAS portfolio with share %; tie check to the Loan System amount).
- IAS messages: each file message indented for reading (step, level, type, IAS portfolio), the before/after checklists, Copy messages (single-line form).
- Event key; history (audit entries for this event).
- Footer actions by status.

**Monthly fees**: run panel (export, period, total), Approve N clean fees, Re-check fees, Load fee export; tiles; table (status, facility, fee type, portfolio, period, rate, average unfunded, amount, expected, difference, checks); fee panel with the calculation, checks, allocation on unfunded, IAS fee transactions, fee key, history, actions.

**IAS files**: two "ready" panels (contract events, fees) with create buttons; list of files with status, contents, copy and download, warnings and checklists, and the import result form.

**Setup and data**: data in use and dates; Run detection; Restore sample data (two-step confirm); one card per input with expected columns, an upload, a date field for the Loan System report slots, row count and "Copy current data as CSV"; the spread adjustment setting; the paydown auto-approval setting (on/off, plus an optional "send paydowns larger than X% of the global amount to review"); the rules in plain language; mapping and lineage viewers.

**Audit log**: table as in [§13.4](#134-audit-log).

---

## 15. Sample data

`src/sample-data.js` generates a fictional month-end in the app's layouts, with prior as of 2026-10-29 and current as of 2026-10-30, two Loan System portfolios (`LOANS-MASTER` → FUND-I, FUND-II, SMA-ALPHA; `CLO-MASTER` → CLO-2023-1, CLO-2024-1), share patterns that differ by tranche, and global amounts = position ÷ share. It must cover:

| Case | Expected |
|---|---|
| Clean 1M and 3M rollovers (several) | auto |
| A facility held in both portfolios, paid down 10% at its roll | review; **one** global action; redemptions in all five IAS portfolios |
| Margin change; tenor change 1M→3M | review, contract change |
| 1→2 split; 2→1 combine (revolver); 2→2 complex | review |
| Revolver rollover with a paydown | review |
| Mid-period amortization paydown | review |
| Delayed draw into a new contract | review |
| 17-day stub on an existing loan | review |
| PIK term loan with capitalized interest | review |
| New purchase with a 46-day initial long (pays on the 15th) | review, initial long flag |
| A sale on a clean roll (position down, global unchanged) | trade |
| IAS position break | exception |
| Facility not in the tranche map | exception |
| Revolvers and delayed draws with no activity (for fees) | no event |

With these, the sample month-end gives **26 events: 11 clean rollovers, 3 paydowns auto-approved (A1003, A1009 at the roll; A1010 mid-period), 9 for review, 2 exceptions, 1 trade.** The fee export (October 2026, ACT/360) gives **13 fees: 7 clean, 3 for review, 3 exceptions** (a rate mismatch, unfunded drift from a mid-month draw, a negative September correction; a duplicate row, a fee on a term loan, an unmapped facility).

Also provide `toLoanReport(rows)` to produce the same data as Loan System report rows, and two sample report files (`docs/samples/loan-system-contracts-report-2026-10-29.csv` and `-10-30.csv`).

---

## 16. Acceptance tests

All in `tests/engine.test.js`. Each bullet is at least one test.

### 16.1 Basics
- `allocate` sums exactly for 1, 2, large, negative and zero amounts; `allocate(100, A:1,B:1,C:1)` = 34/33/33; empty weights → null.
- CSV round trip with commas and quotes; `missingColumns`.
- `toCents('1,234.56')` = 123456; `toCents('(1,000.00)')` = −100000; `fromCents(-5)` = '-0.05'; `formatMoney(1333333333)` = '13,333,333.33'; `normalizeDate('10/30/2026')` = '2026-10-30'.
- Event keys are stable across runs and unique.

### 16.2 Detection and routing
- Sample counts as in [§15](#15-sample-data).
- Clean rollover: auto, no messages, lineage to the old IAS contract.
- Margin change: messages in order `1:SMF:CONTRACT_CREATE, 2:GLOBAL:CONTRACT_SPLIT, 2:PORTFOLIO:CONTRACT_SPLIT ×3`; new contract ID = Loan System contract ID; global split nets to zero; portfolio units sum to the old amount.
- Split: two lines, each tying to its amount; each IAS portfolio's split units equal its holding of the old contract; one tranche update with two contract records; one global action.
- Complex: steps `1:CONTRACT_CREATE, 2:CONTRACT_COMBINE, 3:CONTRACT_SPLIT`; the combine names the target, the split names the first new contract as source.
- Revolver paydown at roll: global type 6 with units = global change; three redemptions summing to the paydown; `TaContractRedemption` line format.
- Draw into a new contract: steps create, global draw, portfolio draw; `TaDrawDown` line format; allocations sum.
- Stub period → review with "17 days".
- Paydown auto-approval: A1003, A1009 and A1010 route `auto_approve`; every tie-out row has IAS before = Loan System before and IAS after = Loan System after; the global action redeems the full global paydown. With `paydowns: false` A1003 → review with a "turned off" info flag; with `maxPct: 5` A1003 (10%) → review, A1010 (0.25%) stays auto. Moving one portfolio's A1003 amount by $3.00 → review, that row's `shareDiff` = 300, flag "Not auto-approved … off its share".
- Split dates: A1007's effective date = the new contracts' start date = the old contract's end date, and every non-create message is dated 2026-10-30. A new contract starting a day later → review "start on different dates (2026-10-30, 2026-10-31)"; the old contract ending 2026-10-29 → review "418211 ends 2026-10-29, but the new contracts start 2026-10-30".
- PIK: legs `[CAPITALIZE]`, global type 10, no "do not draw" flag.
- IAS position break and unmapped facility → exception.
- Term loan funded increase (global moved) → exception.
- Missing global amount → exception.
- Portfolio without bank details → exception.
- A fund redeeming more than it holds → exception naming the fund.
- Future-dated redemption/drawdown → one file warning; none when today is later.
- Lineage export: of current contracts C2 (two portfolios) and C9, with links C1→IAS-1 and C2→IAS-1, rows = [C2→IAS-1], unlinked = [C9], expired = 1, liveCount = 2; with `liveOnly: false` rows are C1 and C2; the CSV parses back through `normalizeLineage` to the same links.

### 16.3 Trades, new purchases, dates
- A sale on a clean roll: route trade, type TRADE, no messages, lineage still carried forward.
- New purchase with a 46-day first contract: NEW_POSITION, review, message names IAS's first pay date 2026-11-15 and the Loan System's 2026-12-15; with a regular first period → trade.
- A sale on the same day as a split: review, no paydown leg.
- `firstScheduledPayDate`: (1M, 10/30 → 12/15) → 11/15; (1M, 10/15 → 11/30) → 10/30; (3M, 9/01 → 2027-01-29) → 2026-10-29; (1M, 10/30 → 11/30) → 11/30.
- Date checks: sample passes; IAS date ≠ prior → error; current not later → error; long gap → one warning; mixed dates in a file → error.

### 16.4 One event per facility
- A facility held in two portfolios is one event with two holdings that tie, one global action, and redemptions in all five IAS portfolios, each Loan System portfolio redeeming its own share.
- A break in one portfolio blocks the whole event and shows which portfolio doesn't tie.
- Portfolios disagreeing on a global amount → exception.
- A sale in one portfolio on a clean roll → TRADE for the facility; only that portfolio has a trade delta.

### 16.5 IAS message golden strings (must match exactly)

Contract create (build-spec golden input: tranche DUMMYSEC001, loan type 2, maturity 20310107, currency 1, contract CNTR0005, floating, Q, accrual month 19, day 30, SR3M, spread 500, floor 1, issue name `01/25 Revolver`):

```text
SMFBANKLOANTRANCHE(UPDATE,SecID(3,DUMMYSEC001),,2,20310107,1,SMFBANKLOANCONTRACT(REPLACE,SMFBANKLOANCONTRACTREC(REPLACE,SecID(26,CNTR0005), ,B,20310107,,COUPONDATA(V,,C,Q,D,19,30,T,,,0,HOLIDAYS(US,3),FLOATDATA(SR3M,A,Q,19,30,COMPOUNDFACTORS(500.000000,1.000000),0.000000,1.000000,0,0,LOCKOUTINFORMATION(0,2),RESETDATECONV(3),RESETHOLIDAYSCHEDULE(US))),ISSUENAME(01/25 Revolver))))
```

Fixed variant (coupon 7.25): contains `COUPONDATA(F,7.250000,C,Q,` and no `FLOATDATA`. With CCID on: ends `,CCID(USER,20261017,0))`. No excluded field ever appears.

Combine (tranche DUMMYSEC001, target CNTR0001, sources CNTR0002 and CNTR0003 at 100,000.00 each, portfolio 9999, BNK1 / Dummy Custody Account / 12345678 / CSH, CCID DUMMYCCID001, date 2026-10-17):

```text
TaCONTRACTCOMBINE(ADD,,SecID(3,DUMMYSEC001),CONTRACTSECID(26,CNTR0001),20261017,20261017,9999,BNK(BNK1,Dummy Custody Account,12345678,CASHBANK(CSH)),200000.000000,CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,CNTR0002),100000.000000),CONTRACTALLOCREC(SecID(26,CNTR0003),100000.000000)),CCID(DUMMYCCID001,20261017,0))
```

Split (source CNTR0001, targets CNTR0002 and CNTR0003 at 50,000.00 each, maturity 2031-01-07):

```text
TaCONTRACTSPLIT(ADD,,SecID(3,DUMMYSEC001),CONTRACTSECID(26,CNTR0001),20261017,20261017,9999,BNK(BNK1,Dummy Custody Account,12345678,CASHBANK(CSH)),100000.000000,0.000000,,CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(26,CNTR0002),50000.000000),CONTRACTALLOCREC(SecID(26,CNTR0003),50000.000000)),SETMTHD(11),TRDR(M,20310107,100.0000000,0.000000000000000,,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000,,),CCID(DUMMYCCID001,20261017,0))
```

Global combine (CNTR0004 −1,000,000; CNTR0002 +1,500,000; CNTR0001 −500,000):

```text
BANKLOANACTION(Add,,SecID(3,DUMMYSEC001),20261017,9,,BANKLOANACTIONCONTRACTALLOC(BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,CNTR0004),-1000000.000000),BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,CNTR0002),1500000.000000),BANKLOANACTIONCONTRACTALLOCREC(ContractSecID(26,CNTR0001),-500000.000000)))
```

Redemption (tranche 037542A*8, contract F00002046, 500,000.00, portfolio 1341, BNK AG5 / Agent Bank - Private BL / 84716600 / CIT, date 2026-10-19):

```text
TaContractRedemption(ADD,,SecID(3,037542A*8),CONTRACTSECID(26,F00002046),20261019,1341,BNK(AG5,Agent Bank - Private BL,84716600,CASHBANK(CIT)),500000.000000,500000.000000,0.000000)
```

Drawdown (1,000,000.00 allocated 33,248.08 to contract 2089 under ID type 10007, 588,235.29 to F00002046, 378,516.63 to F00002087):

```text
TaDrawDown(ADD,,SecID(3,037542A*8),20261019,20261019,,BNK(AG5,Agent Bank - Private BL,84716600,CASHBANK(CIT)),1341,1000000.000000,1000000.000000,BLUNFUNDED(UNFUNDEDUNITS(1000000.000000),BLUNFUNDEDTKDN(F)),CONTRACTALLOC(ADD,CONTRACTALLOCREC(SecID(10007,2089),33248.080000),CONTRACTALLOCREC(SecID(26,F00002046),588235.290000),CONTRACTALLOCREC(SecID(26,F00002087),378516.630000)),DELAYEDDELIVERYDATE(20261019))
```

An IAS file for an event is one message per line, newline-terminated, in the order create, global, portfolio; every line has balanced parentheses; no line starts with `ADD,` followed by a digit (no transaction numbers).

### 16.6 Contract create validation
At least one failing case per rule in [§11](#11-contract-create-mapping-and-validation), including payment type 66 converting to B with a warning, duplicate contract IDs in one file, and unbalanced parentheses. From Loan System data: a 1M→3M tenor change maps to loan type 1, coupon frequency Q, accrual month 19, base index SR3M; a missing tranche maturity makes the event an exception.

### 16.7 Loan System report
- Headers match with or without brackets and in any case; missing columns are named; `instrumentType` without `instrumentSubType` is reported missing.
- Example row: spread 0.05 → 500 bps, spreadAdjustment 0.0025 → 25 bps, floor 0.01 → 1%, 4 payments/yr with 1M SOFR → quarterly pay and monthly reset, Term Loan → TL, Float → Floating. Margin 525 with the setting on, 500 off.
- Accrual types map to Funded / Unfunded / LC / Other / Unfunded; commitment includes LC.
- Unrecognised accrual and instrument sub types are reported; weekly pay, ACT/ACT and Prime block the contract create; ACT/365 (Fixed) and 30U/360 don't.
- A spread adjustment change between periods is a contract change with the setting on, a rollover with it off.
- The sample report files give exactly the same events and IAS messages as the built-in sample.
- Portfolio name, issuer and instrument name carry through to the event.

### 16.8 Fees
- Sample counts as in [§15](#15-sample-data).
- Expected fee: 5,000,000.00 at 50 bps for 2026-10-01 to 2026-10-31 → 31 days, 215,278 cents (ACT/360); 212,329 cents (ACT/365).
- A clean fee splits on unfunded and ties to the cent; all rows are `UNFUNDED_FEE`.
- Rate mismatch, unfunded drift and a negative correction → review (the correction allocates and ties); duplicate row, term loan fee and unmapped facility → exception.
- Fee keys are unique even with duplicate rows.

---

## 17. Assumptions and open items

These are built as described but still need confirming. List them in the README.

- **IAS contract IDs**: new IAS contracts take the Loan System accrual ID (24-character hex in the Loan System). Confirm IAS accepts that length, or how IAS should number new contracts.
- **`SMFBANKLOANCONTRACT(REPLACE, …)`**: confirm in an IAS test region that sending only the new contracts doesn't remove the tranche's existing contracts. If it does, existing contracts must be re-sent.
- **Global action types** 6, 4 and 10 for paydown, draw and capitalization; whether Tranche Amount is needed.
- **`TaContractRedemption`** isn't yet validated against an IAS-generated message.
- **`TaDrawDown`**: blank broker slot, `BLUNFUNDEDTKDN(F)` meaning, settle date vs trade date, whether `CONTRACTALLOC` can be omitted.
- **`TRDR()` fields** on splits, ex date vs payment date, CCID content.
- **`BNK()` field order**: bank, bank name, custody account, cash bank (from the drawdown spec).
- **Contract ID types**: the app sends 26 for every contract; some may use another type (e.g. 10007).
- **Capitalized interest** portfolio message format (manual today).
- **Spread adjustment**: whether IAS's spread is always spread + adjustment (setting, default on).
- **Monthly contracts' accrual month** (sent blank); 1M SOFR paying quarterly: whether Loan System accrues monthly or quarterly.
- **IAS codes** for Prime, ACT/ACT and weekly pay.
- **"% of Funded"** accrual rows (ignored) and letters of credit in IAS.
- **Fixed-rate coupon** source (`MarginBps ÷ 100`).
- **IAS holdings as of a past date** and **back-dated messages** (one business day, three after a weekend).
- **Fee file layout** and allocating fees on average daily unfunded.
- **Contract-level IAS holdings**: moving actual units per contract instead of pro-rata estimates.
- **Initial long fix** in IAS (flagged today, no message generated).
- **Payment date changes** (e.g. 15th → 30th) aren't detected as such.

---

## 18. Out of scope

- Sending anything to IAS or Loan System. The app only writes files a person loads.
- Booking trades (the trade feed does that).
- Creating new tranches or deals in IAS.
- Unfunded contract records in IAS's security master.
- Shared multi-user state, logins and automated feeds (a later production phase: scheduled feeds, shared database, single sign-on, monitoring).
- Two-person approval (can be added later).
