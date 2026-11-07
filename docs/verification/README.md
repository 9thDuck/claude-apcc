# Verification passes

Three independent passes by a headless model worker (not the author), each told to try to break the previous fixes, with every probe logged. Verdicts are kept as written, uncorrected. Each pass found real bugs, which were fixed and are listed in `CHANGELOG.md`. The author reran tests and checks after each fix; these documents are observations, not a certificate. Pass 3 found that some legitimate persist writes were wrongly denied in the hard zone and that many crafted attacks were not denied, against the code at that time; the fixes since then are covered by `hooks/apcc.test.mjs` and `scripts/verify.mjs`, not by a fourth independent pass.

Commit hashes in these documents refer to the pre-publication history, which is not in this repository.

The raw probe logs (`log.md`, `results*.json`) the passes refer to are not included in this repository; the pass documents are the summaries.
