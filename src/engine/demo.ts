// Démo en ligne de commande du moteur de gardes.
// Lance : npm run demo
// Enchaîne 3 mois consécutifs en REPORTANT l'équité (carry) d'un mois sur l'autre,
// pour montrer que (a) chaque mois est équitable et (b) la charge se rééquilibre dans le temps.

import { solveGardes } from './gardes';
import { buildMonth } from './calendar';
import { DEFAULT_WEIGHTS, type DoctorId, type GardeInput } from './types';

const DOCTORS: DoctorId[] = [
  'DZIERZEK', 'ESSONO', 'EGBOHOU', 'KABA', 'YAGOUBI', 'BOUKADIDA',
  'HANNAFI', 'NAOUSSI', 'DE NEEF', 'SBOUI', 'KARADJI', 'HOUNDJE',
  'CHABANIS', 'GRAVEROT', 'FABRE', 'NAVES', 'GOUDEAU', 'DUFOUR',
];

const FR_WD = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// Un peu de contraintes réalistes par mois (congés / indispo / vœux).
const MONTHS: { year: number; month: number; label: string; blocked: Record<string, number[]>; wishes: Record<string, number[]> }[] = [
  {
    year: 2026, month: 4, label: 'AVRIL 2026',
    blocked: { GRAVEROT: [6, 7, 8, 9, 10], FABRE: [13, 14, 15, 16, 17], KABA: [1, 2, 3] },
    wishes: { SBOUI: [11], HOUNDJE: [25] },
  },
  {
    year: 2026, month: 5, label: 'MAI 2026',
    blocked: { DUFOUR: [4, 5, 6, 7, 8], NAVES: [18, 19, 20], ESSONO: [25, 26] },
    wishes: { KABA: [9], GOUDEAU: [16] },
  },
  {
    year: 2026, month: 6, label: 'JUIN 2026',
    blocked: { HANNAFI: [1, 2, 3, 4, 5], CHABANIS: [22, 23, 24, 25, 26] },
    wishes: { NAOUSSI: [13], 'DE NEEF': [27] },
  },
];

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  // Reports cumulatifs (équité multi-mois) : nombre de gardes et jours pénibles. Démarrent à 0.
  const carryCount: Record<DoctorId, number> = Object.fromEntries(DOCTORS.map((d) => [d, 0]));
  const carryHeavy: Record<DoctorId, number> = Object.fromEntries(DOCTORS.map((d) => [d, 0]));
  const totalGardes: Record<DoctorId, number> = Object.fromEntries(DOCTORS.map((d) => [d, 0]));
  const totalWE: Record<DoctorId, number> = Object.fromEntries(DOCTORS.map((d) => [d, 0]));

  for (const m of MONTHS) {
    const input: GardeInput = {
      year: m.year, month: m.month, doctors: DOCTORS,
      gardeBlocked: m.blocked, wishes: m.wishes, carryCount: { ...carryCount }, carryHeavy: { ...carryHeavy },
    };
    const res = await solveGardes(input);

    console.log('\n' + '='.repeat(64));
    console.log(`  ${m.label}`);
    console.log('='.repeat(64));

    if (res.status === 'infeasible') {
      console.log(`  ⛔ INFAISABLE — ${res.reason}`);
      console.log(`     Médecins éligibles ce jour : ${res.eligible.join(', ')}`);
      continue;
    }

    const days = buildMonth(m.year, m.month, DEFAULT_WEIGHTS, []);
    const byDay: Record<number, { G1?: string; G2?: string }> = {};
    for (const a of res.assignments) (byDay[a.day] ??= {})[a.role] = a.doctorId;

    console.log(`  ${pad('Jour', 10)} ${pad('G1', 12)} ${pad('G2', 12)}`);
    for (const cd of days) {
      const tag = cd.isWeekend ? ' *' : '  ';
      const head = `${FR_WD[cd.weekday]} ${String(cd.day).padStart(2)}${tag}`;
      console.log(`  ${pad(head, 10)} ${pad(byDay[cd.day]?.G1 ?? '-', 12)} ${pad(byDay[cd.day]?.G2 ?? '-', 12)}`);
    }

    // Compteurs du mois.
    const monthGardes: Record<string, number> = {};
    const monthWE: Record<string, number> = {};
    for (const a of res.assignments) {
      monthGardes[a.doctorId] = (monthGardes[a.doctorId] ?? 0) + 1;
      const cd = days.find((d) => d.day === a.day)!;
      if (cd.isWeekend) monthWE[a.doctorId] = (monthWE[a.doctorId] ?? 0) + 1;
    }

    console.log(`\n  Équité — écart du nombre de gardes (cumulé) : ${res.equity.spread}`);
    console.log(`  ${pad('Médecin', 12)} ${pad('gardes', 7)} ${pad('we', 4)} ${pad('cumul gardes', 13)} ${pad('cumul pénibles', 14)}`);
    for (const doc of DOCTORS) {
      carryCount[doc] = res.equity.cumulativeCount[doc]; // report cumulatif pour le mois suivant
      carryHeavy[doc] = res.equity.cumulativeHeavy[doc];
      totalGardes[doc] += monthGardes[doc] ?? 0;
      totalWE[doc] += monthWE[doc] ?? 0;
      console.log(
        `  ${pad(doc, 12)} ${pad(String(monthGardes[doc] ?? 0), 7)} ${pad(String(monthWE[doc] ?? 0), 4)} ${pad(String(res.equity.cumulativeCount[doc]), 13)} ${pad(String(res.equity.cumulativeHeavy[doc]), 14)}`,
      );
    }
  }

  console.log('\n' + '#'.repeat(64));
  console.log('  BILAN SUR 3 MOIS (cumul)');
  console.log('#'.repeat(64));
  console.log(`  ${pad('Médecin', 12)} ${pad('gardes', 7)} ${pad('we', 4)} ${pad('pénibles', 9)}`);
  const counts = DOCTORS.map((d) => totalGardes[d]);
  const wes = DOCTORS.map((d) => totalWE[d]);
  for (const doc of DOCTORS) {
    console.log(`  ${pad(doc, 12)} ${pad(String(totalGardes[doc]), 7)} ${pad(String(totalWE[doc]), 4)} ${pad(String(carryHeavy[doc]), 9)}`);
  }
  console.log(`\n  Écart nombre de gardes sur 3 mois : ${Math.max(...counts) - Math.min(...counts)} | écart week-ends : ${Math.max(...wes) - Math.min(...wes)} (plus c'est bas, plus c'est équitable)`);
  console.log('  → Le nombre de gardes ET les jours pénibles tournent : personne n\'accumule toujours les mêmes corvées.\n');
}

main();
