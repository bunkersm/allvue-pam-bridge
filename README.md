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
   | lower funded total | Paydown leg (booked first) | Review |
   | irregular period (stub/broken) | Flag | Review |

   **Exceptions** block approval: unmapped asset or portfolio, PAM positions not tying to AllVue before the event, funded + unfunded ≠ commitment, term loan draws, draws larger than unfunded, missing contract lineage.
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

## Input files

Load these on **Setup and data** as CSV. Header names must match.

| File | Columns |
|---|---|
| AllVue contracts (prior and current day) | `AsOfDate, AllVuePortfolio, AssetID, AssetName, FacilityType, ContractID, ContractType, StartDate, EndDate, Amount, Commitment, BaseRate, Tenor, MarginBps, FloorPct, PayFreq, ResetFreq, DayCount` |
| Portfolio map | `AllVuePortfolio, PAMPortfolio` |
| Tranche map | `AssetID, PAMTrancheID, FacilityType` |
| PAM positions | `PAMPortfolio, PAMTrancheID, Funded, Unfunded` |
| Contract lineage | `AllVueContractID, PAMContractID` |
| AllVue unfunded fee export | `AllVuePortfolio, AssetID, AssetName, FacilityType, FeeType, PeriodStart, PeriodEnd, FeeRateBps, AverageUnfunded, DayCount, Amount, AllVueTransactionID` |

`FacilityType` is `TL`, `RC` or `DDTL`. `ContractType` is `Funded` or `Unfunded` (one unfunded row per RC/DDTL tranche). Dates may be `YYYY-MM-DD` or `M/D/YYYY`.

## PAM import file

The output layout in `src/engine.js` (`LAYOUTS.pamImport`) is a **placeholder**:

`BatchID, Seq, EventKey, MessageType, PAMPortfolio, PAMTrancheID, PAMContractID, TargetContractRef, EffectiveDate, Amount, BaseRate, Tenor, MarginBps, FloorPct, PayFreq, ResetFreq, DayCount`

Fee files use `BatchID, Seq, FeeKey, TransactionType, FeeType, PAMPortfolio, PAMTrancheID, PeriodStart, PeriodEnd, Amount, AllVueTransactionID` with transaction type `UNFUNDED_FEE`. Also a placeholder.

Message types: `CONTRACT_CHANGE`, `CONTRACT_SPLIT`, `CONTRACT_COMBINE`, `CONTRACT_CLOSE`, `CONTRACT_OPEN`, `PAYDOWN`, `DRAW`. New PAM contracts are referenced as `AV-<contract id>` until PAM assigns an ID.

## Files

- `src/engine.js`: detection, classification, allocation, CSV and PAM file rows. No DOM, so it can move to a server job unchanged.
- `src/sample-data.js`: fictional month-end scenario.
- `src/app.js`, `src/styles.css`, `index.html`: the review UI.
- `tests/engine.test.js`: engine tests.

## Next steps

- Replace the AllVue column mapping with the real AllVue export headers.
- Replace the PAM layout with the real import message formats, one writer per message type.
- Add a PAM position extract for next-day reconciliation.
- Split fees on average daily unfunded per PAM portfolio once a position history is available.
- Add four-eyes approval (preparer and approver must differ) if required.
- Move state from browser storage to a shared database when more than one person uses it.
