export interface ExtractedFields {
  drug_name: string;
  dosage: string;
  frequency: string;
  warnings: string[];
  prescriber: string;
}

export interface ScoreResult {
  readability: number;
  accuracy: number;
  tone: number;
  composite: number;
}

const CASTILIAN_WORDS = ['vosotros', 'coger', 'ordenador', 'conducir', 'zumo', 'vuestro'];

const FIELD_SKIP_WORDS = new Set([
  "the","for","use","take","with","without","food","water","oral","tablet","tableta",
  "capsule","capsula","solution","solución","cada","con","sin","una","uno","las","los",
  "del","por","que","este","esta","son","sus","vez","día","dia","tomar","tome",
]);

export function extractFieldsFromLabelText(labelText: string): ExtractedFields {
  const dosageMatch = labelText.match(/\b\d+(?:\.\d+)?\s*(?:mg\/mL|mcg\/mL|mg|mL|mcg|g|%)\b/i);
  const dosage = dosageMatch ? dosageMatch[0].trim() : "";

  const words = labelText.match(/\b[A-Za-záéíóúüñÁÉÍÓÚÜÑ]{4,}\b/g) ?? [];
  const drug_name = words.find((w) => !FIELD_SKIP_WORDS.has(w.toLowerCase())) ?? "";

  const freqMatch = labelText.match(
    /\b(?:once|twice|three times|every \d+ hours?|cada \d+ horas?|al día|una vez|dos veces|daily|weekly)\b/i
  );
  const frequency = freqMatch ? freqMatch[0].trim() : "";

  return { drug_name, dosage, frequency, warnings: [], prescriber: "" };
}

function countSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  if (!clean) return 1;
  const vowels = (clean.match(/[aeiouáéíóú]/g) ?? []).length;
  if (vowels === 0) return 1;
  // Subtract diphthongs: weak(i/u)+any vowel, or strong(a/e/o)+weak(i/u)
  const diphthongs = (clean.match(/[iu][aeiouáéíóú]|[aeoáéó][iu]/g) ?? []).length;
  return Math.max(1, vowels - diphthongs);
}

export function computeReadability(text: string): number {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.match(/\b[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+\b/g) ?? [];
  if (words.length === 0 || sentences.length === 0) return 50;
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgSyllablesPerWord = totalSyllables / words.length;
  const avgWordsPerSentence = words.length / sentences.length;
  // Fernández Huerta formula
  const score = 206.84 - 60.1 * avgSyllablesPerWord - 1.02 * avgWordsPerSentence;
  return Math.min(100, Math.max(0, Math.round(score * 10) / 10));
}

export function computeAccuracy(fields: ExtractedFields, explanation: string): number {
  const lower = explanation.toLowerCase();
  const checks = [fields.drug_name, fields.dosage, fields.frequency].filter(Boolean);
  if (checks.length === 0) return 0;
  const hits = checks.filter(f => lower.includes(f.toLowerCase())).length;
  return Math.round((hits / checks.length) * 100);
}

export function computeTone(explanation: string): number {
  const lower = explanation.toLowerCase();
  const found = CASTILIAN_WORDS.filter(w => new RegExp(`\\b${w}\\b`).test(lower)).length;
  return Math.max(0, 100 - found * 20);
}

export function computeComposite(readability: number, accuracy: number, tone: number): number {
  return Math.round(readability * 0.4 + accuracy * 0.4 + tone * 0.2);
}

export function scoreExplanation(fields: ExtractedFields, explanation: string): ScoreResult {
  const readability = computeReadability(explanation);
  const accuracy = computeAccuracy(fields, explanation);
  const tone = computeTone(explanation);
  const composite = computeComposite(readability, accuracy, tone);
  return { readability, accuracy, tone, composite };
}
