import { NextRequest, NextResponse } from "next/server";
import {
  computeReadability,
  computeAccuracy,
  computeTone,
  computeComposite,
  extractFieldsFromLabelText,
} from "@/lib/scoring";
import { saveExplanation } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  let body: { explanation?: unknown; label_text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { explanation, label_text } = body;

  if (!explanation || typeof explanation !== "string") {
    return NextResponse.json({ error: "explanation is required" }, { status: 400 });
  }
  if (!label_text || typeof label_text !== "string") {
    return NextResponse.json({ error: "label_text is required" }, { status: 400 });
  }

  const fields = extractFieldsFromLabelText(label_text);
  const readability = computeReadability(explanation);
  const accuracy = computeAccuracy(fields, explanation);
  const tone = computeTone(explanation);
  const composite = computeComposite(readability, accuracy, tone);

  await saveExplanation({ label_text, explanation, readability, accuracy, tone, composite });

  return NextResponse.json({ readability, accuracy, tone, composite });
}
