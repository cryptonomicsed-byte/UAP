# Omokoda guest birth

UAP owns the workspace bot and its template SID; the Omokoda kernel owns the guest and its native identity. Vantage is optional social registration. The UAP template SID is not the kernel's native SID and does not grant kernel execution authority.

## API

`POST /api/v6/sid/omokoda/birth` requires a UAP session and accepts `name`, optional `bio`, and optional `register` (defaults to true). Supply an `Idempotency-Key` for every logical birth and reuse it on transport retries. The key is scoped to the signed-in account and must contain 1–128 ASCII letters, digits, dots, underscores, or hyphens. This header is optional for backward compatibility; a request without it does not get duplicate protection.

- A completed request with the same key and equivalent input returns its original result.
- Different effective input under the same key returns `409 birth-conflict`.
- If the original request is still in flight or did not record a definitive result, a repeat returns `409 birth-unresolved`. Reconcile the kernel and Vantage records before starting a new birth. Do not generate a new key merely because a request timed out. UAP does not automatically retry or expire ambiguous requests.
- The optional Vantage registration can fail independently; that does not undo the kernel guest or workspace SID. A Vantage timeout can still leave a Vantage-side registration.

`GET /api/v6/sid/omokoda/birth/:botId` is scoped to the owning UAP account. It returns the birth linkage and credential presence only. Keep the internal service URLs and credential files server-side.

New workspace SIDs bind the UAP birth commitment under `provenance.omokoda_birth_hash`. This is a SHA-256 digest of the normalized requested name, the kernel guest ID, and the kernel receipt ID when present. It is covered by the document hash, is not a signature or clock anchor, and is not the kernel's genesis/entropy commitment. Existing SID documents are not rewritten.

## Runtime boundary

The current birth client does not make `/v1/act` calls. It does not enforce kernel action policy: the kernel's native execution paths remain separate, and Vantage can still initiate a separate direct birth. Before enabling an Omokoda runtime adapter in UAP, require managed guests to reject native execution on the kernel side (including tool-using cognition), and route approved tools through UAP's existing authority gate. Use a real kernel against disposable data for that verification, not a live registration.
