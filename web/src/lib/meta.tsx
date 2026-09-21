import { createContext, useContext } from "react";
import type { Meta } from "./api";

export interface MetaContext {
  meta: Meta | null;
  /** Bumped after a demo reset or a test event, so open views refetch. */
  version: number;
  bump: () => void;
}

export const MetaCtx = createContext<MetaContext>({ meta: null, version: 0, bump: () => {} });
export const useMeta = () => useContext(MetaCtx);
