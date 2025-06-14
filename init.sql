-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create tstzrange type if not exists (usually built-in)
-- This is just to ensure compatibility