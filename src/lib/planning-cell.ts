// What a doctor actually does on a given day, decomposed from the raw grid token.
// Mirrors the on-screen PlanningGrid rendering so exports match the UI exactly.
//
//   main       — poste général de la journée (ex : 'ACU', 'MM', 'G1')
//   morning    — ce qu'il faut le matin (réunion biblio le mardi)
//   afternoon  — ce qu'il faut l'après-midi / le soir (staff, réunion, ou garde du soir)
//   afternoonKind — 'garde' (garde du soir 18h) | 'meeting' (staff/réunion) | ''

// Postes qui ne « travaillent » pas la journée → pas de réunion appliquée par-dessus.
const NOT_WORKING = new Set(['G1', 'G2', 'RS', 'CA', 'ABS', '']);

// Réunions qui se posent PAR-DESSUS le poste de journée d'un médecin :
//   mardi    → biblio (matin) + staff (après-midi)
//   mercredi → réunion (après-midi)
//   vendredi → staff (après-midi)
function meetings(weekday: number, post: string | undefined): { morning: string; afternoon: string } {
  if (!post || NOT_WORKING.has(post)) return { morning: '', afternoon: '' };
  if (weekday === 1) return { morning: 'biblio', afternoon: 'staff' }; // mardi
  if (weekday === 2) return { morning: '', afternoon: 'réunion' };     // mercredi
  if (weekday === 4) return { morning: '', afternoon: 'staff' };       // vendredi
  return { morning: '', afternoon: '' };
}

export type PlanningCell = {
  main: string;
  morning: string;
  afternoon: string;
  afternoonKind: 'garde' | 'meeting' | '';
};

export function planningCell(weekday: number, raw: string | undefined): PlanningCell {
  const [main, evening] = raw ? raw.split('+') : [undefined, undefined]; // 'ACU+G2' = ACU jour + G2 soir
  const m = meetings(weekday, main);
  if (evening) {
    // Garde du soir : elle prend la place de l'après-midi (mais la réunion du matin reste).
    return { main: main ?? '', morning: m.morning, afternoon: `${evening} 18h`, afternoonKind: 'garde' };
  }
  return { main: main ?? '', morning: m.morning, afternoon: m.afternoon, afternoonKind: m.afternoon ? 'meeting' : '' };
}
