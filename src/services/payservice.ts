import { exec } from "child_process";
import path from "path";

type PayDevnetResult = {
  success: boolean;
  tx: string;
  receiptPda: string;
  treasury: string;
  mint: string;
  recipient: string;
  amountRaw: number;
  payCountBefore: string;
  payCountAfter: string;
};

export async function executePayment(
  recipient: string,
  amount: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocolPath = path.resolve(
      process.env.PROTOCOL_PATH || "../zephyon-protocol"
    );

    const command = `
      cd ${protocolPath} &&
      TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/pay_devnet.ts \
      2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J \
      ${recipient} \
      ${amount}
    `;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Payment execution failed:");
        console.error(stderr);

        reject(stderr || error.message);
        return;
      }

      console.log("Protocol response:");
      console.log(stdout);

      const jsonMarker = "--- JSON_RESULT ---";
      const markerIndex = stdout.indexOf(jsonMarker);

      if (markerIndex === -1) {
        reject("Unable to locate JSON_RESULT block");
        return;
      }

      const jsonText = stdout
        .slice(markerIndex + jsonMarker.length)
        .trim()
        .split("\n")[0];

      try {
        const parsed = JSON.parse(jsonText) as PayDevnetResult;

        if (!parsed.success || !parsed.receiptPda) {
          reject("Protocol response did not include a valid receipt PDA");
          return;
        }

        resolve(parsed.receiptPda);
      } catch (parseError) {
        console.error("Failed to parse protocol JSON_RESULT:");
        console.error(parseError);
        reject("Unable to parse protocol JSON_RESULT");
      }
    });
  });
}