import { InvalidArgumentError, type Command } from "commander";
import {
  HandheldApiClient,
  type GatewayUsageBillingState,
  type GatewayWalletSpendSummary,
  type GatewayWalletTransaction,
} from "../api-client.js";

type JsonOption = { json?: boolean };
const BILLING_SUMMARY_TIMEOUT_MS = 10_000;

export function registerBillingCommand(program: Command): void {
  const billing = program
    .command("billing", { hidden: true })
    .description("show wallet balance, free-tier usage, and spend")
    .action(async () => {
      await showBillingSummary(program);
    });

  billing
    .command("summary")
    .description("show wallet balance, free-tier usage, and current spend")
    .option("--window-start-ms <ms>", "spend window start time in epoch milliseconds", parseMillis)
    .option("--window-end-ms <ms>", "spend window end time in epoch milliseconds", parseMillis)
    .action(
      async (opts: { windowEndMs?: number; windowStartMs?: number }) => {
        await showBillingSummary(program, opts);
      },
    );

  billing
    .command("balance")
    .description("show current wallet balance")
    .action(async () => {
      const json = program.opts<JsonOption>().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.getBillingBalance();
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Wallet balance: ${formatCents(result.balanceCents)}`);
      } catch (err) {
        fail(err);
      }
    });

  billing
    .command("transactions")
    .description("list recent wallet transactions")
    .option("--limit <n>", "number of transactions to return", parsePositiveInteger, 20)
    .action(async (opts: { limit: number }) => {
      const json = program.opts<JsonOption>().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.getBillingTransactions(opts.limit);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printTransactions(result.transactions);
      } catch (err) {
        fail(err);
      }
    });

  billing
    .command("spend")
    .description("show wallet spend summary")
    .option("--window-start-ms <ms>", "spend window start time in epoch milliseconds", parseMillis)
    .option("--window-end-ms <ms>", "spend window end time in epoch milliseconds", parseMillis)
    .action(
      async (opts: { windowEndMs?: number; windowStartMs?: number }) => {
        const json = program.opts<JsonOption>().json;
        try {
          const api = new HandheldApiClient();
          const result = await api.getBillingSpendSummary(opts);
          if (json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          printSpendSummary(result);
        } catch (err) {
          fail(err);
        }
      },
    );
}

async function showBillingSummary(
  program: Command,
  opts: { windowEndMs?: number; windowStartMs?: number } = {},
): Promise<void> {
  const json = program.opts<JsonOption>().json;
  try {
    const api = new HandheldApiClient();
    const [usage, spend] = await Promise.all([
      withTimeout(api.getBillingUsageState(), "billing usage state"),
      withTimeout(api.getBillingSpendSummary(opts), "billing spend summary"),
    ]);
    if (json) {
      console.log(JSON.stringify({ spend, usage }, null, 2));
      return;
    }
    printBillingSummary(usage, spend);
  } catch (err) {
    fail(err);
  }
}

function printBillingSummary(
  usage: GatewayUsageBillingState,
  spend: GatewayWalletSpendSummary,
): void {
  console.log(`Wallet balance: ${formatCents(usage.balanceCents)}`);
  console.log(
    `Free minutes: ${usage.freeMinutesRemaining} remaining / ${usage.freeMinutesUsed} used`,
  );
  console.log(
    `Cycle: ${formatTime(usage.billingCycleStartMs)} - ${formatTime(usage.billingCycleEndMs)}`,
  );
  console.log(
    `Cycle spend: ${formatCents(spend.spendCents)} across ${formatCount(spend.debitCount, "debit")}`,
  );
}

function printSpendSummary(summary: GatewayWalletSpendSummary): void {
  console.log(`Window: ${formatTime(summary.windowStartMs)} - ${formatTime(summary.windowEndMs)}`);
  console.log(`Spend:  ${formatCents(summary.spendCents)}`);
  console.log(`Debits: ${summary.debitCount}`);
}

function printTransactions(rows: GatewayWalletTransaction[]): void {
  if (rows.length === 0) {
    console.log("No wallet transactions found.");
    return;
  }
  console.log(
    `${"CREATED".padEnd(24)} ${"TYPE".padEnd(10)} ${"AMOUNT".padStart(10)} ${"SOURCE".padEnd(12)} DESCRIPTION`,
  );
  console.log("-".repeat(88));
  for (const row of rows) {
    const created = formatUnknownTime(row.createdAt ?? row.createdAtMs);
    const type = stringField(row, "type") ?? "-";
    const amount = numberField(row, "amountCents");
    const amountCell = amount === null ? "—" : formatCents(amount);
    const source = stringField(row, "source") ?? "-";
    const description = stringField(row, "description") ?? stringField(row, "referenceId") ?? "";
    console.log(
      `${created.padEnd(24)} ${trimCell(type, 10).padEnd(10)} ${amountCell.padStart(10)} ${trimCell(source, 12).padEnd(12)} ${description}`,
    );
  }
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatTime(ms?: number | null): string {
  if (ms === null || ms === undefined) return "-";
  return new Date(ms).toISOString();
}

function formatUnknownTime(value: unknown): string {
  if (typeof value === "number") return formatTime(value);
  if (typeof value === "string" && value.length > 0) return value;
  return "-";
}

function formatCount(count: number, label: string): string {
  return `${count} ${count === 1 ? label : `${label}s`}`;
}

function trimCell(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + ".";
}

function stringField(row: GatewayWalletTransaction, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(row: GatewayWalletTransaction, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} timed out after ${BILLING_SUMMARY_TIMEOUT_MS}ms`,
            ),
          );
        }, BILLING_SUMMARY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseMillis(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function fail(err: unknown): never {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
