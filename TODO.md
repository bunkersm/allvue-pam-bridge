# To do

Open work and questions for Loan Event Bridge, roughly in priority order.

## Data from PAM and AllVue

- [ ] **PAM contract-level holdings extract.** Replace the tranche-level PAM positions file with holdings by contract:
      `AsOfDate, PAMPortfolio, PAMTrancheID, PAMContractID, ContractType, Units` (funded rows per contract, an unfunded row per tranche for RC/DDTL).
      Then: splits and combines move each fund's actual units; tie out PAM units to AllVue per contract; check every lineage contract exists in PAM with units;
      flag a fund moving more units than it holds; split fees on the unfunded rows.
      Extract must be as of the prior AllVue snapshot date, on the same settled/traded basis. *Need: which PAM report gives holdings by contract.*
- [ ] **Confirm PAM can produce holdings as of a past date** (e.g. as of Friday 10/16 when pulled on Tuesday 10/20, after the trade feed has posted Monday's trades).
- [ ] **Confirm PAM accepts messages effective the previous business day** (every file is back-dated by one business day, three after a weekend).
- [ ] **PAM code translations.** Confirm every AllVue → PAM code in `docs/pam-code-translations.csv`, then load that file in the app instead of the codes built into `src/engine.js`.
- [ ] **Real AllVue contract export headers** (with dummy rows) to replace the assumed column names.
- [ ] **AllVue fee export and PAM fee transaction file layouts** for the fee pilot.

## PAM message formats still needed

- [ ] Portfolio-level paydown, draw and interest capitalization messages (currently an "after loading" checklist).
- [ ] Confirm BANKLOANACTION types: 6 contract redemption (paydown), 4 drawdown (draw), 10 interest capitalization (PIK); whether Tranche Amount is needed.
- [ ] Confirm the `TRDR()` fields on splits (method M, maturity date, price 100), ex date vs payment date, and what the CCID should hold.

## Contract create (SMFBANKLOANTRANCHE) open items

- [ ] **Test `SMFBANKLOANCONTRACT(REPLACE, …)` in a PAM test region.** If it replaces the tranche's whole contract list, the app must re-send existing contracts (needs the contract-level holdings extract).
- [ ] Loan type on UPDATE; float method `A`; pay and reset date convention `3`; CCID concurrency on UPDATE.
- [ ] Accrual month for monthly contracts (spec covers Q, S, A only; monthly sent blank).
- [ ] Fixed-rate coupon source (currently `MarginBps` / 100) or a separate `CouponPct` column; Partial PIK handling.

## App features

- [ ] Bank account reference table by PAM portfolio (defaults plus per-facility overrides) instead of bank columns on the portfolio map.
- [ ] Ask for PAM contract IDs when an event is handled outside the app, so contract lineage stays complete.
- [ ] Payment date changes (e.g. 15th → 30th): detect and send PAM the new pay day.
- [x] Initial long / short first periods on new positions are flagged. *Still need: what the PAM fix is, so the app can generate it.*
- [ ] Link new purchases to the PAM contract the trade feed creates (needs the contract-level holdings extract on the next run).
- [ ] Base rate adjustments: fold the adjustment into PAM's spread each period; check floors.
- [x] Trades and new purchases are left to the trade feed (position change with no global change).
- [ ] Local settings file (`local-config.js`, never committed) for real portfolio and tranche maps on a work computer.
- [ ] Two-person approval, if required.
- [ ] Split fees on average daily unfunded once position history is available.

## Production

- [ ] Automated AllVue and PAM feeds, scheduler, shared database, single sign-on, monitoring.
