declare module "react-cytoscapejs" {
  import type { ComponentType } from "react";

  interface CytoscapeComponentProps {
    elements: unknown[];
    stylesheet?: unknown[];
    layout?: Record<string, unknown>;
    style?: Record<string, string | number>;
    cy?: (cy: import("cytoscape").Core) => void;
    [key: string]: unknown;
  }

  const CytoscapeComponent: ComponentType<Record<string, unknown>> & {
    normalizeElements?: (elements: unknown[]) => unknown[];
  };

  export default CytoscapeComponent;
}
