# Backend status — 1 November 2026

## Implemented

- Replaced email/password sessions with a dedicated persistent credential for personal local use on this Mac.
- Provisioned a private workspace in ECHO27 through the connected Supabase administration tools; no Supabase account password or service-role key was required.
- Added private connection/entry tables, forced RLS policies, credential verification, and a limited read/create/update RPC.
- Saves title, text, date, language, mood, compressed photos, and captions. Title-only pages and clearing existing text are supported.
- Removed Save draft, login UI, and completion-based editing locks. Completion stays in device storage and is excluded from all cloud payloads/schema.
- Added pending/offline/conflict status, startup/reconnect retry, and idempotent write recovery.
- Preserves typing during delayed reads and changes made while a save is in progress.
- Existing public account-based tables/workflows remain unchanged. The local app uses `journal_private.entries`.

## Verification

- Live `/api/session` verified the configured workspace through Supabase without browser cookies or a login.
- Live `/api/entries` returned the workspace's entries.
- Rolled-back database transaction verified the restricted anon-to-RPC path, invalid-credential rejection, title-only insert, photo/caption/mood storage, idempotent retry, update/version increment, stale-write rejection, and absence of completion data. No test rows were retained.
- Automated backend tests verify local access guards, content validation/forwarding, no secrets in browser responses, error mappings, clearing text, and completion/ownership exclusion.
- Automated frontend tests verify edits during reads/writes, lost-response recovery, conflicts, all content fields, and completion exclusion.
- Security advisors report no new findings for this change. The pre-existing `public.rls_auto_enable()` execute-grant warnings remain outside this change.
- Interactive browser QA was unavailable: the browser access host was unavailable and native Chrome control timed out. Backend and frontend behavior were verified through live connection checks, transactional SQL, and automated tests instead.

## Existing advisor references

- https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
- https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable

## Scope

This is a loopback-only personal app, not a public deployment. Keep the private `.local/connection.json` on this Mac. Device changes can remain pending until connectivity returns; the UI must say Saved to Supabase before assuming a cloud copy exists. No AI rewriting, payment, or hosted deployment work was performed.

## Soniox voice integration

- Added `POST /api/voice/session`, guarded by the same localhost/Host/Origin checks as journal writes.
- Server-only `SONIOX_API_KEY` issues short-lived, single-use temporary keys restricted to real-time speech-to-text with a 30-minute session cap.
- Uses `stt-rt-v5` and current WebSocket subprotocol authentication. Locale hints map English/Tamil/Telugu/Malayalam/Hindi to `en`/`ta`/`te`/`ml`/`hi`.
- Final speech tokens append to the originating page and autosave; provisional text is displayed separately. Microphone/socket cleanup covers cancellation, denial, failure, navigation, and stream completion.
- The user's Soniox key is configured. A live temporary-key request succeeded, and the authenticated WebSocket accepted the connection. A generated English test phrase could not be transcribed because Soniox returned `402 organization_balance_exhausted`. Adding Soniox organization credits is required before the live transcription check can pass. Browser microphone verification remains pending.

- Soniox verification: all 55 project tests passed, including temporary-key endpoint tests and recording/transcript regressions. The restarted dashboard serves `voice.js` and loads the configured server key. Live transcription is blocked only by the provider's exhausted organization balance; no successful transcript is claimed.
