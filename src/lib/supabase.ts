import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface ExplanationRow {
  id?: string;
  label_text: string;
  explanation: string;
  readability: number;
  accuracy: number;
  tone: number;
  composite: number;
  created_at?: string;
}

function makeClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Lazily created so missing env vars don't crash at import time
let _client: SupabaseClient | null | undefined;
function getClient(): SupabaseClient | null {
  if (_client === undefined) _client = makeClient();
  return _client;
}

export async function saveExplanation(row: ExplanationRow): Promise<void> {
  const db = getClient();
  if (!db) return;
  const { error } = await db.from('explanations').insert(row);
  if (error) console.error('[supabase] saveExplanation:', error.message);
}

export async function getAllExplanations(): Promise<ExplanationRow[]> {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db
    .from('explanations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) console.error('[supabase] getAllExplanations:', error.message);
  return data ?? [];
}

export async function updateExplanation(
  id: string,
  updates: Partial<Omit<ExplanationRow, 'id' | 'created_at'>>
): Promise<void> {
  const db = getClient();
  if (!db) return;
  const { error } = await db.from('explanations').update(updates).eq('id', id);
  if (error) console.error('[supabase] updateExplanation:', error.message);
}

export async function getLowScoringExplanations(threshold = 60): Promise<ExplanationRow[]> {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db
    .from('explanations')
    .select('*')
    .lt('composite', threshold)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) console.error('[supabase] getLowScoringExplanations:', error.message);
  return data ?? [];
}
