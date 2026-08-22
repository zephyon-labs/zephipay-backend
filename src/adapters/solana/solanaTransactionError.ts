// Closed allowlist matching the serialized TransactionError contract exposed by
// @solana/rpc-types 5.5.1. Unknown future variants deliberately fail closed.
const TRANSACTION_ERROR_UNIT_VARIANTS = new Set([
  "AccountBorrowOutstanding",
  "AccountInUse",
  "AccountLoadedTwice",
  "AccountNotFound",
  "AddressLookupTableNotFound",
  "AlreadyProcessed",
  "BlockhashNotFound",
  "CallChainTooDeep",
  "ClusterMaintenance",
  "InsufficientFundsForFee",
  "InvalidAccountForFee",
  "InvalidAccountIndex",
  "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex",
  "InvalidAddressLookupTableOwner",
  "InvalidLoadedAccountsDataSizeLimit",
  "InvalidProgramForExecution",
  "InvalidRentPayingAccount",
  "InvalidWritableAccount",
  "MaxLoadedAccountsDataSizeExceeded",
  "MissingSignatureForFee",
  "ProgramAccountNotFound",
  "ResanitizationNeeded",
  "SanitizeFailure",
  "SignatureFailure",
  "TooManyAccountLocks",
  "UnbalancedTransaction",
  "UnsupportedVersion",
  "WouldExceedAccountDataBlockLimit",
  "WouldExceedAccountDataTotalLimit",
  "WouldExceedMaxAccountCostLimit",
  "WouldExceedMaxBlockCostLimit",
  "WouldExceedMaxVoteCostLimit",
]);

const INSTRUCTION_ERROR_UNIT_VARIANTS = new Set([
  "AccountAlreadyInitialized",
  "AccountBorrowFailed",
  "AccountBorrowOutstanding",
  "AccountDataSizeChanged",
  "AccountDataTooSmall",
  "AccountNotExecutable",
  "AccountNotRentExempt",
  "ArithmeticOverflow",
  "BorshIoError",
  "BuiltinProgramsMustConsumeComputeUnits",
  "CallDepth",
  "ComputationalBudgetExceeded",
  "DuplicateAccountIndex",
  "DuplicateAccountOutOfSync",
  "ExecutableAccountNotRentExempt",
  "ExecutableDataModified",
  "ExecutableLamportChange",
  "ExecutableModified",
  "ExternalAccountDataModified",
  "ExternalAccountLamportSpend",
  "GenericError",
  "IllegalOwner",
  "Immutable",
  "IncorrectAuthority",
  "IncorrectProgramId",
  "InsufficientFunds",
  "InvalidAccountData",
  "InvalidAccountOwner",
  "InvalidArgument",
  "InvalidError",
  "InvalidInstructionData",
  "InvalidRealloc",
  "InvalidSeeds",
  "MaxAccountsDataAllocationsExceeded",
  "MaxAccountsExceeded",
  "MaxInstructionTraceLengthExceeded",
  "MaxSeedLengthExceeded",
  "MissingAccount",
  "MissingRequiredSignature",
  "ModifiedProgramId",
  "NotEnoughAccountKeys",
  "PrivilegeEscalation",
  "ProgramEnvironmentSetupFailure",
  "ProgramFailedToCompile",
  "ProgramFailedToComplete",
  "ReadonlyDataModified",
  "ReadonlyLamportChange",
  "ReentrancyNotAllowed",
  "RentEpochModified",
  "UnbalancedInstruction",
  "UninitializedAccount",
  "UnsupportedProgramId",
  "UnsupportedSysvar",
]);

const MAX_INSTRUCTION_OR_ACCOUNT_INDEX = 255;
const MAX_CUSTOM_PROGRAM_ERROR = 0xffff_ffff;

export function isSupportedSolanaTransactionError(value: unknown): boolean {
  if (typeof value === "string") return TRANSACTION_ERROR_UNIT_VARIANTS.has(value);
  if (!record(value)) return false;

  const keys = Object.keys(value);
  if (keys.length !== 1) return false;

  switch (keys[0]) {
    case "DuplicateInstruction":
      return index(value.DuplicateInstruction);
    case "InstructionError":
      return instructionError(value.InstructionError);
    case "InsufficientFundsForRent":
      return accountIndex(value.InsufficientFundsForRent);
    case "ProgramExecutionTemporarilyRestricted":
      return accountIndex(value.ProgramExecutionTemporarilyRestricted);
    default:
      return false;
  }
}

function instructionError(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2 || !index(value[0])) return false;
  const detail = value[1];
  if (typeof detail === "string") return INSTRUCTION_ERROR_UNIT_VARIANTS.has(detail);
  if (!record(detail) || !exactKeys(detail, ["Custom"])) return false;
  return integerInRange(detail.Custom, MAX_CUSTOM_PROGRAM_ERROR);
}

function accountIndex(value: unknown): boolean {
  return record(value) && exactKeys(value, ["account_index"]) && index(value.account_index);
}

function index(value: unknown): boolean {
  return integerInRange(value, MAX_INSTRUCTION_OR_ACCOUNT_INDEX);
}

function integerInRange(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
