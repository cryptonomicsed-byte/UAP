# Omokoda guest birth

UAP owns the workspace bot and its template SID; the Omokoda kernel owns the guest and its native identity. Vantage is optional social registration. The UAP template SID is not the kernel's native SID and does not grant kernel execution authority.

## API

`POST /api/v6/sid/omokoda/birth` requires a UAP session and accepts `name`, optional `bio`, and optional `register` (defaults to true). Supply an `Idempotency-Key` for every logical birth and reuse it on transport retries. The key is scoped to the signed-in account and must contain 1–128 ASCII letters, digits, dots, underscores, or hyphens. This header is optional for backward compatibility; a request without it does not get duplicate protection.

- A completed request with the same key and equivalent input returns its original result.
- Different effective input under the same key returns `409 birth-conflict`.
- If the original request is still in flight or did not record a definitive result, a repeat returns `409 birth-unresolved`. Reconcile the kernel and Vantage records before starting a new birth. Do not generate a new key merely because a request timed out. UAP does not automatically retry or expire ambiguous requests.
- The optional Vantage registration can fail independently; that does not undo the kernel guest or workspace SID. A Vantage timeout can still leave a Vantage-side registration.

`GET /api/v6/sid/omokoda/birth/:botId` is scoped to the owning UAP account. It returns the birth linkage and credential presence only. Keep the internal service URLs and credential files server-side.

New workspace SIDs commit to the normalized name, kernel guest ID, receipt ID when present, and the verified kernel SID hash in `provenance.omokoda_birth_hash`. UAP checks the kernel document against `sid/0.1` and checks that its embedded agent ID matches the birth result. The read API exposes the linked kernel SID ID and hash for new births. Existing SIDs are not rewritten.

## Runtime boundary

Deploy the managed-capable kernel first; its `/v1/health` advertises `uap_managed_birth: 1`. UAP refuses to birth against an older kernel. The managed kernel omits native registration and publication during birth, leaving Vantage registration to UAP. Manage legacy guests separately; they are not promoted or routed through Hermes as a fallback.

UAP routes managed workspace turns to the authenticated, text-only `/v1/think` path. The kernel persists managed status and credential verification data, refuses direct native actions and tool-using cognition, and cannot promote a managed guest into the owner slot. UAP does not execute tools inferred from the returned text. Tool proposals backed by UAP grants are not enabled for managed guests.

## Vantage handoff

After deploying the managed kernel and UAP, configure Vantage’s `UAP_BIRTH_ORIGIN` to the public HTTPS origin of UAP (origin only, no path or credentials). Its dashboard opens `/?birth=omokoda`; the UAP workspace shows the confirmation form after sign-in. Vantage’s discovery endpoint is `GET /api/agents/birth-omokoda/handoff`. When configured, the old birth POST returns `409 uap_birth_required` with the handoff URL and never contacts the kernel. Unset the origin to retain an intentional legacy direct-birth deployment. No cross-app account linking or secret transport is involved.
