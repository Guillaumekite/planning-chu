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

  it('« Jamais G1 » (forceG2) : never the G1 role, even without the acupuncture flag', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D03: { forceG2: true } } });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    for (const cd of res.days) {
      expect(res.grid.D03[cd.day]).not.toBe('G1');
      expect(res.grid.D03[cd.day]).not.toBe('U+G1');
    }
    // She still takes gardes — as G2 only.
    expect(res.days.filter((cd) => res.grid.D03[cd.day] === 'G2').length).toBeGreaterThan(0);
  });

  it('disables ACU entirely when the acupuncture flag is off', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D02: { acupuncture: true } }, acupuncture: false });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    for (const cd of res.days) for (const doc of docs) {
      expect((res.grid[doc][cd.day] ?? '').startsWith('ACU')).toBe(false);
    }
  });

  it('récup ladder: 13 working → Saturday G1 off Monday; 14 → the G2 too; 12 → nobody', async () => {
    const run = async (n: number) => {
      const res = await solvePlanning({ year: 2026, month: 4, doctors: doctors(n) });
      if (res.status !== 'feasible') throw new Error('expected feasible');
      return res;
    };
    const [r12, r13, r14] = await Promise.all([run(12), run(13), run(14)]);
    const checkMondays = (
      res: Awaited<ReturnType<typeof run>>, docs: string[],
      expectG1Off: boolean, expectG2Off: boolean,
    ) => {
      let sats = 0;
      for (const cd of res.days) {
        if (cd.weekday !== 5) continue; // Saturday
        const monday = cd.day + 2;
        if (!res.days.find((x) => x.day === monday && x.weekday === 0)) continue;
        const g1 = docs.find((d) => res.grid[d][cd.day] === 'G1')!;
        const g2 = docs.find((d) => res.grid[d][cd.day] === 'G2')!;
        expect(!res.grid[g1][monday]).toBe(expectG1Off);
        expect(!res.grid[g2][monday]).toBe(expectG2Off);
        sats++;
      }
      expect(sats).toBeGreaterThan(0);
    };
    checkMondays(r12, doctors(12), false, false); // 12 travaillants < 13 → no récup at all
    checkMondays(r13, doctors(13), true, false); // 13 → the Saturday G1 rests Monday, not the G2
    checkMondays(r14, doctors(14), true, true); // 14 → both Saturday gardes rest Monday
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

  it('G+ (souhait_garde) is HARD: with ≤2 wishers on a day, the wisher gets the garde', async () => {
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: doctors(12),
      availability: { D01: { 9: 'souhait_garde' } },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    expect(['G1', 'G2']).toContain(res.grid.D01[9]); // the wished garde is guaranteed
    expect(res.warnings.filter((w) => w.includes('G+'))).toHaveLength(0); // honored cleanly
  });

  it('3+ G+ on the same day: both slots go to wishers, and the admin is warned', async () => {
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: doctors(12),
      availability: {
        D01: { 9: 'souhait_garde' }, D02: { 9: 'souhait_garde' }, D03: { 9: 'souhait_garde' },
      },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const holders = doctors(12).filter((d) => ['G1', 'G2'].includes(res.grid[d][9]));
    expect(holders.length).toBe(2);
    for (const doc of holders) expect(['D01', 'D02', 'D03']).toContain(doc);
    expect(res.warnings.some((w) => w.includes('3 G+'))).toBe(true);
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

  it('CD appears when capacity exceeds the core posts, never at their expense', async () => {
    const profiles = { D01: { douleurPoids: 1 }, D02: { douleurPoids: 1 } };
    const big = await solvePlanning({ year: 2026, month: 4, doctors: doctors(12), profiles });
    // 9 working → the pool is exactly consumed by the mandatory core (2 BM, S, CS1, CS2) → no CD.
    const small = await solvePlanning({ year: 2026, month: 4, doctors: doctors(9), profiles });
    if (big.status !== 'feasible' || small.status !== 'feasible') throw new Error('expected feasible');
    const cdBig = big.days.reduce((s, cd) => s + doctors(12).filter((d) => big.grid[d][cd.day] === 'CD').length, 0);
    // Day 1 has no RS from a previous day → real spare capacity → a CD there is legitimate.
    // From day 2 on, 2 gardes + 2 RS leave the pool exactly equal to the core → never a CD.
    const cdSmall = small.days.reduce(
      (s, cd) => s + (cd.day >= 2 ? doctors(9).filter((d) => small.grid[d][cd.day] === 'CD').length : 0),
      0,
    );
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

  it('staffing table: Ped replaces one BM on Mon/Wed/Thu/Fri, never on Tuesday; 3rd BM at ≥10; no P without the flag', async () => {
    const big = await solvePlanning({ year: 2026, month: 4, doctors: doctors(12) });
    const nine = await solvePlanning({ year: 2026, month: 4, doctors: doctors(9) });
    if (big.status !== 'feasible' || nine.status !== 'feasible') throw new Error('expected feasible');
    // No P post without any présence-flagged doctor.
    for (const res of [big, nine]) {
      for (const cd of res.days) for (const doc of Object.keys(res.grid)) expect(res.grid[doc][cd.day]).not.toBe('P');
    }
    const count = (res: typeof big, day: number, docs: string[], post: string) =>
      docs.filter((d) => res.grid[d][day] === post).length;
    for (const cd of nine.days) {
      if (cd.isWeekend || cd.isHoliday) continue;
      const isPedDay = [0, 2, 3, 4].includes(cd.weekday);
      // 9 working: 2 "blocs" of which one is Ped on Ped days (1 BM + 1 Ped), else 2 BM —
      // plus 1 S, CS1, CS2. Exactly, no spare for a 3rd bloc.
      expect(count(nine, cd.day, doctors(9), 'BM')).toBe(isPedDay ? 1 : 2);
      expect(count(nine, cd.day, doctors(9), 'Ped')).toBe(isPedDay ? 1 : 0);
      expect(count(nine, cd.day, doctors(9), 'S')).toBe(1);
      expect(count(nine, cd.day, doctors(9), 'CS1')).toBe(1);
      expect(count(nine, cd.day, doctors(9), 'CS2')).toBe(1);
    }
    // 12 on the roster: 3 blocs — Tuesdays 3 BM + 0 Ped; Ped days 2 BM + exactly 1 Ped.
    let checkedTuesdays = 0, checkedPedDays = 0;
    for (const cd of big.days) {
      if (cd.isWeekend || cd.isHoliday) continue;
      if (cd.weekday === 1) {
        expect(count(big, cd.day, doctors(12), 'BM')).toBe(3);
        expect(count(big, cd.day, doctors(12), 'Ped')).toBe(0);
        checkedTuesdays++;
      } else {
        expect(count(big, cd.day, doctors(12), 'BM')).toBe(2);
        expect(count(big, cd.day, doctors(12), 'Ped')).toBe(1);
        checkedPedDays++;
      }
    }
    expect(checkedTuesdays).toBeGreaterThan(0);
    expect(checkedPedDays).toBeGreaterThan(0);
  });

  it('CS equity: combined CS1+CS2 per doctor stays tight, capped at 6, alternated, never two days in a row', async () => {
    const docs = doctors(12);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const isCs = (v: string | undefined) => v === 'CS1' || v === 'CS2';
    for (const doc of docs) {
      const cs1 = res.days.filter((cd) => res.grid[doc][cd.day] === 'CS1').length;
      const cs2 = res.days.filter((cd) => res.grid[doc][cd.day] === 'CS2').length;
      expect(cs1 + cs2).toBeLessThanOrEqual(6); // hard monthly cap
      // Per-doctor alternation: never "only CS1" or "only CS2" — a residual gap of 2 can remain
      // when two same-preference doctors collide near month end, that's acceptable.
      expect(Math.abs(cs1 - cs2)).toBeLessThanOrEqual(2);
      // Never CS on two calendar days in a row (enough staff at 12 → no fallback needed).
      for (const cd of res.days) {
        if (isCs(res.grid[doc][cd.day]) && isCs(res.grid[doc][cd.day + 1])) {
          throw new Error(`${doc} has CS on days ${cd.day} and ${cd.day + 1}`);
        }
      }
    }
    // Combined totals stay tight across always-present doctors (44 slots / 12 docs ≈ 3.7).
    const totals = docs.map((doc) => res.days.filter((cd) => isCs(res.grid[doc][cd.day])).length);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(2);
  });

  it('at 8 working, a single CS runs each day, alternating so CS1/CS2 stay even per week', async () => {
    // 9 doctors, one on congé for two full weeks → 8 working on those weekdays only.
    const docs = doctors(9);
    const conge: Record<number, 'conge'> = {};
    for (let d = 6; d <= 19; d++) conge[d] = 'conge'; // Mon 6 → Sun 19 (April 2026)
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, availability: { D09: conge } });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const csOn = (day: number) => ({
      cs1: docs.filter((d) => res.grid[d][day] === 'CS1').length,
      cs2: docs.filter((d) => res.grid[d][day] === 'CS2').length,
    });
    let weekCs1 = 0, weekCs2 = 0;
    for (const cd of res.days) {
      if (cd.isWeekend || cd.isHoliday) continue;
      const { cs1, cs2 } = csOn(cd.day);
      if (cd.day >= 6 && cd.day <= 19) {
        expect(cs1 + cs2).toBe(1); // 8 working → exactly one CS, never both
        weekCs1 += cs1; weekCs2 += cs2;
      } else {
        expect(cs1).toBe(1); // 9 working → both consultations run
        expect(cs2).toBe(1);
      }
    }
    expect(Math.abs(weekCs1 - weekCs2)).toBeLessThanOrEqual(1); // alternation keeps them even
  });

  it('MM/MS runs ONLY when the acupuncture doctor is on garde AND ≥ 12 are working', async () => {
    const docs = doctors(13);
    const res = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D02: { acupuncture: true } } });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    let matSeen = 0;
    for (const cd of res.days) {
      if (cd.isWeekend || cd.isHoliday) continue;
      const mat = docs.filter((d) => ['MM', 'MS'].includes(res.grid[d][cd.day]));
      const dziOnGarde = ['G1', 'G2', 'ACU+G2', 'U+G1', 'U+G2'].includes(res.grid.D02[cd.day]);
      if (!dziOnGarde) expect(mat.length).toBe(0); // no maternity post without the acu doctor on garde
      matSeen += mat.length;
    }
    expect(matSeen).toBeGreaterThan(0); // …but it does run on (some of) her garde days

    // Below 12 working, never — even when she IS on garde.
    const small = await solvePlanning({ year: 2026, month: 4, doctors: doctors(11), profiles: { D02: { acupuncture: true } } });
    if (small.status !== 'feasible') throw new Error('expected feasible');
    for (const cd of small.days) {
      expect(doctors(11).filter((d) => ['MM', 'MS'].includes(small.grid[d][cd.day])).length).toBe(0);
    }
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
    // D01 universitaire declares EVERY weekday as Univ (any weekday garde is a Univ-day garde).
    // Since the Friday-equity change (3891a71), Fri and Sat are equally "weekend" for fairness, so
    // the solver no longer has an implicit bias toward placing a constrained doctor's garde on
    // Friday over Saturday — relying on that bias (as this test used to) is no longer reliable.
    // Force the scenario deterministically instead: make every doctor EXCEPT D01/D02 unavailable
    // for garde on one specific Friday (day 3), so the "2 doctors/day" hard constraint forces both
    // D01 and D02 onto that day; mark D02 `acupuncture: true` so the role balancer pins D02 to G2
    // (planning.ts's forceG2 rule), leaving D01 as G1 by elimination — guaranteeing a Univ+G1 event
    // regardless of any other equity-driven placement choice.
    const univAll = weekdaysOf(2026, 4);
    const forcedFriday = 3; // first Friday of April 2026
    const availability: Record<string, Record<number, 'no_garde'>> = {};
    for (const doc of docs) {
      if (doc === 'D01' || doc === 'D02') continue;
      availability[doc] = { [forcedFriday]: 'no_garde' };
    }
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { universitaire: true, universityRatio: 50 }, D02: { acupuncture: true } },
      univConstraints: { D01: univAll },
      availability,
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
    // A full-timer can legitimately have a FEW blanks — Monday récup after a Saturday garde,
    // granted only when ≥ 12 doctors actually WORK that Monday — but nowhere near the part-timer's
    // ~half-blank TP pattern. The <=4 ceiling covers a handful of Saturday récups over the month.
    const blankD02 = weekdays.filter((cd) => !res.grid.D02[cd.day]).length;
    expect(blankD02).toBeLessThanOrEqual(4);
    expect(blankD02).toBeLessThan(blank / 2);
  });
});
