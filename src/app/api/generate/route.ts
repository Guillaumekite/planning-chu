import { NextResponse } from 'next/server';
import { z } from 'zod';
import { solvePlanning } from '@/engine/planning';
import { getLatestPublishedBefore } from '@/lib/plannings';

// The GLPK solver is native (WASM) → this route must run on the Node.js runtime.
export const runtime = 'nodejs';

const AvailEnum = z.enum(['dispo', 'souhait_garde', 'no_garde', 'conge']);

const ProfileSchema = z.object({
  universitaire: z.boolean().optional(),
  universityRatio: z.number().min(0).max(100).optional(),
  fte: z.number().min(0).max(1).optional(),
  acupuncture: z.boolean().optional(), // legacy : équivaut à acuLundi + acuMercredi
  acuLundi: z.boolean().optional(),
  acuMercredi: z.boolean().optional(),
  douleurPoids: z.number().int().min(0).max(2).optional(),
  forceG2: z.boolean().optional(), // "Jamais G1" — jamais le rôle G1 (ex. Dzierzek)
  noS: z.boolean().optional(), // jamais le poste S
  presence: z.boolean().optional(), // éligible au poste P (≥ 12 travaillants)
});

const BodySchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  doctors: z.array(z.string().min(1)).min(2),
  holidays: z.array(z.number().int().min(1).max(31)).optional(),
  availability: z.record(z.string(), z.record(z.string(), AvailEnum)).optional(),
  profiles: z.record(z.string(), ProfileSchema).optional(),
  acupuncture: z.boolean().optional(),
  wishes: z.record(z.string(), z.array(z.number().int().min(1).max(31))).optional(),
  univConstraints: z.record(z.string(), z.array(z.number().int().min(1).max(31))).optional(),
  tpPreferred: z.record(z.string(), z.array(z.number().int().min(1).max(31))).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON invalide' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Entrée invalide', details: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  if (new Set(input.doctors).size !== input.doctors.length) {
    return NextResponse.json({ error: 'Deux médecins portent le même nom.' }, { status: 400 });
  }

  // Convert availability keys (day numbers come as strings from JSON) to numbers.
  const availability: Record<string, Record<number, z.infer<typeof AvailEnum>>> = {};
  if (input.availability) {
    for (const [doc, perDay] of Object.entries(input.availability)) {
      availability[doc] = {};
      for (const [day, state] of Object.entries(perDay)) availability[doc][Number(day)] = state;
    }
  }

  try {
    // Cross-month garde equity: the previous PUBLISHED month's monthly counters become this
    // month's carry — a doctor who took the painful weekends last month is relieved this month.
    // One-month lookback (not the full history) so returning/new doctors aren't hammered.
    const prev = await getLatestPublishedBefore(input.year, input.month);
    const prevEq = (prev?.garde_equity ?? {}) as {
      count?: Record<string, number>;
      heavyCount?: Record<string, number>;
      weekendCount?: Record<string, number>;
    };

    const result = await solvePlanning({
      year: input.year,
      month: input.month,
      doctors: input.doctors,
      holidays: input.holidays,
      wishes: input.wishes,
      availability,
      profiles: input.profiles,
      acupuncture: input.acupuncture,
      univConstraints: input.univConstraints,
      tpPreferred: input.tpPreferred,
      carryCount: prevEq.count,
      carryHeavy: prevEq.heavyCount,
      carryWeekend: prevEq.weekendCount,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `Erreur du moteur : ${(e as Error).message}` }, { status: 500 });
  }
}
