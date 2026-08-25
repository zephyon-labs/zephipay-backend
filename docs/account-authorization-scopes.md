# Account authorization scopes

ZephiPay treats account and payment authority as independent capabilities:

- `AUTH0_REQUIRED_SCOPE` remains the backward-compatible account-read setting and defaults to `read:account`.
- `AUTH0_WRITE_ACCOUNT_SCOPE` is additive, defaults to `write:account`, and protects Payment Identity and receiving-destination mutations.
- `AUTH0_READ_PAYMENTS_SCOPE` and `AUTH0_WRITE_PAYMENTS_SCOPE` continue to protect payment history and payment actions independently.

`write:account` permits account mutation without implicitly granting account reads or any payment action. Scope permits a category of action; the verified Auth0 issuer plus subject still selects the canonical account. Request bodies, query parameters, email, username, and identity headers cannot select another owner.

Before enforcement is deployed, an Auth0 operator must manually add the `write:account` permission to the ZephiPay API and permit the first-party Regular Web Application grant to request it. Tenant, API, and application identifiers are intentionally not encoded here. Existing sessions without the new scope may keep reading but must reauthenticate before mutating.

For Mainnet, receiving-destination mutation also requires a designed recent-auth/step-up and destination-ownership security policy. `write:account` alone is only the bounded controlled-beta authorization boundary. AUTHZ-003 remains separate: standard web sessions still request `write:payments` until later incremental, device-aware, or transaction-specific authority work.
