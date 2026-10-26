# ORCA Rehab: Fireflies → Google Chat recaps

A small Cloud Run service that posts a concise recap of approved Fireflies meetings into one Google Chat space. The recap is posted **as your Google user**, and Google shows the Chat app's name beside your name.

```
Fireflies ──meeting.summarized──▶ POST /webhooks/fireflies
                                   │ verify X-Hub-Signature (raw bytes)
                                   │ validate payload, accept only meeting.summarized
                                   │ Firestore: register meeting (transaction)
                                   │ Cloud Tasks: create named task (deduplicated)
                                   ▼ 202 only after durable enqueue
Cloud Tasks ──OIDC token────────▶ POST /tasks/process-meeting  (token verified in-app)
                                   │ Firestore lease (one worker per meeting)
                                   │ Fireflies GraphQL: transcript(id) summary + metadata
                                   │ eligibility rules (default: post nothing)
                                   │ format recap (escaped, ≤ 30,000 bytes)
                                   │ persist deterministic requestId/messageId, then
                                   ▼ Chat API spaces.messages.create (user auth)
```

No AI provider is used. The recap reuses Fireflies' own summary.

---

## Behavior verified against current docs

| Topic | What the service relies on | Source |
|---|---|---|
| Webhook event | Webhooks V2 `meeting.summarized`, body `{event, timestamp, meeting_id, reprocessed_at?}` | [Fireflies Webhooks V2](https://docs.fireflies.ai/graphql-api/webhooks-v2) |
| Signature | `X-Hub-Signature: sha256=<hex HMAC-SHA256(raw body, signing secret)>` | same |
| Delivery and retries | 2xx within 30 s. Retries 429/5xx/connection errors 5× (30 s → 2 h). Other 4xx are not retried. | same |
| Summary updates | Resends carry `reprocessed_at`. v1 treats them as already processed. | same |
| Meeting data | `transcript(id)`: `title`, `date` (epoch ms), `organizer_email`, `transcript_url`, `calendar_id`, `meeting_info.summary_status`, `summary.{short_summary, overview, action_items, extended_sections}` | [Transcript](https://docs.fireflies.ai/schema/transcript), [Summary](https://docs.fireflies.ai/schema/summary), [MeetingInfo](https://docs.fireflies.ai/schema/meeting-info) |
| API errors | `too_many_requests` (429, `Retry-After`), `object_not_found`, `forbidden`, … | [Error codes](https://docs.fireflies.ai/miscellaneous/error-codes) |
| Posting | `POST /v1/{space}/messages` with user scope `chat.messages.create`. User-auth messages are text-only. | [spaces.messages.create](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create) |
| Idempotency | `requestId`: "a repeated request with the same ID returns the existing message". `messageId` is `client-…` (≤ 63 chars, `[a-z0-9-]`) and unique per space. | same |
| Size limit | 32,000 bytes per message. The service targets 30,000. | [Create messages](https://developers.google.com/workspace/chat/create-messages) |
| Markup | `markupSyntax: MARKUP_SYNTAX_CHAT` is set explicitly. | [Message resource](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages) |
| OAuth | `access_type=offline` and `prompt=consent` for a refresh token. Granted scopes are checked. `invalid_grant` means re-auth is needed. | [OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server) |

**Undocumented areas and how the service handles them:**
- **Fireflies has no "decisions" field.** Decisions appear only if your Fireflies summary has a custom section (`extended_sections`) titled like "Key decisions". Otherwise the section is omitted.
- **`action_items` is documented only as a String.** Owners are taken only from explicit `**Name**` headings or `Owner:` labels. Deadlines are taken only from explicit `Due:`/`Deadline:` labels. Nothing is inferred.
- **Google does not document what happens when an existing `messageId` is reused.** The service relies on the documented `requestId` behavior. If Chat returns `409 ALREADY_EXISTS`, the service treats it as "already posted".
- **Google does not document an escape character for Chat markup.** Meeting-derived text has markup characters (`< > * _ ~ \``) replaced with look-alike characters. This means it cannot create mentions (`<users/all>`), links, or formatting.

---

## Repository layout

```
src/
  server.ts, app.ts, container.ts, config.ts, logger.ts, ids.ts
  routes/      webhook.ts · tasks.ts · oauth.ts
  fireflies/   signature.ts · webhookPayload.ts · client.ts
  google/      oauth.ts · credentials.ts · tokenStore.ts · chatClient.ts · oidc.ts
  store/       Firestore + in-memory state (leases, OAuth state)
  queue/       Cloud Tasks + inline (local) queue
  processing/  processor.ts (lease → fetch → rules → format → idempotent send) · errors.ts
  recap/       eligibility.ts · format.ts · escape.ts · actionItems.ts
  cli/         preview.ts (print a recap, never sends) · replay.ts (operator re-run)
test/          unit + integration tests (synthetic fixtures, mocked APIs)
deploy/        env.example.yaml
```

Endpoints:

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Cloud Run reserves `/healthz`, so `/health` is used. |
| `POST /webhooks/fireflies` | HMAC signature | Fireflies webhook |
| `POST /tasks/process-meeting` | Cloud Tasks OIDC token (verified in-app) | Worker |
| `GET/POST /oauth/start` | admin token in POST body | Connect the posting account |
| `GET /oauth/callback` | state + browser-bound nonce | OAuth redirect target |

---

## Local development

Requires Node.js ≥ 22.

```bash
npm install
cp .env.example .env        # APP_MODE=local, DRY_RUN=true by default
npm run check               # typecheck + tests + build
npm run dev                 # http://localhost:8080
```

Local mode uses an in-memory store, an in-process queue, and an in-memory token store. None of these are durable, and production config refuses them. With `DRY_RUN=true`, the formatted recap is printed to stdout instead of being sent.

**Preview a recap without sending anything:**

```bash
npm run preview -- --fixture test/fixtures/transcript-full.json
FIREFLIES_API_KEY=... MEETING_RULES='[...]' npm run preview -- --meeting <meetingId>
```

The preview prints the eligibility decision, the byte size, and the exact message text.

**Send a signed test webhook to a local server:**

```bash
SECRET=replace-with-a-long-random-local-secret   # = FIREFLIES_WEBHOOK_SECRET in .env
BODY='{"event":"meeting.summarized","timestamp":1710876789456,"meeting_id":"<meetingId>"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"
curl -i -X POST localhost:8080/webhooks/fireflies -H 'content-type: application/json' -H "x-hub-signature: $SIG" -d "$BODY"
```

This needs a real `FIREFLIES_API_KEY` and a matching `MEETING_RULES` entry. To test fully offline, point `FIREFLIES_API_URL` at a mock GraphQL server.

---

## Meeting eligibility

`MEETING_RULES` is a JSON array, and the default `[]` posts nothing. A meeting is eligible when **any** rule matches. A rule matches when **all** of its criteria match. Every rule needs at least one positive criterion. Metadata always comes from the Fireflies API response, never from the webhook body.

| Criterion | Match |
|---|---|
| `organizerEmails` | exact, case-insensitive |
| `organizerDomains` | organizer email domain (`orcarehab.com`) |
| `titleContains` | substring, case-insensitive |
| `calendarIds` | Fireflies `calendar_id` (recurring-series id) |
| `titleExcludes` | exclusion, only together with a positive criterion |

```json
[
  { "name": "weekly-ops", "organizerEmails": ["you@orcarehab.com"], "titleContains": ["Ops Sync"] },
  { "name": "leadership", "calendarIds": ["abc123series"], "titleExcludes": ["1:1", "patient"] }
]
```

> **PHI caution.** Recaps copy Fireflies summary content into Chat. Approve only internal or operational meetings, not clinical or patient meetings. Confirm that your Fireflies and Google Workspace agreements cover any regulated data before widening the rules.

---

## Google Cloud setup

Set the variables once:

```bash
PROJECT_ID=your-project-id
REGION=us-west1
SERVICE=fireflies-chat-recaps
QUEUE=fireflies-recaps
gcloud config set project $PROJECT_ID
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SERVICE_URL=https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app   # deterministic Cloud Run URL
RUNTIME_SA=ff-recaps-runtime@$PROJECT_ID.iam.gserviceaccount.com
TASKS_SA=ff-recaps-tasks@$PROJECT_ID.iam.gserviceaccount.com
```

### 1. APIs, Firestore, queue

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudtasks.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  chat.googleapis.com iamcredentials.googleapis.com

gcloud firestore databases create --location=$REGION     # Native mode; skip if one exists

# Single-use OAuth state documents expire automatically (optional but recommended).
gcloud firestore fields ttls update expireAt --collection-group=ff_recaps_oauth_states --enable-ttl

# --max-attempts must equal TASKS_MAX_ATTEMPTS (20). This gives roughly one day
# of retries, enough time to re-authorize Google if needed.
gcloud tasks queues create $QUEUE --location=$REGION \
  --max-attempts=20 --min-backoff=30s --max-backoff=3600s --max-doublings=5 \
  --max-concurrent-dispatches=5 --max-dispatches-per-second=1
```

### 2. Service accounts and IAM

```bash
gcloud iam service-accounts create ff-recaps-runtime --display-name="Fireflies recaps (Cloud Run)"
gcloud iam service-accounts create ff-recaps-tasks   --display-name="Fireflies recaps (Cloud Tasks OIDC)"

# Firestore read/write
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$RUNTIME_SA --role=roles/datastore.user
# Enqueue tasks on this queue only
gcloud tasks queues add-iam-policy-binding $QUEUE --location=$REGION --member=serviceAccount:$RUNTIME_SA --role=roles/cloudtasks.enqueuer
# Creating a task with an OIDC token requires iam.serviceAccounts.actAs on the token's service account
gcloud iam service-accounts add-iam-policy-binding $TASKS_SA --member=serviceAccount:$RUNTIME_SA --role=roles/iam.serviceAccountUser
# Cloud Tasks service agent mints tokens as TASKS_SA
gcloud iam service-accounts add-iam-policy-binding $TASKS_SA \
  --member=serviceAccount:service-$PROJECT_NUMBER@gcp-sa-cloudtasks.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
```

### 3. Secret Manager

Create the static secrets. Values are read from stdin and never written to disk or shell history:

```bash
read -rs FF_KEY && printf '%s' "$FF_KEY" | gcloud secrets create fireflies-api-key --data-file=- && unset FF_KEY
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create fireflies-webhook-secret --data-file=-
read -rs OAUTH_SECRET && printf '%s' "$OAUTH_SECRET" | gcloud secrets create google-oauth-client-secret --data-file=- && unset OAUTH_SECRET
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create oauth-admin-token --data-file=-

# Empty secret; the service adds a version on each successful authorization
gcloud secrets create google-chat-refresh-token --replication-policy=automatic

for s in fireflies-api-key fireflies-webhook-secret google-oauth-client-secret oauth-admin-token google-chat-refresh-token; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
# Add a new refresh-token version and disable older versions
gcloud secrets add-iam-policy-binding google-chat-refresh-token --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretVersionManager
```

You will need two of these values later. Print them only when needed:

```bash
gcloud secrets versions access latest --secret=fireflies-webhook-secret   # paste into Fireflies
gcloud secrets versions access latest --secret=oauth-admin-token          # type into /oauth/start
```

---

## Google OAuth and Chat app setup

Do these steps in the same Google Cloud project, signed in with a Workspace account.

1. **OAuth consent screen** (Google Auth Platform → Branding / Audience):
   - Set **User type: Internal**. Internal apps avoid the 7-day refresh-token expiry that applies to *External* apps in *Testing* status.
   - Under **Data access**, add `openid`, `.../auth/userinfo.email`, and `https://www.googleapis.com/auth/chat.messages.create`.
2. **Configure the Chat app** (APIs & Services → Google Chat API → *Configuration*):
   - Set an app name (e.g. "ORCA Fireflies Recaps"), an avatar URL, and a description.
   - Google requires this configuration for Chat API calls. The app name is what appears next to your name on each recap.
   - Interactive features can stay disabled.
3. **OAuth client** (Google Auth Platform → Clients → Create → *Web application*):
   - Authorized redirect URI: `https://<SERVICE_URL>/oauth/callback`
   - For local OAuth testing, also add `http://localhost:8080/oauth/callback`.
   - Put the client ID in `GOOGLE_OAUTH_CLIENT_ID` and the secret in the `google-oauth-client-secret` secret.

**Workspace administrator configuration (may be required):**
- **Admin console → Security → Access and data control → API controls → App access control:** if third-party apps are restricted, mark this OAuth client as *Trusted* or allow the Chat scope. Otherwise token refresh fails with `admin_policy_enforced`, which the service reports as a re-authorization error.
- **Google Chat must be enabled** for the posting user's organizational unit.
- **Session-control policies** that limit Google Cloud session length can invalidate refresh tokens. If recaps start needing frequent re-authorization, check these policies.

---

## Choosing the Chat space

1. Open the space in Google Chat in a browser. The URL ends in `/space/AAAA…` (or `/room/AAAA…`).
2. Set `GOOGLE_CHAT_SPACE=spaces/AAAA…`.
3. The posting account must already be a member.

The service never creates spaces, invites people, or sends direct messages. It only calls `spaces.messages.create` on this one space.

---

## Deploy to Cloud Run

```bash
cp deploy/env.example.yaml deploy/env.yaml   # fill in; git-ignored. PUBLIC_BASE_URL=$SERVICE_URL

gcloud run deploy $SERVICE --source . --region $REGION \
  --service-account $RUNTIME_SA \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 3 --concurrency 20 --timeout 300 --cpu 1 --memory 512Mi \
  --env-vars-file deploy/env.yaml \
  --set-secrets FIREFLIES_API_KEY=fireflies-api-key:latest,FIREFLIES_WEBHOOK_SECRET=fireflies-webhook-secret:latest,GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:latest,OAUTH_ADMIN_TOKEN=oauth-admin-token:latest

curl -s $SERVICE_URL/health
```

- **Why `--allow-unauthenticated`:** Fireflies has to reach the webhook. Every other route authenticates in-app: the HMAC signature, the Cloud Tasks OIDC token (issuer, audience, and the exact service-account email), and the admin token plus OAuth state.
- **Scale to zero:** Cloud Run can scale to zero because all durable state lives in Firestore, Cloud Tasks, and Secret Manager. Instances keep only caches.
- **Config validation:** the service validates its configuration at startup and exits with a list of missing or invalid variable *names* (never values).
- **Changing the rules later:** `gcloud run services update $SERVICE --region $REGION --env-vars-file deploy/env.yaml`.

### Connect the posting account

1. Open `https://<SERVICE_URL>/oauth/start`. Enter the admin token, which is submitted by POST so it never appears in a URL.
2. Sign in as `GOOGLE_AUTHORIZED_USER_EMAIL` and approve.
   - The callback verifies the one-time `state`, the browser-bound cookie, the Google ID token (email must match and be verified), and that `chat.messages.create` was granted.
   - It then stores the refresh token as a new Secret Manager version and disables older versions.
3. Any other account is rejected, and nothing is stored.

**Re-authorize** the same way whenever logs show `recap.google_auth_required`. Causes include a revoked grant, six months without use, an admin policy change, or a password reset.

### Configure the Fireflies webhook

In Fireflies, open **Integrations → Fireflies API → Webhooks** (Webhooks V2; [app.fireflies.ai/integrations/api/webhook](https://app.fireflies.ai/integrations/api/webhook)):

- **URL:** `https://<SERVICE_URL>/webhooks/fireflies`
- **Events:** only **Meeting summarized** (`meeting.summarized`).
- **Signing secret:** the value of `fireflies-webhook-secret`.
- **"Resend when a meeting's notes change":** leave off. If enabled, resends (`reprocessed_at`) are acknowledged and ignored in v1.
- **Account:** the Fireflies API key's account must be able to read the meetings that the webhook reports. Check in Fireflies which meetings the webhook covers (yours or your team's) for your plan.

---

## End-to-end test with one approved meeting

1. Deploy with a narrow rule, e.g. `[{"name":"e2e-test","organizerEmails":["you@orcarehab.com"],"titleContains":["Recap Bot Test"]}]`.
2. Connect the posting account (above). Confirm `gcloud secrets versions list google-chat-refresh-token` shows one enabled version.
3. Hold a short meeting titled **Recap Bot Test**, organized by you, with Fireflies recording. Discuss one decision and one action item with an owner.
4. Optionally, preview locally before Fireflies fires: `npm run preview -- --meeting <id>` with `FIREFLIES_API_KEY` and the same `MEETING_RULES`.
5. Watch the processing:

   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="'$SERVICE'" AND jsonPayload.event=~"^(webhook|recap)\."' \
     --limit 50 --format='table(timestamp,jsonPayload.event,jsonPayload.meetingId,jsonPayload.code,jsonPayload.message)'
   ```

   Expected sequence: `webhook.accepted` → `recap.processing` → `recap.sending` → `recap.sent`.
6. Check the space: one message from you, with the Chat app's name attributed.
7. Check idempotency. Re-send the same webhook body, signed with the same secret (use the curl snippet above against `$SERVICE_URL`). You should get `200 {"status":"duplicate"}` and no second message.
8. Check durable state. The Firestore document in `ff_recaps_meetings` should show `status: sent` and `chatMessageName`.

**No Fireflies event yet?** The same curl snippet can deliver a correctly signed `meeting.summarized` for an existing meeting id.

---

## Operations

**Logs.** Logs are structured JSON with a Cloud Logging `severity`. They contain meeting ids, task names, status, error codes, counts, and byte sizes. They never contain transcripts, summaries, titles, recap text, tokens, signatures, OAuth codes or state, or query strings.

| `jsonPayload.event` | Meaning | Action |
|---|---|---|
| `webhook.rejected` | bad signature / payload / event type | Check the Fireflies secret and event selection |
| `webhook.enqueue_failed` (ERROR) | Firestore or Cloud Tasks unavailable; 503 returned, Fireflies retries | Check IAM / quotas |
| `recap.skipped` | no rule matched (`reason`) | Expected for unapproved meetings |
| `recap.retry` | transient error (`code`), Cloud Tasks retries | None unless persistent |
| `recap.google_auth_required` (ERROR) | refresh token revoked, expired, or missing | Re-authorize via `/oauth/start` |
| `recap.delivery_failed` (ERROR, Error Reporting) | permanent failure or retries exhausted. `code: delivery_uncertain` means the final attempt may have posted. | Check the space, then `npm run replay -- --meeting <id>` if needed |

Suggested alert: a log-based alert on `severity>=ERROR AND jsonPayload.event=~"recap\.(delivery_failed|google_auth_required)"`.

**Replay.** `npm run replay -- --meeting <id>` re-queues a failed meeting. It needs production env vars and gcloud application-default credentials. Replay reuses the stored Chat `requestId`/`messageId`, so replaying a meeting that was in fact posted does not create a duplicate.

**Duplicate and concurrency guarantees:**
- Concurrent or duplicate webhooks map to one named Cloud Task, and Firestore records the meeting transactionally.
- Concurrent task attempts compete for a Firestore lease. Losers get 503 with `Retry-After` and later find the meeting finished.
- The Chat `requestId` and `messageId` are derived from the meeting id and saved before the send. A retry after a timeout or crash re-sends the same ids, and Chat returns the existing message.
- If Google rules change while a send is in doubt, the send still completes. Eligibility is not re-evaluated once sending has started.

---

## Remaining limitations

- **Updated summaries** (`reprocessed_at`) are not re-posted or edited in v1.
- **Retention of `requestId` deduplication** on Google's side is not documented. The design relies on retries happening within the queue's retry window (about one day).
- **Action-item parsing** depends on Fireflies' undocumented text layout. Unrecognized lines are kept verbatim, without owners or deadlines.
