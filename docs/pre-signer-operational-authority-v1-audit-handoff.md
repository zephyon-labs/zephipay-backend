# Pre-signer operational authority V1 — audit handoff

Date: 2026-10-01. Scope: Backend only. Phase B is a local implementation candidate for independent audit; it has not been pushed, opened as a PR, merged or deployed.

## Phase A protected closure

1. **Reviewed package:** exact clean commit `6202e6c8b15a34929d1e5d54f2033e4c5bc2cad3`, against `8f4f49fc60c104ea7b837e553dc9fd5f2cdc60c0`. Reverified 14 files, 1,707 insertions, 2 deletions and exact patch SHA-256 `e2dd3bd5643afdf0fbcfd12adce9613c19d933e7b03399685ed2bf8c51d9c8e4`. No post-audit change, dependency change or activation. Independent verdict: ACCEPT WITH NONBLOCKING OBSERVATIONS; P0/P1/P2 zero.
2. **Pushed branch:** `feat/trusted-finalization-v1`; exact reviewed commit, no force push and no direct main push.
3. **PR:** [Backend #4](https://github.com/zephyon-labs/zephipay-backend/pull/4).
4. **Hosted CI:** required [verify](https://github.com/zephyon-labs/zephipay-backend/actions/runs/36824220813/job/110246179959) passed, 1m20s. No remediation or audited-patch edit was needed.
5. **Merge:** normal protected merge with exact head-match guard, completed 2026-10-01 at 06:24:48 UTC. No administrative protection bypass.
6. **Canonical Backend main:** `36d3e7300102f8ca42e05af04f051f1d58b5a339`, local clean and matching remote main. No deployment.

## Phase B candidate

7. **Starting state:** clean isolated checkout from the merged canonical Backend commit above. Protocol 0.4.0 and dependency lock remain unchanged.
8. **Branch/worktree:** `feat/pre-signer-operational-authority-v1`, `/home/zeranova/dev/zephyon-labs/zephipay-backend-operational-authority-v1`. Local commit hash is supplied with the final audit report; derive the complete patch using `git diff 36d3e7300102f8ca42e05af04f051f1d58b5a339 HEAD`.
9. **Lifecycle:** terminal `EXPIRED_NEVER_CONTACTED`; no revival or signer contact. The committed attempt fence remains intact; this is not cancellation.
10. **Eligibility:** affirmative locked expiry/revocation, current canonical generation, exact never-contacted/reserved state, and no committed contact, result, uncertain/realized accounting or contradictory evidence. Ambiguity retains exposure.
11. **Serialization:** contact and expiry serialize on the same intent/budget-family/budget/operation authority domain. Contact ledger and transition are atomic. Expiry winner forbids later contact; contact winner forbids timeout reclamation.
12. **Release:** immutable expiry record, terminal transition, released exposure and audit event commit together. All three fee components remain historically attributable. No uncertain exposure is released.
13. **Budgets:** immutable numbered versions and a CAS-revisioned family head; finalization persists exact original budget ID/version. Capacity sums outstanding and consumed exposure across all versions.
14. **Disablement:** blocks new claims; preserves old reservations, original version and recovery. Revising a disabled budget does not reactivate it. Lower limits cannot block old recovery or reset charged costs.
15. **DB roles:** explicit NOLOGIN admin, app, issuer, signer-result, observer and support groups; separate privileged provisioning command with fatal failures. Actual deployment logins/secrets remain outside scope.
16. **Application restrictions:** restricted initial INSERT columns, initial-state and deferred authority guards, approved operational functions, no direct result/contact/expiry/effect/accounting writes or schema escalation. Positive and negative tests use actual restricted LOGIN connections.
17. **Session revocation:** verified provider identity/session is immutably bound to existing canonical `account_sessions`; consent, claim and first contact check active/unrevoked/unexpired canonical session under locks. No competing identity store or logout shortcut.
18. **History:** old consent bytes remain intact; historical NULL session bindings are not inferred/backfilled into eligibility. Already-contacted operations retain their original recovery authority. Legacy contact records identify their provenance explicitly.
19. **Migrations:** additive migration 024; 001–023 unchanged. Clean application of all 24 migrations passed. A copied 023 fixture upgraded successfully: one signed operation, consent, attempt, Runtime record and budget plus eight authority events retained their original content; no historical session was silently bound. Legacy signer ID/version/contact provenance was preserved, and reclamation was rejected. Role provisioning succeeded twice on the upgraded database.
20. **Concurrency:** real PostgreSQL tests cover both contact/expiry winners, signer-result recovery, consent/Runtime/session revocation, cancellation, double expiry/release, budget disablement and budget version changes. Independent connections and observed lock waits establish forced race ordering where required.
21. **Failure injection:** deferred-commit expiry failure rolls back release/history; post-commit lost responses replay safely; budget administration failures roll back immutable version and head updates; session lock timeout/revocation checks retain safe retry behavior.
22. **Idempotency:** repeated expiry returns identical terminal state/version with one release record and one authority event. Eight simultaneous expiry workers converge.
23. **Audit:** immutable reason/reference records include old/new state, operation ID, generation, reservation identity, released units, consent/Runtime/session references, actor, database actor and time. No tokens or signing bytes enter operational logs.
24. **Devnet:** existing live/simulation Devnet route, worker, runtime and receipt code unchanged. Source scan found zero foundation references outside the unmounted foundation itself. Existing PostgreSQL Devnet regressions passed.
25. **ZERA:** no registry entry, mint, payment route, qualification, distribution, staking, liquidity or activation. Canonical supply/allocation baseline SHA-256 remains `182299950ae49c2bd2d8d5a99d2f73b3d0f77520982ab3c04ff8e2b9c1bbdff1`; 200M maximum supply unchanged.
26. **Protocol:** unchanged pinned `github:zephyon-labs/zephyon-protocol#v0.4.0`; no local semantic fork, SDK release or lockfile change.
27. **Unit/static validation:** 395 unit tests passed; lint and build passed; validation of 24 ordered migrations passed; no test skipped or failed in the completed unit run.
28. **Focused PostgreSQL:** 94 tests passed (46 existing foundation + 48 operational-authority tests), zero failed/skipped. The focused run is a subset of the full PostgreSQL suite, not an additional disjoint test population.
29. **Full PostgreSQL:** 183 tests passed, zero failed/skipped, including 46 prior foundation and 48 new operational-authority cases.
30. **Repeated races:** ten sequential repetitions of eleven critical tests; 110 passes, zero failures or skips. Includes the forced canonical-session revocation eligibility race.
31. **Diff:** 16 files changed, 1,301 insertions and 43 deletions. `git diff --check` passed. Final local commit and patch fingerprint are reported separately; no Phase B push/PR/merge.
32. **Open integration:** real identity/session service binding; reviewed login membership/ownership and deployment-wide ACL inventory; trusted Runtime/signer/observer transport composition; production budget values; expiry scheduling; contradictory historical-evidence incident handling; future replacement-intent UX. No current package chooses these production policies. OBS-04 independent-vector-generator provenance remains deferred.
33. **Next package:** independent audit of this candidate. After acceptance and separate protected closure, define a bounded trusted-session and least-privilege composition package using synthetic adapters before any real signer/wallet/sponsorship activation.

## Validation evidence

Local logs are retained under `/tmp/pre-signer-authority-*`: `unit-final.log`, `lint.log`, `build.log`, `migration-validation.log`, `final-migrations.log`, `final-roles.log`, `upgrade.log`, `upgrade-roles.log`, `focused-final.log`, `postgres-full.log`, and `race-1.log` through `race-10.log`. The legacy content comparison was run through independent PostgreSQL pools and reported content equality for every existing fixture record.

The initial operational run exposed two fixture defects (missing synthetic JWT type and an unforced revocation queue order). Both were corrected. Final implementation also conservatively distinguishes malformed callback bytes from matching-message signature uncertainty; the new regression verifies that a valid sponsor slot with a missing customer signature cannot authorize reclamation. No production credential, real signer, KMS/HSM, live observer or value-bearing transaction was involved.

The permission model reinforces approved database transitions. It does not claim that a compromised schema owner or a process holding every authority credential is isolated. Future deployment must satisfy the explicit contract in [pre-signer-operational-authority-v1.md](pre-signer-operational-authority-v1.md), including reviewed login memberships, pinned search paths, mandatory role provisioning and real-login permission probes. Evidence arriving after a terminal decision is incident history, not permission to revive authority.

Final verdict: **READY FOR INDEPENDENT AUDIT**. Stop here; do not push or merge this Phase B branch.
