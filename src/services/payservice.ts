import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

import idl from "../protocol/idl/protocol.json";

const PROGRAM_ID = new PublicKey(
  "BtP7rVw9sqN4pW5RuzZJ2c4576R5pJU9yRtjrRJ7b5bM"
);

const MINT = new PublicKey("2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J");

type PaymentResult = {
  receiptId: string;
  signature: string;
  treasury: string;
  mint: string;
  recipient: string;
  amountRaw: string;
  payCountBefore: string;
  payCountAfter: string;
};

function deriveTreasuryPda(programId: PublicKey): PublicKey {
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    programId
  );

  return treasuryPda;
}

function loadPayer(): Keypair {
  const secret = process.env.SOLANA_KEYPAIR_JSON;

  if (!secret) {
    throw new Error("SOLANA_KEYPAIR_JSON missing");
  }

  const secretKey = Uint8Array.from(JSON.parse(secret));
  return Keypair.fromSecretKey(secretKey);
}

function validateAmount(amount: string): BN {
  const amountRaw = Number(amount);

  if (
    !Number.isFinite(amountRaw) ||
    amountRaw <= 0 ||
    !Number.isInteger(amountRaw)
  ) {
    throw new Error("Amount must be a positive raw integer.");
  }

  return new BN(amountRaw);
}

export async function executePayment(
  recipient: string,
  amount: string
): Promise<PaymentResult> {
  try {
    console.log("Executing REAL ZephyPay devnet payment");

    const payer = loadPayer();
    const recipientPubkey = new PublicKey(recipient);
    const amountBn = validateAmount(amount);

    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(payer),
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      }
    );

    anchor.setProvider(provider);

    const idlWithMeta = {
      ...(idl as anchor.Idl),
      metadata: {
        ...((idl as any).metadata ?? {}),
        address: PROGRAM_ID.toBase58(),
      },
    };

    const program = new anchor.Program(idlWithMeta as anchor.Idl, provider);
    const programAny = program as any;

    const treasuryPda = deriveTreasuryPda(PROGRAM_ID);

    const treasury = await programAny.account.treasury.fetch(treasuryPda);

    console.log("Treasury PDA:", treasuryPda.toBase58());
    console.log("Paused:", treasury.paused);
    console.log("Pay Count Before:", treasury.payCount.toString());

    if (treasury.paused) {
      throw new Error("Treasury is paused.");
    }

    const treasuryAta = getAssociatedTokenAddressSync(
      MINT,
      treasuryPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      MINT,
      recipientPubkey,
      false,
      "confirmed",
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const payCountBefore = new BN(treasury.payCount.toString());

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        treasuryPda.toBuffer(),
        payCountBefore.toArrayLike(Buffer, "le", 8),
      ],
      PROGRAM_ID
    );

    console.log("Mint:", MINT.toBase58());
    console.log("Recipient:", recipientPubkey.toBase58());
    console.log("Treasury ATA:", treasuryAta.toBase58());
    console.log("Recipient ATA:", recipientAta.address.toBase58());
    console.log("Expected Receipt PDA:", receiptPda.toBase58());

    await getAccount(
      provider.connection,
      treasuryAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );

    const signature = await programAny.methods
      .splPay(amountBn, null, null)
      .accounts({
        treasuryAuthority: provider.wallet.publicKey,
        treasury: treasuryPda,
        mint: MINT,
        treasuryAta,
        recipient: recipientPubkey,
        recipientAta: recipientAta.address,
        receipt: receiptPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const treasuryAfter = await programAny.account.treasury.fetch(treasuryPda);

    console.log("Pay TX:", signature);
    console.log("Pay Count After:", treasuryAfter.payCount.toString());

    return {
      receiptId: receiptPda.toBase58(),
      signature,
      treasury: treasuryPda.toBase58(),
      mint: MINT.toBase58(),
      recipient: recipientPubkey.toBase58(),
      amountRaw: amountBn.toString(),
      payCountBefore: payCountBefore.toString(),
      payCountAfter: treasuryAfter.payCount.toString(),
    };
  } catch (error) {
    console.error("executePayment failed:", error);
    throw error;
  }
}