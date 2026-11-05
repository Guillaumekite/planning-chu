import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import PresencesClient from './PresencesClient';

export const runtime = 'nodejs';

export default async function PresencesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mustChangePassword) redirect('/change-password');
  if (session.role !== 'admin') redirect('/disponibilites');
  return <PresencesClient />;
}
