// scripts/learning-curve.ts
//
// Learning-curve experiment driver. Runs:
//   cycle 0  : score the 5 held-out labels against the current example bank (baseline)
//   cycles 1..N : (a) re-generate explanations for the 19 training labels and save
//                 them to Supabase, (b) run evolve (rewrite<60, promote>80, prune<50),
//                 (c) re-score the same 5 held-out labels.
//
// The held-out 5 in src/data/eval-holdout.json are never used as few-shot, never
// saved to Supabase, never promoted, never rewritten. A post-evolve assertion
// crashes the script (and restores examples.json from snapshot) if any held-out
// ID ever appears in the example bank.
//
// Outputs: results/learning-curve-<run-id>.{csv,svg} and results/examples.snapshot-<run-id>.json
//
// Usage:
//   npx tsx scripts/learning-curve.ts [--cycles N] [--dry-run] [--yes] [--resume <run-id>]

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import readline from "readline";

import { CLAUDE_MODEL } from "../src/lib/model";
import {
  scoreExplanation,
  extractFieldsFromLabelText,
  ExtractedFields,
  ScoreResult,
} from "../src/lib/scoring";
import { inferCategory } from "../src/lib/inferCategory";

// ─── Types ──────────────────────────────────────────────────────────────────

type Example = {
  id: string;
  category: string;
  eval?: boolean;
  label_text: string;
  fields: ExtractedFields;
  explanation: string;
};

type ExplanationRow = {
  id?: string;
  label_text: string;
  explanation: string;
  readability: number;
  accuracy: number;
  tone: number;
  composite: number;
  created_at?: string;
};

type CycleRecord = {
  cycle: number;
  mean_composite: number;
  mean_readability: number;
  mean_accuracy: number;
  mean_tone: number;
};

type RunState = {
  run_id: string;
  N: number;
  last_completed_cycle: number;
  records: CycleRecord[];
};

// ─── Constants & paths ──────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const EXAMPLES_PATH = path.join(ROOT, "src", "data", "examples.json");
const EXAMPLES_ROOT_PATH = path.join(ROOT, "data", "examples.json");
const HOLDOUT_PATH = path.join(ROOT, "src", "data", "eval-holdout.json");
const RESULTS_DIR = path.join(ROOT, "results");
const ENV_PATH = path.join(ROOT, ".env");

const SYSTEM_PROMPT_EXPLAIN = `You are a healthcare communicator specializing in Latin American Spanish patient education.
Write clear, warm explanations for prescription medications at a 6th-grade reading level.
Rules:
- Latin American Spanish ONLY — never use: vosotros, coger, ordenador, conducir, zumo, vuestro
- 2–3 short paragraphs, maximum 120 words total
- Simple words, no medical jargon
- Cover: what the drug does, when/how to take it, 1–2 key warnings
- Be warm and reassuring`;

const SYSTEM_PROMPT_REWRITE = `You are an expert medical communicator rewriting low-quality prescription explanations.
Your rewrites must score high on the Fernández Huerta readability scale (aim for 65+).
Rules:
- Maximum 15 words per sentence
- Maximum 6th-grade vocabulary
- Latin American Spanish ONLY — never use: vosotros, coger, ordenador, conducir, zumo, vuestro
- 2–3 short paragraphs, under 110 words total
- Include the drug name, dosage, and frequency
- Warm and reassuring tone`;

// ─── .env loader (no dep) ───────────────────────────────────────────────────

function loadDotenv(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Override only if the existing value is empty — a shell that exports
    // `ANTHROPIC_API_KEY=` (empty) shouldn't shadow the real value in .env.
    const existing = process.env[key];
    if (existing === undefined || existing === "") process.env[key] = value;
  }
}

// ─── CLI parsing ────────────────────────────────────────────────────────────

type CliArgs = {
  cycles: number;
  dryRun: boolean;
  yes: boolean;
  resume: string | null;
};

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let cycles = 5;
  let dryRun = false;
  let yes = false;
  let resume: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cycles") cycles = parseInt(argv[++i], 10);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--resume") resume = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/learning-curve.ts [--cycles N] [--dry-run] [--yes] [--resume <run-id>]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(cycles) || cycles < 1) {
    console.error("--cycles must be a positive integer");
    process.exit(2);
  }
  return { cycles, dryRun, yes, resume };
}

// ─── Retry helper ───────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 3,
  baseMs = 1000
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      // Don't retry hard auth/validation errors
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (i < attempts - 1) {
        const delay = baseMs * Math.pow(2, i);
        console.warn(
          `  ↻ ${label} failed (attempt ${i + 1}/${attempts}): ${(err as Error).message ?? err}. Retrying in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Supabase wrapper (no fail-on-unavailable) ─────────────────────────────

let supabaseAvailable = false;
let supabaseModule: typeof import("@supabase/supabase-js") | null = null;
type Sb = ReturnType<NonNullable<typeof supabaseModule>["createClient"]>;
let supabaseClient: Sb | null = null;

async function probeSupabase(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn(
      "  ⚠ Supabase: SUPABASE_URL/SUPABASE_ANON_KEY unset — continuing with local scoring only"
    );
    return;
  }
  try {
    supabaseModule = await import("@supabase/supabase-js");
    supabaseClient = supabaseModule.createClient(url, key);
    const { error } = await supabaseClient
      .from("explanations")
      .select("id", { count: "exact", head: true });
    if (error) {
      console.warn(
        `  ⚠ Supabase: table probe failed (${error.message}) — continuing locally`
      );
      supabaseClient = null;
      return;
    }
    supabaseAvailable = true;
    console.log("  ✓ Supabase reachable");
  } catch (err) {
    console.warn(
      `  ⚠ Supabase: client init failed (${(err as Error).message}) — continuing locally`
    );
    supabaseClient = null;
  }
}

async function sbInsert(row: ExplanationRow): Promise<{ id: string } | null> {
  if (!supabaseAvailable || !supabaseClient) return null;
  try {
    return await withRetry(async () => {
      const { data, error } = await supabaseClient!
        .from("explanations")
        .insert(row)
        .select("id")
        .single();
      if (error) throw error;
      return data as { id: string };
    }, "supabase.insert");
  } catch (err) {
    console.warn(`  ⚠ supabase.insert gave up: ${(err as Error).message}`);
    return null;
  }
}

async function sbSelectAll(): Promise<ExplanationRow[]> {
  if (!supabaseAvailable || !supabaseClient) return [];
  try {
    return await withRetry(async () => {
      const { data, error } = await supabaseClient!
        .from("explanations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ExplanationRow[];
    }, "supabase.select");
  } catch (err) {
    console.warn(`  ⚠ supabase.select gave up: ${(err as Error).message}`);
    return [];
  }
}

async function sbUpdate(
  id: string,
  updates: Partial<Omit<ExplanationRow, "id" | "created_at">>
): Promise<void> {
  if (!supabaseAvailable || !supabaseClient) return;
  try {
    await withRetry(async () => {
      const { error } = await supabaseClient!
        .from("explanations")
        .update(updates)
        .eq("id", id);
      if (error) throw error;
    }, "supabase.update");
  } catch (err) {
    console.warn(`  ⚠ supabase.update gave up: ${(err as Error).message}`);
  }
}

// ─── Example bank IO ───────────────────────────────────────────────────────

function loadExamples(): Example[] {
  return JSON.parse(fs.readFileSync(EXAMPLES_PATH, "utf-8"));
}

// IDs that must always carry eval:true — re-asserted on every write so the
// flag can't be silently dropped by an evolve cycle that predates it.
const EVAL_IDS = new Set(["ex15", "ex16", "ex17", "ex18", "ex19"]);

function writeExamples(examples: Example[]): void {
  const guarded = examples.map((e) =>
    EVAL_IDS.has(e.id) ? { ...e, eval: true } : e
  );
  const json = JSON.stringify(guarded, null, 2) + "\n";
  fs.writeFileSync(EXAMPLES_PATH, json, "utf-8");
  try {
    fs.writeFileSync(EXAMPLES_ROOT_PATH, json, "utf-8");
  } catch {
    // mirror is best-effort
  }
}

function loadHoldout(): Example[] {
  return JSON.parse(fs.readFileSync(HOLDOUT_PATH, "utf-8"));
}

// ─── Few-shot prompt assembly (mirrors /api/explain) ───────────────────────

function pickFewShot(examples: Example[], category: string): Example[] {
  const eligible = examples.filter((e) => !e.eval);
  const matching = eligible.filter((e) => e.category === category);
  const pool =
    matching.length >= 3
      ? matching
      : [...matching, ...eligible.filter((e) => e.category !== category)];
  return pool.slice(0, 3);
}

function fewShotBlock(examples: Example[]): string {
  return examples
    .map(
      (e, i) =>
        `--- Example ${i + 1} ---\nDrug: ${e.fields.drug_name} ${e.fields.dosage}\nFrequency: ${e.fields.frequency}\nExplanation:\n${e.explanation}`
    )
    .join("\n\n");
}

async function generateExplanation(
  anthropic: Anthropic,
  fields: ExtractedFields,
  examples: Example[]
): Promise<string> {
  const category = inferCategory(fields.drug_name);
  const fewShot = pickFewShot(examples, category);
  const res = await withRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT_EXPLAIN,
        messages: [
          {
            role: "user",
            content: `Here are examples of good explanations:\n\n${fewShotBlock(fewShot)}\n\n--- Now write an explanation for this prescription ---\nDrug: ${fields.drug_name} ${fields.dosage}\nFrequency: ${fields.frequency}\nWarnings: ${fields.warnings.join(", ") || "none listed"}\n\nExplanation:`,
          },
        ],
      }),
    "anthropic.messages.create (explain)"
  );
  return res.content[0].type === "text" ? res.content[0].text.trim() : "";
}

async function rewriteExplanation(
  anthropic: Anthropic,
  explanation: string,
  labelText: string
): Promise<string> {
  const res = await withRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT_REWRITE,
        messages: [
          {
            role: "user",
            content: `This explanation scored below 60 on our quality scale. Rewrite it to be clearer and simpler.\n\nOriginal explanation:\n${explanation}\n\nContext (original label text):\n${labelText || "not available"}\n\nRewritten explanation:`,
          },
        ],
      }),
    "anthropic.messages.create (rewrite)"
  );
  return res.content[0].type === "text" ? res.content[0].text.trim() : explanation;
}

// ─── Evolve logic (replicated from /api/evolve, with held-out leak guard) ──

async function evolveOnce(
  anthropic: Anthropic,
  holdoutIds: Set<string>
): Promise<{ rewrote: number; promoted: number; pruned: number; totalRows: number }> {
  const rows = await sbSelectAll();
  if (rows.length === 0) {
    return { rewrote: 0, promoted: 0, pruned: 0, totalRows: 0 };
  }

  let examples = loadExamples();
  const promotedIds = new Set(examples.map((e) => e.id));
  const currentComposite = new Map<string, number>(
    rows.filter((r) => r.id).map((r) => [r.id!, r.composite])
  );

  let rewrote = 0;
  let promoted = 0;

  for (const row of rows) {
    if (!row.id) continue;
    if (holdoutIds.has(row.id)) continue; // belt-and-braces: never act on held-out IDs

    if (row.composite < 60) {
      let rewritten: string;
      try {
        rewritten = await rewriteExplanation(
          anthropic,
          row.explanation,
          row.label_text ?? ""
        );
        rewrote++;
      } catch (err) {
        console.warn(`  ⚠ rewrite gave up on ${row.id}: ${(err as Error).message}`);
        continue;
      }
      const fields = extractFieldsFromLabelText(row.label_text ?? "");
      const scores = scoreExplanation(fields, rewritten);
      await sbUpdate(row.id, { explanation: rewritten, ...scores });
      currentComposite.set(row.id, scores.composite);
      if (scores.composite > 80 && !promotedIds.has(row.id)) {
        examples.push({
          id: row.id,
          category: inferCategory(fields.drug_name),
          label_text: row.label_text ?? "",
          fields,
          explanation: rewritten,
        });
        promotedIds.add(row.id);
        promoted++;
      }
    } else if (row.composite > 80 && !promotedIds.has(row.id)) {
      const fields = extractFieldsFromLabelText(row.label_text ?? "");
      examples.push({
        id: row.id,
        category: inferCategory(fields.drug_name),
        label_text: row.label_text ?? "",
        fields,
        explanation: row.explanation,
      });
      promotedIds.add(row.id);
      promoted++;
    }
  }

  const lowScoringIds = new Set(
    rows
      .filter((r) => r.id && (currentComposite.get(r.id) ?? r.composite) < 50)
      .map((r) => r.id!)
  );
  const before = examples.length;
  examples = examples.filter((e) => !lowScoringIds.has(e.id));
  const pruned = before - examples.length;

  if (promoted > 0 || pruned > 0) writeExamples(examples);

  return { rewrote, promoted, pruned, totalRows: rows.length };
}

// ─── Cost estimate + confirmation ──────────────────────────────────────────

function estimateCost(N: number, trainingPoolSize: number): number {
  // Rough estimate at OpenRouter Sonnet 4.6 list pricing (~$3/M in, $15/M out).
  // Per call (explain or rewrite): ~1.5k input, ~0.4k output ≈ $0.0105.
  const PER_CALL = 0.0105;
  const REWRITE_GUESS = 3; // rewrites per cycle
  const cycle0 = 5 * PER_CALL;
  const perCycle = (5 + trainingPoolSize + REWRITE_GUESS) * PER_CALL;
  return cycle0 + N * perCycle;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase().startsWith("y"));
    });
  });
}

// ─── CSV (incremental) ─────────────────────────────────────────────────────

function csvPath(runId: string): string {
  return path.join(RESULTS_DIR, `learning-curve-${runId}.csv`);
}
function statePath(runId: string): string {
  return path.join(RESULTS_DIR, `.learning-curve-${runId}.state.json`);
}
function snapshotPath(runId: string): string {
  return path.join(RESULTS_DIR, `examples.snapshot-${runId}.json`);
}
function svgPath(runId: string): string {
  return path.join(RESULTS_DIR, `learning-curve-${runId}.svg`);
}

function writeCsvHeader(filePath: string, runId: string, N: number, holdoutN: number): void {
  const header =
    `# run_id=${runId}  N=${N}  holdout_n=${holdoutN}  model=${CLAUDE_MODEL}\n` +
    `cycle,mean_composite,mean_readability,mean_accuracy,mean_tone\n`;
  fs.writeFileSync(filePath, header, "utf-8");
}

function appendCsvRow(filePath: string, rec: CycleRecord): void {
  const line = `${rec.cycle},${rec.mean_composite.toFixed(2)},${rec.mean_readability.toFixed(
    2
  )},${rec.mean_accuracy.toFixed(2)},${rec.mean_tone.toFixed(2)}\n`;
  fs.appendFileSync(filePath, line, "utf-8");
}

function writeState(filePath: string, state: RunState): void {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

function readState(filePath: string): RunState | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as RunState;
}

// ─── Held-out evaluation pass ──────────────────────────────────────────────

async function scoreHoldout(
  anthropic: Anthropic,
  holdout: Example[],
  examples: Example[]
): Promise<CycleRecord> {
  const subs: ScoreResult[] = [];
  for (const item of holdout) {
    const explanation = await generateExplanation(anthropic, item.fields, examples);
    if (!explanation) {
      console.warn(`  ⚠ empty explanation for ${item.id} — skipping`);
      continue;
    }
    const scored = scoreExplanation(item.fields, explanation);
    subs.push(scored);
  }
  const n = subs.length || 1;
  const mean = (k: keyof ScoreResult) => subs.reduce((s, x) => s + x[k], 0) / n;
  return {
    cycle: 0, // overwritten by caller
    mean_composite: mean("composite"),
    mean_readability: mean("readability"),
    mean_accuracy: mean("accuracy"),
    mean_tone: mean("tone"),
  };
}

// ─── Training pass (regenerate + persist; never touches held-out) ──────────

async function trainingPass(
  anthropic: Anthropic,
  examples: Example[],
  holdoutIds: Set<string>
): Promise<void> {
  for (const ex of examples) {
    if (holdoutIds.has(ex.id)) continue; // belt-and-braces
    let explanation: string;
    try {
      explanation = await generateExplanation(anthropic, ex.fields, examples);
    } catch (err) {
      console.warn(`  ⚠ training gen failed for ${ex.id}: ${(err as Error).message}`);
      continue;
    }
    if (!explanation) continue;
    const scores = scoreExplanation(ex.fields, explanation);
    const labelText = [
      ex.fields.drug_name,
      ex.fields.dosage,
      ex.fields.frequency,
      ...ex.fields.warnings,
      ex.fields.prescriber,
    ]
      .filter(Boolean)
      .join(". ");
    await sbInsert({ label_text: labelText, explanation, ...scores });
  }
}

// ─── SVG renderer (no deps) ────────────────────────────────────────────────

function renderSvg(records: CycleRecord[], N: number, holdoutN: number): string {
  const W = 900,
    H = 540;
  const M = { top: 60, right: 220, bottom: 60, left: 70 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const xMin = 0;
  const xMax = Math.max(N, records.length - 1, 1);
  const yMin = 0;
  const yMax = 100;

  const xs = (c: number) => M.left + (innerW * (c - xMin)) / (xMax - xMin || 1);
  const ys = (v: number) => M.top + innerH - (innerH * (v - yMin)) / (yMax - yMin);

  const series: { key: keyof CycleRecord; label: string; color: string; width: number }[] = [
    { key: "mean_composite", label: "Composite", color: "#1f77b4", width: 3 },
    { key: "mean_readability", label: "Readability (Fernández Huerta)", color: "#ff7f0e", width: 1.5 },
    { key: "mean_accuracy", label: "Accuracy", color: "#2ca02c", width: 1.5 },
    { key: "mean_tone", label: "Tone", color: "#d62728", width: 1.5 },
  ];

  const lines = series.map((s) => {
    const pts = records
      .map((r) => `${xs(r.cycle)},${ys(r[s.key] as number)}`)
      .join(" ");
    return `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width}" points="${pts}" />`;
  });

  const dots = series
    .flatMap((s) =>
      records.map(
        (r) =>
          `<circle cx="${xs(r.cycle)}" cy="${ys(r[s.key] as number)}" r="${
            s.key === "mean_composite" ? 4 : 2.5
          }" fill="${s.color}" />`
      )
    )
    .join("");

  // y gridlines at 0, 20, 40, 60, 80, 100
  const yGrid = [0, 20, 40, 60, 80, 100]
    .map(
      (v) =>
        `<line x1="${M.left}" y1="${ys(v)}" x2="${M.left + innerW}" y2="${ys(
          v
        )}" stroke="#e5e5e5" stroke-width="1" />` +
        `<text x="${M.left - 8}" y="${ys(v) + 4}" font-family="system-ui, sans-serif" font-size="11" fill="#666" text-anchor="end">${v}</text>`
    )
    .join("");

  // x gridlines per integer cycle
  const xTicks = [];
  for (let c = 0; c <= xMax; c++) {
    xTicks.push(
      `<line x1="${xs(c)}" y1="${M.top}" x2="${xs(c)}" y2="${M.top + innerH}" stroke="#f0f0f0" stroke-width="1" />` +
        `<text x="${xs(c)}" y="${M.top + innerH + 18}" font-family="system-ui, sans-serif" font-size="11" fill="#666" text-anchor="middle">${c}</text>`
    );
  }

  const legend = series
    .map(
      (s, i) =>
        `<g transform="translate(${M.left + innerW + 20}, ${M.top + 24 + i * 26})">` +
        `<line x1="0" y1="6" x2="22" y2="6" stroke="${s.color}" stroke-width="${s.width}" />` +
        `<text x="30" y="10" font-family="system-ui, sans-serif" font-size="12" fill="#222">${s.label}</text>` +
        `</g>`
    )
    .join("");

  const title = `Learning curve — held-out n=${holdoutN}, cycles=${N}, model=${CLAUDE_MODEL}`;
  const xLabel = `<text x="${M.left + innerW / 2}" y="${H - 18}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#222">Evolution cycle</text>`;
  const yLabel = `<text transform="translate(20, ${M.top + innerH / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#222">Mean score (0–100)</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="white" />
  <text x="${W / 2}" y="30" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#111" font-weight="600">${title}</text>
  ${yGrid}
  ${xTicks.join("")}
  <rect x="${M.left}" y="${M.top}" width="${innerW}" height="${innerH}" fill="none" stroke="#999" stroke-width="1" />
  ${lines.join("")}
  ${dots}
  ${legend}
  ${xLabel}
  ${yLabel}
</svg>
`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDotenv();
  const args = parseArgs();

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const holdout = loadHoldout();
  const examples = loadExamples();
  const holdoutIds = new Set(holdout.map((h) => h.id));

  // Sanity: no held-out IDs already in examples.json
  const preLeak = examples.filter((e) => holdoutIds.has(e.id));
  if (preLeak.length > 0) {
    console.error(
      `FATAL: held-out IDs already present in examples.json: ${preLeak.map((e) => e.id).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`Learning-curve experiment`);
  console.log(`  training pool : ${examples.length} examples`);
  console.log(`  held-out      : ${holdout.length} labels (${holdout.map((h) => h.id).join(", ")})`);
  console.log(`  cycles        : ${args.cycles}`);
  console.log(`  model         : ${CLAUDE_MODEL}`);
  console.log(`  base URL      : ${process.env.ANTHROPIC_BASE_URL ?? "(SDK default)"}`);

  // Env / mock-mode check
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "paste-your-key-here" || key.startsWith("paste-")) {
    console.error(
      "FATAL: ANTHROPIC_API_KEY not set (or still a paste-placeholder). The route's mock mode would activate; experiment results would be bogus. Aborting."
    );
    process.exit(1);
  }

  console.log("\nProbing Supabase...");
  await probeSupabase();

  const cost = estimateCost(args.cycles, examples.length);
  console.log(`\nCost estimate: ≈ $${cost.toFixed(2)} for ${args.cycles} cycles`);

  if (args.dryRun) {
    console.log("\n[--dry-run] exiting before any paid API calls.");
    return;
  }

  if (!args.yes) {
    const ok = await confirm(`Continue? [y/N] `);
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // Resume or fresh
  let runId: string;
  let state: RunState;
  if (args.resume) {
    runId = args.resume;
    const prior = readState(statePath(runId));
    if (!prior) {
      console.error(`FATAL: no state file for run-id ${runId}`);
      process.exit(1);
    }
    state = prior;
    console.log(`\nResuming run ${runId} from cycle ${state.last_completed_cycle + 1}`);
  } else {
    runId = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    state = { run_id: runId, N: args.cycles, last_completed_cycle: -1, records: [] };
    // Snapshot examples.json
    fs.copyFileSync(EXAMPLES_PATH, snapshotPath(runId));
    writeCsvHeader(csvPath(runId), runId, args.cycles, holdout.length);
    writeState(statePath(runId), state);
    console.log(`\nRun id: ${runId}`);
    console.log(`Snapshot: ${snapshotPath(runId)}`);
    console.log(`CSV:      ${csvPath(runId)}`);
  }

  const anthropic = new Anthropic({ apiKey: key });

  // Helper to run held-out scoring + persist + log progress
  async function runHoldoutCycle(cycleIdx: number): Promise<void> {
    const currentExamples = loadExamples();
    const rec = await scoreHoldout(anthropic, holdout, currentExamples);
    rec.cycle = cycleIdx;
    appendCsvRow(csvPath(runId), rec);
    state.records.push(rec);
    state.last_completed_cycle = cycleIdx;
    writeState(statePath(runId), state);
    console.log(
      `Cycle ${cycleIdx}/${args.cycles} complete — mean composite: ${rec.mean_composite.toFixed(2)}`
    );
    console.log(
      `  readability=${rec.mean_readability.toFixed(2)}  accuracy=${rec.mean_accuracy.toFixed(2)}  tone=${rec.mean_tone.toFixed(2)}`
    );
  }

  // Cycle 0 (baseline) if not already done
  if (state.last_completed_cycle < 0) {
    console.log("\n=== Cycle 0 (baseline) ===");
    await runHoldoutCycle(0);
  }

  // Cycles 1..N
  for (let c = Math.max(1, state.last_completed_cycle + 1); c <= args.cycles; c++) {
    console.log(`\n=== Cycle ${c}/${args.cycles} ===`);

    console.log(`  training pass on ${examples.length} labels...`);
    const currentExamples = loadExamples();
    await trainingPass(anthropic, currentExamples, holdoutIds);

    console.log(`  evolve (rewrite<60, promote>80, prune<50)...`);
    const evRes = await evolveOnce(anthropic, holdoutIds);
    console.log(
      `    rewrote=${evRes.rewrote} promoted=${evRes.promoted} pruned=${evRes.pruned} total_db_rows=${evRes.totalRows}`
    );

    // Post-evolve leak assertion
    const post = loadExamples();
    const leaked = post.filter((e) => holdoutIds.has(e.id));
    if (leaked.length > 0) {
      console.error(
        `\nFATAL: held-out IDs leaked into examples.json after evolve: ${leaked
          .map((e) => e.id)
          .join(", ")}`
      );
      console.error(`Restoring from snapshot ${snapshotPath(runId)} and aborting.`);
      fs.copyFileSync(snapshotPath(runId), EXAMPLES_PATH);
      try {
        fs.copyFileSync(snapshotPath(runId), EXAMPLES_ROOT_PATH);
      } catch {}
      process.exit(1);
    }

    console.log(`  re-evaluating held-out ${holdout.length} labels...`);
    await runHoldoutCycle(c);
  }

  // Render SVG
  const svg = renderSvg(state.records, args.cycles, holdout.length);
  fs.writeFileSync(svgPath(runId), svg, "utf-8");

  // Final summary
  const first = state.records[0];
  const last = state.records[state.records.length - 1];
  console.log(`\n─── Final summary ─────────────────────────────`);
  console.log(`  cycle 0 mean composite: ${first.mean_composite.toFixed(2)}`);
  console.log(`  cycle ${last.cycle} mean composite: ${last.mean_composite.toFixed(2)}`);
  console.log(
    `  delta: ${(last.mean_composite - first.mean_composite).toFixed(2)} points`
  );
  console.log(``);
  console.log(`  CSV: ${csvPath(runId)}`);
  console.log(`  SVG: ${svgPath(runId)}`);
  console.log(`  Snapshot: ${snapshotPath(runId)}`);
  console.log(``);
  console.log(
    `  Caveat: n=${holdout.length} held-out → directional only. SE on the mean is roughly ±5–10 points/cycle; read the curve's shape, not point-to-point deltas. ev5 Rosuvastatin shares its drug class with ex15/ex18 (statins) in training; ev1 Amoxicillin's original label_text matched the removed ex5 — see plan for the contamination fix.`
  );
}

main().catch((err) => {
  console.error("\nUNHANDLED ERROR:", err);
  process.exit(1);
});
