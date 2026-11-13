import { CreateFlow } from "@/components/app/create/CreateFlow";
import { CreateFlowV5 } from "@/components/app/create/CreateFlowV5";
import { isElysium } from "@/lib/chainProfile";

export const metadata = { title: "Create · BALLAST" };

export default function CreatePage() {
  return (
    <div className="space-y-5">
      <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Create a launch</h1>
      {isElysium ? <CreateFlowV5 /> : <CreateFlow />}
    </div>
  );
}
