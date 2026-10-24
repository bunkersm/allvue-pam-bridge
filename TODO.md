# To do

Open work and questions for Loan Event Bridge, roughly in priority order.

## Data from IAS and the Loan System

- [ ] **IAS contract-level holdings extract.** Replace the tranche-level IAS positions file with holdings by contract:
      `AsOfDate, IASPortfolio, IASTrancheID, IASContractID, ContractType, Units` (funded rows per contract, an unfunded row per tranche for RC/DDTL).
      Then: splits and combines move each fund's actual units; tie out IAS units to the Loan System per contract; check every lineage contract exists in IAS with units;
      flag a fund moving more units than it holds; split fees on the unfunded rows.
      Extract must be as of the prior Loan System snapshot date, on the same settled/traded basis. *Need: which IAS report gives holdings by contract.*
- [ ] **Confirm IAS can produce holdings as of a past date** (e.g. as of Friday 10/16 when pulled on Tuesday 10/20, after the trade feed has posted Monday's trades).
- [ ] **Confirm IAS accepts messages effective the previous business day** (every file is back-dated by one business day, three after a weekend).
- [ ] **IAS code translations.** Confirm every Loan System → IAS code in `docs/ias-code-translations.csv`, then load that file in the app instead of the codes built into `src/engine.js`.
- [x] Loan System contracts report loads as-is (see README).
- [ ] **Loan System report questions:** what "% of Funded" accrual rows are (ignored today); whether letters of credit need anything in IAS; IAS codes for weekly pay (52), ACT/ACT day counts and Prime; whether a 1M SOFR contract that pays quarterly has monthly or quarterly accrual periods in the Loan System (affects the pay day and accrual month sent to IAS).
- [ ] **Spread adjustment:** decide whether IAS's spread is always `spread + spreadAdjustment` (a Setup setting, on by default).
- [ ] **IAS contract ID length:** Loan System accrual IDs are 24-character hex strings. Confirm IAS accepts them as contract security IDs, or decide how IAS numbers new contracts.
- [ ] **Loan System fee export and IAS fee transaction file layouts** for the fee pilot.

## IAS message formats still needed

- [x] Paydown (`TaContractRedemption`) and draw (`TaDrawDown`) portfolio messages, from the minimum message specs.
- [ ] Portfolio-level interest capitalization (PIK) message (currently an "after loading" checklist).
- [ ] **Validate `TaContractRedemption` against an IAS-generated message** (the spec isn't validated yet): CONTRACTSECID syntax, whether Units is needed alongside Principal, accrued interest with the paydown, back-dated redemption dates in a closed period.
- [ ] `TaDrawDown` open items: the blank broker slot (IAS's own export omits it), whether CONTRACTALLOC can be left out, `BLUNFUNDEDTKDN(F)` meaning, and whether settlement date should differ from trade date.
- [ ] Contract ID types: the drawdown example has a contract under ID type 10007 as well as 26. The app sends 26 for every contract.
- [ ] Confirm the `BNK()` fields are bank, bank name, custody account, cash bank (the drawdown spec's order) for splits and combines too.
- [ ] Confirm BANKLOANACTION types: 6 contract redemption (paydown), 4 drawdown (draw), 10 interest capitalization (PIK); whether Tranche Amount is needed.
- [ ] Confirm the `TRDR()` fields on splits (method M, maturity date, price 100), ex date vs payment date, and what the CCID should hold.

## Contract create (SMFBANKLOANTRANCHE) open items

- [ ] **Test `SMFBANKLOANCONTRACT(REPLACE, …)` in an IAS test region.** If it replaces the tranche's whole contract list, the app must re-send existing contracts (needs the contract-level holdings extract).
- [ ] Loan type on UPDATE; float method `A`; pay and reset date convention `3`; CCID concurrency on UPDATE.
- [ ] Accrual month for monthly contracts (spec covers Q, S, A only; monthly sent blank).
- [ ] Fixed-rate coupon source (currently `MarginBps` / 100) or a separate `CouponPct` column; Partial PIK handling.

## App features

- [ ] Bank account reference table by IAS portfolio (defaults plus per-facility overrides) instead of bank columns on the portfolio map.
- [x] Ask for IAS contract IDs when an event is handled outside the app, so contract lineage stays complete (Contract links box; also for new purchases).
- [x] End-of-day lineage file to carry links to another computer or browser.
- [ ] Store the lineage somewhere shared (file share or database) instead of each browser, or rebuild it each morning from the IAS contract-level holdings extract.
- [ ] Payment date changes (e.g. 15th → 30th): detect and send IAS the new pay day.
- [x] Initial long / short first periods on new positions are flagged. *Still need: what the IAS fix is, so the app can generate it.*
- [ ] Link new purchases to the IAS contract the trade feed creates (needs the contract-level holdings extract on the next run).
- [ ] Base rate adjustments: fold the adjustment into IAS's spread each period; check floors.
- [x] Trades and new purchases are left to the trade feed (position change with no global change).
- [ ] Local settings file (`local-config.js`, never committed) for real portfolio and tranche maps on a work computer.
- [ ] Two-person approval, if required.
- [ ] Split fees on average daily unfunded once position history is available.

## Production

- [ ] Automated Loan System and IAS feeds, scheduler, shared database, single sign-on, monitoring.
