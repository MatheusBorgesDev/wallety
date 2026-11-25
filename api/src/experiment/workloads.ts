// A workload decides which two accounts each transfer touches, which is what sets how
// often concurrent transfers collide.
export type Workload = {
  name: string;
  // Accounts taking part, numbered 0 to accounts - 1.
  accounts: number;
  // The first `hotAccounts` accounts form the hot set.
  hotAccounts: number;
  // Share of transfers whose two accounts both come from the hot set.
  hotShare: number;
};

export const workloads = {
  // Every transfer picks two of the same four accounts.
  "high-contention": { name: "high-contention", accounts: 4, hotAccounts: 0, hotShare: 0 },
  // Two accounts picked uniformly out of a thousand.
  "low-contention": { name: "low-contention", accounts: 1000, hotAccounts: 0, hotShare: 0 },
  // Half of the transfers stay inside four hot accounts, the rest are uniform over a thousand.
  mixed: { name: "mixed", accounts: 1000, hotAccounts: 4, hotShare: 0.5 },
} satisfies Record<string, Workload>;

export type WorkloadName = keyof typeof workloads;

export function pickPair(workload: Workload, random: () => number): [from: number, to: number] {
  const range = random() < workload.hotShare ? workload.hotAccounts : workload.accounts;
  const from = Math.floor(random() * range);
  // Draw from the remaining range - 1 accounts, so both are different and still uniform.
  const offset = 1 + Math.floor(random() * (range - 1));
  return [from, (from + offset) % range];
}
