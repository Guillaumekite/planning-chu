import { WEEKDAYS_FR, postStyle, gardeBorderStyle, postLabel } from '@/lib/store';
import { planningCell } from '@/lib/planning-cell';

export type GridDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };

export default function PlanningGrid({
  days, grid, doctors, editable = false, selected = null, editedKeys, onCellClick,
}: {
  days: GridDay[];
  grid: Record<string, Record<number, string>>;
  doctors: string[];
  /** Mode édition admin : les cases deviennent cliquables. */
  editable?: boolean;
  /** Case en cours d'édition (surlignée). */
  selected?: { doc: string; day: number } | null;
  /** Clés `doc|day` des cases modifiées depuis le début de l'édition (marqueur visuel). */
  editedKeys?: Set<string>;
  onCellClick?: (doc: string, day: number) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="border-collapse text-center text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-3 py-1 text-left">Médecin</th>
            {days.map((d) => (
              <th key={d.day} className={`min-w-[40px] border-b border-gray-200 px-1 py-1 ${d.isWeekend || d.isHoliday ? 'bg-amber-100' : 'bg-gray-50'}`}>
                <div className="text-[10px] text-gray-500">{WEEKDAYS_FR[d.weekday]}</div>
                <div className="font-semibold">{d.day}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {doctors.map((doc) => (
            <tr key={doc}>
              <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-medium whitespace-nowrap">{doc}</td>
              {days.map((d) => {
                const raw = grid[doc]?.[d.day];
                const { morning, main, afternoon } = planningCell(d.weekday, raw);
                const isSelected = selected?.doc === doc && selected?.day === d.day;
                const isEdited = editedKeys?.has(`${doc}|${d.day}`) ?? false;
                return (
                  <td
                    key={d.day}
                    onClick={editable ? () => onCellClick?.(doc, d.day) : undefined}
                    className={`relative h-12 ${gardeBorderStyle(raw)} px-0.5 align-middle ${postStyle(raw)}` +
                      (editable ? ' cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300' : '') +
                      (isSelected ? ' outline outline-2 outline-blue-600' : '')}
                  >
                    {isEdited && <span className="absolute right-0 top-0 h-0 w-0 border-l-8 border-t-8 border-l-transparent border-t-blue-500" title="Case modifiée" />}
                    <div className="text-[8px] leading-none text-gray-600/70">{morning || ' '}</div>
                    <div className="text-[11px] font-medium leading-tight">{postLabel(main)}</div>
                    <div className="text-[8px] leading-none text-gray-600/70">{afternoon || ' '}</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
