# Domain disclaimers (V6-RISK-05)

These statements are product policy. Role labels, skill packs, and model output **do not** create professional credentials, legal guarantees, or personhood.

## Medicine and clinical

- Roles such as “Medical Research Librarian” or any label containing “Doctor” grant **no** clinical credential, license, or authority to treat.
- Patient/record access requires explicit consent registry entries (`server/src/lib/patient-consent.ts`). Training-purpose use of clinical data is forbidden.
- Outputs are research/education aids unless a human with applicable professional standing reviews and accepts responsibility.

## Scientific research

- Citations must be primary-source verifiable. Hallucinated DOIs fail the research gate.
- Model self-scores never override independent science gate outcomes.
- Reproducibility packs (data, env, seeds) are required for claims of experimental support; prompts alone are not evidence.

## Contracts and financial risk

- Sui Move and EVM/Solidity are separate families; cross-family tools are rejected.
- Passing unit tests does **not** clear audit findings. Critical/high findings block promote.
- Production signing keys are never exposed to the model. Mainnet and value-at-risk actions need human owner signoff.
- No skill pack guarantees absence of economic exploit, reentrancy, or governance failure.

## Games, NPCs, embodiment

- NPCs are software processes. Decorative entities do not receive SIDs.
- Persistent NPC SIDs are operational identities for memory and grants, **not** legal persons.
- World policy may block wallet/economic tools by default.

## Media and music

- Rights review is required before commercial use of melodies, voices, or third-party stems.
- “Model says the mix is good” is not acceptance; human listening/review is required for release claims.
- Provenance (prompt, model, version, output digest) is retained for audit.

## Agents generally

- An agent SID is a tenant-scoped software identity with grants and audit history.
- Agents do not hold property, enter contracts, or waive user rights.
- Tool success is only what receipts and policy permits record — never implied by fluent language.
