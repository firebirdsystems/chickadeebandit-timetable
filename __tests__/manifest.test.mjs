import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url)));
describe('phase-one manifest',()=>{
 it('declares only implemented import/export phases',()=>{expect(manifest.data_access.reads).toEqual(['family.members','family.preferences','family.calendar']);expect(manifest.exports).toBeUndefined();expect(manifest.ai_access).toBeUndefined();expect(manifest.kiosk).toBeUndefined();});
 it('attributes and governs every table',()=>{for(const name of ['timetables','periods','lessons','exceptions','school_days'])expect(manifest.member_references[name]).toBeDefined();for(const name of ['periods','lessons','exceptions','school_days']){expect(manifest.row_policies[name].parent_owner_actions).toEqual(['update','delete']);expect(manifest.row_policies[name].writer_column).toBe('created_by');}expect(manifest.row_policies.school_days.max_rows).toBeUndefined();});
 it('keeps import provenance kind plaintext and the digest encrypted',()=>{expect(manifest.db_plaintext_columns).toContain('source_kind');expect(manifest.db_plaintext_columns).not.toContain('source_digest');const sql=readFileSync(new URL('../migrations/002_import_provenance.sql',import.meta.url),'utf8');expect(sql).toMatch(/ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'/);expect(sql).toMatch(/ADD COLUMN source_digest TEXT;/);expect(sql.trim().split('\n').at(-1)).not.toMatch(/^--/);});
 it('uses a bounded student-level agenda and selected-day preload',()=>{expect(manifest.agenda.source.query).toMatch(/GROUP BY t.id/);expect(manifest.agenda.source.query).toMatch(/LIMIT 20$/);expect(Object.keys(manifest.preload)).toEqual(['timetables']);});
});
