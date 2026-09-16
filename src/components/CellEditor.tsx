'use client';

// Palette d'édition d'une case du planning (mode admin). Décompose la valeur brute
// en « poste de jour » + « garde du soir » optionnelle ('ACU+G2', 'U+G1'…), comme
// planning-cell.ts, et recompose la valeur à chaque clic.
import { postLabel, postStyle } from '@/lib/store';

// Postes de jour proposés — les demandes de l'admin d'abord, puis le reste des codes.
const PRIMARY_POSTS = ['BM', 'S', 'CS1', 'CS2', 'Ped', 'U', 'G1', 'G2'] as const;
const OTHER_POSTS = ['BM-BS', 'MM-MS', 'MM', 'ACU', 'CD', 'HC', 'P', 'RS', 'CA', 'ABS'] as const;

// La garde du soir ne se combine qu'avec un vrai poste de jour (pas vide, pas une
// garde pure, pas un repos/absence) — mêmes combinaisons que le générateur (U+G1, ACU+G2…).
const NO_EVENING = new Set(['', 'G1', 'G2', 'RS', 'CA', 'ABS']);

export default function CellEditor({
  doc, day, value, onChange, onClose,
}: {
  doc: string;
  day: number;
  value: string;
  onChange: (raw: string) => void;
  onClose: () => void;
}) {
  const [main, evening] = value ? value.split('+') : ['', undefined];

  function setMain(post: string) {
    const keepEvening = evening && !NO_EVENING.has(post) ? `+${evening}` : '';
    onChange(post ? `${post}${keepEvening}` : '');
  }
  function setEvening(g: 'G1' | 'G2' | null) {
    onChange(g ? `${main}+${g}` : main);
  }

  const btn = (post: string, current: boolean) =>
    `rounded border px-2 py-1 text-xs font-medium ${postStyle(post)} ` +
    (current ? 'border-blue-600 ring-2 ring-blue-300' : 'border-gray-300 hover:border-gray-500');

  return (
    <div className="rounded-lg border border-blue-300 bg-blue-50/50 p-3">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span><b>{doc}</b> — jour {day}</span>
        <button onClick={onClose} className="text-gray-500 hover:underline">fermer</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => setMain('')} className={`rounded border px-2 py-1 text-xs ${main === '' ? 'border-blue-600 ring-2 ring-blue-300' : 'border-gray-300 hover:border-gray-500'}`}>
          vide (off)
        </button>
        {PRIMARY_POSTS.map((p) => (
          <button key={p} onClick={() => setMain(p)} className={btn(p, main === p)}>{postLabel(p)}</button>
        ))}
        <span className="mx-1 text-gray-300">|</span>
        {OTHER_POSTS.map((p) => (
          <button key={p} onClick={() => setMain(p)} className={btn(p, main === p)}>{postLabel(p)}</button>
        ))}
      </div>
      {!NO_EVENING.has(main) && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          <span className="text-gray-600">Garde du soir :</span>
          <button onClick={() => setEvening(null)} className={`rounded border px-2 py-1 ${!evening ? 'border-blue-600 ring-2 ring-blue-300' : 'border-gray-300 hover:border-gray-500'}`}>aucune</button>
          <button onClick={() => setEvening('G1')} className={btn('G1', evening === 'G1')}>+G1</button>
          <button onClick={() => setEvening('G2')} className={btn('G2', evening === 'G2')}>+G2</button>
        </div>
      )}
    </div>
  );
}
