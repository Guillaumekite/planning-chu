// src/components/PostCounterTable.tsx
// Matrice postes × jours : nombre de médecins par poste, contrôle et motif.
// Aligne ses colonnes-jours sous le PlanningGrid.
import { WEEKDAYS_FR, postLabel } from '@/lib/store';
import { computePostCounter, type CounterDay } from '@/lib/garde-counter';

export default function PostCounterTable({
  days, grid,
}: {
  days: CounterDay[];
  grid: Record<string, Record<number, string>>;
}) {
  const pc = computePostCounter(grid, days);
  const flaggedDays = days.filter((d) => pc.flagged[d.day].size > 0);

  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold">Compteur des postes</h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="border-collapse text-center text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-3 py-1 text-left">Poste</th>
              {days.map((d) => (
                <th key={d.day} className={`min-w-[40px] border-b border-gray-200 px-1 py-1 ${d.isWeekend || d.isHoliday ? 'bg-amber-100' : 'bg-gray-50'}`}>
                  <div className="text-[10px] text-gray-500">{WEEKDAYS_FR[d.weekday]}</div>
                  <div className="font-semibold">{d.day}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pc.posts.map((post) => (
              <tr key={post}>
                <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-medium">{postLabel(post)}</td>
                {days.map((d) => {
                  const n = pc.counts[d.day][post] ?? 0;
                  const bad = pc.flagged[d.day].has(post) || (post === 'CS1' || post === 'CS2' ? pc.flagged[d.day].has('CS') : false);
                  const grey = d.isWeekend || d.isHoliday;
                  return (
                    <td key={d.day} className={`h-8 border border-gray-100 px-0.5 align-middle ${bad ? 'bg-red-200 font-bold text-red-800' : grey ? 'bg-gray-50' : ''}`}>
                      {n || ''}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-gray-300">
              <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-semibold">Travaillants</td>
              {days.map((d) => (
                <td key={d.day} className="h-8 border border-gray-100 px-0.5 align-middle text-gray-600">{pc.working[d.day]}</td>
              ))}
            </tr>
            <tr>
              <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-semibold">Contrôle</td>
              {days.map((d) => {
                const ok = pc.flagged[d.day].size === 0;
                return (
                  <td key={d.day} title={ok ? '' : pc.reason[d.day]} className={`h-8 border border-gray-100 px-0.5 align-middle ${ok ? 'text-green-600' : 'bg-red-200 text-red-800'}`}>
                    {ok ? '✓' : '✗'}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {flaggedDays.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-red-800">
          {flaggedDays.map((d) => (
            <li key={d.day}>Jour {d.day} : {pc.reason[d.day]}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
