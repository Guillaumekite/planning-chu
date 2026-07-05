import { describe, it, expect } from 'vitest';
import { solvePlanning, type PlanningInput, type DoctorProfile } from './planning';
import { daysInMonth, buildMonth } from './calendar';
import { DEFAULT_WEIGHTS } from './types';

function doctors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
}

/** All weekday (Mon–Fri, non-holiday) day-numbers of a month. */
function weekdaysOf(year: number, month: number): number[] {
  return buildMonth(year, month, DEFAULT_WEIGHTS, []).filter((cd) => !cd.isWeekend && !cd.isHoliday).map((cd) => cd.day);
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
    const docs = doctors(11); // < 12 → no Monday-off compensation, clean invariant
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

  it('gives ACU on Mondays (plain or ACU+G2 evening garde), never G1, and only to the acu doctor', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D02: { acupuncture: true } } });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let acu = 0;
    for (const cd of res.days) {
      if (cd.weekday !== 0) continue; // Monday
      const p = res.grid.D02[cd.day];
      if (p && p.startsWith('ACU')) acu++;
      // On a Monday, the acu doctor is never on G1 (a Monday garde must be G2 / ACU+G2).
      expect(p).not.toBe('G1');
    }
    expect(acu).toBeGreaterThan(0);
    // No other doctor ever gets ACU.
    for (const cd of res.days) for (const doc of docs.filter((d) => d !== 'D02')) {
      expect((res.grid[doc][cd.day] ?? '').startsWith('ACU')).toBe(false);
    }
  });

  it('places ACU on Wednesdays too, and never puts the acu doctor on G1 any day', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D02: { acupuncture: true } } });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let wed = 0;
    for (const cd of res.days) if (cd.weekday === 2 && (res.grid.D02[cd.day] ?? '').startsWith('ACU')) wed++;
    expect(wed).toBeGreaterThan(0);
    for (const cd of res.days) expect(res.grid.D02[cd.day]).not.toBe('G1'); // never G1
  });

  it('disables ACU entirely when the acupuncture flag is off', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D02: { acupuncture: true } }, acupuncture: false });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    for (const cd of res.days) for (const doc of docs) {
      expect((res.grid[doc][cd.day] ?? '').startsWith('ACU')).toBe(false);
    }
  });

  it('compensates Saturday gardes with the following Monday off when team ≥ 12', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let checked = 0;
    for (const cd of res.days) {
      if (cd.weekday !== 5) continue; // Saturday
      const mondayDay = cd.day + 2;
      const md = res.days.find((x) => x.day === mondayDay);
      if (!md || md.weekday !== 0) continue;
      for (const doc of docs) {
        if (['G1', 'G2'].includes(res.grid[doc][cd.day])) {
          expect(!res.grid[doc][mondayDay]).toBe(true); // off (blank) that Monday
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
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
      year: 2026, month: 4, doctors: doctors(11),
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
    const profiles = { D01: { douleurPoids: 1 }, D02: { douleurPoids: 1 } };
    const big = await solvePlanning({ year: 2026, month: 4, doctors: doctors(12), profiles });
    const small = await solvePlanning({ year: 2026, month: 4, doctors: doctors(8), profiles });
    if (big.status !== 'feasible' || small.status !== 'feasible') throw new Error('expected feasible');
    const cdBig = big.days.reduce((s, cd) => s + doctors(12).filter((d) => big.grid[d][cd.day] === 'CD').length, 0);
    const cdSmall = small.days.reduce((s, cd) => s + doctors(8).filter((d) => small.grid[d][cd.day] === 'CD').length, 0);
    expect(cdBig).toBeGreaterThan(0);
    expect(cdSmall).toBe(0);
  });

  it('assigns CD only to doctors with douleurPoids ≥ 1', async () => {
    const docs = doctors(14);
    const profiles: Record<string, DoctorProfile> = { D01: { douleurPoids: 2 }, D02: { douleurPoids: 1 }, D03: { douleurPoids: 1 } };
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const eligible = new Set(['D01', 'D02', 'D03']);
    let cdTotal = 0;
    for (const cd of res.days) for (const doc of docs) {
      if (res.grid[doc][cd.day] === 'CD') { cdTotal++; expect(eligible.has(doc)).toBe(true); }
    }
    expect(cdTotal).toBeGreaterThan(0);
  });

  it('gives Esbuy (douleurPoids 2) about twice the CD of a douleurPoids-1 doctor', async () => {
    const docs = doctors(16);
    const profiles: Record<string, DoctorProfile> = {
      D01: { douleurPoids: 2 }, D02: { douleurPoids: 1 }, D03: { douleurPoids: 1 },
      D04: { douleurPoids: 1 }, D05: { douleurPoids: 1 },
    };
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const cdCount = (doc: string) => res.days.filter((c) => res.grid[doc][c.day] === 'CD').length;
    const esbuy = cdCount('D01');
    const others = ['D02', 'D03', 'D04', 'D05'].map(cdCount);
    const avgOther = others.reduce((s, v) => s + v, 0) / others.length;
    expect(esbuy).toBeGreaterThanOrEqual(Math.max(...others));
    expect(esbuy / avgOther).toBeGreaterThan(1.5);
    expect(esbuy / avgOther).toBeLessThan(2.6);
  });

  it('leaves CD uncovered on days when no douleur doctor is present', async () => {
    const docs = doctors(12);
    const conge: Record<number, 'conge'> = {};
    for (let d = 1; d <= 30; d++) conge[d] = 'conge';
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { douleurPoids: 1 } }, availability: { D01: conge },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let cdTotal = 0;
    for (const cd of res.days) for (const doc of docs) if (res.grid[doc][cd.day] === 'CD') cdTotal++;
    expect(cdTotal).toBe(0);
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

  it('places U on EXACTLY the declared Univ days (no auto %-fill) when constraints are posted', async () => {
    const docs = doctors(12);
    // D01 is universitaire but never gardable (no_garde every day) → declared days become plain 'U',
    // with no garde/RS interference. Declared weekdays in April 2026: 7, 14, 21 (all Tuesdays).
    const noGarde: Record<number, 'no_garde'> = {};
    for (let d = 1; d <= 30; d++) noGarde[d] = 'no_garde';
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { universitaire: true, universityRatio: 50 } },
      availability: { D01: noGarde },
      univConstraints: { D01: [7, 14, 21] },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const uDays = res.days.filter((cd) => (res.grid.D01[cd.day] ?? '').startsWith('U')).map((cd) => cd.day);
    expect(uDays.sort((a, b) => a - b)).toEqual([7, 14, 21]);
  });

  it('blocks the garde the DAY BEFORE a declared Univ day (RS would clash with being at university)', async () => {
    const docs = doctors(12);
    // D01 wishes a garde on day 13 but declares Univ on day 14 → garde on 13 must be blocked.
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { universitaire: true, universityRatio: 50 } },
      availability: { D01: { 13: 'souhait_garde' } },
      univConstraints: { D01: [14] },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    expect(['G1', 'G2']).not.toContain(res.grid.D01[13]);
  });

  it('when a universitaire is G1 on a Univ day → U+G1 and exactly one BM-BS covers the bloc that day', async () => {
    const docs = doctors(12);
    // D01 universitaire, fully available, declares EVERY weekday as Univ → any weekday garde lands on
    // a Univ day, producing U+G1 (or U+G2). This makes at least one U+G1 highly likely.
    const univAll = weekdaysOf(2026, 4);
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { universitaire: true, universityRatio: 50 } },
      univConstraints: { D01: univAll },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let uG1Count = 0;
    for (const cd of res.days) {
      const bmbs = docs.filter((d) => res.grid[d][cd.day] === 'BM-BS');
      const uG1 = docs.filter((d) => res.grid[d][cd.day] === 'U+G1');
      // Invariant: BM-BS appears iff some doctor is U+G1 that day, exactly one each, on distinct docs.
      expect(bmbs.length).toBe(uG1.length);
      if (uG1.length) {
        expect(bmbs.length).toBe(1);
        expect(bmbs[0]).not.toBe(uG1[0]);
        uG1Count += 1;
      }
    }
    expect(uG1Count).toBeGreaterThan(0); // the scenario actually exercises the U+G1 → BM-BS path
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
