import ExcelJS from 'exceljs';
import type { PlanningRow } from '@/lib/plannings';
import { MONTHS_FR, WEEKDAYS_FR } from '@/lib/store';
import { planningCell, type PlanningCell } from '@/lib/planning-cell';
import { computePostCounter, POST_ROWS } from '@/lib/garde-counter';

type Equity = {
  count: Record<string, number>;
  weekendCount: Record<string, number>;
  heavyCount: Record<string, number>;
};

// Gris = week-end / jour férié / congé-absence ; rouge = gardes G1 & G2 (inspiré du planning papier).
const GREY_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } } as const;
const RED = 'FFCC0000';
const ABSENT = new Set(['CA', 'ABS']); // congé / absence → grisé

function isGarde(post: string): boolean {
  return post === 'G1' || post === 'G2';
}

// One doctor-day as a single readable line, e.g. "MM (matin: biblio, aprem: staff)" or "ACU (soir: G2 18h)".
function csvCell(weekday: number, raw: string | undefined): string {
  const c = planningCell(weekday, raw);
  const extras: string[] = [];
  if (c.morning) extras.push(`matin: ${c.morning}`);
  if (c.afternoon) extras.push(`${c.afternoonKind === 'garde' ? 'soir' : 'aprem'}: ${c.afternoon}`);
  return extras.length ? `${c.main} (${extras.join(', ')})`.trim() : c.main;
}

// Séparateur ';' + BOM UTF-8 : Excel FR ouvre correctement sans ré-import manuel.
// Empile trois blocs dans un seul fichier : planning, compteur des postes, équité.
export function toCsv(planning: PlanningRow, doctors: string[]): string {
  const dayCols = planning.days.map((d) => `${WEEKDAYS_FR[d.weekday]} ${d.day}`);

  const header = ['Médecin', ...dayCols].join(';');
  const rows = doctors.map((doc) =>
    [doc, ...planning.days.map((d) => csvCell(d.weekday, planning.grid[doc]?.[d.day]))].join(';'),
  );

  const pc = computePostCounter(planning.grid, planning.days);
  const counterHeader = ['Compteur des postes', ...dayCols].join(';');
  const counterRows = POST_ROWS.map((post) =>
    [post, ...planning.days.map((d) => {
      const n = pc.counts[d.day][post] ?? 0;
      const bad = pc.flagged[d.day].has(post) || ((post === 'CS1' || post === 'CS2') && pc.flagged[d.day].has('CS'));
      return `${n}${bad ? '!' : ''}`;
    })].join(';'),
  );
  const workingRow = ['Travaillants', ...planning.days.map((d) => String(pc.working[d.day]))].join(';');
  const controlRow = ['Contrôle', ...planning.days.map((d) => (pc.flagged[d.day].size === 0 ? '✓' : '✗'))].join(';');
  const motifRows = planning.days
    .filter((d) => pc.flagged[d.day].size > 0)
    .map((d) => `Jour ${d.day} : ${pc.reason[d.day]}`);

  const equity = planning.garde_equity as Equity | null;
  const equityBlock = equity
    ? [
        ['Équité', 'Gardes', 'Week-ends', 'Jours pénibles'].join(';'),
        ...doctors.map((doc) => [doc, equity.count?.[doc] ?? 0, equity.weekendCount?.[doc] ?? 0, equity.heavyCount?.[doc] ?? 0].join(';')),
      ]
    : [];

  return [
    header,
    ...rows,
    '',
    counterHeader,
    ...counterRows,
    workingRow,
    controlRow,
    ...motifRows,
    '',
    ...equityBlock,
  ].join('\n');
}

const ANNOT_FONT = { size: 8, italic: true, color: { argb: 'FF7A7A7A' } } as const;       // réunions (matin/aprem)
const GARDE_ANNOT_FONT = { size: 8, bold: true, color: { argb: RED } } as const;           // garde du soir (ex : G2 18h)

// Render a doctor-day cell like the on-screen grid: matin (petit, gris) / POSTE (gras) / soir (petit).
// Gardes G1/G2 en rouge. Renvoie la cellule parsée pour décider du grisé (week-end / congé).
function setDayCell(cell: ExcelJS.Cell, weekday: number, raw: string | undefined): PlanningCell {
  const c = planningCell(weekday, raw);
  const mainFont: Partial<ExcelJS.Font> = { bold: !!c.main, size: 11 };
  if (isGarde(c.main)) mainFont.color = { argb: RED };
  if (!c.morning && !c.afternoon) {
    cell.value = c.main; // simple : juste le poste de la journée
    if (c.main) cell.font = mainFont;
  } else {
    const runs: ExcelJS.RichText[] = [];
    if (c.morning) runs.push({ text: c.morning + '\n', font: ANNOT_FONT });
    runs.push({ text: c.main || ' ', font: mainFont });
    if (c.afternoon) runs.push({ text: '\n' + c.afternoon, font: c.afternoonKind === 'garde' ? GARDE_ANNOT_FONT : ANNOT_FONT });
    cell.value = { richText: runs };
  }
  cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
  return c;
}

export async function toXlsx(planning: PlanningRow, doctors: string[], year: number, month: number): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(`${MONTHS_FR[month - 1]} ${year}`);
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  sheet.columns = [
    { header: 'Médecin', key: 'doctor', width: 20 },
    ...planning.days.map((d) => ({ header: `${WEEKDAYS_FR[d.weekday]} ${d.day}`, key: `d${d.day}`, width: 11 })),
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  // En-tête : colonnes week-end / férié en gris.
  planning.days.forEach((d, i) => {
    if (d.isWeekend || d.isHoliday) sheet.getRow(1).getCell(i + 2).fill = GREY_FILL;
  });

  for (const doc of doctors) {
    const row = sheet.addRow([doc]);
    row.height = 38;
    row.getCell(1).alignment = { vertical: 'middle' };
    row.getCell(1).font = { bold: true };
    planning.days.forEach((d, i) => {
      const cell = row.getCell(i + 2);
      const c = setDayCell(cell, d.weekday, planning.grid[doc]?.[d.day]);
      // Gris : week-end, jour férié, ou congé/absence.
      if (d.isWeekend || d.isHoliday || ABSENT.has(c.main)) cell.fill = GREY_FILL;
    });
  }

  const equity = planning.garde_equity as Equity | null;
  if (equity) {
    const eqSheet = wb.addWorksheet('Équité');
    eqSheet.columns = [
      { header: 'Médecin', key: 'doctor', width: 20 },
      { header: 'Gardes', key: 'count', width: 10 },
      { header: 'Week-ends', key: 'weekend', width: 12 },
      { header: 'Jours pénibles', key: 'heavy', width: 14 },
    ];
    eqSheet.getRow(1).font = { bold: true };
    for (const doc of doctors) {
      eqSheet.addRow({
        doctor: doc,
        count: equity.count?.[doc] ?? 0,
        weekend: equity.weekendCount?.[doc] ?? 0,
        heavy: equity.heavyCount?.[doc] ?? 0,
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}
