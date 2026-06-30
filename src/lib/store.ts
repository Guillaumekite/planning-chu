// Client-side local store (prototype). Roster + availability live in the browser's
// localStorage for now; a shared database + auth will replace this next.

export type Doctor = {
  name: string;
  password: string;
  active: boolean;
  universitaire?: boolean;
  universityRatio?: number; // % temps fac (0-100)
  partTime?: boolean;
  partTimeRatio?: number; // % de présence si temps partiel (0-100), défaut 100
};
export type Availability = 'dispo' | 'souhait_garde' | 'no_garde' | 'conge';
/** doctor name → (day number → availability) */
export type MonthAvailability = Record<string, Record<number, Availability>>;

/** Palette order + display for the doctor availability calendar (dispo = the eraser). */
export const AVAIL_STATES: Availability[] = ['dispo', 'souhait_garde', 'no_garde', 'conge'];
export const AVAIL_INFO: Record<Availability, { label: string; cls: string; legend: string }> = {
  dispo: { label: '', cls: 'bg-white hover:bg-gray-100', legend: 'Dispo (effacer)' },
  souhait_garde: { label: 'G+', cls: 'bg-violet-200 text-violet-800', legend: 'Préfère être de garde' },
  no_garde: { label: 'G−', cls: 'bg-orange-200 text-orange-800', legend: 'Pas dispo pour la garde (travaille)' },
  conge: { label: 'Congé', cls: 'bg-blue-200 text-blue-800', legend: 'Demande de congé (en attente)' },
};

const DOCTORS_KEY = 'planning-chu-doctors';
const AVAIL_KEY = 'planning-chu-availability';

export const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
export const WEEKDAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function loadDoctors(): Doctor[] {
  try {
    const raw = localStorage.getItem(DOCTORS_KEY);
    return raw ? (JSON.parse(raw) as Doctor[]) : [];
  } catch {
    return [];
  }
}

export function saveDoctors(doctors: Doctor[]): void {
  localStorage.setItem(DOCTORS_KEY, JSON.stringify(doctors));
}

type AvailStore = Record<string, MonthAvailability>; // monthKey → availability

export function loadAvailability(year: number, month: number): MonthAvailability {
  try {
    const raw = localStorage.getItem(AVAIL_KEY);
    const all = raw ? (JSON.parse(raw) as AvailStore) : {};
    return all[monthKey(year, month)] ?? {};
  } catch {
    return {};
  }
}

export function saveAvailability(year: number, month: number, avail: MonthAvailability): void {
  let all: AvailStore = {};
  try {
    const raw = localStorage.getItem(AVAIL_KEY);
    all = raw ? (JSON.parse(raw) as AvailStore) : {};
  } catch {}
  all[monthKey(year, month)] = avail;
  localStorage.setItem(AVAIL_KEY, JSON.stringify(all));
}

/** Tailwind classes for each post acronym, for the planning grid. */
export function postStyle(post: string | undefined): string {
  switch (post) {
    case 'G1':
      return 'bg-red-600 text-white font-semibold';
    case 'G2':
      return 'bg-orange-500 text-white font-semibold';
    case 'RS':
      return 'bg-gray-200 text-gray-600';
    case 'U':
      return 'bg-indigo-100 text-indigo-700 font-medium';
    case 'P':
      return 'bg-pink-100 text-pink-700';
    case 'Ped':
      return 'bg-rose-100 text-rose-700';
    case 'MM':
      return 'bg-cyan-100 text-cyan-700';
    case 'CD':
      return 'bg-fuchsia-100 text-fuchsia-700';
    case 'ACU':
      return 'bg-lime-100 text-lime-700';
    case 'CA':
      return 'bg-green-100 text-green-700';
    case 'ABS':
      return 'bg-gray-100 text-gray-400';
    case 'CS1':
    case 'CS2':
      return 'bg-blue-50 text-blue-700';
    case 'BM':
      return 'bg-purple-50 text-purple-700';
    case 'S':
      return 'bg-teal-50 text-teal-700';
    case 'HC':
      return 'bg-yellow-50 text-yellow-700';
    default:
      return '';
  }
}
