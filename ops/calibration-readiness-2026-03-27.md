# Calibration Readiness — 2026-03-27

## Stato attuale
L'infrastruttura di calibrazione è pronta, ma il dataset non è ancora maturo per insight utili.

## Conferme di oggi
- `calibration.db` scelto come source of truth
- `score_bucket` aggiunto e retrofittato
- report automatici 30d e 7d generabili
- feature usefulness report generabile
- cron di snapshot e cron di calibration attivi

## Dati disponibili
- token_snapshots: 2290
- token_scores: 2290
- token_outcomes: 0
- 7d outcomes con `relative_return_pct`: 0
- 30d outcomes con `relative_return_pct`: 0

## Interpretazione
Il sistema non è bloccato da codice o automazione.
È bloccato solo dalla mancanza di tempo trascorso sui nuovi snapshot.

## Cosa NON serve fare ora
- non serve altro refactor della pipeline
- non serve cambiare i pesi live
- non serve aggiungere nuovi report analitici

## Cosa serve davvero
1. lasciare accumulare snapshot giornalieri
2. verificare tra 7 giorni i primi outcomes relativi vs BTC
3. usare quel primo batch per una proposta v2 di reweighting

## Trigger operativo
Quando `token_outcomes` con `days_forward=7` e `relative_return_pct IS NOT NULL` supera **100 sample**, ha senso fare una prima review seria dei pesi.
