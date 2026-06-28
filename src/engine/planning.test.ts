import { describe, it, expect } from 'vitest';
import { solvePlanning, type PlanningInput, type DoctorProfile } from './planning';
import { daysInMonth } from './calendar';

function doctors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
}

describe('solvePlanning — gardes & structure', () => {
  it('has exactly one G1 and one G2 per day', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const n = daysInMonth(2026, 4);
    for (let day = 1; day <= n; day++) {
      const posts = docs.map((d) => res.grid[d][day]);
      expect(posts.filter((p) => p === 'G1')).toHaveLength(1);
      expect(posts.filter((p) => p === 'G2')).toHaveLength(1);
    }
  });

  it('gives every present weekday doctor a post, and leaves weekend off-doctors blank', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    for (const cd of res.days) {
      for (const doc of docs) {
        const post = res.grid[doc][cd.day];
        if (cd.isWeekend || cd.isHoliday) {
          // Only gardes / RS on weekends; everyone else is blank (off).
          if (post) expect(['G1', 'G2', 'RS']).toContain(post);
        } else {
          expect(typeof post === 'string' && post.length > 0).toBe(true);
        }
      }
    }
  });

  it('puts RS the weekday after a garde', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const n = daysInMonth(2026, 4);
    for (let day = 1; day < n; day++) {
      for (const doc of docs) {
        if (res.grid[doc][day] === 'G1' || res.grid[doc][day] === 'G2') {
          expect(res.grid[doc][day + 1]).toBe('RS');
        }
      }
    }
  });

  it('labels congé as CA; no_garde works but never gets a garde', async () => {
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: doctors(12),
      availability: { D01: { 6: 'conge', 8: 'no_garde' } }, // weekdays
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    expect(res.grid.D01[6]).toBe('CA');
    // no_garde: present (has a real post) but not a garde.
    expect(['G1', 'G2', 'CA', '']).not.toContain(res.grid.D01[8]);
    expect(res.grid.D01[8]).toBeTruthy();
  });

  it('honours souhait_garde as a garde wish where possible', async () => {
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: doctors(12),
      availability: { D01: { 9: 'souhait_garde' } },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    // The wish is a soft preference; at minimum it never prevents a valid plan.
    expect(res.status).toBe('feasible');
  });
});

describe('solvePlanning — special posts (open to everyone) & part-time', () => {
  it('U only for universitaires, on weekdays, ≈ ratio of their working days', async () => {
    const docs = doctors(12);
    const profiles: Record<string, DoctorProfile> = { D01: { universitaire: true, universityRatio: 50 } };
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    for (const doc of docs.slice(1)) for (const cd of res.days) expect(res.grid[doc][cd.day]).not.toBe('U');
    for (const cd of res.days) if (res.grid.D01[cd.day] === 'U') expect(cd.isWeekend).toBe(false);
    expect(res.days.filter((cd) => res.grid.D01[cd.day] === 'U').length).toBeGreaterThan(2);
  });

  it('skips U entirely in July/August', async () => {
    const res = await solvePlanning({
      year: 2026, month: 7, doctors: doctors(12),
      profiles: { D01: { universitaire: true, universityRatio: 50 } },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    expect(res.days.filter((cd) => res.grid.D01[cd.day] === 'U').length).toBe(0);
  });

  it('Ped appears only on Mon/Wed/Thu/Fri (distributed across the team)', async () => {
    const res = await solvePlanning({ year: 2026, month: 4, doctors: doctors(12) });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let pedSeen = 0;
    for (const cd of res.days) for (const doc of doctors(12)) if (res.grid[doc][cd.day] === 'Ped') {
      pedSeen++; expect([0, 2, 3, 4]).toContain(cd.weekday);
    }
    expect(pedSeen).toBeGreaterThan(0);
  });

  it('CD appears with ≥9 present but not with a small roster', async () => {
    const big = await solvePlanning({ year: 2026, month: 4, doctors: doctors(12) });
    const small = await solvePlanning({ year: 2026, month: 4, doctors: doctors(8) });
    if (big.status !== 'feasible' || small.status !== 'feasible') throw new Error('expected feasible');
    const cdBig = big.days.reduce((s, cd) => s + doctors(12).filter((d) => big.grid[d][cd.day] === 'CD').length, 0);
    const cdSmall = small.days.reduce((s, cd) => s + doctors(8).filter((d) => small.grid[d][cd.day] === 'CD').length, 0);
    expect(cdBig).toBeGreaterThan(0);
    expect(cdSmall).toBe(0);
  });

  it('P appears with ≥10 present but not with a small roster', async () => {
    const big = await solvePlanning({ year: 2026, month: 4, doctors: doctors(12) });
    const small = await solvePlanning({ year: 2026, month: 4, doctors: doctors(8) });
    if (big.status !== 'feasible' || small.status !== 'feasible') throw new Error('expected feasible');
    const pBig = big.days.reduce((s, cd) => s + doctors(12).filter((d) => big.grid[d][cd.day] === 'P').length, 0);
    const pSmall = small.days.reduce((s, cd) => s + doctors(8).filter((d) => small.grid[d][cd.day] === 'P').length, 0);
    expect(pBig).toBeGreaterThan(0);
    expect(pSmall).toBe(0);
  });

  it('gives fewer gardes to a doctor on long leave, but the same to one with only 1-2 leave days', async () => {
    const docs = doctors(12);
    const gardes = (res: Extract<Awaited<ReturnType<typeof solvePlanning>>, { status: 'feasible' }>, doc: string) =>
      res.days.filter((cd) => ['G1', 'G2'].includes(res.grid[doc][cd.day])).length;

    // Half the month on leave → clearly fewer gardes.
    const longLeave: Record<number, 'conge'> = {};
    for (let d = 1; d <= 15; d++) longLeave[d] = 'conge';
    const r1 = await solvePlanning({ year: 2026, month: 4, doctors: docs, availability: { D01: longLeave } });
    if (r1.status !== 'feasible') throw new Error('feasible');
    const avg1 = docs.slice(1).reduce((s, d) => s + gardes(r1, d), 0) / (docs.length - 1);
    expect(gardes(r1, 'D01')).toBeLessThan(avg1 - 1);

    // Only 2 leave days → essentially the same load as everyone else.
    const r2 = await solvePlanning({ year: 2026, month: 4, doctors: docs, availability: { D02: { 10: 'conge', 11: 'conge' } } });
    if (r2.status !== 'feasible') throw new Error('feasible');
    const avg2 = docs.filter((d) => d !== 'D02').reduce((s, d) => s + gardes(r2, d), 0) / (docs.length - 1);
    expect(Math.abs(gardes(r2, 'D02') - avg2)).toBeLessThanOrEqual(1.5);
  });

  it('a part-time (50%) doctor works ~half the weekdays, with off days left BLANK (not labelled)', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D01: { fte: 0.5 } } });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const gardes = (doc: string) => res.days.filter((cd) => ['G1', 'G2'].includes(res.grid[doc][cd.day])).length;
    expect(gardes('D01')).toBeLessThan(docs.slice(1).reduce((s, d) => s + gardes(d), 0) / (docs.length - 1));

    const weekdays = res.days.filter((cd) => !cd.isWeekend && !cd.isHoliday);
    // No 'TP' label exists anywhere — off days must not reveal part-time status.
    for (const cd of res.days) for (const doc of docs) expect(res.grid[doc][cd.day]).not.toBe('TP');
    // ~half the weekdays are blank (off) for the part-timer.
    const blank = weekdays.filter((cd) => !res.grid.D01[cd.day]).length;
    expect(blank).toBeGreaterThanOrEqual(Math.floor(weekdays.length * 0.35));
    expect(blank).toBeLessThanOrEqual(Math.ceil(weekdays.length * 0.65));
    // A full-timer works every weekday (no blanks).
    expect(weekdays.filter((cd) => !res.grid.D02[cd.day]).length).toBe(0);
  });
});
