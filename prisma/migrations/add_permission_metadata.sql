-- Migration: Add display_name and description to permissions table
-- Data: 2025-11-18

ALTER TABLE permissions
ADD COLUMN display_name VARCHAR(255) NULL AFTER name,
ADD COLUMN description TEXT NULL AFTER display_name;

-- Update existing permissions to have display_name = name
UPDATE permissions SET display_name = name WHERE display_name IS NULL;
