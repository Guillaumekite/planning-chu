import { WEEKDAYS_FR, postStyle } from '@/lib/store';

export type GridDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };

// Day-wide meetings that sit ON TOP of a doctor's main post (not posts themselves):
//   Tuesday  → biblio (matin) + staff (après-midi)
//   Wednesday→ réunion (après-midi)
//   Friday   → staff (après-midi)
// They only apply to doctors actually working a day post (not garde / RS / congé / off).
const NOT_WORKING = new Set(['G1', 'G2', 'RS', 'CA', 'ABS', '']);

function meetings(weekday: number, post: string | undefined): { morning: string; afternoon: string } {
  if (!post || NOT_WORKING.has(post)) return { morning: '', afternoon: '' };
  if (weekday === 1) return { morning: 'biblio', afternoon: 'staff' }; // mardi
  if (weekday === 2) return { morning: '', afternoon: 'réunion' }; // mercredi
  if (weekday === 4) return { morning: '', afternoon: 'staff' }; // vendredi
  return { morning: '', afternoon: '' };
}

export default function PlanningGrid({
  days, grid, doctors,
}: {
  days: GridDay[];
  grid: Record<string, Record<number, string>>;
  doctors: string[];
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
                const post = grid[doc]?.[d.day];
                const m = meetings(d.weekday, post);
                return (
                  <td key={d.day} className={`h-12 border border-gray-100 px-0.5 align-middle ${postStyle(post)}`}>
                    <div className="text-[8px] leading-none text-gray-600/70">{m.morning || ' '}</div>
                    <div className="text-[11px] font-medium leading-tight">{post ?? ''}</div>
                    <div className="text-[8px] leading-none text-gray-600/70">{m.afternoon || ' '}</div>
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
