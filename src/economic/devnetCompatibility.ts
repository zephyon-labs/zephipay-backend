import { AssetIdentityV1, createAssetIdentityV1, createEconomicAmountV1 } from "zephyon-protocol";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { PaymentRecord } from "../payments/paymentTypes";
import { CIRCLE_SOLANA_DEVNET_USDC_DECIMALS, CIRCLE_SOLANA_DEVNET_USDC_MINT } from "../devnet/canonicalDevnetAsset";
import { CanonicalDevnetPreparationPolicy, devnetPreparationPolicy, hashDevnetPolicy } from "../devnet/devnetPreparationPolicy";
/** Offline projection only. It is intentionally NOT imported by routes, Runtime composition or workers. */
export function normalizeCurrentDevnetIntentV1(payment: PaymentRecord, policy: CanonicalDevnetPreparationPolicy, trustedAsset: AssetIdentityV1) {
    const asset = createAssetIdentityV1(trustedAsset);
    if (asset.kind !== "spl-token" || asset.network.environment !== "devnet" || asset.tokenProgram !== TOKEN_PROGRAM_ID.toBase58() || asset.mint !== CIRCLE_SOLANA_DEVNET_USDC_MINT || asset.decimals !== CIRCLE_SOLANA_DEVNET_USDC_DECIMALS)
        throw new Error("Only current canonical Devnet USDC can be adapted.");
    // Genesis must come from a qualified definition, not from a client cluster label.
    if (payment.network !== "solana-devnet" || payment.rail !== "solana" || payment.asset !== "USDC" || payment.mintAddress !== asset.mint || payment.recipientType !== "DIRECT_WALLET" || policy.network !== "solana-devnet" || policy.mint !== asset.mint || policy.decimals !== 6)
        throw new Error("Legacy payment or policy mismatch.");
    const checked = devnetPreparationPolicy({ mint: policy.mint, decimals: policy.decimals, sourceTokenAccount: policy.sourceTokenAccount, signerKeyId: policy.signer.keyId, signerKeyVersion: policy.signer.keyVersion, signerPublicKey: policy.signer.publicKey, submissionProviderId: policy.providers.submission, reconciliationProviderId: policy.providers.reconciliation });
    if (hashDevnetPolicy(checked) !== hashDevnetPolicy(policy))
        throw new Error("Legacy policy shape mismatch.");
    const wallet = new PublicKey(payment.recipientAddress);
    if (wallet.toBase58() !== payment.recipientAddress)
        throw new Error("Noncanonical destination.");
    const amount = createEconomicAmountV1({ schema: "zephyon.amount/v1", asset, atomicUnits: payment.amountRaw.toString() }, asset);
    return Object.freeze({
        schema: "zephyon.devnet-compatibility/v1" as const, executionMode: "devnet-validation" as const,
        paymentIntentId: payment.id, intentVersion: payment.version.toString(), requestHash: payment.requestHash, principalId: payment.actorSubject, amount,
        sourceAuthority: Object.freeze({ mode: "devnet-server" as const, signer: policy.signer.publicKey, account: policy.sourceTokenAccount, keyId: policy.signer.keyId, keyVersion: policy.signer.keyVersion }),
        feeAuthority: Object.freeze({ mode: "devnet-server" as const, signer: policy.signer.publicKey, keyId: policy.signer.keyId, keyVersion: policy.signer.keyVersion }),
        recipient: Object.freeze({ snapshotReference: payment.requestHash, wallet: payment.recipientAddress, tokenAccount: getAssociatedTokenAddressSync(new PublicKey(asset.mint), wallet).toBase58(), ownership: "UNVERIFIED" as const }),
        purposeReference: payment.id, preparationPolicyHash: hashDevnetPolicy(policy),
        confirmation: Object.freeze({ kind: "LEGACY_TEST_INVENTORY_CONFIRMATION" as const, confirmedAt: payment.userConfirmedAt ?? null, requestHash: payment.requestHash }),
        customerSignature: "NOT_PRESENT" as const, productionRuntimeEvidence: "NOT_ESTABLISHED" as const,
        legacyCorrelation: Object.freeze({ runtimeId: payment.runtimeId ?? null, runtimeTransactionId: payment.runtimeTransactionId ?? null, chainSignature: payment.solanaSignature ?? null })
    });
}
