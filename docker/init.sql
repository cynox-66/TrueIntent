-- ==============================================================================
-- CaptureLock Local Database Initialization
-- Phase 0: Base database configuration (extensions, settings)
-- Complete domain schema will be defined via Drizzle ORM in Phase 1.
-- ==============================================================================

-- Enable UUID extension if needed by future models
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Ensure timezone is UTC
SET timezone = 'UTC';
