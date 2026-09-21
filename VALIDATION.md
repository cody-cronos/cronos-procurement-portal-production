# Verified country save correction — September 21, 2026

## Reproduced failure

Before changing the code, a regression using local PostgreSQL reproduced the exact error `value too long for type character(2)`: a usage-count update to a linked legacy address transmitted its stored country value `United States`. Editing the project Country field alone did not change that separate address. The original failure is recorded in tmp/country-save-before.log.

## Verification of the packaged source

The package was installed into a separate validation checkout using the same guarded atlas-prepare-release.mjs installer used by Railway.

- 159 server tests passed, zero failures. Country tests verify 15 inputs including United States, USA, U.S.A., United States of America, lowercase codes, Canada/CAN, United Kingdom/UK/GBR, Germany, France, United Arab Emirates, South Korea and the existing blank-country default.
- Tests verify that the typed database column receives US while legacy_payload keeps the original full country value, and the frozen app_records source collection is unchanged.
- Unknown country input produces a specific field error before any partial batch is written. Existing revision checks still reject stale edits.
- 9 browser checks passed using the actual Vue project forms and a local PostgreSQL fixture. These include saving an existing project that already says US while its linked address says United States; saving a new project entered with United States of America; retaining failed drafts and selected users; and reopening confirmed changes in another tab.
- The production Vite build passed. Its existing large-bundle warning remains non-blocking.
- The ZIP contents and all non-document payload file checksums were checked against the exact tested checkout.

No production data, migrations, configuration or deployments were changed during validation. The live user's specific stored address was not read; the reported failure and ineffective workaround were reproduced with synthetic records.

## Data source and implementation

Recognized region codes and alpha-3 aliases come from Unicode CLDR snapshots:

- https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/codeMappings.json (blob 315e1a66daa8469e8c5ac567b2120dd4462e36df)
- https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/territoryInfo.json (blob f4d1177ca41700e17fecce40ae368ea1ccf59547)

English display names use the Node runtime's Intl.DisplayNames with explicit aliases for common alternative names. There is no new runtime dependency. Unknown inputs are rejected rather than truncated.

The correction changes only the server country conversion and directory mapping, with corresponding regression tests. It retains the earlier app payload. No additional SQL is required.

Validation logs: tmp/country-save-release-validation/server-tests.log, country-browser.log, build.log, and tmp/country-save-browser-results.json within that checkout.
