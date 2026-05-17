-- Run this in your Supabase SQL editor to create the explanations table

CREATE TABLE IF NOT EXISTS explanations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  label_text TEXT,
  explanation TEXT NOT NULL,
  readability FLOAT NOT NULL DEFAULT 0,
  accuracy FLOAT NOT NULL DEFAULT 0,
  tone FLOAT NOT NULL DEFAULT 0,
  composite FLOAT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying low-scoring explanations efficiently
CREATE INDEX IF NOT EXISTS idx_explanations_composite ON explanations (composite);
CREATE INDEX IF NOT EXISTS idx_explanations_created_at ON explanations (created_at DESC);
