const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sql = fs.readFileSync('supabase-schema-v2.sql', 'utf8');

test('v2 schema installs all record tables, RLS, Realtime and an atomic version check', () => {
  for (const table of ['students', 'scores', 'preparations', 'course_progress', 'custom_fields', 'attachments']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /enable row level security/);
  assert.match(sql, /auth\.uid\(\) = user_id/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /alter publication supabase_realtime add table/);
});

test('v2 schema creates a private per-user Storage bucket policy', () => {
  assert.match(sql, /values \('tutor-files','tutor-files',false\)/);
  for (const operation of ['select', 'insert', 'update', 'delete']) assert.match(sql, new RegExp(`tutor_files_${operation}_own`));
  assert.match(sql, /storage\.foldername\(name\)\)\[1\]=auth\.uid\(\)::text/);
});

test('legacy migration is idempotent and keeps a pre-migration JSON backup', () => {
  assert.match(sql, /tutor_profile_backups/);
  assert.match(sql, /already_migrated/);
  assert.match(sql, /on conflict\(user_id\) do nothing/);
  assert.doesNotMatch(sql, /drop table\s+(?:if exists\s+)?public\.tutor_profiles/i);
});
