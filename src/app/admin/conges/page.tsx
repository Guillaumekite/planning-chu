import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import CongesClient from './CongesClient';

export const runtime = 'nodejs';

export default async function CongesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mustChangePassword) redirect('/change-password');
  if (session.role !== 'admin') redirect('/disponibilites');
  return <CongesClient />;
}
