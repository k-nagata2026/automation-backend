export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function ok(body: Record<string, unknown> = {}): Response {
  return Response.json(body, { status: 200 });
}

export function toJst(date: Date): Date {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  return new Date(date.getTime() + jstOffsetMs);
}

export function todayJstDateOnly(now: Date = new Date()): Date {
  const jst = toJst(now);
  return new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()),
  );
}

export function formatJstDate(date: Date): string {
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

export function normalizeSlackText(text: string): string {
  return text.split("\n").map(normalizeBulletLine).join("\n");
}

const SLACK_INDENT_PER_LEVEL = 3;
const BULLET_PATTERN = /^( *)(•|◦|▪\uFE0E?) +(.*)$/;

function normalizeBulletLine(line: string): string {
  const expanded = line.replace(/\t/g, "    ");
  const match = expanded.match(BULLET_PATTERN);
  if (!match) return line;

  const [, indent, , content] = match;
  const level = Math.floor(indent.length / SLACK_INDENT_PER_LEVEL);
  return `${"  ".repeat(level)}- ${content}`;
}
