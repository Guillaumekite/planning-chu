import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import DispoClient from './DispoClient';

export const runtime = 'nodejs';

export default async function DisponibilitesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mustChangePassword) redirect('/change-password');
  return <DispoClient isAdmin={session.role === 'admin'} doctorId={session.doctorId} />;
}
