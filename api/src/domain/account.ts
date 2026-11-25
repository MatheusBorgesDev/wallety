// USER accounts belong to a person and live inside a sandbox. The SYSTEM
// account of each currency is where money enters the ledger: it belongs to
// no one and to no sandbox.
export type AccountKind = "USER" | "SYSTEM";

// What the domain needs to know about an account to validate a transfer.
export type AccountRef = {
  id: string;
  kind: AccountKind;
  currency: string;
  sandboxId: string | null;
};
