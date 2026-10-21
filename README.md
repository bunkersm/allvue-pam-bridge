# Loan Event Bridge

Prototype that finds loan contract activity in AllVue, sorts it into what PAM needs, and produces PAM import files after review.

Everything runs in the browser. There is no server, and files you load stay on your machine.

## Run it

Open `index.html` in a browser. It starts with a fictional month-end (2026-10-29 → 2026-10-30): 25 events across two AllVue portfolios that feed five PAM portfolios.

Run the engine tests with Node 18 or later:

```
npm test
```

## How it works

### Dates

Each morning run processes one **business date** D (the previous business day):

| Input | As of |
|---|---|
| AllVue prior snapshot | End of the business day before D |
| PAM holdings | Same date as the AllVue prior snapshot |
| AllVue current snapshot | End of D |

Example: run on Tuesday 10/20 → business date Monday 10/19; AllVue prior and PAM holdings as of Friday 10/16. Detection stops if PAM's `AsOfDate` doesn't match the AllVue prior date or the current snapshot isn't later, and warns if the snapshots are more than 4 days apart.

### Trades

Buys, sells and new purchases are booked in PAM by the **trade feed**, not by this app. A position change with no change in the facility's global amount is a trade, and nothing is sent. A position that wasn't in the prior snapshot is a **new purchase**: nothing is sent, but an initial long or short first period goes to review with PAM's expected first pay date next to AllVue's. A trade on the same day as a split, combine or terms change goes to review.

1. **Detect.** For each AllVue portfolio and asset, compare the prior-day and current-day contract exports. Contracts that are gone are *expiring*; contracts that appeared are *new*; contracts with the same ID but a different amount or terms are *amended*.
2. **Classify.**

   | AllVue pattern | Event | Route |
   |---|---|---|
   | 1 → 1, same amount and terms, regular period | Rollover | Auto: verified, nothing sent to PAM |
   | 1 → 1, terms differ | Contract change | Review |
   | 1 → many | Contract split | Review |
   | many → 1 | Contract combine | Review |
   | many → many | Complex restructure | Review |
   | new contract, nothing expiring | Draw | Review |
   | lower funded total | Paydown (booked after any split or combine) | Review |
   | higher funded total on a Capitalize/Partial contract | Capitalized (PIK) interest | Review |
   | your position moves but the global amount doesn't | Trade, not a paydown or draw | Exception |
   | irregular period (stub/broken) | Flag | Review |

   **Exceptions** block approval: missing global amounts, a position change with no global change (a trade), unmapped asset or portfolio, PAM positions not tying to AllVue before the event, funded + unfunded ≠ commitment, term loan draws, draws larger than unfunded, missing contract lineage.
3. **Allocate.** Each amount is split across the PAM portfolios mapped to the AllVue portfolio, pro rata on their current PAM position (funded + unfunded), with largest-remainder rounding so the parts tie to the AllVue amount to the cent.
4. **Review.** Approve or reject each event with a comment. Every decision goes to the audit log.
5. **PAM file.** Approved events go into a numbered import file. Import it through PAM's import browser, then record which events loaded or failed. Failed events return to review with the PAM error.

## Monthly fees

The **Monthly fees** tab replaces the manual monthly load of unfunded fee transactions.

1. Load the AllVue unfunded fee export (one row per facility, fee type and period).
2. Each fee is checked against rate × average unfunded × days ÷ 360 (or 365). It is **clean** within the larger of $1.00 or 0.1%.
3. **Review**: amount outside tolerance, negative (correction) or zero amounts, and PAM unfunded today differing from AllVue's average unfunded by more than 10% (unfunded changed mid-period, so the split by fund may be off).
4. **Exceptions**: duplicate rows, fees on term loans, unmapped facilities, no PAM unfunded position.
5. Fees are split across PAM portfolios on their current **unfunded** position, to the cent.
6. **Approve all clean fees** in one click, review the rest individually, then create a fee file on **PAM files**.

The sample is a fictional October 2026 export with 13 rows: 7 clean, 3 for review, 3 exceptions.

Every event has a deterministic key (portfolio, asset, effective date, contract IDs), so re-running detection never creates duplicates and keeps decisions already made.

## AllVue contracts report

The AllVue prior and current slots take the **AllVue contracts report as-is** (one row per portfolio, facility and accrual). Headers are matched without brackets or case. The report has no as-of date, so the app reads it from the file name (e.g. `allvue-contracts-report-2026-10-29.csv`) or from the date field on the Setup tab. Sample files are in `docs/samples/`.

| Report column | App field | Conversion |
|---|---|---|
| `portfolioId` | AllVue portfolio | Keys the portfolio map |
| `primaryIdentifier` | Facility (asset) | Keys the tranche map; stored in PAM's alternative ID table |
| `referenceAccrualId` | Contract | Linked to PAM contracts through the lineage table |
| `accrualType` | Contract kind | Funded; Unfunded and Delayed Draw Unfunded → unfunded; Letter of Credit → counts toward the commitment only; % of Funded → ignored |
| `instrumentType` | Facility type | Term Loan TL, Revolver RC, Delayed Draw DDTL |
| `baseRateIndexName` | Base rate, tenor | `1M SOFR Term` → SOFR 1M; reset frequency comes from the tenor |
| `rateType`, `interestPaymentType` | Rate type, interest type | Float → Floating; Cash / Capitalize |
| `spread`, `spreadAdjustment` | Margin (bps) | Decimals × 10,000. The adjustment is added to the PAM spread when the Setup setting is on |
| `rateFloor`, `rateCeiling` | Floor, cap (%) | Decimals × 100 |
| `dayCount` | Day count | ACT/360, ACT/365 (Fixed), 30U/360. ACT/ACT has no PAM code yet |
| `numPaymentsPerYear` | Pay frequency | 12 monthly, 4 quarterly, 2 semi-annual, 1 annual; 52 has no PAM code yet |
| `beginDate`, `endDate` | Contract period | |
| `accrualAmount`, `globalAccrualAmount` | Position, global amount | Commitment = funded + unfunded + letters of credit per portfolio and facility |

## Input files

Load these on **Setup and data** as CSV. Header names must match.

| File | Columns |
|---|---|
| AllVue contracts (prior and current day) | `AsOfDate, AllVuePortfolio, AssetID, AssetName, FacilityType, ContractID, ContractType, StartDate, EndDate, Amount, GlobalAmount, Commitment, RateType, InterestType, BaseRate, Tenor, MarginBps, FloorPct, PayFreq, ResetFreq, DayCount` |
| Portfolio map | `AllVuePortfolio, PAMPortfolio, Bank, BankName, CustodyAccount, CashBank` (the four `BNK()` fields, in order) |
| Tranche map | `AssetID, PAMTrancheID, FacilityType, MaturityDate, PAMCurrency` |
| PAM holdings | `AsOfDate, PAMPortfolio, PAMTrancheID, Funded, Unfunded` |
| Contract lineage | `AllVueContractID, PAMContractID` |
| AllVue unfunded fee export | `AllVuePortfolio, AssetID, AssetName, FacilityType, FeeType, PeriodStart, PeriodEnd, FeeRateBps, AverageUnfunded, DayCount, Amount, AllVueTransactionID` |

`Amount` is your position; `GlobalAmount` is the whole facility's amount for that contract. `RateType` is `Fixed` or `Floating`. `InterestType` is `Cash`, `Capitalize` or `Partial`. `FacilityType` is `TL`, `RC` or `DDTL`. `ContractType` is `Funded` or `Unfunded` (one unfunded row per RC/DDTL tranche). Dates may be `YYYY-MM-DD` or `M/D/YYYY`.

## PAM import file

Contract events produce a PAM message file (`PAM_IMPORT_<batch>.txt`) in PAM's import syntax, one message per line (single-line, newline-terminated), in load order:

1. **Create contract**: one `SMFBANKLOANTRANCHE(UPDATE, …)` per event, adding every new contract on the tranche as an `SMFBANKLOANCONTRACTREC`, following the PAM bank loan contract add build spec (minimal message, validated before it goes in the file; the spec's golden string is a test). New contracts take the AllVue contract ID.
2. For each step (combine, split, then paydown, draw or capitalized interest):
   - one **`BANKLOANACTION`** global action, with signed global units per contract (sources negative, targets positive). Types: 8 contract split, 9 contract combine; 6 contract redemption, 4 drawdown and 10 interest capitalization are assumed for paydowns, draws and PIK and need confirming. The transaction generate job stays off.
   - portfolio transactions, with `BNK()` from the portfolio map. The transaction number is left blank; PAM assigns it on `ADD`.
     - **`TaCONTRACTSPLIT`** per PAM portfolio (the source contract in `CONTRACTSECID`, targets in `CONTRACTALLOC`) or **`TaCONTRACTCOMBINE`** (the target in `CONTRACTSECID`, sources in `CONTRACTALLOC`), each with a `CCID`.
     - **`TaContractRedemption`** for paydowns: one per contract per PAM portfolio, accrued interest 0 (per the TACONTRACTREDEMPTION minimum message spec).
     - **`TaDrawDown`** for draws: one per PAM portfolio, `BLUNFUNDED` taking down the draw amount, `CONTRACTALLOC` to the contracts drawn into, trade, settle and delayed delivery date all the effective date (per the TADRAWDOWN minimum message spec).
     - *Capitalized (PIK) interest has no format yet, so it appears as an "after loading" checklist.*
   - No fund may redeem more than its funded PAM holding or draw more than its unfunded. A file warns about redemptions and drawdowns dated after today, which PAM rejects.

| Event | Steps |
|---|---|
| Clean rollover | Nothing |
| Rollover with paydown, draw or PIK, same terms | Global action on the existing PAM contract (+ manual portfolio transactions) |
| Terms change (1:1) | Create → split old → new → any paydown/draw |
| Split (1 → many) | Create each → split → any paydown/draw spread by size |
| Combine (many → 1) | Create → combine → any paydown/draw |
| Many → many | Create each → combine into the first new contract → split out to the others → any paydown/draw |
| Draw into a new contract | Create → draw |

PAM closes emptied contracts itself. The `TRDR()` block on splits (method `M`, the tranche maturity date, price 100) and `SETMTHD(11)` are copied from PAM's sample and should be confirmed. Security ID types are 3 for the facility (the PAM tranche ID) and 26 for contracts; see `PAM` in `src/engine.js`.

Fee files use `BatchID, Seq, FeeKey, TransactionType, FeeType, PAMPortfolio, PAMTrancheID, PeriodStart, PeriodEnd, Amount, AllVueTransactionID` with transaction type `UNFUNDED_FEE`. Also a placeholder.

### Contract create mapping

| PAM field | From |
|---|---|
| Loan type | Facility type: TL 1, RC 2, DDTL 3 |
| Tranche and contract maturity | Tranche map `MaturityDate` |
| Currency | Tranche map `PAMCurrency` |
| Coupon type | `RateType`: Floating V, Fixed F (fixed coupon = `MarginBps` / 100) |
| Coupon form | `InterestType`: Cash C, Capitalize or Partial P |
| Coupon and reset frequency | Pay and reset frequency: M, Q, S, A |
| Day count | ACT/360 D, ACT/365 C, 30/360 A |
| Accrual and reset month and day | The contract's pay date (end date, allowing for business-day rolls) |
| Base index | SOFR + tenor: SR1M, SR3M |
| Spread, minimum rate | Margin (bps), floor (%) |
| Everything else | Spec defaults (`PAM_CONTRACT_DEFAULTS` in `src/engine.js`) |

Open items from the spec, to confirm in a PAM test region before production:
1. Whether `SMFBANKLOANCONTRACT(REPLACE, …)` with only the new contracts leaves existing contracts on the tranche intact, or replaces the whole list. **If it replaces the list, existing contracts would be removed**; the builder already supports several contract records per tranche so they can be re-sent.
2. Whether loan type can be blank on UPDATE.
3. Float method `A`, pay date convention `3` and reset date convention `3`.
4. Whether PAM enforces CCID concurrency on tranche UPDATE (CCID is supported but off).
5. What accrual month to send for monthly contracts (the spec defines it for Q, S and A only; monthly is sent blank).

## Files

- `src/engine.js`: detection, classification, allocation, CSV and PAM file rows. No DOM, so it can move to a server job unchanged.
- `src/sample-data.js`: fictional month-end scenario.
- `src/app.js`, `src/styles.css`, `index.html`: the review UI.
- `tests/engine.test.js`: engine tests.

## Next steps

See [TODO.md](TODO.md) for the full list of open work and questions.


- Replace the AllVue column mapping with the real AllVue export headers.
- Replace the PAM layout with the real import message formats, one writer per message type.
- Add a PAM position extract for next-day reconciliation.
- Split fees on average daily unfunded per PAM portfolio once a position history is available.
- Add four-eyes approval (preparer and approver must differ) if required.
- Move state from browser storage to a shared database when more than one person uses it.
