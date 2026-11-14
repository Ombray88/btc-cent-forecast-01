# BTC Cent Forecast

Final submission for make.fun Bitcoin 4-hour-ahead forecaster.

## Final Entry & Validation
- **Forecaster:** Pure persistence (`BETA = 0`, forecast equals checkpoint close).
- **Validation Rationale:** The multi-window dip-bounce gate was thoroughly validated across 3 race walk-forward folds and 6 practice cases. Because the dip-bounce signal never activated on any fold or case (0 active folds), the frozen gate fell back to pure persistence, tying persistence exactly.
- **Measured Results:**
  - **Race Walk-Forward (3 folds):** Persistence MAE 59,553.07 cents.
  - **Practice (5 scorable cases):** MAE 47,054.66 cents, worst dollar error $766.97.
- **Reproducibility:** Run `validate.mjs` in this repository to reproduce the validation sweep.
