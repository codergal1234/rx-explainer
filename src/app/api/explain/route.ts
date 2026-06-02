import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { scoreExplanation, ExtractedFields } from "@/lib/scoring";
import { saveExplanation } from "@/lib/supabase";
import { inferCategory } from "@/lib/inferCategory";
import { CLAUDE_MODEL } from "@/lib/model";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const USE_MOCK =
  !ANTHROPIC_API_KEY ||
  ANTHROPIC_API_KEY === "paste-your-key-here" ||
  ANTHROPIC_API_KEY.startsWith("paste-");

const MOCK_RESPONSES = [
  {
    fields: {
      drug_name: "Atorvastatina",
      dosage: "40 mg",
      frequency: "una vez al día en la noche",
      warnings: ["Evitar jugo de toronja", "Reportar dolor muscular"],
      prescriber: "Dr. García",
    },
    explanation:
      "Este medicamento, la atorvastatina, baja el colesterol malo en su sangre y protege su corazón.\n\nTómelo cada noche antes de dormir, con o sin comida. Aunque se sienta bien, no lo deje de tomar — el colesterol alto no duele pero sí daña poco a poco.\n\nNo tome jugo de toronja mientras use este medicamento. Si siente dolor o debilidad fuerte en los músculos, llame a su doctor de inmediato.",
  },
  {
    fields: {
      drug_name: "Metformina",
      dosage: "500 mg",
      frequency: "dos veces al día con comida",
      warnings: ["Tomar siempre con comida", "Avisar antes de estudios con tinte"],
      prescriber: "Dr. Santos",
    },
    explanation:
      "Este medicamento, la metformina, ayuda a controlar el azúcar en su sangre. Es para personas con diabetes tipo 2.\n\nTómelo con el desayuno y con la cena para evitar que le revuelva el estómago. No lo tome con el estómago vacío.\n\nSi va a hacerse un estudio con tinte de contraste, como un CT scan, avísele a su doctor que toma este medicamento.",
  },
];

type Example = {
  id: string;
  category: string;
  eval?: boolean;
  label_text: string;
  fields: ExtractedFields;
  explanation: string;
};

// Training pool only. The held-out eval set lives in src/data/eval-holdout.json
// and is intentionally never loaded here — that file exists to keep evaluation
// labels out of the few-shot bank so the learning-curve experiment stays valid.
function loadExamples(): Example[] {
  try {
    const filePath = path.join(process.cwd(), "src", "data", "examples.json");
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}


function pickFewShot(examples: Example[], category: string): Example[] {
  const eligible = examples.filter((e) => !e.eval);
  const matching = eligible.filter((e) => e.category === category);
  const pool = matching.length >= 3 ? matching : [...matching, ...eligible.filter((e) => e.category !== category)];
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

async function callElevenLabs(text: string): Promise<string | null> {
  if (!ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!res.ok) {
      console.error("[elevenlabs] TTS failed:", res.status, await res.text());
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString("base64");
  } catch (err) {
    console.error("[elevenlabs] TTS error:", err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const image = formData.get("image");

  if (!image || !(image instanceof Blob)) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  // ── Mock path ──────────────────────────────────────────────────────────────
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 1800));
    const mock = MOCK_RESPONSES[image.size % MOCK_RESPONSES.length];
    const audio = await callElevenLabs(mock.explanation);
    const scores = scoreExplanation(mock.fields, mock.explanation);
    await saveExplanation({
      label_text: "mock",
      explanation: mock.explanation,
      ...scores,
    });
    return NextResponse.json({ fields: mock.fields, explanation: mock.explanation, audio });
  }

  // ── Real path ──────────────────────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Step 1: OCR / field extraction
  const arrayBuffer = await image.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString("base64");
  const mediaType = (image.type || "image/jpeg") as
    | "image/jpeg"
    | "image/png"
    | "image/gif"
    | "image/webp";

  const ocrResponse = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Image },
          },
          {
            type: "text",
            text: `Extract information from this prescription label. Return ONLY valid JSON with exactly these keys (no markdown, no extra text):
{
  "drug_name": "medication name in Spanish if recognizable, otherwise the brand/generic name as-is",
  "dosage": "dosage amount and unit, e.g. '40 mg' or '10 mg/5 mL'",
  "frequency": "how often to take it in plain Latin-American Spanish, e.g. 'una vez al día', 'cada 8 horas'",
  "warnings": ["array of warning phrases translated to simple Spanish"],
  "prescriber": "prescriber name if visible, else empty string"
}
If any field is not visible, use an empty string or empty array.`,
          },
        ],
      },
    ],
  });

  let fields: ExtractedFields;
  try {
    const raw = ocrResponse.content[0].type === "text" ? ocrResponse.content[0].text : "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    fields = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    fields.warnings = Array.isArray(fields.warnings) ? fields.warnings : [];
    fields.prescriber = fields.prescriber ?? "";
  } catch {
    return NextResponse.json({ error: "Could not parse prescription fields" }, { status: 422 });
  }

  // Step 2: Generate explanation using few-shot examples
  const examples = loadExamples();
  const category = inferCategory(fields.drug_name);
  const fewShot = pickFewShot(examples, category);

  const explainResponse = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: `You are a healthcare communicator specializing in Latin American Spanish patient education.
Write clear, warm explanations for prescription medications at a 6th-grade reading level.
Rules:
- Latin American Spanish ONLY — never use: vosotros, coger, ordenador, conducir, zumo, vuestro
- 2–3 short paragraphs, maximum 120 words total
- Simple words, no medical jargon
- Cover: what the drug does, when/how to take it, 1–2 key warnings
- Be warm and reassuring`,
    messages: [
      {
        role: "user",
        content: `Here are examples of good explanations:\n\n${fewShotBlock(fewShot)}\n\n--- Now write an explanation for this prescription ---\nDrug: ${fields.drug_name} ${fields.dosage}\nFrequency: ${fields.frequency}\nWarnings: ${fields.warnings.join(", ") || "none listed"}\n\nExplanation:`,
      },
    ],
  });

  const explanation =
    explainResponse.content[0].type === "text"
      ? explainResponse.content[0].text.trim()
      : "";

  // Step 3: TTS
  const audio = await callElevenLabs(explanation);

  // Step 4: Score and persist
  const scores = scoreExplanation(fields, explanation);
  const labelText = [fields.drug_name, fields.dosage, fields.frequency, ...fields.warnings, fields.prescriber]
    .filter(Boolean)
    .join(". ");
  await saveExplanation({ label_text: labelText, explanation, ...scores });

  return NextResponse.json({ fields, explanation, audio });
}
