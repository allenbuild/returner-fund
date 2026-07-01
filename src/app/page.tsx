import { Dashboard } from "@/components/Dashboard";
import { buildInitialPageGraph } from "@/lib/graph/initial-page-graph";

export default function Home() {
  return <Dashboard initialGraph={buildInitialPageGraph()} />;
}
