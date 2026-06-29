import { redirect } from 'next/navigation';
import { getSession, hasViewAccess } from '@/lib/auth';
import PlanningView from './PlanningView';

export const runtime = 'nodejs';

export default async function PlanningPage() {
  const session = await getSession();
  const view = await hasViewAccess();
  if (!session && !view) redirect('/'); // need the passcode or a login
  return <PlanningView loggedIn={!!session} />;
}
