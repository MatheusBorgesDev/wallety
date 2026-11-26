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

// The deployment holds as many demo sandboxes as it is willing to.
export class DemoCapacityReached extends DomainError {
  constructor() {
    super("Too many demos are running right now; try again later");
  }
}

export class EmailAlreadyRegistered extends DomainError {
  constructor() {
    super("This email is already registered");
  }
}

// One error for an unknown email and for a wrong password: the caller must not be able
// to tell which of the two happened.
export class InvalidCredentials extends DomainError {
  constructor() {
    super("Invalid email or password");
  }
}
