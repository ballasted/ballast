import { CreateFlow } from "@/components/app/create/CreateFlow";

export const metadata = { title: "Create · BALLAST" };

export default function CreatePage() {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Create a launch</h1>
      <CreateFlow />
    </div>
  );
}
