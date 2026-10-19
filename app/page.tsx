import { Composer } from "@/components/Composer";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#FAFAFA] flex items-center justify-center">
      <div className="w-full max-w-3xl flex flex-col items-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          PiForge
        </h1>
        <div className="w-full mt-6">
          <Composer />
        </div>
      </div>
    </main>
  );
}
