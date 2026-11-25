// Business-rule violations. They are expected outcomes, not bugs: the HTTP
// layer maps them to 4xx responses, and anything else is an unexpected 500.
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NonPositiveAmount extends DomainError {
  constructor(amount: bigint) {
    super(`Transfer amount must be positive, got ${amount}`);
  }
}

export class SameAccountTransfer extends DomainError {
  constructor(accountId: string) {
    super(`Cannot transfer to the same account: ${accountId}`);
  }
}

export class SystemAccountAsDestination extends DomainError {
  constructor(accountId: string) {
    super(`A system account cannot receive a transfer: ${accountId}`);
  }
}

export class CurrencyMismatch extends DomainError {
  constructor(from: string, to: string) {
    super(`Currency mismatch: ${from} -> ${to}`);
  }
}

export class CrossSandboxTransfer extends DomainError {
  constructor() {
    super("Transfers are only allowed between accounts of the same sandbox");
  }
}

export class InsufficientFunds extends DomainError {
  constructor(accountId: string) {
    super(`Insufficient funds in account ${accountId}`);
  }
}
