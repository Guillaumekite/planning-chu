import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8 font-sans text-gray-900">
      <h1 className="text-3xl font-bold">Planning Anesthésie — CHU</h1>
      <p className="mt-3 text-gray-600">
        Génération automatique et équitable des gardes (G1/G2). L&apos;algorithme s&apos;adapte à
        n&apos;importe quel nombre de médecins (7, 10, 18…) et répartit équitablement les gardes,
        week-ends et jours pénibles.
      </p>
      <div className="mt-8 flex gap-4">
        <Link href="/admin" className="rounded bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700">
          Espace admin — créer les médecins &amp; générer
        </Link>
      </div>
      <p className="mt-6 text-sm text-gray-400">
        Prototype. La vue publique du planning, la connexion des médecins et la saisie des vœux
        viendront ensuite.
      </p>
    </main>
  );
}
