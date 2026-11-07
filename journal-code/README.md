# ECHO27 Journal — personal local app

Run `npm run dev` and open **http://localhost:3000**. Node.js 22 or newer is required. No npm dependencies need installing.

This checkout is configured for the original Mac. After cloning, copy `.env.example` to `.env` and configure the private workspace connection described below before starting the server. `.env` and `.local/connection.json` are intentionally excluded from Git; transfer the connection file privately or provision a new workspace through an authorized Supabase administration session.

## Automatic Supabase saving

This Mac is connected to the existing **ECHO27** Supabase project in Mumbai using a dedicated Journal workspace. The browser never asks for a Supabase email or password. The local Node backend authenticates each request with a private workspace credential.

- Title, text, date, language, mood, photos, and captions save automatically. Text edits are saved locally after a short pause, then sent to Supabase automatically.
- Existing device entries are picked up and uploaded automatically when the page opens. Conflicting same-date entries are preserved locally rather than silently overwritten.
- **Save draft** has been removed. **Complete journal** only marks a page complete in this browser. It is not sent to Supabase, does not lock editing, and does not change database behavior.
- A local copy remains in IndexedDB. Offline or failed cloud writes retry automatically while the app is open, and after reopening it.
- The visible save status distinguishes **Saved to Supabase**, pending changes, offline storage, and conflicts. Keep the tab open until it reports Saved to Supabase if you need immediate cloud confirmation.
- A lost save response can be retried without creating a duplicate. Updates check both the version and timestamp to preserve competing edits.
- One page per date is stored in this dedicated workspace. Text supports up to 20,000 characters, titles 160 characters, and up to three JPEG/PNG/WebP photos of 2 MiB each with 160-character captions.

Photos are resized/compressed in the browser and stored with captions in the private entry's JSON field. This is suitable for this personal app; large photo libraries should use private object storage instead.

## Soniox voice typing

Add your Soniox API key to the local `.env` file, then restart `npm run dev`:

```dotenv
SONIOX_API_KEY=your_soniox_api_key
```

Get the key from https://console.soniox.com. Enable temporary-key creation and real-time speech-to-text permissions, and ensure the account has sufficient credits. Keep the key out of frontend files and source control.

Select **English**, **தமிழ் (Tamil)**, **తెలుగు (Telugu)**, **മലയാളം (Malayalam)**, or **हिन्दी (Hindi)** in the language selector, then click **Speak your thoughts** and allow microphone access. Click **Stop listening** when finished. Confirmed words append to the current page in the spoken language and use the same autosave path as typed text. A separate preview shows provisional words while Soniox refines them. Date/history navigation waits for the final transcript; switching away from the tab stops microphone capture.

The backend issues a single-use temporary key valid for starting one stream within 60 seconds. Each session is limited to 30 minutes. Audio streams from the browser directly to Soniox over TLS; the permanent API key stays on the local backend. Journal does not save audio recordings. Real-time Soniox usage is billed to your Soniox account.

Use a current Chrome or Firefox browser with WebM/Opus or Ogg/Opus recording support. Voice typing requires internet access; ordinary typing and device autosave continue offline. Missing keys, denied microphone permissions, insufficient credits, dropped connections, and provider limits show a voice-specific message without removing confirmed text.

Official API references:
- https://docs.soniox.com/guides/temporary-api-keys
- https://docs.soniox.com/guides/websocket-authentication
- https://docs.soniox.com/stt/concepts/supported-languages

## Private connection

`.env` contains the project URL and publishable key. The ignored `.local/connection.json` contains this Mac's workspace ID and 256-bit secret. It has owner-only permissions. The database stores only a SHA-256 hash of that secret. No account password, Supabase admin key, or database password is used by the app.

Keep `.local/connection.json` private and preserve it across server restarts. Do not share it with the project files or commit it. If it is lost or revoked, reconnect the local app through an authorized Supabase administration session; the UI will keep local edits pending rather than request a login. The app's runtime connection is independent of whether this GPT conversation stays open.

This is deliberately **personal use on this Mac only**. The server binds to `127.0.0.1`, rejects other hosts/cross-origin requests, and grants anyone using the local Journal app on this Mac access to this workspace. Do not expose or deploy this server publicly without adding an appropriate user access model.

## Database

`backend/sql/local_journal.sql` records the new database setup. Dedicated `journal_private.connections` and `journal_private.entries` tables have RLS enabled and forced. Browser roles have no direct table access. A public invoker RPC calls a private credential-checking function owned by a restricted, non-login role that cannot bypass RLS. The credential grants only this Journal workspace's read/create/update operations; it cannot delete entries or access unrelated project data.

The pre-existing account-based `public.journal_entries`, daily-story workflow, and other project tables remain intact. The active local app now uses `journal_private.entries`; no Journal Auth accounts or old cloud entries existed when this workspace was configured. Completion has no column in the new tables.

## Checks and API

Run `npm test` for backend request checks and frontend autosave regression tests. A local listener must be permitted by the execution environment.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Local backend configuration status |
| POST | `/api/voice/session` | Issue a restricted Soniox voice session for the selected language |
| GET | `/api/session` | Verify the dedicated Supabase workspace connection |
| GET | `/api/entries?after=<uuid>` | Read cloud entries in pages |
| POST | `/api/entries` | Idempotently create a page |
| PATCH | `/api/entries/<uuid>` | Save changes with version protection |

No email/password, sign-in, sign-out, or delete endpoint is enabled. Mutations require same-origin JSON requests. Credentials and journal contents must not be logged.

## Other features

Display preferences, name, and completion are local to the browser. Exports, Soniox dictation, sample music, and backups remain available. AI rewriting, payments, privacy lock, Flare access, and deletion remain unconnected placeholders.
