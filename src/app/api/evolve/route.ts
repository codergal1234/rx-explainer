import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { getAllExplanations, updateExplanation } from "@/lib/supabase";
import { scoreExplanation, extractFieldsFromLabelText, ExtractedFields } from "@/lib/scoring";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const USE_MOCK =
  !ANTHROPIC_API_KEY ||
  ANTHROPIC_API_KEY === "paste-your-key-here" ||
  ANTHROPIC_API_KEY.startsWith("paste-");

type Example = {
  id: string;
  category: string;
  label_text: string;
  fields: ExtractedFields;
  explanation: string;
};

const EXAMPLES_PATH = path.join(process.cwd(), "src", "data", "examples.json");
const EXAMPLES_ROOT_PATH = path.join(process.cwd(), "data", "examples.json");

function loadExamples(): Example[] {
  try {
    return JSON.parse(fs.readFileSync(EXAMPLES_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeExamples(examples: Example[]): void {
  const json = JSON.stringify(examples, null, 2) + "\n";
  fs.writeFileSync(EXAMPLES_PATH, json, "utf-8");
  try {
    fs.writeFileSync(EXAMPLES_ROOT_PATH, json, "utf-8");
  } catch {
    // root copy is best-effort
  }
}

async function rewriteExplanation(
  anthropic: Anthropic,
  explanation: string,
  labelText: string
): Promise<string> {
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: `You are an expert medical communicator rewriting low-quality prescription explanations.
Your rewrites must score high on the Fernández Huerta readability scale (aim for 65+).
Rules:
- Maximum 15 words per sentence
- Maximum 6th-grade vocabulary
- Latin American Spanish ONLY — never use: vosotros, coger, ordenador, conducir, zumo, vuestro
- 2–3 short paragraphs, under 110 words total
- Include the drug name, dosage, and frequency
- Warm and reassuring tone`,
    messages: [
      {
        role: "user",
        content: `This explanation scored below 60 on our quality scale. Rewrite it to be clearer and simpler.

Original explanation:
${explanation}

Context (original label text):
${labelText || "not available"}

Rewritten explanation:`,
      },
    ],
  });
  return res.content[0].type === "text" ? res.content[0].text.trim() : explanation;
}

export async function POST() {
  const rows = await getAllExplanations();

  if (rows.length === 0) {
    return NextResponse.json({ message: "No explanations in database", rewrote: 0, promoted: 0, pruned: 0 });
  }

  const anthropic = USE_MOCK ? null : new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let examples = loadExamples();
  const promotedIds = new Set(examples.map((e) => e.id));
  const currentComposite = new Map(rows.map((r) => [r.id!, r.composite]));

  let rewrote = 0;
  let promoted = 0;

  for (const row of rows) {
    if (!row.id) continue;

    if (row.composite < 60) {
      let rewritten: string;
      if (USE_MOCK || !anthropic) {
        rewritten = row.explanation + " Consulte a su médico para más información.";
      } else {
        try {
          rewritten = await rewriteExplanation(anthropic, row.explanation, row.label_text ?? "");
          rewrote++;
        } catch (err) {
          console.error("[evolve] rewrite failed:", err);
          continue;
        }
      }

      const fields = extractFieldsFromLabelText(row.label_text ?? "");
      const scores = scoreExplanation(fields, rewritten);
      await updateExplanation(row.id, { explanation: rewritten, ...scores });
      currentComposite.set(row.id, scores.composite);

      if (scores.composite > 80 && !promotedIds.has(row.id)) {
        examples.push({
          id: row.id,
          category: "general",
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
        category: "general",
        label_text: row.label_text ?? "",
        fields,
        explanation: row.explanation,
      });
      promotedIds.add(row.id);
      promoted++;
    }
  }

  // Prune using post-rewrite scores so a rewritten+promoted entry isn't immediately evicted
  const lowScoringIds = new Set(
    rows.filter((r) => r.id && (currentComposite.get(r.id) ?? r.composite) < 50).map((r) => r.id!)
  );
  const before = examples.length;
  examples = examples.filter((e) => !lowScoringIds.has(e.id));
  const pruned = before - examples.length;

  if (promoted > 0 || pruned > 0) {
    writeExamples(examples);
  }

  return NextResponse.json({
    message: "Evolution cycle complete",
    totalRows: rows.length,
    rewrote,
    promoted,
    pruned,
  });
}
