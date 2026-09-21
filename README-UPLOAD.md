# Atlas country save correction — September 21, 2026

This app-only correction fixes `value too long for type character(2)` when saving a project whose linked customer address contains a full country name. Changing the project's Country field alone does not update that separate directory value.

## Install

1. Extract ATLAS-COUNTRY-SAVE-FIX-2026-09-21.zip.
2. Upload all five files inside GITHUB-UPLOAD to the root of the existing repository: https://github.com/codyh918/cronos-procurement-portal/upload/main. Replace those filenames and commit them together. Upload the files, not the folder or ZIP.
3. Wait for Railway to show the deployment as Active. Preserve any unsaved form text, then reload Atlas with Ctrl+Shift+R.
4. Reopen the project and save the intended changes. Existing addresses containing United States, USA, U.S.A., or United States of America are converted to US when they are saved. Other recognized English country names and country abbreviations are converted as well.

No additional SQL is required. Keep the previously installed database migration.

## What changes

The directory API now converts country values immediately before writing country_code. This covers existing linked addresses, new addresses, and directory synchronization. It stores the original input in the existing legacy_payload field and leaves the frozen source collection unchanged. Values that are not recognized produce a specific Country error identifying the address; they are never silently truncated. A missing country retains the existing US default.

The package retains the earlier project, duplicate-ID, team-member and confirmed-save fixes. It introduces no new database schema, dependency, or sign-in change. The guarded build installer still refuses to overwrite an unrecognized edit to a required source file.

This update has been prepared locally and has not been deployed by Codex. See VALIDATION.md for verification results.
