import { CreateFlow } from "@/components/app/create/CreateFlow";
import { Meander } from "@/components/Meander";

export const metadata = { title: "Create · BALLAST" };

export default function CreatePage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Create a launch</h1>
        <Meander className="mt-3 max-w-xs" />
      </div>
      <CreateFlow />
    </div>
  );
}
