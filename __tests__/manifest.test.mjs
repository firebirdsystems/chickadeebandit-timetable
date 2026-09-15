import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url)));
describe('phase-one manifest',()=>{
 it('declares only implemented import/export phases',()=>{expect(manifest.data_access.reads).toEqual(['family.members','family.preferences']);expect(manifest.exports).toBeUndefined();expect(manifest.ai_access).toBeUndefined();expect(manifest.kiosk).toBeUndefined();});
 it('attributes and governs every table',()=>{for(const name of ['timetables','periods','lessons','exceptions','school_days'])expect(manifest.member_references[name]).toBeDefined();for(const name of ['periods','lessons','exceptions','school_days']){expect(manifest.row_policies[name].parent_owner_actions).toEqual(['update','delete']);expect(manifest.row_policies[name].writer_column).toBe('created_by');}expect(manifest.row_policies.school_days.max_rows).toBeUndefined();});
 it('uses a bounded student-level agenda and selected-day preload',()=>{expect(manifest.agenda.source.query).toMatch(/GROUP BY t.id/);expect(manifest.agenda.source.query).toMatch(/LIMIT 20$/);expect(Object.keys(manifest.preload)).toEqual(['timetables']);});
});
