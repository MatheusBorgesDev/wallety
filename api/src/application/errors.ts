import { DomainError } from "../domain/errors.js";

// Raised both when an account does not exist and when it exists but the caller
// may not use it, so a response never reveals that someone else's account exists.
export class AccountNotFound extends DomainError {
  constructor(accountId: string) {
    super(`Account not found: ${accountId}`);
  }
}

export class IdempotencyKeyReuse extends DomainError {
  constructor() {
    super("This idempotency key was already used with a different request");
  }
}
