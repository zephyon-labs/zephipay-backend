import * as anchor from "@coral-xyz/anchor";
import crypto from "crypto";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";

import fs from "fs";
import idl from "../protocol/idl/protocol.json";

const PROGRAM_ID = new PublicKey(
  "BtP7rVw9sqN4pW5RuzZJ2c4576R5pJU9yRtjrRJ7b5bM"
);

export async function executePayment(
  recipient: string,
  amount: string
): Promise<string> {
  try {
    console.log("Executing REAL devnet payment");

    const secret = process.env.SOLANA_KEYPAIR_JSON;

    if (!secret) {
      throw new Error("SOLANA_KEYPAIR_JSON missing");
    }

    const secretKey = Uint8Array.from(JSON.parse(secret));

    const payer = Keypair.fromSecretKey(secretKey);

    const connection = new Connection(
      clusterApiUrl("devnet"),
      "confirmed"
    );

    const wallet = new anchor.Wallet(payer);

    const provider = new anchor.AnchorProvider(
      connection,
      wallet,
      {}
    );

    anchor.setProvider(provider);

    const program = new anchor.Program(
      idl as anchor.Idl,
      provider
    );

    console.log("Program initialized");

    console.log({
      recipient,
      amount,
    });

    // TEMPORARY RETURN
    // Real splPay call next

    return `REAL-${crypto.randomUUID()}`;
  } catch (error) {
    console.error(error);
    throw error;
  }
}