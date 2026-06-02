export function inferCategory(drugName: string): string {
  const n = drugName.toLowerCase();
  if (/estatina|statin|atorva|simva|rosuva|pravastat/.test(n)) return "cardiovascular";
  if (/metformin|glipizid|gliburid|insulin|sitagliptin|glargina|dapagliflozin/.test(n)) return "diabetes";
  if (/lisinopril|enalapril|captopril|ramipril|amlodipino|losartan|valsartan|irbesartan|hidroclorotiazida|olmesartan/.test(n)) return "antihypertensive";
  if (/ibuprofeno|ibuprofen|acetaminofén|paracetamol|naproxen|naproxeno|aspirina|ketorolaco/.test(n)) return "pain";
  if (/amoxicilina|amoxicillin|azitromicina|ciprofloxacino|levofloxacino|cefazolina|doxiciclina/.test(n)) return "antibiotic";
  if (/warfarina|warfarin|heparina|apixabán|rivaroxabán|dabigatrán/.test(n)) return "anticoagulant";
  if (/albuterol|salbutamol|montelukast|fluticasona|budesonida|salmeterol|formoterol/.test(n)) return "respiratory";
  if (/levotiroxina|levothyroxine/.test(n)) return "thyroid";
  if (/sertralina|sertraline|escitalopram|fluoxetina|fluoxetine|paroxetina|venlafaxina|bupropion|amitriptilina/.test(n)) return "antidepressant";
  return "general";
}
